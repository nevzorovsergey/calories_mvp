import type { SupabaseClient } from "@supabase/supabase-js";

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
