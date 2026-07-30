import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

/**
 * Выбор блюда и размера порции (тикет 10 спеки .scratch/russian-dish-catalog).
 *
 * Здесь и только здесь состав блюда из справочника превращается в
 * пользовательскую версию приёма пищи. Распознавание этого не делает намеренно:
 * до выбора человека состава нет, а `recognitions` и
 * `recognition_dish_candidates` остаются нетронутыми навсегда — предложение
 * модели и версия пользователя не перезаписывают друг друга (§1.3 PRD).
 *
 * Раскладка считается от `ingredient_components.share`, а не от `gram_weight`:
 * граммы в справочнике записаны для средней порции, а пользователь мог выбрать
 * маленькую или большую. Доля — единственное, на что можно опираться при
 * масштабировании (та же семантика, что у FNDDS, см. миграцию 0006).
 */
export const dynamic = "force-dynamic";

interface Payload {
  /** Позиция справочника. null — пользователь отверг все три варианта. */
  dish_id: number | null;
  /** Какой из трёх вариантов выбран, 1..3. null при ручном вводе. */
  candidate_position?: number | null;
  portion_size: "small" | "medium" | "large" | "custom";
  /** Обязателен при portion_size = 'custom'. */
  weight_g?: number | null;
}

const PORTION_SEQ: Record<string, number> = { small: 1, medium: 2, large: 3 };

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: mealId } = await params;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Не авторизован" }, { status: 401 });
  }

  const payload = (await request.json()) as Payload;
  if (payload.dish_id == null) {
    return NextResponse.json({ error: "Ожидается поле dish_id" }, { status: 400 });
  }
  if (!payload.portion_size) {
    return NextResponse.json({ error: "Ожидается поле portion_size" }, { status: 400 });
  }

  // Вес порции: из справочника либо введённый руками.
  let weight = payload.weight_g ?? null;
  if (payload.portion_size !== "custom") {
    const { data: portion, error } = await supabase
      .from("ingredient_portions")
      .select("gram_weight")
      .eq("ingredient_id", payload.dish_id)
      .eq("seq", PORTION_SEQ[payload.portion_size])
      .maybeSingle();
    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }
    weight = portion ? Number(portion.gram_weight) : null;
  }
  if (!weight || weight <= 0) {
    return NextResponse.json(
      { error: "Не удалось определить вес порции" },
      { status: 400 },
    );
  }

  const { data: components, error: componentsError } = await supabase
    .from("ingredient_components")
    .select("seq, ingredient_id, name_en_fallback, share")
    .eq("dish_id", payload.dish_id)
    .order("seq");
  if (componentsError) {
    return NextResponse.json({ error: componentsError.message }, { status: 500 });
  }
  if (!components?.length) {
    return NextResponse.json(
      { error: "У блюда нет состава в справочнике" },
      { status: 422 },
    );
  }

  const ids = components
    .map((c) => c.ingredient_id as number | null)
    .filter((v): v is number => v !== null);

  const [{ data: names }, { data: nutrients }] = await Promise.all([
    supabase.from("ingredients").select("id, name_ru").in("id", ids),
    supabase
      .from("ingredient_nutrients")
      .select("ingredient_id, amount_per_100g, nutrients!inner(code)")
      .in("ingredient_id", ids)
      .in("nutrients.code", ["energy_kcal", "protein", "fat", "carbs"]),
  ]);

  const nameById = new Map((names ?? []).map((n) => [n.id as number, n.name_ru as string]));
  const per100 = new Map<number, Record<string, number>>();
  for (const row of nutrients ?? []) {
    const id = row.ingredient_id as number;
    const code = (row.nutrients as unknown as { code: string }).code;
    const bucket = per100.get(id) ?? {};
    bucket[code] = Number(row.amount_per_100g);
    per100.set(id, bucket);
  }

  // Пользовательская версия пересобирается целиком: выбор блюда — это новый
  // ответ на вопрос «что я съел», а не правка предыдущего.
  await supabase.from("meal_items").delete().eq("meal_id", mealId);

  const rows = components.map((c, index) => {
    const ingredientId = c.ingredient_id as number | null;
    const macros = ingredientId ? per100.get(ingredientId) ?? {} : {};
    return {
      meal_id: mealId,
      position: index,
      ingredient_id: ingredientId,
      name_ru:
        (ingredientId ? nameById.get(ingredientId) : null) ??
        (c.name_en_fallback as string | null) ??
        "без названия",
      weight_g: Number((Number(c.share) * weight).toFixed(1)),
      // Состав пришёл из справочника целиком — и позиции, и их нутриенты.
      nutrition_source: "catalog",
      // Четвёртое значение origin: без него аналитика H1 считала бы раскладку
      // справочника за предложение модели, и «доля оставленного без изменений»
      // потеряла бы смысл ровно там, где её сравнивают с H7.
      origin: "catalog_dish",
      kcal_per_100g: macros.energy_kcal ?? null,
      protein_per_100g: macros.protein ?? null,
      fat_per_100g: macros.fat ?? null,
      carbs_per_100g: macros.carbs ?? null,
    };
  });

  const { error: insertError } = await supabase.from("meal_items").insert(rows);
  if (insertError) {
    return NextResponse.json({ error: insertError.message }, { status: 500 });
  }

  const { data: dish } = await supabase
    .from("ingredients")
    .select("name_ru")
    .eq("id", payload.dish_id)
    .maybeSingle();

  const { error: mealError } = await supabase
    .from("meals")
    .update({
      status: "ready",
      selected_dish_id: payload.dish_id,
      selected_candidate_position: payload.candidate_position ?? null,
      selected_portion_size: payload.portion_size,
      dish_name_ru: dish?.name_ru ?? null,
    })
    .eq("id", mealId);
  if (mealError) {
    return NextResponse.json({ error: mealError.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true, items: rows.length, weight_g: weight });
}
