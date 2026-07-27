/**
 * Реестр эталонов масштаба (§7.5.3–7.5.4 PRD).
 *
 * Пользователь один раз отмечает чекбоксами, что у него есть и что он обычно
 * кладёт в кадр; выбранное пишется в `user_reference_objects` с точным
 * `true_size_mm`. Дальше эти размеры (а) подставляются в пользовательское
 * сообщение к модели — «используй эти точные размеры, не угадывай их», и
 * (б) дают знаменатель для `scale_size_error` = |claimed − true| / true.
 *
 * `reliability` — насколько размер вообще определён. Банковская карта
 * стандартизирована ISO и одинакова во всём мире; монета зависит от страны и
 * номинала; столовые приборы у всех разные. Показываем это в интерфейсе, чтобы
 * пользователь не считал приблизительное точным (§13.6).
 */

/** Совпадает с enum `scale_references[].type` в схеме ответа модели (§7.3). */
export type ReferenceType =
  | "coin"
  | "bank_card"
  | "ruler"
  | "cutlery"
  | "smartphone"
  | "wristwatch"
  | "fitness_tracker"
  | "hand"
  | "standard_plate"
  | "standard_glass"
  | "bottle"
  | "other";

export type SizeAxis = "diameter" | "width" | "length" | "case_height";

export interface ReferencePreset {
  /** Стабильный ключ пресета, попадает в UI-состояние; в БД пишется label. */
  key: string;
  type: ReferenceType;
  label: string;
  trueSizeMm: number;
  sizeAxis: SizeAxis;
  reliability: "exact" | "model_dependent" | "approximate";
  note?: string;
}

export const REFERENCE_PRESETS: ReferencePreset[] = [
  {
    key: "bank_card",
    type: "bank_card",
    label: "Банковская карта",
    trueSizeMm: 85.6,
    sizeAxis: "width",
    reliability: "exact",
    note: "ISO/IEC 7810 ID-1 — 85,60 × 53,98 мм, одинаково во всём мире",
  },
  {
    key: "ruler_15",
    type: "ruler",
    label: "Линейка 15 см",
    trueSizeMm: 150,
    sizeAxis: "length",
    reliability: "exact",
  },
  {
    key: "ruler_30",
    type: "ruler",
    label: "Линейка 30 см",
    trueSizeMm: 300,
    sizeAxis: "length",
    reliability: "exact",
  },
  {
    key: "coin_rub_1",
    type: "coin",
    label: "Монета 1 ₽",
    trueSizeMm: 20.5,
    sizeAxis: "diameter",
    reliability: "exact",
  },
  {
    key: "coin_rub_2",
    type: "coin",
    label: "Монета 2 ₽",
    trueSizeMm: 23,
    sizeAxis: "diameter",
    reliability: "exact",
  },
  {
    key: "coin_rub_5",
    type: "coin",
    label: "Монета 5 ₽",
    trueSizeMm: 25,
    sizeAxis: "diameter",
    reliability: "exact",
  },
  {
    key: "coin_rub_10",
    type: "coin",
    label: "Монета 10 ₽",
    trueSizeMm: 22,
    sizeAxis: "diameter",
    reliability: "exact",
  },
  {
    key: "coin_eur_1",
    type: "coin",
    label: "Монета 1 €",
    trueSizeMm: 23.25,
    sizeAxis: "diameter",
    reliability: "exact",
  },
  {
    key: "coin_eur_2",
    type: "coin",
    label: "Монета 2 €",
    trueSizeMm: 25.75,
    sizeAxis: "diameter",
    reliability: "exact",
  },
  {
    key: "watch_apple_41",
    type: "wristwatch",
    label: "Apple Watch 41 мм",
    trueSizeMm: 41,
    sizeAxis: "case_height",
    reliability: "model_dependent",
  },
  {
    key: "watch_apple_45",
    type: "wristwatch",
    label: "Apple Watch 45 мм",
    trueSizeMm: 45,
    sizeAxis: "case_height",
    reliability: "model_dependent",
  },
  {
    key: "watch_apple_49",
    type: "wristwatch",
    label: "Apple Watch Ultra 49 мм",
    trueSizeMm: 49,
    sizeAxis: "case_height",
    reliability: "model_dependent",
  },
  {
    key: "tracker_generic",
    type: "fitness_tracker",
    label: "Фитнес-браслет",
    trueSizeMm: 45,
    sizeAxis: "case_height",
    reliability: "approximate",
    note: "Размер сильно зависит от модели — уточните вручную, если знаете",
  },
  {
    key: "spoon_table",
    type: "cutlery",
    label: "Столовая ложка",
    trueSizeMm: 195,
    sizeAxis: "length",
    reliability: "approximate",
  },
  {
    key: "spoon_tea",
    type: "cutlery",
    label: "Чайная ложка",
    trueSizeMm: 140,
    sizeAxis: "length",
    reliability: "approximate",
  },
  {
    key: "fork_table",
    type: "cutlery",
    label: "Столовая вилка",
    trueSizeMm: 195,
    sizeAxis: "length",
    reliability: "approximate",
  },
];

export const PRESETS_BY_KEY: Record<string, ReferencePreset> =
  Object.fromEntries(REFERENCE_PRESETS.map((p) => [p.key, p]));

const AXIS_LABEL_RU: Record<SizeAxis, string> = {
  diameter: "диаметр",
  width: "ширина",
  length: "длина",
  case_height: "высота корпуса",
};

/** Строка для пользовательского сообщения модели (§7.2, последний абзац). */
export function buildReferenceHint(
  objects: { label: string; true_size_mm: number; size_axis: string }[],
): string | null {
  if (objects.length === 0) return null;
  const parts = objects.map((o) => {
    const axis = AXIS_LABEL_RU[o.size_axis as SizeAxis] ?? o.size_axis;
    return `${o.label} (${axis} ${o.true_size_mm} мм)`;
  });
  return `В кадре может присутствовать: ${parts.join(", ")}. Используй эти точные размеры, не угадывай их.`;
}
