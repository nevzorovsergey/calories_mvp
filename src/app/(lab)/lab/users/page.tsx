import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { loadUserStats } from "@/lib/data/lab-review";
import { formatPercent } from "@/lib/data/lab";

/**
 * Пользователи (FR-LABX-5).
 *
 * Таблица отвечает на один вопрос: чьи данные можно брать в расчёт. Прототипом
 * пользуются несколько человек, и вклад у них разный — у того, кто загрузил три
 * фотографии и ни разу не заполнил модалку веса, «MAPE 12%» означает совсем не
 * то же самое, что у того, кто загрузил двести. Поэтому рядом с долями всегда
 * стоит их знаменатель.
 */
export const dynamic = "force-dynamic";

export default async function LabUsersPage() {
  const supabase = await createClient();
  const users = await loadUserStats(supabase);

  return (
    <div className="max-w-6xl">
      <h1 className="mb-1 text-title font-semibold">Пользователи</h1>
      <p className="mb-4 text-caption text-ink-secondary">
        Регистрация закрыта, аккаунты заводятся вручную — поэтому список короткий
        и полный. Клик по имени открывает его приёмы пищи.
      </p>

      <div className="overflow-x-auto rounded-2xl bg-card">
        <table className="w-full min-w-max text-caption">
          <thead>
            <tr className="border-b border-separator text-ink-secondary">
              <th className="px-3 py-2 text-left font-normal">Кто</th>
              <th className="px-3 py-2 text-right font-normal">Приёмов пищи</th>
              <th className="px-3 py-2 text-right font-normal">С фото</th>
              <th className="px-3 py-2 text-right font-normal">Распознаваний</th>
              <th className="px-3 py-2 text-right font-normal">Неудачных</th>
              <th
                className="px-3 py-2 text-right font-normal"
                title="Доля приёмов пищи, где состав модели остался нетронутым"
              >
                Принято как есть
              </th>
              <th className="px-3 py-2 text-right font-normal" title="Медиана |модель − человек| / человек">
                Медиана ошибки веса
              </th>
              <th
                className="px-3 py-2 text-right font-normal"
                title="Выбрал первый из трёх вариантов названия"
              >
                Угадано с первого
              </th>
              <th
                className="px-3 py-2 text-right font-normal"
                title="Заполнено модалок «Откуда вес?» (в скобках — сколько раз «Не знаю»)"
              >
                Ответов о весе
              </th>
              <th className="px-3 py-2 text-right font-normal">Последняя запись</th>
            </tr>
          </thead>
          <tbody>
            {users.length === 0 && (
              <tr>
                <td className="px-3 py-4 text-ink-secondary" colSpan={10}>
                  Пользователей нет.
                </td>
              </tr>
            )}
            {users.map((user) => (
              <tr key={user.id} className="border-b border-separator last:border-0">
                <td className="px-3 py-2">
                  <Link href={`/lab/meals?user=${user.id}`} className="text-accent">
                    {user.display_name}
                  </Link>
                  <span className="block text-micro text-ink-secondary">
                    {user.timezone}
                    {user.is_admin && " · админ"}
                  </span>
                </td>
                <td className="tnum px-3 py-2 text-right">{user.meals}</td>
                <td className="tnum px-3 py-2 text-right">{user.withPhoto}</td>
                <td className="tnum px-3 py-2 text-right">{user.recognitions}</td>
                <td
                  className={`tnum px-3 py-2 text-right ${user.failedRecognitions > 0 ? "text-error" : "text-ink-secondary"}`}
                >
                  {user.failedRecognitions || "—"}
                </td>
                <td className="tnum px-3 py-2 text-right">
                  {formatPercent(user.keptShare)}
                </td>
                <td className="tnum px-3 py-2 text-right">
                  {formatPercent(user.medianWeightApe, 1)}
                </td>
                <td className="tnum px-3 py-2 text-right">
                  {formatPercent(user.topCandidateShare)}
                  <span className="ml-1 text-micro text-ink-secondary">
                    n={user.dishChoices}
                  </span>
                </td>
                <td className="tnum px-3 py-2 text-right">
                  {user.evidence}
                  {user.evidenceUnknown > 0 && (
                    <span className="ml-1 text-micro text-ink-secondary">
                      ({user.evidenceUnknown} «не знаю»)
                    </span>
                  )}
                </td>
                <td className="tnum px-3 py-2 text-right text-ink-secondary">
                  {user.lastActivity ? user.lastActivity.slice(0, 10) : "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="mt-2 mb-6 text-micro text-ink-secondary">
        «Принято как есть» считается только по приёмам пищи, где было что
        принимать: добавленные из справочника, выбор блюда и незавершённые в
        знаменатель не идут. «Угадано с первого» — про распознавание по названию:
        сколько раз человек взял первый из трёх предложенных вариантов.
      </p>
    </div>
  );
}
