import Link from "next/link";
import {
  KIND_RU,
  SOURCE_RU,
  type CatalogFilters as Filters,
  type Facets,
} from "@/lib/data/lab-catalog";

/**
 * Фильтры справочника (FR-LABX-2).
 *
 * Обычная GET-форма, а не клиентский компонент с состоянием. Причина простая:
 * фильтры и так живут в адресной строке — это и есть их состояние, — а форма
 * без JavaScript даёт то же самое даром, плюс ссылку на выборку можно переслать
 * или положить в закладки. Сброс страницы при смене фильтра выходит сам собой:
 * поля `page` в форме нет.
 */
export default function CatalogFilters({
  filters,
  facets,
}: {
  filters: Filters;
  facets: Facets;
}) {
  return (
    <form
      method="get"
      action="/lab/catalog"
      className="mb-4 rounded-2xl bg-card p-3 text-caption"
    >
      <div className="flex flex-wrap items-end gap-2">
        <Field label="Поиск" className="min-w-56 grow">
          <input
            type="search"
            name="q"
            defaultValue={filters.q ?? ""}
            placeholder="название или fdc_id"
            className="tap-target w-full rounded-xl bg-screen px-3 py-2 text-body"
          />
        </Field>

        <Field label="Вид">
          <Select name="kind" value={filters.kind}>
            <option value="">все</option>
            {facets.kind.map((f) => (
              <option key={f.value} value={f.value}>
                {KIND_RU[f.value] ?? f.value} ({f.n})
              </option>
            ))}
          </Select>
        </Field>

        <Field label="Источник">
          <Select name="source" value={filters.source}>
            <option value="">все</option>
            {facets.source.map((f) => (
              <option key={f.value} value={f.value}>
                {SOURCE_RU[f.value] ?? f.value} ({f.n})
              </option>
            ))}
          </Select>
        </Field>

        <Field label="Категория">
          <Select name="category" value={filters.category}>
            <option value="">все</option>
            {facets.category.map((f) => (
              <option key={f.value} value={f.value}>
                {f.value} ({f.n})
              </option>
            ))}
          </Select>
        </Field>

        <Field label="Сортировка">
          <Select name="sort" value={filters.sort}>
            <option value="popularity">по популярности</option>
            <option value="name">по названию</option>
            <option value="id">по id</option>
          </Select>
        </Field>
      </div>

      <div className="mt-2 flex flex-wrap items-end gap-2">
        <Field label="Активность">
          <TriState name="active" value={filters.active} yes="активные" no="выключенные" />
        </Field>
        <Field label="Служебные">
          <TriState name="service" value={filters.service} yes="только они" no="без них" />
        </Field>
        <Field label="Порции">
          <TriState name="portions" value={filters.hasPortions} yes="есть" no="нет" />
        </Field>
        <Field label="Раскладка">
          <TriState name="components" value={filters.hasComponents} yes="есть" no="нет" />
        </Field>
        <Field label="Нутриенты">
          <TriState name="nutrients" value={filters.hasNutrients} yes="есть" no="нет" />
        </Field>

        <div className="ml-auto flex gap-2">
          <Link
            href="/lab/catalog"
            className="tap-target inline-flex items-center rounded-xl bg-screen px-4 py-2 text-ink-secondary"
          >
            Сбросить
          </Link>
          <button
            type="submit"
            className="tap-target inline-flex items-center rounded-xl bg-accent px-4 py-2 text-white"
          >
            Применить
          </button>
        </div>
      </div>
    </form>
  );
}

function Field({
  label,
  className = "",
  children,
}: {
  label: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <label className={`block ${className}`}>
      <span className="mb-1 block text-micro text-ink-secondary uppercase">{label}</span>
      {children}
    </label>
  );
}

function Select({
  name,
  value,
  children,
}: {
  name: string;
  value: string | null;
  children: React.ReactNode;
}) {
  return (
    <select
      name={name}
      defaultValue={value ?? ""}
      className="tap-target max-w-56 rounded-xl bg-screen px-3 py-2 text-body"
    >
      {children}
    </select>
  );
}

/**
 * Три состояния, а не галочка: «неважно», «да» и «нет» — разные вопросы.
 * Галочка умеет только первые два, и «покажи позиции БЕЗ нутриентов» —
 * а это как раз запрос, ради которого на справочник и смотрят — ей не задать.
 */
function TriState({
  name,
  value,
  yes,
  no,
}: {
  name: string;
  value: boolean | null;
  yes: string;
  no: string;
}) {
  return (
    <select
      name={name}
      defaultValue={value === null ? "" : value ? "1" : "0"}
      className="tap-target rounded-xl bg-screen px-3 py-2 text-body"
    >
      <option value="">неважно</option>
      <option value="1">{yes}</option>
      <option value="0">{no}</option>
    </select>
  );
}
