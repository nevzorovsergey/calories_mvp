import type { SupabaseClient } from "@supabase/supabase-js";
import { signPhoto } from "@/lib/data/meals";
import {
  NO_EDITS,
  tallyEdits,
  verdictOf,
  type Edits,
  type Verdict,
} from "@/lib/data/lab-review";

/**
 * Полный разбор одного приёма пищи (FR-LABX-7).
 *
 * Собирает вместе три слоя, которые в схеме лежат отдельно и никогда не
 * перезаписывают друг друга (§1.3 PRD): что предложила модель, что выбрал
 * человек и что он потом рассказал о весе. Ценность экрана ровно в том, что
 * все три видны сразу — по отдельности каждый ничего не объясняет.
 */

export interface ReviewRecognitionItem {
  id: string;
  position: number;
  name_ru: string;
  weight_g: number;
  visible: boolean | null;
  match_status: string;
  match_score: number | null;
  ingredient_id: number | null;
  kcal_per_100g: number | null;
}

export interface ReviewRecognition {
  id: string;
  model_id: string;
  model_label: string;
  vendor: string;
  prompt_version: string;
  is_primary: boolean;
  status: string;
  error_text: string | null;
  dish_name_ru: string | null;
  total_weight_g: number | null;
  overall_confidence: number | null;
  portion_size: string | null;
  portion_reasoning: string | null;
  scale_mode: string | null;
  scale_size_error: number | null;
  scale_chain: Record<string, unknown> | null;
  has_scale_ref: boolean | null;
  nutrition_catalog: Record<string, number> | null;
  latency_ms: number | null;
  cost_rub_actual: number | null;
  cost_direct_usd: number | null;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  created_at: string;
  items: ReviewRecognitionItem[];
  candidates: {
    position: number;
    name_ru: string;
    confidence: number | null;
    why: string | null;
    ingredient_id: number | null;
    match_score: number | null;
    match_source: string | null;
    /** Совпал с тем, что человек в итоге выбрал. */
    chosen: boolean;
  }[];
}

export interface ReviewUserItem {
  id: string;
  position: number;
  name_ru: string;
  weight_g: number;
  original_weight_g: number | null;
  origin: string;
  nutrition_source: string;
  ingredient_id: number | null;
  source_item_id: string | null;
  kcal_per_100g: number | null;
}

export interface MealReview {
  id: string;
  user_id: string;
  display_name: string;
  meal_date: string;
  eaten_at: string;
  created_at: string;
  updated_at: string;
  status: string;
  verdict: Verdict;
  edits: Edits;
  dish_name_ru: string | null;
  user_hint: string | null;
  photoUrl: string | null;
  photo_width: number | null;
  photo_height: number | null;
  photo_sha256: string | null;
  selected_dish_name: string | null;
  selected_candidate_position: number | null;
  selected_portion_size: string | null;
  userWeightG: number | null;
  userKcal: number | null;
  items: ReviewUserItem[];
  /** Позиции модели, которые человек выбросил, — с их исходными названиями. */
  removed: { source_item_id: string; name_ru: string; weight_g: number; removed_at: string }[];
  recognitions: ReviewRecognition[];
  evidence: {
    method: string | null;
    self_confidence: number | null;
    reference_objects: string[];
    had_reference: boolean;
    comment: string | null;
    created_at: string;
  } | null;
}

