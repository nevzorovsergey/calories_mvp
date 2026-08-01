import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import {
  FEED_PAGE_SIZE,
  feedFiltersToQuery,
  loadMealFeed,
  parseFeedFilters,
} from "@/lib/data/lab-review";
import { formatPercent } from "@/lib/data/lab";
import { formatNumber, formatTime } from "@/lib/format";
import { weightMethodLabel } from "@/lib/weight-evidence";
import MealThumb from "@/components/MealThumb";
import VerdictBadge from "@/components/lab/VerdictBadge";
import ConfidenceStars from "@/components/lab/ConfidenceStars";
import FeedFilters from "@/components/lab/FeedFilters";
import Pager from "@/components/lab/Pager";

/**
 * Лента приёмов пищи (FR-LABX-6).
 *
 * Строка ленты держит рядом четыре вещи, которые в базе лежат в четырёх
 * таблицах: фотографию, вердикт, отклонение модели и то, что человек сам
 * сказал о весе. Смысл именно в соседстве — «ошибка 40%» и «человек прикинул на
 * глаз, уверенность 2 из 5» вместе означают совсем не то, что «ошибка 40%» и
 * «взвесил на весах, уверенность 5».
 */
export const dynamic = "force-dynamic";

export default async function LabMealsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const raw = await searchParams;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === "string") params.set(key, value);
    else if (Array.isArray(value) && value[0]) params.set(key, value[0]);
  }

  const filters = parseFeedFilters(params);
  const supabase = await createClient();
  const [{ data: users }, feed] = await Promise.all([
    supabase.from("profiles").select("id, display_name").order("display_name"),
    loadMealFeed(supabase, filters),
  ]);

  const postFiltered =
    filters.verdict === "kept" ||
    filters.verdict === "edited" ||
    filters.verdict === "dish";

  return (
    <div className="max-w-6xl">
      <h1 className="mb-1 text-title font-semibold">Приёмы пищи</h1>
      <p className="mb-4 text-caption text-ink-secondary">
        Что загрузили, что ответила модель и что человек с этим сделал.
      </p>

      <FeedFilters
        filters={filters}
        users={(users ?? []) as { id: string; display_name: string }[]}
      />

      {feed.rows.length === 0 ? (
        <p className="rounded-2xl bg-card p-6 text-center text-caption text-ink-secondary">
          Под фильтры ничего не подошло.
        </p>
      ) : (
        <ul className="space-y-2">
          {feed.rows.map((row) => (
            <li key={row.id}>
              <Link
                href={`/lab/meals/${row.id}`}
                className="flex items-start gap-3 rounded-2xl bg-card p-3"
              >
                <MealThumb src={row.thumbUrl} alt="" size={72} />

                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-baseline gap-2">
                    <span className="truncate font-medium">
                      {row.dish_name_ru ?? "Без названия"}
                    </span>
                    <VerdictBadge verdict={row.verdict} />
                  </div>

                  <p className="mt-0.5 text-caption text-ink-secondary">
                    {row.display_name} · {row.meal_date}, {formatTime(row.eaten_at)}
                    {row.modelLabel && ` · ${row.modelLabel}`}
                  </p>

                  {row.user_hint && (
                    <p className="mt-0.5 truncate text-caption text-ink-secondary">
                      Подсказка: «{row.user_hint}»
                    </p>
                  )}

                  <p className="mt-1 text-caption">
                    <span className="tnum">
                      {row.userWeightG === null
                        ? "вес не посчитан"
                        : `${formatNumber(row.userWeightG, 0)} г`}
                      {row.userKcal !== null &&
                        ` · ${formatNumber(row.userKcal, 0)} ккал`}
                    </span>
                    {row.modelWeightG !== null && (
                      <span className="ml-2 text-ink-secondary">
                        модель {formatNumber(row.modelWeightG, 0)} г
                      </span>
                    )}
                  </p>

                  {(row.edits.edited > 0 ||
                    row.edits.added > 0 ||
                    row.edits.removed > 0) && (
                    <p className="mt-0.5 text-micro text-ink-secondary">
                      без правок {row.edits.kept} · изменено {row.edits.edited} ·
                      добавлено {row.edits.added} · удалено {row.edits.removed}
                    </p>
                  )}
                </div>

                <div className="shrink-0 text-right text-caption">
                  <p className="tnum">
                    <span className="text-ink-secondary">вес </span>
                    <Deviation value={row.weightApe} />
                  </p>
                  <p className="tnum">
                    <span className="text-ink-secondary">ккал </span>
                    <Deviation value={row.kcalApe} />
                  </p>
                  <p className="mt-1">
                    <ConfidenceStars value={row.selfConfidence} asked={row.hasEvidence} />
                  </p>
                  {row.hasEvidence && (
                    <p className="text-micro text-ink-secondary">
                      {weightMethodLabel(row.weightMethod)}
                    </p>
                  )}
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}

      <Pager
        basePath="/lab/meals"
        query={new URLSearchParams(feedFiltersToQuery({ ...filters, page: 1 }))}
        page={filters.page}
        pageSize={FEED_PAGE_SIZE}
        total={feed.total}
        totalIsLowerBound={postFiltered}
      />
    </div>
  );
}

/**
 * Отклонение модели от того, что в итоге записал человек. Цветом отмечается
 * только крупный промах — красить всё подряд значит не сказать ничего; порог
 * в 25% взят как граница, за которой ошибка меняет решение о еде, а не число
 * в отчёте.
 */
function Deviation({ value }: { value: number | null }) {
  if (value === null) return <span className="text-ink-secondary">—</span>;
  return (
    <span className={value > 0.25 ? "text-error" : ""}>{formatPercent(value)}</span>
  );
}
