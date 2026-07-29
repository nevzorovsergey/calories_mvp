"use client";

import { useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { NUTRIENTS, type NutrientGroup } from "@config/nutrients";
import { formatNumber, formatNutrient } from "@/lib/format";

/**
 * Итоговая нутриентная панель (FR-HOME-1, FR-EDIT-7).
 *
 * Калории и БЖУ — всегда на виду; 13 витаминов и 10 минералов — под
 * сворачиваемым блоком «Подробнее», с абсолютными значениями и % от суточной
 * нормы. Норма одна общая для всех, без учёта пола и возраста (§8.3).
 *
 * Переключатель «Порция / 100 г» (FR-DET-6, FR-EDIT-12) пересчитывает всю
 * панель на 100 г блюда. Это единственный вид, который можно с чем-то сверить:
 * калорийность порции зависит от оценки веса, а на 100 г — нет.
 */

export type NutrientTotals = Record<string, number>;

const GROUP_TITLES: Record<NutrientGroup, string> = {
  macro: "Макронутриенты",
  vitamin: "Витамины",
  mineral: "Минералы",
};

export default function NutrientPanel({
  totals,
  /** Общий вес блюда: без него пересчитывать на 100 г не из чего, переключателя нет. */
  totalWeightG,
  /** true — итог целиком построен на оценке модели, показываем это цветом (§13.6). */
  estimated = false,
  /**
   * Показать общий вес крупно, рядом с калорийностью. На экране правки его не
   * включаем: там прямо над панелью стоит редактируемое поле «Общий вес, г»,
   * и то же число в двух местах только путает.
   */
  showTotalWeight = false,
}: {
  totals: NutrientTotals;
  totalWeightG?: number;
  estimated?: boolean;
  showTotalWeight?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const [per100, setPer100] = useState(false);

  const canPer100 = typeof totalWeightG === "number" && totalWeightG > 0;
  const showPer100 = per100 && canPer100;
  /** В режиме «100 г» вес показывать нечего: он там по определению равен 100 г. */
  const showWeight = showTotalWeight && canPer100 && !showPer100;
  const factor = showPer100 ? 100 / (totalWeightG as number) : 1;
  const amountOf = (code: string) => (totals[code] ?? 0) * factor;

  const kcal = amountOf("energy_kcal");
  const macros = [
    { code: "protein", label: "Белки" },
    { code: "fat", label: "Жиры" },
    { code: "carbs", label: "Углеводы" },
    { code: "fiber", label: "Клетчатка" },
  ];

  return (
    <div role="group" aria-label="Итог по нутриентам" className="rounded-2xl bg-card p-4">
      {canPer100 && (
        <div
          role="group"
          aria-label="Пересчёт нутриентов"
          className="mb-2 flex justify-end"
        >
          <div className="inline-flex rounded-full bg-screen p-0.5 text-caption">
            {[
              { value: false, label: "Порция" },
              { value: true, label: "100 г" },
            ].map(({ value, label }) => (
              <button
                key={label}
                type="button"
                onClick={() => setPer100(value)}
                aria-pressed={per100 === value}
                className={`tap-target rounded-full px-3 ${
                  per100 === value ? "bg-card font-medium" : "text-ink-secondary"
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="flex items-baseline justify-between">
        {showWeight ? (
          <span>
            <span
              className={`tnum block text-title font-semibold ${estimated ? "text-warning" : ""}`}
            >
              {estimated && <span aria-hidden>≈</span>}
              {formatNumber(totalWeightG as number, 0)}
              <span className="ml-1 text-caption font-normal text-ink-secondary">
                г
              </span>
            </span>
            <span className="block text-caption text-ink-secondary">Вес</span>
          </span>
        ) : (
          <span className="text-caption text-ink-secondary">
            {showPer100 ? "Калорийность 100 г" : "Калорийность"}
          </span>
        )}

        <span className={showWeight ? "text-right" : ""}>
          <span
            className={`tnum block text-title font-semibold ${estimated ? "text-warning" : ""}`}
          >
            {estimated && <span aria-hidden>≈</span>}
            {formatNutrient(kcal)}
            <span className="ml-1 text-caption font-normal text-ink-secondary">
              ккал
            </span>
          </span>
          {showWeight && (
            <span className="block text-caption text-ink-secondary">
              Калорийность
            </span>
          )}
        </span>
      </div>

      <div className="mt-3 grid grid-cols-4 gap-2">
        {macros.map(({ code, label }) => (
          <div key={code} className="text-center">
            <div className="tnum text-body font-medium">
              {formatNutrient(amountOf(code))}
            </div>
            <div className="text-micro text-ink-secondary">{label}, г</div>
          </div>
        ))}
      </div>

      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        className="tap-target mt-3 flex w-full items-center gap-1 text-caption text-accent"
      >
        {expanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
        Подробнее: витамины и минералы
      </button>

      {expanded && (
        <div className="mt-2 space-y-4">
          {(["macro", "vitamin", "mineral"] as NutrientGroup[]).map((group) => (
            <section key={group}>
              <h3 className="mb-1 text-caption text-ink-secondary">
                {GROUP_TITLES[group]}
              </h3>
              <ul className="divide-y divide-separator">
                {NUTRIENTS.filter((n) => n.group === group).map((n) => {
                  const amount = amountOf(n.code);
                  const percent = n.rdi ? Math.round((amount / n.rdi) * 100) : null;
                  return (
                    <li
                      key={n.code}
                      className="flex items-baseline justify-between py-1"
                    >
                      <span className="text-caption">{n.nameRu}</span>
                      <span className="flex items-baseline gap-2">
                        <span className="tnum text-caption">
                          {formatNutrient(amount)}
                          <span className="ml-0.5 text-ink-secondary">
                            {unitRu(n.unit)}
                          </span>
                        </span>
                        {percent !== null && (
                          <span className="tnum w-12 text-right text-micro text-ink-secondary">
                            {percent}%
                          </span>
                        )}
                      </span>
                    </li>
                  );
                })}
              </ul>
            </section>
          ))}
          <p className="text-micro text-ink-secondary">
            Проценты — от общей суточной нормы, без учёта пола и возраста
            {showPer100 && ", в пересчёте на 100 г блюда"}.
          </p>
        </div>
      )}
    </div>
  );
}

function unitRu(unit: string): string {
  switch (unit) {
    case "kcal":
      return "ккал";
    case "g":
      return "г";
    case "mg":
      return "мг";
    case "mcg":
      return "мкг";
    default:
      return unit;
  }
}
