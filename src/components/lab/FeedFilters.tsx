import Link from "next/link";
import { VERDICT_RU, type FeedFilters as Filters, type Verdict } from "@/lib/data/lab-review";

/**
 * Фильтры ленты приёмов пищи (FR-LABX-6).
 *
 * Как и в справочнике — обычная GET-форма: состояние живёт в адресной строке,
 * ссылкой на выборку можно поделиться, страница сбрасывается сама.
 */
export default function FeedFilters({
  filters,
  users,
}: {
  filters: Filters;
  users: { id: string; display_name: string }[];
}) {
  return (
    <form
      method="get"
      action="/lab/meals"
      className="mb-4 flex flex-wrap items-end gap-2 rounded-2xl bg-card p-3 text-caption"
    >
      <Field label="Пользователь">
        <select
          name="user"
          defaultValue={filters.userId ?? ""}
          className="tap-target max-w-56 rounded-xl bg-screen px-3 py-2 text-body"
        >
          <option value="">все</option>
          {users.map((user) => (
            <option key={user.id} value={user.id}>
              {user.display_name}
            </option>
          ))}
        </select>
      </Field>

      <Field label="Вердикт">
        <select
          name="verdict"
          defaultValue={filters.verdict ?? ""}
          className="tap-target rounded-xl bg-screen px-3 py-2 text-body"
        >
          <option value="">любой</option>
          {(Object.keys(VERDICT_RU) as Verdict[]).map((verdict) => (
            <option key={verdict} value={verdict}>
              {VERDICT_RU[verdict]}
            </option>
          ))}
        </select>
      </Field>

      <Field label="С даты">
        <input
          type="date"
          name="from"
          defaultValue={filters.from ?? ""}
          className="tap-target rounded-xl bg-screen px-3 py-2 text-body"
        />
      </Field>

      <Field label="По дату">
        <input
          type="date"
          name="to"
          defaultValue={filters.to ?? ""}
          className="tap-target rounded-xl bg-screen px-3 py-2 text-body"
        />
      </Field>

      <div className="ml-auto flex gap-2">
        <Link
          href="/lab/meals"
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
    </form>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-micro text-ink-secondary uppercase">{label}</span>
      {children}
    </label>
  );
}
