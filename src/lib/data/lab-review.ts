import type { SupabaseClient } from "@supabase/supabase-js";
import { signThumbs } from "@/lib/data/meals";
import { median } from "@/lib/data/lab";

/**
 * Разбор приёмов пищи по пользователям (FR-LABX-5 — FR-LABX-7).
 *
 * Никакой новой разметки здесь не появляется. Всё, что показывается как
 * «оценка», человек уже проставил своими действиями: правкой состава, выбором
 * блюда из трёх кандидатов и ответами модалки «Откуда вес?». Задача модуля —
 * собрать эти следы в одно место и не соврать при этом, чего человек НЕ делал:
 * приём пищи без правок и приём пищи, добавленный из справочника, — разные
 * вещи, хотя в обоих `origin` однороден.
 */

export const FEED_PAGE_SIZE = 40;

export type Verdict =
  /** Состав целиком как предложила модель, человек ничего не тронул. */
  | "kept"
  /** Человек выбрал блюдо из трёх вариантов, состав приехал из справочника. */
  | "dish"
  /** Человек правил вес, удалял или добавлял позиции. */
  | "edited"
  /** Добавлено из справочника: распознавания не было и быть не могло. */
  | "manual"
  /** Распознавание по названию закончилось, блюдо ещё не выбрано. */
  | "awaiting"
  | "processing"
  | "failed";

export const VERDICT_RU: Record<Verdict, string> = {
  kept: "принято как есть",
  dish: "блюдо выбрано",
  edited: "поправлено",
  manual: "из справочника",
  awaiting: "ждёт выбора",
  processing: "распознаётся",
  failed: "не распозналось",
};

export interface Edits {
  kept: number;
  edited: number;
  added: number;
  removed: number;
  /** Позиции раскладки блюда из справочника — `origin = 'catalog_dish'`. */
  catalog: number;
}

export const NO_EDITS: Edits = { kept: 0, edited: 0, added: 0, removed: 0, catalog: 0 };

/**
 * Вердикт выводится из статуса и следов правок — и порядок проверок здесь
 * содержательный.
 *
 * Статус идёт первым: у приёма пищи из справочника все позиции помечены
 * `user_added`, и «поправлено» про него было бы неправдой — правили не модель,
 * модели не было вовсе.
 *
 * `catalog_dish` проверяется последним из содержательных: выбрав блюдо, человек
 * мог потом ещё и поправить состав, и тогда строки перезаписываются на
 * `user_added` (см. api/meals/[id]/items). Правка — более сильное утверждение о
 * том, что модель ошиблась, чем сам факт выбора, поэтому она и побеждает.
 */
export function verdictOf(status: string, edits: Edits): Verdict {
  if (status === "manual") return "manual";
  if (status === "awaiting_choice") return "awaiting";
  if (status === "processing") return "processing";
  if (status === "failed") return "failed";
  if (edits.edited > 0 || edits.added > 0 || edits.removed > 0) return "edited";
  if (edits.catalog > 0) return "dish";
  return "kept";
}

/**
 * Раскладка позиций по происхождению, по одному счётчику на приём пищи.
 *
 * Значения `origin` перечислены явно, без ветки «иначе»: появится пятое — оно
 * не растворится в одной из существующих корзин, а просто не попадёт ни в
 * какую, и вердикт станет «принято как есть» — то есть заметно неправильным.
 * Молча слипшийся счётчик заметить было бы куда труднее.
 */
export function tallyEdits(
  items: { meal_id: string; origin: string }[],
  removed: { meal_id: string }[],
): Map<string, Edits> {
  const byMeal = new Map<string, Edits>();
  const bump = (mealId: string, key: keyof Edits) => {
    const current = byMeal.get(mealId) ?? { ...NO_EDITS };
    current[key] += 1;
    byMeal.set(mealId, current);
  };

  for (const item of items) {
    if (item.origin === "model_kept") bump(item.meal_id, "kept");
    else if (item.origin === "model_edited") bump(item.meal_id, "edited");
    else if (item.origin === "user_added") bump(item.meal_id, "added");
    else if (item.origin === "catalog_dish") bump(item.meal_id, "catalog");
  }
  for (const row of removed) bump(row.meal_id, "removed");

  return byMeal;
}

/** Относительное отклонение модели от пользовательской версии, доля. */
function ape(model: number | null, user: number | null): number | null {
  if (model === null || user === null || !(user > 0)) return null;
  return Math.abs(model - user) / user;
}

// ── Пользователи (FR-LABX-5) ────────────────────────────────────────────────

