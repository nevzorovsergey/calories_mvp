/** Форматирование чисел и дат для интерфейса. Русская локаль — единственная (§14). */

export function formatNumber(value: number, digits = 0): string {
  return new Intl.NumberFormat("ru-RU", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(value);
}

/**
 * Значение для поля ввода: без разделителей разрядов.
 * ru-RU форматирует 1200 как «1 200» с неразрывным пробелом, и обратный разбор
 * такой строки даёт NaN — вес блюда больше килограмма перестал бы вводиться.
 */
export function formatInputNumber(value: number, digits = 0): string {
  return value.toFixed(digits);
}

/** Разбор того, что пользователь набрал: запятая как разделитель, пробелы игнорируем. */
export function parseInputNumber(value: string): number {
  return Number(value.replace(/\s/g, "").replace(",", "."));
}

/** Небольшие значения (витамины в мг/мкг) теряют смысл при округлении до целого. */
export function formatNutrient(value: number): string {
  if (value === 0) return "0";
  if (Math.abs(value) < 1) return formatNumber(value, 2);
  if (Math.abs(value) < 10) return formatNumber(value, 1);
  return formatNumber(value, 0);
}

const WEEKDAYS = ["воскресенье", "понедельник", "вторник", "среда", "четверг", "пятница", "суббота"];

/** «Сегодня» / «Вчера» / «12 марта, среда» — дата в заголовке экрана. */
export function formatMealDate(isoDate: string, todayIso: string): string {
  if (isoDate === todayIso) return "Сегодня";
  if (isoDate === shiftIsoDate(todayIso, -1)) return "Вчера";

  const [year, month, day] = isoDate.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  const monthName = new Intl.DateTimeFormat("ru-RU", {
    day: "numeric",
    month: "long",
    timeZone: "UTC",
  }).format(date);
  return `${monthName}, ${WEEKDAYS[date.getUTCDay()]}`;
}

export function formatTime(isoTimestamp: string): string {
  return new Intl.DateTimeFormat("ru-RU", {
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(isoTimestamp));
}

export function shiftIsoDate(isoDate: string, days: number): string {
  const [year, month, day] = isoDate.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/**
 * Локальная дата пользователя, а не UTC: поздний ужин иначе уехал бы во
 * «вчера» (§10.1, meal_date). Часовой пояс берём из профиля.
 */
export function localDateIso(timezone?: string): string {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    ...(timezone ? { timeZone: timezone } : {}),
  });
  return formatter.format(new Date());
}
