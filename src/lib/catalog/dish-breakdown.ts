import type { SupabaseClient } from "@supabase/supabase-js";
import { sumNutrition, type NutrientMap } from "@/lib/nutrition/calc";

/**
 * Раскладка готового блюда из справочника на состав и нутриенты.
 *
 * Общий код для двух мест, которые обязаны считать одинаково: выбора блюда
 * (PUT /api/meals/[id]/dish), где раскладка становится пользовательской
 * версией, и таблицы сравнения моделей, где она показывает, во что обошлось бы
 * предложение v3-dish. Разъедься эти два расчёта — и сравнение врало бы, не
 * подавая виду.
 *
 * Считаем от `ingredient_components.share`, а не от `gram_weight`: граммы в
 * справочнике записаны для средней порции, а порция бывает любой. Доля —
 * единственное, на что можно опираться при масштабировании (миграция 0006).
 */

export type PortionSize = "small" | "medium" | "large";

/** `ingredient_portions.seq` по размеру порции. */
export const PORTION_SEQ: Record<PortionSize, number> = {
  small: 1,
  medium: 2,
  large: 3,
};

export const PORTION_LABELS: Record<PortionSize, string> = {
  small: "маленькая порция",
  medium: "обычная порция",
  large: "большая порция",
};

/**
 * Макросы, и только они: ровно эти четыре колонки есть у `meal_items` и ровно
 * их показывает сравнение. Тянуть весь профиль нутриентов ради них — лишние
 * сотни строк на каждый запрос.
 */
const MACRO_CODES = ["energy_kcal", "protein", "fat", "carbs"];

export interface DishComponent {
  ingredient_id: number | null;
  name_ru: string;
  weight_g: number;
  /** Значения справочника на 100 г; пусто, если компонент не резолвится. */
  per100g: NutrientMap;
}

export interface DishBreakdown {
  weight_g: number;
  components: DishComponent[];
  /** Итог по блюду в тех же кодах, что `recognitions.nutrition_catalog`. */
  nutrition: NutrientMap;
}

/** Все типовые порции блюда: `seq` → граммы. */
export async function portionWeights(
  supabase: SupabaseClient,
  dishId: number,
): Promise<Map<number, number>> {
  const { data, error } = await supabase
    .from("ingredient_portions")
    .select("seq, gram_weight")
    .eq("ingredient_id", dishId)
    .order("seq");
  if (error) throw new Error(error.message);
  return new Map(
    (data ?? []).map((p) => [p.seq as number, Number(p.gram_weight)]),
  );
}

/**
 * Вес типовой порции блюда. `null` — такого размера у блюда в справочнике нет
 * (у части блюд FNDDS заполнены не все три).
 */
export async function portionWeight(
  supabase: SupabaseClient,
  dishId: number,
  size: PortionSize,
): Promise<number | null> {
  const weights = await portionWeights(supabase, dishId);
  return weights.get(PORTION_SEQ[size]) ?? null;
}

/**
 * Разложить блюдо на состав указанного веса.
 *
 * `null` — у блюда нет раскладки в справочнике: показать такое как ноль нельзя,
 * это не «блюдо без калорий», а «мы не знаем состав».
 */
export async function buildDishBreakdown(
  supabase: SupabaseClient,
  dishId: number,
  weightG: number,
): Promise<DishBreakdown | null> {
  const { data: components, error } = await supabase
    .from("ingredient_components")
    .select("seq, ingredient_id, name_en_fallback, share")
    .eq("dish_id", dishId)
    .order("seq");
  if (error) throw new Error(error.message);
  if (!components?.length) return null;

  const ids = components
    .map((c) => c.ingredient_id as number | null)
    .filter((v): v is number => v !== null);

  const [{ data: names }, { data: nutrients }] = await Promise.all([
    supabase.from("ingredients").select("id, name_ru").in("id", ids),
    supabase
      .from("ingredient_nutrients")
      .select("ingredient_id, amount_per_100g, nutrients!inner(code)")
      .in("ingredient_id", ids)
      .in("nutrients.code", MACRO_CODES),
  ]);

  const nameById = new Map(
    (names ?? []).map((n) => [n.id as number, n.name_ru as string]),
  );
  const per100 = new Map<number, NutrientMap>();
  for (const row of nutrients ?? []) {
    const id = row.ingredient_id as number;
    const code = (row.nutrients as unknown as { code: string }).code;
    const bucket = per100.get(id) ?? {};
    bucket[code] = Number(row.amount_per_100g);
    per100.set(id, bucket);
  }

  const resolved: DishComponent[] = components.map((c) => {
    const ingredientId = c.ingredient_id as number | null;
    return {
      ingredient_id: ingredientId,
      name_ru:
        (ingredientId ? nameById.get(ingredientId) : null) ??
        (c.name_en_fallback as string | null) ??
        "без названия",
      weight_g: Number((Number(c.share) * weightG).toFixed(1)),
      per100g: (ingredientId ? per100.get(ingredientId) : undefined) ?? {},
    };
  });

  return {
    weight_g: weightG,
    components: resolved,
    nutrition: sumNutrition(
      resolved.map((c) => ({
        weight_g: c.weight_g,
        per100g: c.per100g,
        nutrition_source: "catalog" as const,
      })),
    ),
  };
}
