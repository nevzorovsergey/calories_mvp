import { formatNumber } from "@/lib/format";

/**
 * Сравнение моделей (§11.7).
 *
 * Колонки — модели и «Ваша версия», строки — общий вес, калории, БЖУ, число
 * ингредиентов (FR-CMP-1). Ниже — построчное сравнение состава (FR-CMP-2) и
 * отклонения каждой модели от пользовательской версии (FR-CMP-3).
 *
 * На телефоне таблица прокручивается горизонтально с закреплённой первой
 * колонкой (§13.10) — иначе она нечитаема.
 */

export interface ComparisonRecognition {
  id: string;
  model_label: string;
  prompt_version: string;
  total_weight_g: number;
  nutrition: Record<string, number>;
  scale_mode: string | null;
  latency_ms: number | null;
  items: { name_ru: string; weight_g: number; ingredient_id: number | null }[];
}

export interface ComparisonUserItem {
  name_ru: string;
  weight_g: number;
  ingredient_id: number | null;
}

/** Название ингредиента: не шире половины экрана, переносится по словам. */
const INGREDIENT_CELL = "block max-w-[50vw] hyphens-auto break-words";

/** Шапка колонки модели: фиксированная узкая ширина, перенос на 2+ строки. */
const MODEL_HEAD_CELL = "block w-16 text-micro leading-tight break-words";

function keyOf(item: { name_ru: string; ingredient_id: number | null }): string {
  return item.ingredient_id !== null
    ? `id:${item.ingredient_id}`
    : `name:${item.name_ru.toLowerCase().trim()}`;
}

