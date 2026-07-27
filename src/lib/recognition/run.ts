import type { SupabaseClient } from "@supabase/supabase-js";
import type { ModelConfig } from "@config/models";
import { buildReferenceHint } from "@config/reference-objects";
import { recognizeDish, computeCost } from "@/lib/llm/polza";
import { runScaleChecks, type KnownReference } from "@/lib/llm/scale-check";
import { matchIngredients } from "@/lib/catalog/match";
import {
  loadCatalogNutrition,
  resolveItemNutrition,
  sumNutrition,
  sumModelNutrition,
  type ComputedItem,
} from "@/lib/nutrition/calc";

/**
 * Один прогон модели по фотографии (шаги 5–11 из §5.1 PRD).
 *
 * Общий код для первичного распознавания (POST /api/meals) и для ручного
 * перепрогона другой моделью (POST /api/meals/[id]/recognize). Перепрогон
 * обязан использовать тот же файл, иначе сравнение недействительно (FR-CMP-4).
 */

export interface RunRecognitionParams {
  supabase: SupabaseClient;
  mealId: string;
  userId: string;
  model: ModelConfig;
  imageBase64: string;
  imageMimeType?: string;
  userHint?: string | null;
  isPrimary: boolean;
}

export interface RunRecognitionResult {
  recognitionId: string;
  status: "ok" | "failed";
  errorText: string | null;
  /** Позиции, разобранные из ответа: нужны вызывающему для первичных meal_items. */
  items: RecognizedItem[];
}

export interface RecognizedItem {
  id: string;
  position: number;
  name_ru: string;
  weight_g: number;
  ingredient_id: number | null;
  nutrition_source: "catalog" | "model";
  kcal_per_100g: number | null;
  protein_per_100g: number | null;
  fat_per_100g: number | null;
  carbs_per_100g: number | null;
}

async function loadUserReferences(
  supabase: SupabaseClient,
  userId: string,
): Promise<KnownReference[]> {
  const { data, error } = await supabase
    .from("user_reference_objects")
    .select("type, label, true_size_mm, size_axis")
    .eq("user_id", userId);
  if (error) {
    console.error("loadUserReferences failed", error);
    return [];
  }
  return (data ?? []) as KnownReference[];
}

