import { formatNumber } from "@/lib/format";

/**
 * Визуальный язык достоверности (§13.6 PRD).
 *
 * Единственное место, где мы отходим от стандартной iOS-раскладки, и не ради
 * красоты: степень достоверности числа — главное содержание этого продукта, и
 * она обязана быть видна без чтения.
 *
 *   estimate  — оценка модели: оранжевым, с префиксом «≈», обычным начертанием
 *   confirmed — человек посмотрел и оставил как есть: чёрным, обычным
 *   edited    — человек изменил: чёрным полужирным, рядом зачёркнутое исходное
 *
 * Правило, из которого всё следует: пользователь в любой момент должен видеть,
 * чему он смотрит в глаза — измерению или догадке.
 */

export type Confidence = "estimate" | "confirmed" | "edited";

export function ConfidenceValue({
  value,
  unit,
  confidence,
  originalValue,
  digits = 0,
  className = "",
}: {
  value: number | null | undefined;
  unit?: string;
  confidence: Confidence;
  /** Что предлагала модель — показывается зачёркнутым при confidence="edited". */
  originalValue?: number | null;
  digits?: number;
  className?: string;
}) {
  if (value === null || value === undefined) {
    return <span className={`text-ink-secondary ${className}`}>—</span>;
  }

  const text = `${formatNumber(value, digits)}${unit ? ` ${unit}` : ""}`;

  if (confidence === "estimate") {
    return (
      <span className={`tnum text-warning ${className}`}>
        <span aria-hidden>≈</span>
        <span className="sr-only">оценка модели: </span>
        {text}
      </span>
    );
  }

  if (confidence === "edited") {
    return (
      <span className={`tnum ${className}`}>
        <span className="font-semibold">{text}</span>
        {originalValue !== null && originalValue !== undefined && (
          <span className="ml-1 text-caption text-ink-secondary line-through">
            <span className="sr-only">было: </span>
            {formatNumber(originalValue, digits)}
          </span>
        )}
      </span>
    );
  }

  return <span className={`tnum ${className}`}>{text}</span>;
}

/** Пометка источника нутриентов (FR-CAT-2): «≈» = цифры от модели, не из справочника. */
export function NutritionSourceBadge({ source }: { source: string }) {
  if (source !== "model") return null;
  return (
    <span
      className="ml-1 text-caption text-warning"
      title="Нутриенты взяты из оценки модели, а не из справочника"
    >
      ≈
    </span>
  );
}
