import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import {
  buildDishBreakdown,
  portionWeight,
  type DishBreakdown,
  type PortionSize,
} from "@/lib/catalog/dish-breakdown";

/**
 * Выбор блюда и размера порции (тикет 10 спеки .scratch/russian-dish-catalog).
 *
 * Здесь и только здесь состав блюда из справочника превращается в
 * пользовательскую версию приёма пищи. Распознавание этого не делает намеренно:
 * до выбора человека состава нет, а `recognitions` и
 * `recognition_dish_candidates` остаются нетронутыми навсегда — предложение
 * модели и версия пользователя не перезаписывают друг друга (§1.3 PRD).
 *
 * Сама раскладка живёт в `@/lib/catalog/dish-breakdown`: тем же расчётом
 * таблица сравнения показывает, во что обошлось бы предложение v3-dish.
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
  let breakdown: DishBreakdown | null;
  try {
    if (payload.portion_size !== "custom") {
      weight = await portionWeight(
        supabase,
        payload.dish_id,
        payload.portion_size as PortionSize,
      );
    }
    if (!weight || weight <= 0) {
      return NextResponse.json(
        { error: "Не удалось определить вес порции" },
        { status: 400 },
      );
    }
    breakdown = await buildDishBreakdown(supabase, payload.dish_id, weight);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
  if (!breakdown) {
    return NextResponse.json(
      { error: "У блюда нет состава в справочнике" },
      { status: 422 },
    );
  }

  // Пользовательская версия пересобирается целиком: выбор блюда — это новый
  // ответ на вопрос «что я съел», а не правка предыдущего.
  await supabase.from("meal_items").delete().eq("meal_id", mealId);

  const rows = breakdown.components.map((c, index) => ({
    meal_id: mealId,
    position: index,
    ingredient_id: c.ingredient_id,
    name_ru: c.name_ru,
    weight_g: c.weight_g,
    // Состав пришёл из справочника целиком — и позиции, и их нутриенты.
    nutrition_source: "catalog",
    // Четвёртое значение origin: без него аналитика H1 считала бы раскладку
    // справочника за предложение модели, и «доля оставленного без изменений»
    // потеряла бы смысл ровно там, где её сравнивают с H7.
    origin: "catalog_dish",
    kcal_per_100g: c.per100g.energy_kcal ?? null,
    protein_per_100g: c.per100g.protein ?? null,
    fat_per_100g: c.per100g.fat ?? null,
    carbs_per_100g: c.per100g.carbs ?? null,
  }));

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
