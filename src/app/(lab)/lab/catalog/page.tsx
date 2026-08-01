import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import {
  KIND_RU,
  PAGE_SIZE,
  SOURCE_RU,
  filtersToQuery,
  loadCatalogFacets,
  loadCatalogPage,
  parseFilters,
} from "@/lib/data/lab-catalog";
import { formatNumber } from "@/lib/format";
import CatalogFilters from "@/components/lab/CatalogFilters";
import Pager from "@/components/lab/Pager";

/**
 * Справочник: список с поиском и фильтрами (FR-LABX-2).
 *
 * Колонки подобраны под один вопрос — «почему модель сматчилась именно сюда».
 * Поэтому рядом с названием стоит не только КБЖУ, но и полнота позиции: есть ли
 * у неё порции, раскладка и нутриенты, и сколько раз она реально всплывала в
 * приёмах пищи. Позиция без нутриентов, попавшая в сотню приёмов пищи, — это
 * дефект справочника, и увидеть его надо списком, а не догадкой.
 */
export const dynamic = "force-dynamic";

export default async function CatalogPage({
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

  const filters = parseFilters(params);
  const supabase = await createClient();
  const [facets, page] = await Promise.all([
    loadCatalogFacets(supabase),
    loadCatalogPage(supabase, filters),
  ]);

  return (
    <div className="max-w-full">
      <h1 className="mb-1 text-title font-semibold">Справочник</h1>
      <p className="mb-4 text-caption text-ink-secondary">
        Сырьё USDA и готовые блюда — FNDDS и Поварёнок. Позиции не удаляются: на
        них ссылается история приёмов пищи, поэтому лишнее выключается флагом.
      </p>

      <CatalogFilters filters={filters} facets={facets} />

      {page.error && (
        <p className="mb-4 rounded-2xl bg-card p-4 text-caption text-error" role="alert">
          Не удалось получить выборку: {page.error}
        </p>
      )}

      <div className="overflow-x-auto rounded-2xl bg-card">
        <table className="w-full min-w-max text-caption">
          <thead>
            <tr className="border-b border-separator text-ink-secondary">
              <th className="px-3 py-2 text-left font-normal">Название</th>
              <th className="px-3 py-2 text-left font-normal">Вид</th>
              <th className="px-3 py-2 text-left font-normal">Источник</th>
              <th className="px-3 py-2 text-left font-normal">Категория</th>
              <th className="px-3 py-2 text-right font-normal">ккал/100 г</th>
              <th className="px-3 py-2 text-right font-normal" title="Порции">
                Порц.
              </th>
              <th className="px-3 py-2 text-right font-normal" title="Компоненты раскладки">
                Сост.
              </th>
              <th className="px-3 py-2 text-right font-normal" title="Нутриенты">
                Нутр.
              </th>
              <th className="px-3 py-2 text-right font-normal" title="Синонимы">
                Син.
              </th>
              <th
                className="px-3 py-2 text-right font-normal"
                title="В скольких позициях приёмов пищи встречается"
              >
                В еде
              </th>
            </tr>
          </thead>
          <tbody>
            {page.rows.length === 0 && !page.error && (
              <tr>
                <td className="px-3 py-4 text-ink-secondary" colSpan={10}>
                  Под фильтры ничего не подошло.
                </td>
              </tr>
            )}
            {page.rows.map((row) => (
              <tr key={row.id} className="border-b border-separator last:border-0">
                <td className="max-w-96 px-3 py-2">
                  <Link
                    href={`/lab/catalog/${row.id}`}
                    className="block truncate text-accent"
                    title={row.name_ru}
                  >
                    {row.name_ru}
                  </Link>
                  <span
                    className="block truncate text-micro text-ink-secondary"
                    title={row.name_en}
                  >
                    #{row.id} · {row.name_en}
                    {!row.is_active && (
                      <span className="ml-1 text-error">· выключена</span>
                    )}
                    {row.is_service && (
                      <span className="ml-1 text-warning">· служебная</span>
                    )}
                  </span>
                </td>
                <td className="px-3 py-2">{KIND_RU[row.kind] ?? row.kind}</td>
                <td className="px-3 py-2">{SOURCE_RU[row.source] ?? row.source}</td>
                <td className="max-w-48 truncate px-3 py-2" title={row.category ?? ""}>
                  {row.category ?? "—"}
                </td>
                <td className="tnum px-3 py-2 text-right">
                  {row.kcal_per_100g === null
                    ? "—"
                    : formatNumber(row.kcal_per_100g, 0)}
                </td>
                <Count value={row.portions_count} />
                <Count value={row.components_count} />
                <Count value={row.nutrients_count} />
                <Count value={row.aliases_count} />
                <Count value={row.used_in_meals} />
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <Pager
        basePath="/lab/catalog"
        query={new URLSearchParams(filtersToQuery({ ...filters, page: 1 }))}
        page={filters.page}
        pageSize={PAGE_SIZE}
        total={page.total}
        totalIsLowerBound={page.totalIsLowerBound}
      />
    </div>
  );
}

/** Ноль приглушён: колонки полноты читают взглядом, и важно в них не наличие, а пробел. */
function Count({ value }: { value: number }) {
  return (
    <td
      className={`tnum px-3 py-2 text-right ${value === 0 ? "text-ink-secondary" : ""}`}
    >
      {value === 0 ? "—" : value}
    </td>
  );
}
