import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Чтение справочника для лаборатории (FR-LABX-2, FR-LABX-3).
 *
 * Список идёт через RPC `lab_catalog_page` (миграция 0017) — почему не через
 * PostgREST, объяснено там же. Карточка, наоборот, собирается обычными
 * запросами: строк мало и джойны узкие.
 */

export const PAGE_SIZE = 50;

export interface CatalogRow {
  id: number;
  name_ru: string;
  name_en: string;
  category: string | null;
  source: string;
  source_id: string | null;
  kind: string;
  state: string | null;
  is_active: boolean;
  is_service: boolean;
  popularity_views: number;
  portion_source_level: number | null;
  portions_count: number;
  components_count: number;
  nutrients_count: number;
  aliases_count: number;
  kcal_per_100g: number | null;
  used_in_meals: number;
}

export interface CatalogFilters {
  q: string | null;
  kind: string | null;
  source: string | null;
  category: string | null;
  active: boolean | null;
  service: boolean | null;
  hasPortions: boolean | null;
  hasComponents: boolean | null;
  hasNutrients: boolean | null;
  sort: "popularity" | "name" | "id";
  page: number;
}

export const EMPTY_FILTERS: CatalogFilters = {
  q: null,
  kind: null,
  source: null,
  category: null,
  active: null,
  service: null,
  hasPortions: null,
  hasComponents: null,
  hasNutrients: null,
  sort: "popularity",
  page: 1,
};

/** Разбор фильтров из query string — он же единственный источник состояния экрана. */
export function parseFilters(params: URLSearchParams): CatalogFilters {
  const flag = (name: string): boolean | null => {
    const value = params.get(name);
    if (value === "1") return true;
    if (value === "0") return false;
    return null;
  };
  const sort = params.get("sort");
  const page = Number(params.get("page") ?? "1");

  return {
    q: params.get("q")?.trim() || null,
    kind: params.get("kind") || null,
    source: params.get("source") || null,
    category: params.get("category") || null,
    active: flag("active"),
    service: flag("service"),
    hasPortions: flag("portions"),
    hasComponents: flag("components"),
    hasNutrients: flag("nutrients"),
    sort: sort === "name" || sort === "id" ? sort : "popularity",
    page: Number.isFinite(page) && page >= 1 ? Math.floor(page) : 1,
  };
}

/** Обратная операция: состояние формы → ссылка. Пустые значения не сериализуем. */
export function filtersToQuery(filters: CatalogFilters): string {
  const params = new URLSearchParams();
  const flag = (name: string, value: boolean | null) => {
    if (value !== null) params.set(name, value ? "1" : "0");
  };
  if (filters.q) params.set("q", filters.q);
  if (filters.kind) params.set("kind", filters.kind);
  if (filters.source) params.set("source", filters.source);
  if (filters.category) params.set("category", filters.category);
  flag("active", filters.active);
  flag("service", filters.service);
  flag("portions", filters.hasPortions);
  flag("components", filters.hasComponents);
  flag("nutrients", filters.hasNutrients);
  if (filters.sort !== "popularity") params.set("sort", filters.sort);
  if (filters.page > 1) params.set("page", String(filters.page));
  return params.toString();
}

export interface CatalogPage {
  rows: CatalogRow[];
  total: number;
  /**
   * Счёт упёрся в потолок: `total` — нижняя оценка, а не точное число.
   * Пересчитывать все 136 тысяч строк ради счётчика в углу экрана незачем,
   * но и врать, что нашлось ровно столько, нельзя.
   */
  totalIsLowerBound: boolean;
  error: string | null;
}

