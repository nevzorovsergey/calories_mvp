import type { SupabaseClient } from "@supabase/supabase-js";
import {
  PORTION_LABELS,
  PORTION_SEQ,
  buildDishBreakdown,
  portionWeights,
  type PortionSize,
} from "@/lib/catalog/dish-breakdown";
import type { NutrientMap } from "@/lib/nutrition/calc";

/**
 * Данные для экрана выбора блюда (тикет 10).
 *
 * Собирается тремя запросами вместо одного вложенного: у кандидатов, порций и
 * калорийности разные таблицы и разная кратность, а PostgREST на вложенных
 * выборках с фильтром по связанной таблице ведёт себя неочевидно. Читаемость
 * тут дороже одного лишнего похода в базу — экран открывается один раз.
 */

export interface DishChoiceOption {
  position: number;
  name_ru: string;
  catalog_name_ru: string | null;
  why: string | null;
  ingredient_id: number | null;
  portions: {
    size: "small" | "medium" | "large";
    grams: number;
    kcal: number | null;
  }[];
}

export interface DishChoiceData {
  options: DishChoiceOption[];
  suggestedPortion: "small" | "medium" | "large" | null;
}

const SIZE_BY_SEQ: Record<number, "small" | "medium" | "large"> = {
  1: "small",
  2: "medium",
  3: "large",
};

export async function loadDishChoice(
  supabase: SupabaseClient,
  recognitionId: string | null,
): Promise<DishChoiceData> {
  if (!recognitionId) return { options: [], suggestedPortion: null };

  const [{ data: candidates }, { data: recognition }] = await Promise.all([
    supabase
      .from("recognition_dish_candidates")
      .select("position, name_ru, why, ingredient_id")
      .eq("recognition_id", recognitionId)
      .order("position"),
    supabase
      .from("recognitions")
      .select("portion_size")
      .eq("id", recognitionId)
      .maybeSingle(),
  ]);

  const rows = candidates ?? [];
  const ids = rows
    .map((c) => c.ingredient_id as number | null)
    .filter((v): v is number => v !== null);

  if (ids.length === 0) {
    return {
      options: rows.map((c) => ({
        position: c.position as number,
        name_ru: c.name_ru as string,
        catalog_name_ru: null,
        why: (c.why as string | null) ?? null,
        ingredient_id: null,
        portions: [],
      })),
      suggestedPortion:
        (recognition?.portion_size as DishChoiceData["suggestedPortion"]) ?? null,
    };
  }

  const [{ data: names }, { data: portions }, { data: kcal }] = await Promise.all([
    supabase.from("ingredients").select("id, name_ru").in("id", ids),
    supabase
      .from("ingredient_portions")
      .select("ingredient_id, seq, gram_weight")
      .in("ingredient_id", ids)
      .order("seq"),
    supabase
      .from("ingredient_nutrients")
      .select("ingredient_id, amount_per_100g, nutrients!inner(code)")
      .in("ingredient_id", ids)
      .eq("nutrients.code", "energy_kcal"),
  ]);

  const nameById = new Map(
    (names ?? []).map((n) => [n.id as number, n.name_ru as string]),
  );
  const kcalById = new Map(
    (kcal ?? []).map((k) => [
      k.ingredient_id as number,
      Number(k.amount_per_100g),
    ]),
  );
  const portionsById = new Map<number, { seq: number; grams: number }[]>();
  for (const p of portions ?? []) {
    const id = p.ingredient_id as number;
    const bucket = portionsById.get(id) ?? [];
    bucket.push({ seq: p.seq as number, grams: Number(p.gram_weight) });
    portionsById.set(id, bucket);
  }

  return {
    options: rows.map((c) => {
      const id = c.ingredient_id as number | null;
      const per100 = id ? kcalById.get(id) : undefined;
      return {
        position: c.position as number,
        name_ru: c.name_ru as string,
        catalog_name_ru: id ? (nameById.get(id) ?? null) : null,
        why: (c.why as string | null) ?? null,
        ingredient_id: id,
        portions: (id ? (portionsById.get(id) ?? []) : [])
          .filter((p) => SIZE_BY_SEQ[p.seq])
          .map((p) => ({
            size: SIZE_BY_SEQ[p.seq],
            grams: p.grams,
            // Калорийность порции считается здесь, а не в компоненте: иначе
            // экран показывал бы граммы без цены, а именно цена и есть то, ради
            // чего человек выбирает размер.
            kcal: per100 === undefined ? null : (per100 * p.grams) / 100,
          })),
      };
    }),
    suggestedPortion:
      (recognition?.portion_size as DishChoiceData["suggestedPortion"]) ?? null,
  };
}

