import type { SupabaseClient } from "@supabase/supabase-js";
import type { DishCandidate } from "@/lib/llm/schema";

/**
 * Сопоставление названий блюд от модели со справочником (тикет 08 спеки
 * .scratch/russian-dish-catalog).
 *
 * Это не тот же матчинг, что у ингредиентов (src/lib/catalog/match.ts), и не
 * надо пытаться свести их в одну функцию:
 *
 *   | |ингредиенты|блюда|
 *   |поиск по|name_en, канон USDA|name_ru, разговорное|
 *   |размер пула|8 тысяч|128 тысяч|
 *   |промах|unmatched, КБЖУ от модели|штатный исход, вес вручную|
 *   |что решает|точность|ранжирование|
 *
 * Ранжирование живёт в SQL (`search_dishes`, миграция 0009): триграммной
 * похожести на 128 тысячах позиций не хватает, к ней добавлены популярность и
 * понижение служебных позиций.
 */

/** Ниже этого совпадения кандидат не показывается: лучше «другое», чем чужое блюдо. */
export const DISH_MATCH_THRESHOLD = 0.3;

export interface DishMatch {
  /** Позиция в ответе модели, 1..3 — сохраняется в recognition_dish_candidates. */
  position: number;
  name_ru: string;
  confidence: number;
  why: string;
  ingredient_id: number | null;
  match_score: number | null;
  match_source: string | null;
  /** Название из справочника; отличается от name_ru модели и показывается вместо него. */
  catalog_name_ru: string | null;
}

interface DishRow {
  id: number;
  name_ru: string;
  category: string | null;
  source: string;
  popularity_views: number;
  is_service: boolean;
  match_score: number;
  rank_score: number;
}

async function searchDishes(
  supabase: SupabaseClient,
  term: string,
  limit: number,
): Promise<DishRow[]> {
  const q = term?.trim();
  if (!q) return [];
  const { data, error } = await supabase.rpc("search_dishes", {
    q,
    max_results: limit,
  });
  if (error) {
    // Как и у ингредиентов, матчинг не критичный путь: без справочника блюдо
    // просто останется без привязки, и пользователь введёт вес руками.
    console.error("search_dishes failed", error);
    return [];
  }
  return (data ?? []) as DishRow[];
}

/**
 * Три названия от модели → до трёх позиций справочника.
 *
 * Кандидаты могут указать в одну позицию (модель предложила «оладьи»,
 * «панкейки» и «блины», а в справочнике это одна строка). Дублировать её в
 * выборе нельзя — вторая привязка снимается, название модели остаётся, и
 * пользователь видит три разных варианта, из которых сматчен один.
 */
export async function matchDishCandidates(
  supabase: SupabaseClient,
  candidates: DishCandidate[],
): Promise<DishMatch[]> {
  const used = new Set<number>();
  const results: DishMatch[] = [];

  for (const [index, candidate] of candidates.entries()) {
    const rows = await searchDishes(supabase, candidate.name_ru, 5);
    const best = rows.find(
      (row) => row.match_score >= DISH_MATCH_THRESHOLD && !used.has(row.id),
    );

    if (best) used.add(best.id);
    results.push({
      position: index + 1,
      name_ru: candidate.name_ru,
      confidence: candidate.confidence,
      why: candidate.why,
      ingredient_id: best?.id ?? null,
      match_score: best?.match_score ?? null,
      match_source: best?.source ?? null,
      catalog_name_ru: best?.name_ru ?? null,
    });
  }

  return results;
}