export async function loadCatalogPage(
  supabase: SupabaseClient,
  filters: CatalogFilters,
): Promise<CatalogPage> {
  const { data, error } = await supabase.rpc("lab_catalog_page", {
    q: filters.q,
    p_kind: filters.kind,
    p_source: filters.source,
    p_category: filters.category,
    p_active: filters.active,
    p_service: filters.service,
    p_has_portions: filters.hasPortions,
    p_has_components: filters.hasComponents,
    p_has_nutrients: filters.hasNutrients,
    p_sort: filters.sort,
    p_limit: PAGE_SIZE,
    p_offset: (filters.page - 1) * PAGE_SIZE,
  });

  if (error) {
    return { rows: [], total: 0, totalIsLowerBound: false, error: error.message };
  }

  const raw = (data ?? []) as (CatalogRow & {
    total_count: number;
    total_capped: boolean;
  })[];
  const rows = raw.map((row) => ({
    ...row,
    popularity_views: Number(row.popularity_views ?? 0),
    portions_count: Number(row.portions_count ?? 0),
    components_count: Number(row.components_count ?? 0),
    nutrients_count: Number(row.nutrients_count ?? 0),
    aliases_count: Number(row.aliases_count ?? 0),
    used_in_meals: Number(row.used_in_meals ?? 0),
    kcal_per_100g: row.kcal_per_100g === null ? null : Number(row.kcal_per_100g),
  }));

  // Счётчик едет на каждой строке; пустая страница означает, что сдвиг ушёл за
  // конец выдачи, и общего числа в ответе просто нет.
  return {
    rows,
    total: Number(raw[0]?.total_count ?? 0),
    totalIsLowerBound: raw[0]?.total_capped ?? false,
    error: null,
  };
}

export interface Facets {
  kind: { value: string; n: number }[];
  source: { value: string; n: number }[];
  category: { value: string; n: number }[];
}

export async function loadCatalogFacets(supabase: SupabaseClient): Promise<Facets> {
  const { data } = await supabase.rpc("lab_catalog_facets");
  const rows = (data ?? []) as { facet: string; value: string; n: number }[];
  const pick = (facet: string) =>
    rows
      .filter((r) => r.facet === facet && r.value !== null)
      .map((r) => ({ value: r.value, n: Number(r.n) }));
  return { kind: pick("kind"), source: pick("source"), category: pick("category") };
}

// ── Карточка позиции ────────────────────────────────────────────────────────

export interface CatalogNutrient {
  code: string;
  name_ru: string;
  unit: string;
  group_code: string;
  amount_per_100g: number;
  rdi_default: number | null;
}

export interface CatalogPortion {
  seq: number;
  label_en: string;
  label_ru: string | null;
  gram_weight: number;
  is_default: boolean;
}

export interface CatalogComponent {
  seq: number;
  ingredient_id: number | null;
  name: string;
  gram_weight: number;
  share: number;
}

export interface CatalogAlias {
  id: number;
  alias: string;
  lang: string;
  source: string;
  created_at: string;
}

export interface CatalogItem {
  id: number;
  source: string;
  source_id: string | null;
  name_ru: string;
  name_en: string;
  category: string | null;
  state: string | null;
  kind: string;
  is_active: boolean;
  is_service: boolean;
  popularity_views: number;
  source_recipes: number;
  portion_source_level: number | null;
  density_g_per_ml: number | null;
  created_at: string;
  nutrients: CatalogNutrient[];
  portions: CatalogPortion[];
  components: CatalogComponent[];
  aliases: CatalogAlias[];
  /** Где позиция всплывала: пользовательские позиции и предложения моделей. */
  usage: {
    mealItems: number;
    recognitionItems: number;
    byMatchStatus: { status: string; n: number }[];
    dishCandidates: number;
    selectedAsDish: number;
  };
}

