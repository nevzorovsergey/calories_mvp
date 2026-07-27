import type { DishAnalysis, ScaleChain, ScaleReference } from "./schema";

/**
 * Проверка масштабной цепочки (§7.5.2–7.5.3 PRD).
 *
 * Модель не выполняет фотограмметрию: инструкция «используй монету для
 * масштаба» смещает распределение ответов, но не включает никакого механизма,
 * а самоотчёт `used_for_scale = true` — post-hoc рационализация, а не
 * интроспекция. Верить ему нельзя.
 *
 * Зато цепочку можно проверить арифметически, не имея ground truth: если числа
 * не сходятся между собой, значит модель заполнила блок декоративно, а массу
 * взяла «из головы». Доля таких ответов — измеримая характеристика модели,
 * которой нет ни в одном публичном бенчмарке.
 */

export type ConsistencyFlag =
  | "scale_mismatch"
  | "volume_mismatch"
  | "mass_mismatch"
  | "anchor_incomplete";

export interface ConsistencyCheck {
  flag: ConsistencyFlag;
  /** Что ожидалось по арифметике самой цепочки. */
  expected: number;
  /** Что вернула модель. */
  reported: number;
  /** Относительное расхождение, доля. */
  deviation: number;
  threshold: number;
}

export interface ScaleCheckResult {
  consistency_flags: ConsistencyFlag[];
  consistency_checks: ConsistencyCheck[];
  /** Ведущий эталон, как его заявила модель. */
  leadReference: ScaleReference | null;
  scale_ref_type: string | null;
  scale_ref_claimed_mm: number | null;
  scale_ref_true_mm: number | null;
  /** |claimed − true| / true; NULL, если истинный размер неизвестен (FR-SCALE-3). */
  scale_size_error: number | null;
}

const THRESHOLDS = {
  scale: 0.15, // расхождение масштаба   > 15% → флаг
  volume: 0.3, // расхождение объёма     > 30% → флаг
  mass: 0.25, // расхождение массы      > 25% → флаг
} as const;

function relativeDeviation(expected: number, reported: number): number | null {
  if (!Number.isFinite(expected) || !Number.isFinite(reported)) return null;
  if (expected === 0) return reported === 0 ? 0 : null;
  return Math.abs(reported - expected) / Math.abs(expected);
}

/** Три арифметические сверки цепочки саму с собой (FR-SCALE-1). */
export function checkScaleChain(
  chain: ScaleChain | undefined,
  totalWeightG: number,
): { flags: ConsistencyFlag[]; checks: ConsistencyCheck[] } {
  const flags: ConsistencyFlag[] = [];
  const checks: ConsistencyCheck[] = [];
  if (!chain) return { flags, checks };

  const push = (
    flag: ConsistencyFlag,
    expected: number,
    reported: number,
    threshold: number,
  ) => {
    const deviation = relativeDeviation(expected, reported);
    if (deviation === null) return;
    checks.push({ flag, expected, reported, deviation, threshold });
    if (deviation > threshold) flags.push(flag);
  };

  // 1. ожидаемый_масштаб = anchor_real_mm / anchor_apparent_fraction ≈ mm_per_frame_width
  if (chain.scale_mode === "reference") {
    if (chain.anchor_real_mm > 0 && chain.anchor_apparent_fraction > 0) {
      push(
        "scale_mismatch",
        chain.anchor_real_mm / chain.anchor_apparent_fraction,
        chain.mm_per_frame_width,
        THRESHOLDS.scale,
      );
    } else {
      // Заявлен режим «по эталону», но чисел якоря нет — цепочка недостроена.
      flags.push("anchor_incomplete");
    }
  }

  // 2. ожидаемый_объём = π * (food_footprint_mm/2)² * food_mean_height_mm / 1000
  if (chain.food_footprint_mm > 0 && chain.food_mean_height_mm > 0) {
    const radiusMm = chain.food_footprint_mm / 2;
    const expectedMl =
      (Math.PI * radiusMm * radiusMm * chain.food_mean_height_mm) / 1000;
    push(
      "volume_mismatch",
      expectedMl,
      chain.estimated_volume_ml,
      THRESHOLDS.volume,
    );
  }

  // 3. ожидаемая_масса = estimated_volume_ml * assumed_density_g_per_ml
  if (chain.estimated_volume_ml > 0 && chain.assumed_density_g_per_ml > 0) {
    push(
      "mass_mismatch",
      chain.estimated_volume_ml * chain.assumed_density_g_per_ml,
      totalWeightG,
      THRESHOLDS.mass,
    );
  }

  return { flags, checks };
}

export interface KnownReference {
  type: string;
  label: string;
  true_size_mm: number;
}

/**
 * Ведущий эталон + ошибка в его размере (§7.5.3, FR-SCALE-3).
 *
 * Даже согласованная цепочка едет пропорционально, если модель приписала
 * монете 30 мм вместо 22. Истинные размеры известны точно — из реестра
 * пользователя, — поэтому это чистая, ни от чего не зависящая метрика.
 */
export function analyseReferences(
  analysis: DishAnalysis,
  knownReferences: KnownReference[],
): Omit<ScaleCheckResult, "consistency_flags" | "consistency_checks"> {
  const refs = analysis.scale_references ?? [];
  const anchorType = analysis.scale_chain?.anchor_type;

  const lead =
    refs.find((r) => r.used_for_scale) ??
    (anchorType && anchorType !== "none"
      ? refs.find((r) => r.type === anchorType)
      : undefined) ??
    null;

  const claimedMm =
    lead?.assumed_size_mm ??
    (analysis.scale_chain && analysis.scale_chain.anchor_real_mm > 0
      ? analysis.scale_chain.anchor_real_mm
      : null);

  const refType = lead?.type ?? (anchorType !== "none" ? anchorType : null) ?? null;

  // Истинный размер знаем только если пользователь отметил такой эталон у себя.
  const known = refType
    ? knownReferences.filter((k) => k.type === refType)
    : [];
  let trueMm: number | null = null;
  if (known.length === 1) {
    trueMm = known[0].true_size_mm;
  } else if (known.length > 1 && claimedMm !== null) {
    // Несколько эталонов одного типа (две монеты разного номинала) — берём
    // ближайший к заявленному, иначе ошибка будет об идентификации, а не о размере.
    trueMm = known.reduce((best, k) =>
      Math.abs(k.true_size_mm - claimedMm) < Math.abs(best.true_size_mm - claimedMm)
        ? k
        : best,
    ).true_size_mm;
  }

  const sizeError =
    trueMm !== null && claimedMm !== null && trueMm > 0
      ? Math.abs(claimedMm - trueMm) / trueMm
      : null;

  return {
    leadReference: lead,
    scale_ref_type: refType,
    scale_ref_claimed_mm: claimedMm,
    scale_ref_true_mm: trueMm,
    scale_size_error: sizeError,
  };
}

export function runScaleChecks(
  analysis: DishAnalysis,
  knownReferences: KnownReference[],
): ScaleCheckResult {
  const { flags, checks } = checkScaleChain(
    analysis.scale_chain,
    analysis.total_weight_g,
  );
  return {
    consistency_flags: flags,
    consistency_checks: checks,
    ...analyseReferences(analysis, knownReferences),
  };
}
