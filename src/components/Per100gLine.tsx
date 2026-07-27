import { formatNumber, formatNutrient } from "@/lib/format";

/**
 * КБЖУ на 100 г продукта (FR-DET-6, FR-EDIT-12).
 *
 * Значения на 100 г — это то, что напечатано на упаковке и лежит в справочнике,
 * поэтому именно по ним человек проверяет результат и сравнивает продукты между
 * собой: вес порции модель может оценить как угодно, а «510 ккал на 100 г» у
 * бекона либо похоже на правду, либо сразу видно, что нет.
 *
 * Показываем только то, что реально известно: у позиций без справочника модель
 * отдаёт лишь четыре макронутриента (§7.3), а иногда и их не полностью.
 */

const MACROS = [
  { code: "protein", letter: "Б" },
  { code: "fat", letter: "Ж" },
  { code: "carbs", letter: "У" },
];

/**
 * Один знак после запятой и без хвостового нуля: строку сверяют с упаковкой,
 * где написано «13,6 г», а не «14» и не «13,60». Общий `formatNutrient` тут не
 * годится — он рассчитан на витамины в микрограммах.
 */
function formatMacro(value: number): string {
  const rounded = Math.round(value * 10) / 10;
  return formatNumber(rounded, Number.isInteger(rounded) ? 0 : 1);
}

export default function Per100gLine({
  per100g,
  className = "",
}: {
  /** Значения на 100 г, ключ — `nutrients.code`. */
  per100g: Record<string, number>;
  className?: string;
}) {
  const kcal = per100g.energy_kcal;
  if (typeof kcal !== "number") return null;

  const macros = MACROS.filter(({ code }) => typeof per100g[code] === "number");

  return (
    <span className={`tnum block text-micro text-ink-secondary ${className}`}>
      на 100 г: {formatNutrient(kcal)} ккал
      {macros.map(({ code, letter }) => (
        <span key={code}>
          {" · "}
          {letter} {formatMacro(per100g[code])}
        </span>
      ))}
    </span>
  );
}
