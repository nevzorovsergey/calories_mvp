import type { SupabaseClient } from "@supabase/supabase-js";
import { NUTRIENTS, MODEL_NUTRIENT_FIELDS } from "@config/nutrients";
import type { AnalysisIngredient } from "@/lib/llm/schema";
import type { IngredientMatch } from "@/lib/catalog/match";

/**
 * Расчёт нутриентов (§8.5 PRD).
 *
 *   нутриент = (weight_g / 100) × значение_на_100г
 *   итог по блюду = сумма по ингредиентам
 *
 * Двойной расчёт: для каждого распознавания храним два набора итогов —
 * `nutrition_catalog` (по справочнику) и `nutrition_model` (по цифрам самой
 * модели. Это позволит отдельно ответить: справочник вообще что-то улучшает
 * или модель считает не хуже?
 *
 * Сырое vs готовое: в MVP используем значение как есть, но `state` и
 * `cooking_method` от модели сохраняем. Коэффициенты уварки и сохранности
 * витаминов — вне MVP, поля под них уже есть в схеме.
 */

/** Значения нутриентов на 100 г, ключ — `nutrients.code`. */
export type NutrientMap = Record<string, number>;

export interface CatalogNutrition {
  /** ingredient_id → { code: amount_per_100g } */
  byIngredient: Map<number, NutrientMap>;
}

export async function loadCatalogNutrition(
  supabase: SupabaseClient,
  ingredientIds: number[],
): Promise<CatalogNutrition> {
  const byIngredient = new Map<number, NutrientMap>();
  const unique = [...new Set(ingredientIds.filter((id) => id != null))];
  if (unique.length === 0) return { byIngredient };

  const { data, error } = await supabase
    .from("ingredient_nutrients")
    .select("ingredient_id, amount_per_100g, nutrients(code)")
    .in("ingredient_id", unique);

  if (error) {
    console.error("loadCatalogNutrition failed", error);
    return { byIngredient };
  }

  for (const row of data ?? []) {
    const code = (row as { nutrients?: { code?: string } }).nutrients?.code;
    if (!code) continue;
    const id = (row as { ingredient_id: number }).ingredient_id;
    const amount = Number((row as { amount_per_100g: number }).amount_per_100g);
    const map = byIngredient.get(id) ?? {};
    map[code] = amount;
    byIngredient.set(id, map);
  }

  return { byIngredient };
}

export interface ComputedItem {
  weight_g: number;
  /** Значения на 100 г, которые реально пошли в расчёт. */
  per100g: NutrientMap;
  nutrition_source: "catalog" | "model";
}

/** Нутриенты, которые модель отдаёт напрямую (§7.3) — только 4 макро. */
export function modelPer100g(ingredient: AnalysisIngredient): NutrientMap {
  const map: NutrientMap = {};
  for (const [code, field] of Object.entries(MODEL_NUTRIENT_FIELDS)) {
    const value = (ingredient as unknown as Record<string, unknown>)[field];
    if (typeof value === "number" && Number.isFinite(value)) {
      map[code] = value;
    }
  }
  return map;
}

/**
 * Сводит ингредиент к тому, чем его считать: справочник, если он нашёлся,
 * иначе оценка модели (§8.4, шаг 3). Возвращаемый `nutrition_source` попадает
 * в `meal_items` и определяет пометку «≈» в интерфейсе (FR-CAT-2).
 */
export function resolveItemNutrition(
  ingredient: AnalysisIngredient,
  match: IngredientMatch,
  catalog: CatalogNutrition,
): ComputedItem {
  const catalogMap =
    match.ingredient_id !== null
      ? catalog.byIngredient.get(match.ingredient_id)
      : undefined;

  if (catalogMap && Object.keys(catalogMap).length > 0) {
    return {
      weight_g: ingredient.weight_g,
      per100g: catalogMap,
      nutrition_source: "catalog",
    };
  }

  return {
    weight_g: ingredient.weight_g,
    per100g: modelPer100g(ingredient),
    nutrition_source: "model",
  };
}

/** Суммирует набор позиций в итог по блюду. */
export function sumNutrition(items: ComputedItem[]): NutrientMap {
  const total: NutrientMap = {};
  for (const item of items) {
    const factor = item.weight_g / 100;
    for (const [code, per100] of Object.entries(item.per100g)) {
      if (!Number.isFinite(per100)) continue;
      total[code] = (total[code] ?? 0) + per100 * factor;
    }
  }
  // Округляем до 2 знаков: микрограммы витаминов с 15 знаками после запятой
  // только раздувают jsonb и мешают читать таблицы.
  for (const code of Object.keys(total)) {
    total[code] = Math.round(total[code] * 100) / 100;
  }
  return total;
}

/** Итог «по модели»: только те нутриенты, которые модель вернула сама. */
export function sumModelNutrition(
  ingredients: AnalysisIngredient[],
): NutrientMap {
  return sumNutrition(
    ingredients.map((ing) => ({
      weight_g: ing.weight_g,
      per100g: modelPer100g(ing),
      nutrition_source: "model" as const,
    })),
  );
}

/** Процент от суточной нормы для панели нутриентов (FR-EDIT-7). */
export function percentOfRdi(code: string, amount: number): number | null {
  const def = NUTRIENTS.find((n) => n.code === code);
  if (!def || !def.rdi) return null;
  return Math.round((amount / def.rdi) * 100);
}