export default function ComparisonTable({
  recognitions,
  userTotals,
  userWeight,
  userItems,
}: {
  recognitions: ComparisonRecognition[];
  userTotals: Record<string, number>;
  userWeight: number;
  userItems: ComparisonUserItem[];
}) {
  const userKeys = new Set(userItems.map(keyOf));
  const userKcal = userTotals.energy_kcal ?? 0;

  const rows: { label: string; get: (r: ComparisonRecognition) => string; user: string }[] =
    [
      {
        label: "Общий вес, г",
        get: (r) => formatNumber(r.total_weight_g, 0),
        user: formatNumber(userWeight, 0),
      },
      {
        label: "Калории, ккал",
        get: (r) => formatNumber(r.nutrition.energy_kcal ?? 0, 0),
        user: formatNumber(userKcal, 0),
      },
      {
        label: "Белки, г",
        get: (r) => formatNumber(r.nutrition.protein ?? 0, 0),
        user: formatNumber(userTotals.protein ?? 0, 0),
      },
      {
        label: "Жиры, г",
        get: (r) => formatNumber(r.nutrition.fat ?? 0, 0),
        user: formatNumber(userTotals.fat ?? 0, 0),
      },
      {
        label: "Углеводы, г",
        get: (r) => formatNumber(r.nutrition.carbs ?? 0, 0),
        user: formatNumber(userTotals.carbs ?? 0, 0),
      },
      {
        label: "Ингредиентов",
        get: (r) => String(r.items.length),
        user: String(userItems.length),
      },
    ];

  return (
    <section className="mt-6">
      <h2 className="mb-2 text-caption text-ink-secondary uppercase">
        Сравнение моделей
      </h2>

      <div className="overflow-x-auto rounded-2xl bg-card">
        <table className="w-full min-w-max text-caption">
          <thead>
            <tr className="border-b border-separator">
              <th className="sticky left-0 bg-card px-3 py-2 text-left font-normal text-ink-secondary">
                Показатель
              </th>
              {recognitions.map((r) => (
                <th key={r.id} className="px-3 py-2 text-right font-medium">
                  {r.model_label}
                  <span className="block text-micro font-normal text-ink-secondary">
                    {r.prompt_version}
                  </span>
                </th>
              ))}
              <th className="px-3 py-2 text-right font-medium">Ваша версия</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.label} className="border-b border-separator last:border-0">
                <th className="sticky left-0 bg-card px-3 py-2 text-left font-normal text-ink-secondary">
                  {row.label}
                </th>
                {recognitions.map((r) => (
                  <td key={r.id} className="tnum px-3 py-2 text-right">
                    {row.get(r)}
                  </td>
                ))}
                <td className="tnum px-3 py-2 text-right font-semibold">{row.user}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h3 className="mt-4 mb-2 text-caption text-ink-secondary uppercase">
        Отклонение от вашей версии
      </h3>
      <ul className="overflow-hidden rounded-2xl bg-card">
        {recognitions.map((r) => {
          const modelKeys = new Set(r.items.map(keyOf));
          const matched = [...modelKeys].filter((k) => userKeys.has(k)).length;
          const missed = [...userKeys].filter((k) => !modelKeys.has(k)).length;
          const extra = [...modelKeys].filter((k) => !userKeys.has(k)).length;

          const weightDelta = r.total_weight_g - userWeight;
          const kcalDelta = (r.nutrition.energy_kcal ?? 0) - userKcal;

          return (
            <li key={r.id} className="border-b border-separator p-3 last:border-0">
              <p className="mb-1 font-medium">
                {r.model_label}
                <span className="ml-1 text-micro font-normal text-ink-secondary">
                  {r.prompt_version}
                  {r.scale_mode ? ` · масштаб: ${r.scale_mode}` : ""}
                </span>
              </p>
              <p className="text-caption text-ink-secondary">
                Δ вес:{" "}
                <span className="tnum text-ink">
                  {weightDelta > 0 ? "+" : ""}
                  {formatNumber(weightDelta, 0)} г
                  {userWeight > 0 &&
                    ` (${weightDelta > 0 ? "+" : ""}${Math.round((weightDelta / userWeight) * 100)}%)`}
                </span>
                {" · "}Δ ккал:{" "}
                <span className="tnum text-ink">
                  {kcalDelta > 0 ? "+" : ""}
                  {formatNumber(kcalDelta, 0)}
                  {userKcal > 0 &&
                    ` (${kcalDelta > 0 ? "+" : ""}${Math.round((kcalDelta / userKcal) * 100)}%)`}
                </span>
              </p>
              <p className="text-caption text-ink-secondary">
                Совпало: <span className="text-ink">{matched}</span> · пропустила:{" "}
                <span className="text-ink">{missed}</span> · лишних:{" "}
                <span className="text-ink">{extra}</span>
              </p>
            </li>
          );
        })}
      </ul>

      <h3 className="mt-4 mb-2 text-caption text-ink-secondary uppercase">
        Состав по моделям
      </h3>
      <div className="overflow-x-auto rounded-2xl bg-card">
        {/*
          Колонка ингредиента занимает не больше половины экрана и переносится
          по словам, колонки моделей — фиксированной ширины (§13.10): иначе
          длинное название съедает всю ширину и сравнения не видно.
        */}
        <table className="w-max min-w-full text-caption">
          <thead>
            <tr className="border-b border-separator">
              <th className="sticky left-0 z-10 bg-card px-3 py-2 text-left align-bottom font-normal text-ink-secondary">
                <span className={INGREDIENT_CELL}>Ингредиент</span>
              </th>
              {recognitions.map((r) => (
                <th key={r.id} className="px-2 py-2 text-right align-bottom font-medium">
                  <span className={MODEL_HEAD_CELL}>{r.model_label}</span>
                </th>
              ))}
              <th className="px-2 py-2 text-right align-bottom font-medium">
                <span className={MODEL_HEAD_CELL}>Ваша версия</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {buildIngredientRows(recognitions, userItems).map((row) => (
              <tr key={row.key} className="border-b border-separator last:border-0">
                <th className="sticky left-0 z-10 bg-card px-3 py-2 text-left font-normal">
                  <span className={INGREDIENT_CELL}>{row.label}</span>
                </th>
                {recognitions.map((r) => (
                  <td key={r.id} className="tnum px-2 py-2 text-right whitespace-nowrap">
                    {row.byRecognition[r.id] !== undefined
                      ? `${formatNumber(row.byRecognition[r.id], 0)} г`
                      : "—"}
                  </td>
                ))}
                <td className="tnum px-2 py-2 text-right font-semibold whitespace-nowrap">
                  {row.userWeight !== undefined
                    ? `${formatNumber(row.userWeight, 0)} г`
                    : "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function buildIngredientRows(
  recognitions: ComparisonRecognition[],
  userItems: ComparisonUserItem[],
) {
  const rows = new Map<
    string,
    {
      key: string;
      label: string;
      byRecognition: Record<string, number>;
      userWeight?: number;
    }
  >();

  const ensure = (item: { name_ru: string; ingredient_id: number | null }) => {
    const key = keyOf(item);
    if (!rows.has(key)) {
      rows.set(key, { key, label: item.name_ru, byRecognition: {} });
    }
    return rows.get(key)!;
  };

  for (const item of userItems) {
    ensure(item).userWeight = item.weight_g;
  }
  for (const recognition of recognitions) {
    for (const item of recognition.items) {
      ensure(item).byRecognition[recognition.id] = item.weight_g;
    }
  }

  return [...rows.values()];
}
