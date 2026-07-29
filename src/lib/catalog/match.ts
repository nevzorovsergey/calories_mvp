import type { SupabaseClient } from "@supabase/supabase-js";
import type { AnalysisIngredient } from "@/lib/llm/schema";

/**
 * Сопоставление названий от модели со справочником (§8.4 PRD).
 *
 * По шагам, до первого попадания:
 *   1. точное совпадение name_en (после нормализации) с ingredients.name_en
 *      или с записью в ingredient_aliases;
 *   2. триграммный поиск (pg_trgm) по name_en и name_ru, порог 0.45;
 *   3. не нашли → match_status = 'unmatched', нутриенты берём из модельной
 *      оценки, помечаем nutrition_source = 'model' (и «≈» в интерфейсе,
 *      FR-CAT-2).
 */

export const FUZZY_THRESHOLD = 0.45;

export type MatchStatus = "exact" | "fuzzy" | "unmatched";

export interface IngredientMatch {
  ingredient_id: number | null;
  match_status: MatchStatus;
  match_score: number | null;
  name_ru: string | null;
}

export function normalizeName(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

interface SearchRow {
  id: number;
  name_ru: string;
  name_en: string;
  match_status: string;
  match_score: number;
}

/**
 * Один ингредиент. `search_ingredients` (миграция 0007) делает шаги 1–2 одним
 * запросом: точные совпадения приходят со score 1.0 и всегда впереди.
 */
export async function matchIngredient(
  supabase: SupabaseClient,
  ingredient: Pick<AnalysisIngredient, "name_en" | "name_ru">,
): Promise<IngredientMatch> {
  const candidates = await searchCandidates(supabase, ingredient.name_en);

  const exact = candidates.find((c) => c.match_status === "exact");
  if (exact) {
    return {
      ingredient_id: exact.id,
      match_status: "exact",
      match_score: 1,
      name_ru: exact.name_ru,
    };
  }

  // Русское название — второй заход: модель могла дать неканоничный английский
  // термин, но узнаваемое русское (и наоборот).
  //
  // Условие именно «нет ничего годного», а не «пусто»: на справочнике из 8000
  // позиций английский поиск почти всегда возвращает хоть какой-то слабый
  // триграммный хвост, и проверка на пустоту сделала бы русскую ветку мёртвой
  // ровно тогда, когда она начинает быть нужной.
  const bestEn = candidates
    .filter((c) => c.match_score >= FUZZY_THRESHOLD)
    .sort((a, b) => b.match_score - a.match_score)[0];

  const ruCandidates = bestEn
    ? candidates
    : [...candidates, ...(await searchCandidates(supabase, ingredient.name_ru))];

  const exactRu = ruCandidates.find((c) => c.match_status === "exact");
  if (exactRu) {
    return {
      ingredient_id: exactRu.id,
      match_status: "exact",
      match_score: 1,
      name_ru: exactRu.name_ru,
    };
  }

  const best = ruCandidates
    .filter((c) => c.match_score >= FUZZY_THRESHOLD)
    .sort((a, b) => b.match_score - a.match_score)[0];

  if (best) {
    return {
      ingredient_id: best.id,
      match_status: "fuzzy",
      match_score: best.match_score,
      name_ru: best.name_ru,
    };
  }

  return {
    ingredient_id: null,
    match_status: "unmatched",
    match_score: null,
    name_ru: null,
  };
}

async function searchCandidates(
  supabase: SupabaseClient,
  term: string,
): Promise<SearchRow[]> {
  const normalized = term?.trim();
  if (!normalized) return [];
  const { data, error } = await supabase.rpc("search_ingredients", {
    q: normalized,
    max_results: 20,
    // Только сырьё, и это указано явно, хотя совпадает со значением по умолчанию
    // (миграция 0007). Справочник с 0006 содержит ещё 5432 готовых блюда FNDDS,
    // и они забирают точные совпадения себе: «chicken breast» без фильтра — это
    // «Chicken breast, stewed, skin eaten», а не сырая грудка. Здесь считается
    // КБЖУ распознанного ингредиента, на котором стоит H1.
    kinds: ["ingredient"],
  });
  if (error) {
    // Маппинг — не критичный путь: если справочник недоступен, ингредиент
    // просто станет unmatched и получит нутриенты от модели.
    console.error("search_ingredients failed", error);
    return [];
  }
  return (data ?? []) as SearchRow[];
}

export async function matchIngredients(
  supabase: SupabaseClient,
  ingredients: AnalysisIngredient[],
): Promise<IngredientMatch[]> {
  const results: IngredientMatch[] = [];
  for (const ingredient of ingredients) {
    results.push(await matchIngredient(supabase, ingredient));
  }
  return results;
}
