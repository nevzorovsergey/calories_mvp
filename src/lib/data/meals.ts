import type { SupabaseClient } from "@supabase/supabase-js";
import {
  loadCatalogNutrition,
  sumNutrition,
  type ComputedItem,
  type NutrientMap,
} from "@/lib/nutrition/calc";

/**
 * Чтение данных для экранов. Всё идёт через клиент с пользовательской сессией,
 * поэтому RLS отдаёт только свои приёмы пищи.
 */

export interface MealItemRow {
  id: string;
  position: number;
  ingredient_id: number | null;
  name_ru: string;
  weight_g: number;
  nutrition_source: "catalog" | "model";
  origin: "model_kept" | "model_edited" | "user_added";
  source_item_id: string | null;
  original_weight_g: number | null;
  kcal_per_100g: number | null;
  protein_per_100g: number | null;
  fat_per_100g: number | null;
  carbs_per_100g: number | null;
}

export interface MealRow {
  id: string;
  meal_date: string;
  eaten_at: string;
  status: string;
  dish_name_ru: string | null;
  photo_sent_path: string;
  user_hint: string | null;
  primary_recognition_id: string | null;
}

export interface MealSummary extends MealRow {
  kcal: number;
  thumbUrl: string | null;
  /** true — состав целиком как предложила модель, человек ничего не менял. */
  untouched: boolean;
}

export async function getProfile(supabase: SupabaseClient, userId: string) {
  const { data } = await supabase
    .from("profiles")
    .select("id, display_name, is_admin, timezone")
    .eq("id", userId)
    .single();
  return data;
}

/**
 * Полные нутриенты набора позиций: справочник для сматченных, снимок модели —
 * для остальных (§8.5). Витамины и минералы есть только у справочника, поэтому
 * unmatched-позиции вносят вклад лишь в макронутриенты — это честно отражает,
 * что мы про них знаем.
 */
export async function computeTotals(
  supabase: SupabaseClient,
  items: MealItemRow[],
): Promise<NutrientMap> {
  return sumNutrition(await loadItemsNutrition(supabase, items));
}

/**
 * То же самое, но с разбивкой по позициям: экранам нужны не только итоги, но и
 * значения на 100 г по каждому продукту (FR-DET-6). Порядок совпадает с
 * `items`.
 */
export async function loadItemsNutrition(
  supabase: SupabaseClient,
  items: MealItemRow[],
): Promise<ComputedItem[]> {
  const catalog = await loadCatalogNutrition(
    supabase,
    items
      .map((i) => i.ingredient_id)
      .filter((id): id is number => id !== null),
  );

  return items.map((item) => {
    const catalogMap =
      item.ingredient_id !== null
        ? catalog.byIngredient.get(item.ingredient_id)
        : undefined;

    if (item.nutrition_source === "catalog" && catalogMap) {
      return {
        weight_g: Number(item.weight_g),
        per100g: catalogMap,
        nutrition_source: "catalog",
      };
    }

    const snapshot: NutrientMap = {};
    if (item.kcal_per_100g !== null) snapshot.energy_kcal = Number(item.kcal_per_100g);
    if (item.protein_per_100g !== null) snapshot.protein = Number(item.protein_per_100g);
    if (item.fat_per_100g !== null) snapshot.fat = Number(item.fat_per_100g);
    if (item.carbs_per_100g !== null) snapshot.carbs = Number(item.carbs_per_100g);

    return {
      weight_g: Number(item.weight_g),
      per100g: snapshot,
      nutrition_source: "model",
    };
  });
}

export async function getMealItems(
  supabase: SupabaseClient,
  mealId: string,
): Promise<MealItemRow[]> {
  const { data } = await supabase
    .from("meal_items")
    .select("*")
    .eq("meal_id", mealId)
    .order("position");
  return (data ?? []) as MealItemRow[];
}

/** Лента приёмов пищи за день (FR-HOME-2) вместе с подписанными миниатюрами. */
export async function getDayMeals(
  supabase: SupabaseClient,
  userId: string,
  date: string,
): Promise<{ meals: MealSummary[]; totals: NutrientMap }> {
  const { data: mealRows } = await supabase
    .from("meals")
    .select(
      "id, meal_date, eaten_at, status, dish_name_ru, photo_sent_path, user_hint, primary_recognition_id",
    )
    .eq("user_id", userId)
    .eq("meal_date", date)
    .order("eaten_at", { ascending: true });

  const meals = (mealRows ?? []) as MealRow[];
  if (meals.length === 0) return { meals: [], totals: {} };

  const { data: itemRows } = await supabase
    .from("meal_items")
    .select("*")
    .in(
      "meal_id",
      meals.map((m) => m.id),
    );

  const items = (itemRows ?? []) as (MealItemRow & { meal_id: string })[];
  const byMeal = new Map<string, MealItemRow[]>();
  for (const item of items) {
    const list = byMeal.get(item.meal_id) ?? [];
    list.push(item);
    byMeal.set(item.meal_id, list);
  }

  const thumbs = await signThumbs(
    supabase,
    meals.map((m) => m.photo_sent_path),
  );

  const summaries: MealSummary[] = [];
  for (const meal of meals) {
    const mealItems = byMeal.get(meal.id) ?? [];
    const totals = await computeTotals(supabase, mealItems);
    summaries.push({
      ...meal,
      kcal: totals.energy_kcal ?? 0,
      thumbUrl: thumbs.get(meal.photo_sent_path) ?? null,
      untouched: mealItems.every((i) => i.origin === "model_kept"),
    });
  }

  const totals = await computeTotals(supabase, items);
  return { meals: summaries, totals };
}

export async function signThumbs(
  supabase: SupabaseClient,
  paths: string[],
): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  const unique = [...new Set(paths.filter(Boolean))];
  if (unique.length === 0) return result;

  const { data, error } = await supabase.storage
    .from("meals")
    .createSignedUrls(unique, 60 * 60);
  if (error) {
    console.error("createSignedUrls failed", error);
    return result;
  }
  for (const entry of data ?? []) {
    if (entry.signedUrl && entry.path) result.set(entry.path, entry.signedUrl);
  }
  return result;
}

export async function signPhoto(
  supabase: SupabaseClient,
  path: string,
): Promise<string | null> {
  const { data } = await supabase.storage
    .from("meals")
    .createSignedUrl(path, 60 * 60);
  return data?.signedUrl ?? null;
}