export async function runRecognition(
  params: RunRecognitionParams,
): Promise<RunRecognitionResult> {
  const { supabase, mealId, userId, model, isPrimary } = params;

  const references = await loadUserReferences(supabase, userId);
  const referenceHint = buildReferenceHint(
    references as unknown as {
      label: string;
      true_size_mm: number;
      size_axis: string;
    }[],
  );

  const result = await recognizeDish({
    model,
    imageBase64: params.imageBase64,
    imageMimeType: params.imageMimeType,
    userHint: params.userHint,
    referenceHint,
  });

  const cost = computeCost(result.usage, model.vendorPricing);

  // Неудачные попытки тоже пишем — с их стоимостью, если она была списана,
  // иначе экономика будет занижена (FR-LLM-3).
  const baseRow = {
    meal_id: mealId,
    model_id: model.id,
    model_label: model.label,
    vendor: model.vendor,
    prompt_version: model.promptVersion,
    image_detail: model.imageDetail,
    is_primary: isPrimary,
    raw_response: result.raw as never,
    latency_ms: result.latencyMs,
    usage_raw: (result.usage ?? null) as never,
    vendor_pricing_snapshot: (model.vendorPricing ?? null) as never,
    ...cost,
  };

  if (result.status === "failed" || !result.analysis) {
    const { data, error } = await supabase
      .from("recognitions")
      .insert({ ...baseRow, status: "failed", error_text: result.errorText })
      .select("id")
      .single();
    if (error) throw new Error(`Не удалось записать recognitions: ${error.message}`);
    return {
      recognitionId: data.id,
      status: "failed",
      errorText: result.errorText,
      items: [],
    };
  }

  const analysis = result.analysis;

  // §7.5: арифметическая проверка масштабной цепочки + ошибка в размере эталона.
  const scale = runScaleChecks(analysis, references);

  // §8.4 → §8.5: маппинг на справочник и двойной расчёт нутриентов.
  const matches = await matchIngredients(supabase, analysis.ingredients);
  const catalog = await loadCatalogNutrition(
    supabase,
    matches
      .map((m) => m.ingredient_id)
      .filter((id): id is number => id !== null),
  );

  const computed: ComputedItem[] = analysis.ingredients.map((ingredient, i) =>
    resolveItemNutrition(ingredient, matches[i], catalog),
  );

  const { data: recognition, error: recognitionError } = await supabase
    .from("recognitions")
    .insert({
      ...baseRow,
      status: "ok",
      error_text: null,
      parsed: analysis as never,
      dish_name_ru: analysis.dish_name_ru,
      total_weight_g: analysis.total_weight_g,
      overall_confidence: analysis.overall_confidence,
      scale_refs_count: analysis.scale_references.length,
      has_scale_ref: analysis.scale_references.length > 0,
      image_angle: analysis.image_quality.angle,
      scale_mode: analysis.scale_chain?.scale_mode ?? null,
      scale_ref_type: scale.scale_ref_type,
      scale_ref_true_mm: scale.scale_ref_true_mm,
      scale_ref_claimed_mm: scale.scale_ref_claimed_mm,
      scale_size_error: scale.scale_size_error,
      // Для v1-plain цепочки нет вовсе — пишем NULL, а не пустой объект с
      // пустым списком флагов: «проверять было нечего» и «всё сошлось» — это
      // разные факты, и срез по prompt_version (H6) их не должен путать.
      scale_chain: analysis.scale_chain
        ? ({
            ...analysis.scale_chain,
            consistency_flags: scale.consistency_flags,
            consistency_checks: scale.consistency_checks,
          } as never)
        : null,
      nutrition_catalog: sumNutrition(computed) as never,
      nutrition_model: sumModelNutrition(analysis.ingredients) as never,
    })
    .select("id")
    .single();

  if (recognitionError) {
    throw new Error(`Не удалось записать recognitions: ${recognitionError.message}`);
  }

  const itemRows = analysis.ingredients.map((ingredient, i) => ({
    recognition_id: recognition.id,
    position: i,
    name_ru: ingredient.name_ru,
    name_en: ingredient.name_en,
    weight_g: ingredient.weight_g,
    weight_confidence: ingredient.weight_confidence,
    cooking_method: ingredient.cooking_method,
    state: ingredient.state,
    visible: ingredient.visible,
    kcal_per_100g: ingredient.kcal_per_100g,
    protein_per_100g: ingredient.protein_per_100g,
    fat_per_100g: ingredient.fat_per_100g,
    carbs_per_100g: ingredient.carbs_per_100g,
    ingredient_id: matches[i].ingredient_id,
    match_status: matches[i].match_status,
    match_score: matches[i].match_score,
  }));

  const { data: insertedItems, error: itemsError } = await supabase
    .from("recognition_items")
    .insert(itemRows)
    .select("id, position");

  if (itemsError) {
    throw new Error(`Не удалось записать recognition_items: ${itemsError.message}`);
  }

  const idByPosition = new Map(
    (insertedItems ?? []).map((row) => [row.position as number, row.id as string]),
  );

  const items: RecognizedItem[] = analysis.ingredients.map((ingredient, i) => ({
    id: idByPosition.get(i)!,
    position: i,
    // Если ингредиент нашёлся в справочнике — показываем каноничное русское
    // название справочника, иначе то, что дала модель.
    name_ru: matches[i].name_ru ?? ingredient.name_ru,
    weight_g: ingredient.weight_g,
    ingredient_id: matches[i].ingredient_id,
    nutrition_source: computed[i].nutrition_source,
    kcal_per_100g: computed[i].per100g.energy_kcal ?? null,
    protein_per_100g: computed[i].per100g.protein ?? null,
    fat_per_100g: computed[i].per100g.fat ?? null,
    carbs_per_100g: computed[i].per100g.carbs ?? null,
  }));

  return {
    recognitionId: recognition.id,
    status: "ok",
    errorText: null,
    items,
  };
}
