/**
 * Метрики «Лаборатории» (§11.9, §12 PRD).
 *
 * Считаем в TypeScript поверх вьюх, а не в SQL: объёмы прототипа маленькие
 * (до 100 распознаваний в сутки), зато формулы видно рядом с интерфейсом и их
 * легко менять по ходу эксперимента.
 */

export interface ModelVsUserRow {
  recognition_id: string;
  meal_id: string;
  model_id: string;
  model_label: string;
  prompt_version: string;
  is_primary: boolean;
  weight_ape: number | null;
  kcal_ape: number | null;
  cost_rub_actual: number | null;
  cost_direct_usd: number | null;
  latency_ms: number | null;
  has_scale_ref: boolean | null;
  scale_mode: string | null;
  scale_size_error: number | null;
  scale_chain_consistent: boolean | null;
  had_reference: boolean | null;
}

export interface AgreementRow {
  meal_id: string;
  kept: number;
  edited: number;
  added: number;
  removed: number;
}

export function median(values: number[]): number | null {
  const sorted = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

export function mean(values: number[]): number | null {
  const finite = values.filter((v) => Number.isFinite(v));
  if (finite.length === 0) return null;
  return finite.reduce((a, b) => a + b, 0) / finite.length;
}

export interface ModelSummary {
  key: string;
  model_label: string;
  prompt_version: string;
  runs: number;
  avgLatencyMs: number | null;
  avgCostRub: number | null;
  totalCostRub: number;
  avgCostUsd: number | null;
  medianWeightApe: number | null;
  medianKcalApe: number | null;
  inconsistentShare: number | null;
  avgScaleSizeError: number | null;
}

/** FR-LAB-1: сводка по моделям за период. */
export function summariseModels(rows: ModelVsUserRow[]): ModelSummary[] {
  const groups = new Map<string, ModelVsUserRow[]>();
  for (const row of rows) {
    const key = `${row.model_id}@${row.prompt_version}`;
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }

  return [...groups.entries()]
    .map(([key, group]) => {
      const withChain = group.filter((r) => r.scale_chain_consistent !== null);
      return {
        key,
        model_label: group[0].model_label,
        prompt_version: group[0].prompt_version,
        runs: group.length,
        avgLatencyMs: mean(group.map((r) => r.latency_ms ?? NaN)),
        avgCostRub: mean(group.map((r) => r.cost_rub_actual ?? NaN)),
        totalCostRub: group.reduce((sum, r) => sum + (r.cost_rub_actual ?? 0), 0),
        avgCostUsd: mean(group.map((r) => r.cost_direct_usd ?? NaN)),
        medianWeightApe: median(group.map((r) => r.weight_ape ?? NaN)),
        medianKcalApe: median(group.map((r) => r.kcal_ape ?? NaN)),
        inconsistentShare:
          withChain.length > 0
            ? withChain.filter((r) => r.scale_chain_consistent === false).length /
              withChain.length
            : null,
        avgScaleSizeError: mean(group.map((r) => r.scale_size_error ?? NaN)),
      };
    })
    .sort((a, b) => b.runs - a.runs);
}

export interface Slice {
  label: string;
  n: number;
  mape: number | null;
}

/** Срез MAPE веса по произвольному признаку — основа сводок H4 и H6 (FR-LAB-2). */
export function sliceMape(
  rows: ModelVsUserRow[],
  labeller: (row: ModelVsUserRow) => string | null,
): Slice[] {
  const groups = new Map<string, number[]>();
  for (const row of rows) {
    const label = labeller(row);
    if (label === null || row.weight_ape === null) continue;
    groups.set(label, [...(groups.get(label) ?? []), row.weight_ape]);
  }
  return [...groups.entries()]
    .map(([label, values]) => ({
      label,
      n: values.length,
      mape: mean(values),
    }))
    .sort((a, b) => b.n - a.n);
}

export interface AgreementSummary {
  meals: number;
  kept: number;
  edited: number;
  added: number;
  removed: number;
  /** kept+edited / (kept+edited+removed) — §12. */
  precision: number | null;
  /** kept+edited / (kept+edited+added) — §12. */
  recall: number | null;
  /** Доля позиций, оставленных без изменений — H1. */
  keptShare: number | null;
  /** Доля приёмов пищи, где хоть что-то правили — H2, H5. */
  editedMealShare: number | null;
}

export function summariseAgreement(rows: AgreementRow[]): AgreementSummary {
  const kept = rows.reduce((s, r) => s + r.kept, 0);
  const edited = rows.reduce((s, r) => s + r.edited, 0);
  const added = rows.reduce((s, r) => s + r.added, 0);
  const removed = rows.reduce((s, r) => s + r.removed, 0);
  const matched = kept + edited;

  return {
    meals: rows.length,
    kept,
    edited,
    added,
    removed,
    precision: matched + removed > 0 ? matched / (matched + removed) : null,
    recall: matched + added > 0 ? matched / (matched + added) : null,
    keptShare: matched + added > 0 ? kept / (matched + added) : null,
    editedMealShare:
      rows.length > 0
        ? rows.filter((r) => r.edited > 0 || r.added > 0 || r.removed > 0).length /
          rows.length
        : null,
  };
}

export function formatPercent(value: number | null, digits = 0): string {
  if (value === null || !Number.isFinite(value)) return "—";
  return `${(value * 100).toFixed(digits)}%`;
}
