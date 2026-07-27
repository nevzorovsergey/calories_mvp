import type { SupabaseClient } from "@supabase/supabase-js";
import type { RecognizedItem } from "./run";

/**
 * Первичная пользовательская версия состава.
 *
 * Сразу после распознавания `meal_items` — точная копия предложения модели, все
 * позиции с origin='model_kept'. Дальше пользователь правит именно эту таблицу;
 * `recognitions` и `recognition_items` при этом не меняются никогда (FR-EDIT-10),
 * поэтому обе версии сохраняются навсегда и не перезаписывают друг друга.
 */
export async function createInitialMealItems(
  supabase: SupabaseClient,
  mealId: string,
  items: RecognizedItem[],
): Promise<void> {
  if (items.length === 0) return;

  const rows = items.map((item) => ({
    meal_id: mealId,
    position: item.position,
    ingredient_id: item.ingredient_id,
    name_ru: item.name_ru,
    weight_g: item.weight_g,
    nutrition_source: item.nutrition_source,
    origin: "model_kept",
    source_item_id: item.id,
    original_weight_g: null,
    kcal_per_100g: item.kcal_per_100g,
    protein_per_100g: item.protein_per_100g,
    fat_per_100g: item.fat_per_100g,
    carbs_per_100g: item.carbs_per_100g,
  }));

  const { error } = await supabase.from("meal_items").insert(rows);
  if (error) {
    throw new Error(`Не удалось создать meal_items: ${error.message}`);
  }
}
