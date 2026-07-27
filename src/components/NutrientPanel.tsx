"use client";

import { useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { NUTRIENTS, type NutrientGroup } from "@config/nutrients";
import { formatNutrient } from "@/lib/format";

/**
 * Итоговая нутриентная панель (FR-HOME-1, FR-EDIT-7).
 *
 * Калории и БЖУ — всегда на виду; 13 витаминов и 10 минералов — под
 * сворачиваемым блоком «Подробнее», с абсолютными значениями и % от суточной
 * нормы. Норма одна общая для всех, без учёта пола и возраста (§8.3).
 */

export type NutrientTotals = Record<string, number>;

const GROUP_TITLES: Record<NutrientGroup, string> = {
  macro: "Макронутриенты",
  vitamin: "Витамины",
  mineral: "Минералы",
};

export default function NutrientPanel({
  totals,
  /** true — итог целиком построен на оценке модели, показываем это цветом (§13.6). */
  estimated = false,
}: {
  totals: NutrientTotals;
  estimated?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);

  const kcal = totals.energy_kcal ?? 0;
  const macros = [
    { code: "protein", label: "Белки" },
    { code: "fat", label: "Жиры" },
    { code: "carbs", label: "Углеводы" },
    { code: "fiber", label: "Клетчатка" },
  ];

  return (
    <div className="rounded-2xl bg-card p-4">
      <div className="flex items-baseline justify-between">
        <span className="text-caption text-ink-secondary">Калорийность</span>
        <span
          className={`tnum text-title font-semibold ${estimated ? "text-warning" : ""}`}
        >
          {estimated && <span aria-hidden>≈</span>}
          {formatNutrient(kcal)}
          <span className="ml-1 text-caption font-normal text-ink-secondary">
            ккал
          </span>
        </span>
      </div>

      <div className="mt-3 grid grid-cols-4 gap-2">
        {macros.map(({ code, label }) => (
          <div key={code} className="text-center">
            <div className="tnum text-body font-medium">
              {formatNutrient(totals[code] ?? 0)}
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
                  const amount = totals[n.code] ?? 0;
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
            Проценты — от общей суточной нормы, без учёта пола и возраста.
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