export interface UserStats {
  id: string;
  display_name: string;
  is_admin: boolean;
  timezone: string;
  created_at: string;
  meals: number;
  withPhoto: number;
  recognitions: number;
  failedRecognitions: number;
  /** Доля приёмов пищи, где состав остался как предложила модель (H1, H2). */
  keptShare: number | null;
  /** Медиана отклонения веса модели от пользовательской версии. */
  medianWeightApe: number | null;
  /** Сколько раз человек заполнил модалку «Откуда вес?». */
  evidence: number;
  /** Сколько раз при этом нажал «Не знаю» — метод остался пустым (FR-WE-4). */
  evidenceUnknown: number;
  /** Приёмов пищи, где человек выбирал блюдо из трёх вариантов модели. */
  dishChoices: number;
  /**
   * Доля выборов, пришедшихся на первый вариант — прямая мера того, угадала ли
   * модель с первого раза (H7). Считается только по тем случаям, где выбор
   * вообще был сделан из предложенного.
   */
  topCandidateShare: number | null;
  lastActivity: string | null;
}

export async function loadUserStats(supabase: SupabaseClient): Promise<UserStats[]> {
  const [{ data: profiles }, { data: meals }, { data: items }, { data: removed }, { data: model }, { data: evidence }, { data: failed }] =
    await Promise.all([
      supabase
        .from("profiles")
        .select("id, display_name, is_admin, timezone, created_at")
        .order("created_at"),
      supabase
        .from("meals")
        .select(
          "id, user_id, status, photo_sent_path, eaten_at, selected_dish_id, selected_candidate_position",
        ),
      supabase.from("meal_items").select("meal_id, origin"),
      supabase.from("meal_removed_items").select("meal_id"),
      supabase.from("v_model_vs_user").select("user_id, weight_ape, is_primary"),
      supabase.from("weight_evidence").select("meal_id, method"),
      supabase.from("recognitions").select("meal_id, status"),
    ]);

  const mealRows = (meals ?? []) as {
    id: string;
    user_id: string;
    status: string;
    photo_sent_path: string | null;
    eaten_at: string;
    selected_dish_id: number | null;
    selected_candidate_position: number | null;
  }[];
  const mealOwner = new Map(mealRows.map((m) => [m.id, m.user_id]));

  const editsByMeal = tallyEdits(
    (items ?? []) as { meal_id: string; origin: string }[],
    (removed ?? []) as { meal_id: string }[],
  );

  const apesByUser = new Map<string, number[]>();
  for (const row of (model ?? []) as {
    user_id: string;
    weight_ape: number | null;
    is_primary: boolean;
  }[]) {
    // Только основное распознавание: перепрогоны других моделей — это про
    // сравнение моделей, а не про то, насколько ошиблись перед человеком.
    if (!row.is_primary || row.weight_ape === null) continue;
    apesByUser.set(row.user_id, [...(apesByUser.get(row.user_id) ?? []), Number(row.weight_ape)]);
  }

  const evidenceByUser = new Map<string, { total: number; unknown: number }>();
  for (const row of (evidence ?? []) as { meal_id: string; method: string | null }[]) {
    const userId = mealOwner.get(row.meal_id);
    if (!userId) continue;
    const current = evidenceByUser.get(userId) ?? { total: 0, unknown: 0 };
    current.total += 1;
    if (row.method === null) current.unknown += 1;
    evidenceByUser.set(userId, current);
  }

  const recognitionsByUser = new Map<string, { total: number; failed: number }>();
  for (const row of (failed ?? []) as { meal_id: string; status: string }[]) {
    const userId = mealOwner.get(row.meal_id);
    if (!userId) continue;
    const current = recognitionsByUser.get(userId) ?? { total: 0, failed: 0 };
    current.total += 1;
    if (row.status === "failed") current.failed += 1;
    recognitionsByUser.set(userId, current);
  }

  type ProfileRow = Pick<
    UserStats,
    "id" | "display_name" | "is_admin" | "timezone" | "created_at"
  >;

  return ((profiles ?? []) as ProfileRow[]).map((profile) => {
    const own = mealRows.filter((m) => m.user_id === profile.id);
    // Доля считается по приёмам пищи, у которых вообще было что принимать:
    // добавленные из справочника, выбор блюда и незавершённые в знаменатель не
    // идут. Иначе метрика поехала бы вслед за тем, как часто человек добавляет
    // руками, а про качество состава не сказала бы ничего.
    const judged = own
      .map((m) => verdictOf(m.status, editsByMeal.get(m.id) ?? NO_EDITS))
      .filter((v) => v === "kept" || v === "edited");
    const recognitions = recognitionsByUser.get(profile.id) ?? { total: 0, failed: 0 };
    const ev = evidenceByUser.get(profile.id) ?? { total: 0, unknown: 0 };
    // Выбором считается только тот случай, где человек взял один из вариантов
    // модели. Отверг все три и ввёл своё — позиция пуста (api/meals/[id]/dish),
    // и в знаменатель H7 это не идёт: угадала модель или нет, отсюда не видно.
    const chosen = own.filter((m) => m.selected_candidate_position !== null);

    return {
      ...profile,
      meals: own.length,
      withPhoto: own.filter((m) => m.photo_sent_path).length,
      recognitions: recognitions.total,
      failedRecognitions: recognitions.failed,
      keptShare:
        judged.length > 0
          ? judged.filter((v) => v === "kept").length / judged.length
          : null,
      medianWeightApe: median(apesByUser.get(profile.id) ?? []),
      evidence: ev.total,
      evidenceUnknown: ev.unknown,
      dishChoices: chosen.length,
      topCandidateShare:
        chosen.length > 0
          ? chosen.filter((m) => m.selected_candidate_position === 1).length /
            chosen.length
          : null,
      lastActivity:
        own.length > 0
          ? own.reduce((latest, m) => (m.eaten_at > latest ? m.eaten_at : latest), own[0].eaten_at)
          : null,
    };
  });
}