/**
 * Во что обошлось бы предложение v3-dish, если принять его как есть.
 *
 * Распознавание по названию не пишет ни `recognition_items`, ни
 * `nutrition_catalog` — состав у него появляется только после выбора человека.
 * В таблице сравнения такая колонка стояла пустой: сравнивать «блюдо целиком»
 * с «разбором на ингредиенты» было не с чем. Считаем колонку на лету из того,
 * что модель действительно предложила сама: первый кандидат плюс размер порции,
 * который она же и назвала. Не из выбора пользователя — иначе колонка модели
 * повторяла бы «Вашу версию» и сравнение стало бы тавтологией.
 *
 * Ничего не сохраняем: предложение модели остаётся нетронутым (§1.3 PRD), а
 * пересчёт — три запроса на экран, который открывают поштучно.
 */
export interface DishProposal {
  /** Название из справочника, на котором построен расчёт. */
  dishName: string;
  /** Размер порции, который в итоге пошёл в расчёт; null — нетиповой. */
  portionLabel: string | null;
  weight_g: number;
  nutrition: NutrientMap;
  items: { name_ru: string; weight_g: number; ingredient_id: number | null }[];
}

export async function loadDishProposal(
  supabase: SupabaseClient,
  recognitionId: string,
): Promise<DishProposal | null> {
  try {
    const [{ data: candidates }, { data: recognition }] = await Promise.all([
      supabase
        .from("recognition_dish_candidates")
        .select("position, name_ru, ingredient_id")
        .eq("recognition_id", recognitionId)
        .order("position"),
      supabase
        .from("recognitions")
        .select("portion_size")
        .eq("id", recognitionId)
        .maybeSingle(),
    ]);

    // Модель не обязана называть размер: без него берём обычную порцию — ровно
    // то же значение по умолчанию, что предлагает экран выбора.
    const suggested = ((recognition?.portion_size as PortionSize | null) ??
      "medium") as PortionSize;

    // Первый кандидат может не найтись в справочнике — тогда посчитать его
    // нельзя, и колонка строится по следующему. Это честнее пустоты: модель
    // предложила три варианта, а не один.
    for (const candidate of candidates ?? []) {
      const dishId = candidate.ingredient_id as number | null;
      if (dishId === null) continue;

      const weights = await portionWeights(supabase, dishId);
      if (weights.size === 0) continue;

      // Нужного размера может не быть (у части блюд FNDDS заполнены не все
      // три) — тогда обычная порция, а если и её нет, то первая имеющаяся.
      const wanted = weights.get(PORTION_SEQ[suggested]);
      const fallback =
        weights.get(PORTION_SEQ.medium) ?? [...weights.values()][0];
      const weight = wanted ?? fallback;

      const breakdown = await buildDishBreakdown(supabase, dishId, weight);
      if (!breakdown) continue;

      return {
        dishName: candidate.name_ru as string,
        portionLabel: wanted === undefined ? null : PORTION_LABELS[suggested],
        weight_g: breakdown.weight_g,
        nutrition: breakdown.nutrition,
        items: breakdown.components.map((c) => ({
          name_ru: c.name_ru,
          weight_g: c.weight_g,
          ingredient_id: c.ingredient_id,
        })),
      };
    }

    return null;
  } catch (error) {
    // Сравнение — вспомогательный блок: его сбой не должен ронять весь экран
    // приёма пищи. Колонка останется пустой, как и была.
    console.error("loadDishProposal failed", error);
    return null;
  }
}
