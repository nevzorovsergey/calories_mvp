/**
 * Словарь модалки «Откуда вес?» (§11.5).
 *
 * Лежит отдельно от самой модалки, потому что у него теперь два потребителя:
 * форма, которая эти варианты предлагает, и лаборатория, которая показывает
 * ответы. Разойдись формулировки — в разборе приёма пищи появился бы код
 * `package_label` там, где человек читал «Указано на упаковке», и сверять один
 * экран с другим стало бы нельзя.
 */

export const WEIGHT_METHODS = [
  { value: "scale", label: "Взвесил на весах" },
  { value: "package_label", label: "Указано на упаковке" },
  { value: "menu", label: "Указано в меню или на ценнике" },
  { value: "recipe", label: "Сам готовил, знаю раскладку" },
  { value: "measuring", label: "Мерная посуда (стакан, ложка)" },
  { value: "eyeball", label: "Прикинул на глаз" },
] as const;

export const REFERENCE_OBJECTS = [
  { value: "coin", label: "Монета" },
  { value: "bank_card", label: "Банковская карта" },
  { value: "ruler", label: "Линейка" },
  { value: "cutlery", label: "Столовые приборы" },
  { value: "smartphone", label: "Смартфон" },
  { value: "wristwatch", label: "Часы или браслет" },
  { value: "hand", label: "Ладонь" },
  { value: "standard_plate", label: "Стандартная тарелка" },
  { value: "none", label: "Ничего из этого" },
] as const;

const METHOD_BY_VALUE = new Map(WEIGHT_METHODS.map((m) => [m.value as string, m.label]));
const REFERENCE_BY_VALUE = new Map(
  REFERENCE_OBJECTS.map((r) => [r.value as string, r.label]),
);

/**
 * NULL — не то же самое, что незаполненное: человек нажал «Не знаю» (FR-WE-4), и
 * это осознанный ответ. Различие важно для аналитики, поэтому подписи разные, а
 * решать, какая из них уместна, приходится вызывающему — по наличию самой
 * строки `weight_evidence`.
 */
export function weightMethodLabel(value: string | null): string {
  if (value === null) return "не знает";
  return METHOD_BY_VALUE.get(value) ?? value;
}

export function referenceObjectLabel(value: string): string {
  return REFERENCE_BY_VALUE.get(value) ?? value;
}