// ── Лента приёмов пищи (FR-LABX-6) ──────────────────────────────────────────

export interface FeedFilters {
  userId: string | null;
  verdict: Verdict | null;
  from: string | null;
  to: string | null;
  page: number;
}

export function parseFeedFilters(params: URLSearchParams): FeedFilters {
  const verdict = params.get("verdict");
  const page = Number(params.get("page") ?? "1");
  return {
    userId: params.get("user") || null,
    verdict: verdict && verdict in VERDICT_RU ? (verdict as Verdict) : null,
    from: params.get("from") || null,
    to: params.get("to") || null,
    page: Number.isFinite(page) && page >= 1 ? Math.floor(page) : 1,
  };
}

export function feedFiltersToQuery(filters: FeedFilters): string {
  const params = new URLSearchParams();
  if (filters.userId) params.set("user", filters.userId);
  if (filters.verdict) params.set("verdict", filters.verdict);
  if (filters.from) params.set("from", filters.from);
  if (filters.to) params.set("to", filters.to);
  if (filters.page > 1) params.set("page", String(filters.page));
  return params.toString();
}

export interface FeedRow {
  id: string;
  user_id: string;
  display_name: string;
  meal_date: string;
  eaten_at: string;
  dish_name_ru: string | null;
  user_hint: string | null;
  thumbUrl: string | null;
  verdict: Verdict;
  edits: Edits;
  userWeightG: number | null;
  userKcal: number | null;
  modelLabel: string | null;
  modelWeightG: number | null;
  modelKcal: number | null;
  weightApe: number | null;
  kcalApe: number | null;
  /** Звёздочки 1–5 из модалки «Откуда вес?»; null — не отвечал или «Не знаю». */
  selfConfidence: number | null;
  weightMethod: string | null;
  hasEvidence: boolean;
}

