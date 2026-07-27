import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getProfile } from "@/lib/data/meals";
import {
  formatPercent,
  sliceMape,
  summariseAgreement,
  summariseModels,
  type AgreementRow,
  type ModelVsUserRow,
} from "@/lib/data/lab";
import { formatNumber } from "@/lib/format";

/**
 * «Лаборатория» — экран владельца (§11.9).
 *
 * Внутренний не значит неряшливый: этим экраном пользуются чаще всех
 * остальных, и читаемость таблиц здесь напрямую влияет на скорость выводов.
 * Та же дизайн-система, те же токены; отличия только функциональные —
 * горизонтальный скролл с закреплённой первой колонкой и табличные цифры.
 */
export const dynamic = "force-dynamic";

export default async function LabPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const profile = await getProfile(supabase, user.id);
  if (!profile?.is_admin) {
    return (
      <div className="px-4 pt-4">
        <div className="rounded-2xl bg-card p-6 text-center">
          <p className="font-medium">Экран доступен только владельцу</p>
        </div>
      </div>
    );
  }

  const [{ data: comparisons }, { data: agreement }, { data: failed }] =
    await Promise.all([
      supabase.from("v_model_vs_user").select("*"),
      supabase.from("v_ingredient_agreement").select("*"),
      supabase
        .from("recognitions")
        .select("id, model_label, cost_rub_actual", { count: "exact" })
        .eq("status", "failed"),
    ]);

  const rows = (comparisons ?? []) as ModelVsUserRow[];
  const models = summariseModels(rows);
  const agreementSummary = summariseAgreement((agreement ?? []) as AgreementRow[]);

  const byReference = sliceMape(rows, (r) =>
    r.had_reference === null
      ? null
      : r.had_reference
        ? "эталон был в кадре"
        : "эталона не было",
  );
  const byScaleMode = sliceMape(rows, (r) => r.scale_mode);
  const byPromptVersion = sliceMape(rows, (r) => r.prompt_version);

  const totalRub =
    rows.reduce((sum, r) => sum + (r.cost_rub_actual ?? 0), 0) +
    (failed ?? []).reduce((sum, r) => sum + Number(r.cost_rub_actual ?? 0), 0);

  return (
    <div className="px-4 pt-4">
      <h1 className="mb-1 text-title font-semibold">Лаборатория</h1>
      <p className="mb-6 text-caption text-ink-secondary">
        {rows.length} успешных распознаваний, {(failed ?? []).length} неудачных,{" "}
        {agreementSummary.meals} приёмов пищи с составом.
      </p>

      {/* FR-LAB-1 */}
      <h2 className="mb-2 text-caption text-ink-secondary uppercase">
        Модели за всё время
      </h2>
      <div className="overflow-x-auto rounded-2xl bg-card">
        <table className="w-full min-w-max text-caption">
          <thead>
            <tr className="border-b border-separator text-ink-secondary">
              <th className="sticky left-0 bg-card px-3 py-2 text-left font-normal">
                Модель
              </th>
              <th className="px-3 py-2 text-right font-normal">Прогонов</th>
              <th className="px-3 py-2 text-right font-normal">Латентность</th>
              <th className="px-3 py-2 text-right font-normal">Факт, ₽</th>
              <th className="px-3 py-2 text-right font-normal">Напрямую, $</th>
              <th className="px-3 py-2 text-right font-normal">MAPE веса</th>
              <th className="px-3 py-2 text-right font-normal">MAPE ккал</th>
              <th className="px-3 py-2 text-right font-normal">Цепочка не сходится</th>
              <th className="px-3 py-2 text-right font-normal">Ошибка эталона</th>
            </tr>
          </thead>
          <tbody>
            {models.length === 0 && (
              <tr>
                <td className="px-3 py-3 text-ink-secondary" colSpan={9}>
                  Данных пока нет.
                </td>
              </tr>
            )}
            {models.map((m) => (
              <tr key={m.key} className="border-b border-separator last:border-0">
                <th className="sticky left-0 bg-card px-3 py-2 text-left font-normal">
                  {m.model_label}
                  <span className="block text-micro text-ink-secondary">
                    {m.prompt_version}
                  </span>
                </th>
                <td className="tnum px-3 py-2 text-right">{m.runs}</td>
                <td className="tnum px-3 py-2 text-right">
                  {m.avgLatencyMs ? `${(m.avgLatencyMs / 1000).toFixed(1)} с` : "—"}
                </td>
                <td className="tnum px-3 py-2 text-right">
                  {m.avgCostRub !== null ? m.avgCostRub.toFixed(2) : "—"}
                </td>
                <td className="tnum px-3 py-2 text-right">
                  {m.avgCostUsd !== null ? m.avgCostUsd.toFixed(4) : "—"}
                </td>
                <td className="tnum px-3 py-2 text-right">
                  {formatPercent(m.medianWeightApe)}
                </td>
                <td className="tnum px-3 py-2 text-right">
                  {formatPercent(m.medianKcalApe)}
                </td>
                <td className="tnum px-3 py-2 text-right">
                  {formatPercent(m.inconsistentShare)}
                </td>
                <td className="tnum px-3 py-2 text-right">
                  {formatPercent(m.avgScaleSizeError)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-1 text-micro text-ink-secondary">
        Валюты не смешиваем: рубли — сколько реально потратили, доллары —
        сколько стоило бы напрямую у вендора. Прочерк в долларах значит, что
        цена вендора ещё не сверена в config/models.ts.
      </p>

      {/* FR-LAB-2 */}
      <h2 className="mt-6 mb-2 text-caption text-ink-secondary uppercase">
        H4 — помогает ли эталон в кадре
      </h2>
      <SliceList slices={byReference} />
      <h3 className="mt-3 mb-2 text-caption text-ink-secondary">
        В разрезе того, на чём модель построила оценку
      </h3>
      <SliceList slices={byScaleMode} />

      <h2 className="mt-6 mb-2 text-caption text-ink-secondary uppercase">
        H6 — помогает ли масштабная цепочка
      </h2>
      <SliceList slices={byPromptVersion} />

      {/* FR-LAB-3 */}
      <h2 className="mt-6 mb-2 text-caption text-ink-secondary uppercase">
        H1–H2 — качество состава
      </h2>
      <dl className="rounded-2xl bg-card p-4 text-caption">
        <Row
          label="Оставлено без изменений"
          value={formatPercent(agreementSummary.keptShare)}
        />
        <Row
          label="Приёмов пищи с правками"
          value={formatPercent(agreementSummary.editedMealShare)}
        />
        <Row label="Precision состава" value={formatPercent(agreementSummary.precision)} />
        <Row label="Recall состава" value={formatPercent(agreementSummary.recall)} />
        <Row
          label="Позиции: без правок / изменены / добавлены / удалены"
          value={`${agreementSummary.kept} / ${agreementSummary.edited} / ${agreementSummary.added} / ${agreementSummary.removed}`}
        />
      </dl>

      {/* FR-LAB-5 */}
      <h2 className="mt-6 mb-2 text-caption text-ink-secondary uppercase">Расходы</h2>
      <div className="rounded-2xl bg-card p-4">
        <p className="tnum text-title font-semibold">
          {formatNumber(totalRub, 2)}
          <span className="ml-1 text-caption font-normal text-ink-secondary">₽</span>
        </p>
        <p className="text-caption text-ink-secondary">
          Суммарно за всё время, включая неудачные попытки.
        </p>
      </div>

      {/* FR-LAB-4 */}
      <h2 className="mt-6 mb-2 text-caption text-ink-secondary uppercase">Выгрузка</h2>
      <div className="mb-6 flex gap-2">
        <a
          href="/api/lab/export?format=json"
          className="tap-target inline-flex items-center rounded-xl bg-card px-4 py-2 text-accent"
        >
          Скачать JSON
        </a>
        <a
          href="/api/lab/export?format=csv"
          className="tap-target inline-flex items-center rounded-xl bg-card px-4 py-2 text-accent"
        >
          Скачать CSV
        </a>
      </div>
    </div>
  );
}

function SliceList({ slices }: { slices: { label: string; n: number; mape: number | null }[] }) {
  if (slices.length === 0) {
    return (
      <p className="rounded-2xl bg-card p-4 text-caption text-ink-secondary">
        Данных пока недостаточно.
      </p>
    );
  }
  return (
    <ul className="overflow-hidden rounded-2xl bg-card">
      {slices.map((slice) => (
        <li
          key={slice.label}
          className="flex items-baseline justify-between border-b border-separator px-3 py-2 text-caption last:border-0"
        >
          <span>
            {slice.label}
            <span className="ml-1 text-micro text-ink-secondary">n={slice.n}</span>
          </span>
          <span className="tnum">MAPE веса {formatPercent(slice.mape, 1)}</span>
        </li>
      ))}
    </ul>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between border-b border-separator py-1 last:border-0">
      <dt className="text-ink-secondary">{label}</dt>
      <dd className="tnum">{value}</dd>
    </div>
  );
}