export async function loadMealReview(
  supabase: SupabaseClient,
  mealId: string,
): Promise<MealReview | null> {
  const { data: meal } = await supabase
    .from("meals")
    .select(
      "id, user_id, meal_date, eaten_at, created_at, updated_at, status, dish_name_ru, user_hint, photo_sent_path, photo_width, photo_height, photo_sha256, primary_recognition_id, selected_dish_id, selected_candidate_position, selected_portion_size",
    )
    .eq("id", mealId)
    .maybeSingle();
  if (!meal) return null;

  const [
    { data: profile },
    photoUrl,
    { data: items },
    { data: removedRows },
    { data: totals },
    { data: recognitions },
    { data: evidence },
    { data: selectedDish },
  ] = await Promise.all([
    supabase.from("profiles").select("display_name").eq("id", meal.user_id).maybeSingle(),
    signPhoto(supabase, meal.photo_sent_path),
    supabase
      .from("meal_items")
      .select(
        "id, position, name_ru, weight_g, original_weight_g, origin, nutrition_source, ingredient_id, source_item_id, kcal_per_100g",
      )
      .eq("meal_id", mealId)
      .order("position"),
    supabase
      .from("meal_removed_items")
      .select("source_item_id, removed_at")
      .eq("meal_id", mealId),
    supabase
      .from("v_meal_user_totals")
      .select("user_weight_g, user_kcal")
      .eq("meal_id", mealId)
      .maybeSingle(),
    supabase
      .from("recognitions")
      .select(
        "id, model_id, model_label, vendor, prompt_version, is_primary, status, error_text, dish_name_ru, total_weight_g, overall_confidence, portion_size, portion_reasoning, scale_mode, scale_size_error, scale_chain, has_scale_ref, nutrition_catalog, latency_ms, cost_rub_actual, cost_direct_usd, prompt_tokens, completion_tokens, created_at",
      )
      .eq("meal_id", mealId)
      .order("created_at"),
    supabase
      .from("weight_evidence")
      .select("method, self_confidence, reference_objects, had_reference, comment, created_at")
      .eq("meal_id", mealId)
      .maybeSingle(),
    meal.selected_dish_id
      ? supabase
          .from("ingredients")
          .select("name_ru")
          .eq("id", meal.selected_dish_id)
          .maybeSingle()
      : Promise.resolve({ data: null }),
  ]);

  const recognitionRows = (recognitions ?? []) as Record<string, unknown>[];
  const recognitionIds = recognitionRows.map((r) => r.id as string);

  const [{ data: recognitionItems }, { data: candidates }] = await Promise.all([
    recognitionIds.length > 0
      ? supabase
          .from("recognition_items")
          .select(
            "id, recognition_id, position, name_ru, weight_g, visible, match_status, match_score, ingredient_id, kcal_per_100g",
          )
          .in("recognition_id", recognitionIds)
          .order("position")
      : Promise.resolve({ data: [] }),
    recognitionIds.length > 0
      ? supabase
          .from("recognition_dish_candidates")
          .select(
            "recognition_id, position, name_ru, confidence, why, ingredient_id, match_score, match_source",
          )
          .in("recognition_id", recognitionIds)
          .order("position")
      : Promise.resolve({ data: [] }),
  ]);

  const itemsByRecognition = new Map<string, ReviewRecognitionItem[]>();
  for (const row of (recognitionItems ?? []) as (ReviewRecognitionItem & {
    recognition_id: string;
  })[]) {
    const list = itemsByRecognition.get(row.recognition_id) ?? [];
    list.push({ ...row, weight_g: Number(row.weight_g) });
    itemsByRecognition.set(row.recognition_id, list);
  }

  const candidatesByRecognition = new Map<string, ReviewRecognition["candidates"]>();
  for (const row of (candidates ?? []) as {
    recognition_id: string;
    position: number;
    name_ru: string;
    confidence: number | null;
    why: string | null;
    ingredient_id: number | null;
    match_score: number | null;
    match_source: string | null;
  }[]) {
    const list = candidatesByRecognition.get(row.recognition_id) ?? [];
    list.push({
      position: row.position,
      name_ru: row.name_ru,
      confidence: row.confidence === null ? null : Number(row.confidence),
      why: row.why,
      ingredient_id: row.ingredient_id,
      match_score: row.match_score === null ? null : Number(row.match_score),
      match_source: row.match_source,
      // Позиция кандидата, а не совпадение по id: человек мог выбрать вариант,
      // который в справочник не сматчился, и тогда `selected_dish_id` пуст, но
      // выбор всё равно был сделан.
      chosen: meal.selected_candidate_position === row.position,
    });
    candidatesByRecognition.set(row.recognition_id, list);
  }

  const userItems = ((items ?? []) as ReviewUserItem[]).map((i) => ({
    ...i,
    weight_g: Number(i.weight_g),
    original_weight_g: i.original_weight_g === null ? null : Number(i.original_weight_g),
  }));

  // Названия выброшенных позиций живут в `recognition_items` — в
  // `meal_removed_items` лежит только ссылка. Без этого шага удалённое
  // показывалось бы строкой «удалена позиция 3f2c…».
  const removedIds = ((removedRows ?? []) as { source_item_id: string }[]).map(
    (r) => r.source_item_id,
  );
  const removedNames = new Map<string, { name_ru: string; weight_g: number }>();
  if (removedIds.length > 0) {
    const { data } = await supabase
      .from("recognition_items")
      .select("id, name_ru, weight_g")
      .in("id", removedIds);
    for (const row of (data ?? []) as { id: string; name_ru: string; weight_g: number }[]) {
      removedNames.set(row.id, { name_ru: row.name_ru, weight_g: Number(row.weight_g) });
    }
  }

  const edits: Edits =
    tallyEdits(
      userItems.map((i) => ({ meal_id: mealId, origin: i.origin })),
      removedIds.map(() => ({ meal_id: mealId })),
    ).get(mealId) ?? NO_EDITS;

  return {
    id: meal.id,
    user_id: meal.user_id,
    display_name: profile?.display_name ?? "—",
    meal_date: meal.meal_date,
    eaten_at: meal.eaten_at,
    created_at: meal.created_at,
    updated_at: meal.updated_at,
    status: meal.status,
    verdict: verdictOf(meal.status, edits),
    edits,
    dish_name_ru: meal.dish_name_ru,
    user_hint: meal.user_hint,
    photoUrl,
    photo_width: meal.photo_width,
    photo_height: meal.photo_height,
    photo_sha256: meal.photo_sha256,
    selected_dish_name: (selectedDish as { name_ru: string } | null)?.name_ru ?? null,
    selected_candidate_position: meal.selected_candidate_position,
    selected_portion_size: meal.selected_portion_size,
    userWeightG: totals ? Number(totals.user_weight_g) : null,
    userKcal: totals ? Number(totals.user_kcal) : null,
    items: userItems,
    removed: ((removedRows ?? []) as { source_item_id: string; removed_at: string }[]).map(
      (r) => ({
        source_item_id: r.source_item_id,
        removed_at: r.removed_at,
        name_ru: removedNames.get(r.source_item_id)?.name_ru ?? "позиция удалена из базы",
        weight_g: removedNames.get(r.source_item_id)?.weight_g ?? 0,
      }),
    ),
    recognitions: recognitionRows.map((r) => ({
      ...(r as unknown as Omit<ReviewRecognition, "items" | "candidates">),
      total_weight_g: r.total_weight_g === null ? null : Number(r.total_weight_g),
      items: itemsByRecognition.get(r.id as string) ?? [],
      candidates: candidatesByRecognition.get(r.id as string) ?? [],
    })),
    evidence: evidence
      ? {
          ...evidence,
          reference_objects: (evidence.reference_objects ?? []) as string[],
        }
      : null,
  };
}

export const PORTION_SIZE_RU: Record<string, string> = {
  small: "маленькая",
  medium: "средняя",
  large: "большая",
  custom: "свой вес",
};