export async function loadMealFeed(
  supabase: SupabaseClient,
  filters: FeedFilters,
): Promise<{ rows: FeedRow[]; total: number }> {
  // Вердикт вычисляется в TypeScript, а не в SQL, поэтому фильтр по нему нельзя
  // отдать базе вместе с limit — постранично отбирался бы неверный срез. По
  // статусам, которые вердикт задают напрямую, отбор всё же делаем в базе:
  // это отсекает основную массу, а «принято/поправлено» доразбирается здесь.
  const statusFilter: string[] | null =
    filters.verdict === "manual"
      ? ["manual"]
      : filters.verdict === "awaiting"
        ? ["awaiting_choice"]
        : filters.verdict === "processing"
          ? ["processing"]
          : filters.verdict === "failed"
            ? ["failed"]
            : filters.verdict === "kept" ||
                filters.verdict === "edited" ||
                filters.verdict === "dish"
              ? ["ready"]
              : null;

  let query = supabase
    .from("meals")
    .select(
      "id, user_id, meal_date, eaten_at, status, dish_name_ru, user_hint, photo_sent_path, primary_recognition_id",
      { count: "exact" },
    )
    .order("eaten_at", { ascending: false });

  if (filters.userId) query = query.eq("user_id", filters.userId);
  if (filters.from) query = query.gte("meal_date", filters.from);
  if (filters.to) query = query.lte("meal_date", filters.to);
  if (statusFilter) query = query.in("status", statusFilter);

  // Разделение «принято / поправлено / блюдо выбрано» видно только после
  // подсчёта правок, поэтому для них берём с запасом и режем страницу уже
  // после разбора.
  const needsPostFilter =
    filters.verdict === "kept" ||
    filters.verdict === "edited" ||
    filters.verdict === "dish";
  const from = needsPostFilter ? 0 : (filters.page - 1) * FEED_PAGE_SIZE;
  const to = needsPostFilter
    ? filters.page * FEED_PAGE_SIZE * 4 - 1
    : filters.page * FEED_PAGE_SIZE - 1;

  const { data: mealRows, count } = await query.range(from, to);
  const meals = (mealRows ?? []) as {
    id: string;
    user_id: string;
    meal_date: string;
    eaten_at: string;
    status: string;
    dish_name_ru: string | null;
    user_hint: string | null;
    photo_sent_path: string | null;
    primary_recognition_id: string | null;
  }[];
  if (meals.length === 0) return { rows: [], total: count ?? 0 };

  const ids = meals.map((m) => m.id);
  const [{ data: profiles }, { data: items }, { data: removed }, { data: totals }, { data: recognitions }, { data: evidence }, thumbs] =
    await Promise.all([
      supabase.from("profiles").select("id, display_name"),
      supabase.from("meal_items").select("meal_id, origin").in("meal_id", ids),
      supabase.from("meal_removed_items").select("meal_id").in("meal_id", ids),
      supabase
        .from("v_meal_user_totals")
        .select("meal_id, user_weight_g, user_kcal")
        .in("meal_id", ids),
      supabase
        .from("recognitions")
        .select("id, meal_id, model_label, total_weight_g, nutrition_catalog")
        .in("meal_id", ids)
        .eq("status", "ok"),
      supabase
        .from("weight_evidence")
        .select("meal_id, method, self_confidence")
        .in("meal_id", ids),
      signThumbs(
        supabase,
        meals.map((m) => m.photo_sent_path),
      ),
    ]);

  const nameById = new Map(
    ((profiles ?? []) as { id: string; display_name: string }[]).map((p) => [
      p.id,
      p.display_name,
    ]),
  );

  const editsByMeal = tallyEdits(
    (items ?? []) as { meal_id: string; origin: string }[],
    (removed ?? []) as { meal_id: string }[],
  );

  const totalsByMeal = new Map(
    ((totals ?? []) as { meal_id: string; user_weight_g: number; user_kcal: number }[]).map(
      (t) => [t.meal_id, t],
    ),
  );
  const recognitionById = new Map(
    ((recognitions ?? []) as {
      id: string;
      meal_id: string;
      model_label: string;
      total_weight_g: number | null;
      nutrition_catalog: Record<string, number> | null;
    }[]).map((r) => [r.id, r]),
  );
  const evidenceByMeal = new Map(
    ((evidence ?? []) as {
      meal_id: string;
      method: string | null;
      self_confidence: number | null;
    }[]).map((e) => [e.meal_id, e]),
  );

  const rows: FeedRow[] = meals.map((meal) => {
    const edits = editsByMeal.get(meal.id) ?? NO_EDITS;
    const total = totalsByMeal.get(meal.id);
    const primary = meal.primary_recognition_id
      ? recognitionById.get(meal.primary_recognition_id)
      : undefined;
    const ev = evidenceByMeal.get(meal.id);
    const userWeight = total ? Number(total.user_weight_g) : null;
    const userKcal = total ? Number(total.user_kcal) : null;
    const modelWeight =
      primary?.total_weight_g === null || primary?.total_weight_g === undefined
        ? null
        : Number(primary.total_weight_g);
    const modelKcal =
      primary?.nutrition_catalog?.energy_kcal === undefined
        ? null
        : Number(primary.nutrition_catalog.energy_kcal);

    return {
      id: meal.id,
      user_id: meal.user_id,
      display_name: nameById.get(meal.user_id) ?? "—",
      meal_date: meal.meal_date,
      eaten_at: meal.eaten_at,
      dish_name_ru: meal.dish_name_ru,
      user_hint: meal.user_hint,
      thumbUrl: meal.photo_sent_path ? (thumbs.get(meal.photo_sent_path) ?? null) : null,
      verdict: verdictOf(meal.status, edits),
      edits,
      userWeightG: userWeight,
      userKcal,
      modelLabel: primary?.model_label ?? null,
      modelWeightG: modelWeight,
      modelKcal,
      weightApe: ape(modelWeight, userWeight),
      kcalApe: ape(modelKcal, userKcal),
      selfConfidence: ev?.self_confidence ?? null,
      weightMethod: ev ? ev.method : null,
      hasEvidence: ev !== undefined,
    };
  });

  if (!needsPostFilter) return { rows, total: count ?? 0 };

  const matching = rows.filter((r) => r.verdict === filters.verdict);
  const start = (filters.page - 1) * FEED_PAGE_SIZE;
  return {
    rows: matching.slice(start, start + FEED_PAGE_SIZE),
    // Честного общего числа здесь нет: вердикт «принято/поправлено» не выражается
    // условием запроса, а перебирать ради счётчика всю таблицу незачем. Отдаём
    // то, что удалось разобрать, — интерфейс покажет его как «не меньше чем».
    total: matching.length,
  };
}