export async function loadCatalogItem(
  supabase: SupabaseClient,
  id: number,
): Promise<CatalogItem | null> {
  const { data: item } = await supabase
    .from("ingredients")
    .select(
      "id, source, source_id, name_ru, name_en, category, state, kind, is_active, is_service, popularity_views, source_recipes, portion_source_level, density_g_per_ml, created_at",
    )
    .eq("id", id)
    .maybeSingle();
  if (!item) return null;

  const [
    nutrients,
    portions,
    components,
    aliases,
    mealItems,
    recognitionItems,
    dishCandidates,
    selectedAsDish,
  ] = await Promise.all([
    supabase
      .from("ingredient_nutrients")
      .select("amount_per_100g, nutrients(code, name_ru, unit, group_code, rdi_default, sort_order)")
      .eq("ingredient_id", id),
    supabase
      .from("ingredient_portions")
      .select("seq, label_en, label_ru, gram_weight, is_default")
      .eq("ingredient_id", id)
      .order("seq"),
    // Названия компонентов приезжают из справочника, а те 46 кодов, что не
    // резолвятся (0006), остаются с `name_en_fallback` — показать их всё равно
    // надо, иначе сумма долей перестанет сходиться к единице без объяснения.
    supabase
      .from("ingredient_components")
      .select("seq, ingredient_id, name_en_fallback, gram_weight, share, ingredients!ingredient_components_ingredient_id_fkey(name_ru)")
      .eq("dish_id", id)
      .order("seq"),
    supabase
      .from("ingredient_aliases")
      .select("id, alias, lang, source, created_at")
      .eq("ingredient_id", id)
      .order("alias"),
    supabase
      .from("meal_items")
      .select("id", { count: "exact", head: true })
      .eq("ingredient_id", id),
    supabase
      .from("recognition_items")
      .select("match_status")
      .eq("ingredient_id", id),
    supabase
      .from("recognition_dish_candidates")
      .select("id", { count: "exact", head: true })
      .eq("ingredient_id", id),
    supabase
      .from("meals")
      .select("id", { count: "exact", head: true })
      .eq("selected_dish_id", id),
  ]);

  type NutrientJoin = {
    amount_per_100g: number;
    nutrients: {
      code: string;
      name_ru: string;
      unit: string;
      group_code: string;
      rdi_default: number | null;
      sort_order: number;
    } | null;
  };

  const nutrientRows = ((nutrients.data ?? []) as unknown as NutrientJoin[])
    .filter((row) => row.nutrients !== null)
    .sort((a, b) => (a.nutrients!.sort_order ?? 0) - (b.nutrients!.sort_order ?? 0))
    .map((row) => ({
      code: row.nutrients!.code,
      name_ru: row.nutrients!.name_ru,
      unit: row.nutrients!.unit,
      group_code: row.nutrients!.group_code,
      rdi_default: row.nutrients!.rdi_default,
      amount_per_100g: Number(row.amount_per_100g),
    }));

  type ComponentJoin = {
    seq: number;
    ingredient_id: number | null;
    name_en_fallback: string | null;
    gram_weight: number;
    share: number;
    ingredients: { name_ru: string } | null;
  };

  const componentRows = ((components.data ?? []) as unknown as ComponentJoin[]).map(
    (row) => ({
      seq: row.seq,
      ingredient_id: row.ingredient_id,
      name: row.ingredients?.name_ru ?? row.name_en_fallback ?? "без названия",
      gram_weight: Number(row.gram_weight),
      share: Number(row.share),
    }),
  );

  const matchStatuses = new Map<string, number>();
  for (const row of (recognitionItems.data ?? []) as { match_status: string }[]) {
    matchStatuses.set(row.match_status, (matchStatuses.get(row.match_status) ?? 0) + 1);
  }

  return {
    ...(item as Omit<
      CatalogItem,
      "nutrients" | "portions" | "components" | "aliases" | "usage"
    >),
    popularity_views: Number(item.popularity_views ?? 0),
    source_recipes: Number(item.source_recipes ?? 0),
    nutrients: nutrientRows,
    portions: ((portions.data ?? []) as CatalogPortion[]).map((p) => ({
      ...p,
      gram_weight: Number(p.gram_weight),
    })),
    components: componentRows,
    aliases: (aliases.data ?? []) as CatalogAlias[],
    usage: {
      mealItems: mealItems.count ?? 0,
      recognitionItems: (recognitionItems.data ?? []).length,
      byMatchStatus: [...matchStatuses.entries()]
        .map(([status, n]) => ({ status, n }))
        .sort((a, b) => b.n - a.n),
      dishCandidates: dishCandidates.count ?? 0,
      selectedAsDish: selectedAsDish.count ?? 0,
    },
  };
}

// ── Подписи ─────────────────────────────────────────────────────────────────

export const KIND_RU: Record<string, string> = {
  ingredient: "сырьё",
  dish: "блюдо",
};

export const SOURCE_RU: Record<string, string> = {
  usda_sr: "USDA SR Legacy",
  usda_foundation: "USDA Foundation",
  usda_fndds: "USDA FNDDS",
  povarenok: "Поварёнок",
  manual: "вручную",
};

export const STATE_RU: Record<string, string> = {
  raw: "сырое",
  cooked: "готовое",
  unknown: "не определено",
};

/** Уровни из миграции 0010 — от них зависит, проверяема ли H8. */
export const PORTION_LEVEL_RU: Record<number, string> = {
  1: "квантили своей группы рецептов",
  2: "медиана своя, S и L — от категории",
  3: "целиком от категории",
};

export const NUTRIENT_GROUP_RU: Record<string, string> = {
  macro: "Макронутриенты",
  vitamin: "Витамины",
  mineral: "Минералы",
};
