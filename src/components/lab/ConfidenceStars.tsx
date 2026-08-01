/**
 * Уверенность пользователя в весе, вопрос 3 модалки «Откуда вес?» (FR-WE-3).
 *
 * В базе это `weight_evidence.self_confidence`, целое 1–5. Пусто — два разных
 * случая, и различать их обязательно: человек мог не отвечать вовсе, а мог
 * нажать «Не знаю» (FR-WE-4). Второе — осознанный ответ, и в аналитике он
 * значит совсем не то же самое, что молчание. Различие приходит параметром
 * `asked`, потому что видно оно только по наличию строки `weight_evidence`.
 */
export default function ConfidenceStars({
  value,
  asked,
}: {
  value: number | null;
  /** Модалка была заполнена — то есть вопрос человеку задавали. */
  asked: boolean;
}) {
  if (value === null) {
    return (
      <span className="text-micro text-ink-secondary">
        {asked ? "не знает" : "не спрашивали"}
      </span>
    );
  }

  return (
    <span
      className="tnum whitespace-nowrap"
      title={`${value} из 5: 1 — совсем не уверен, 5 — знает точно`}
    >
      <span aria-hidden className="text-warning">
        {"★".repeat(value)}
      </span>
      <span aria-hidden className="text-ink-secondary">
        {"☆".repeat(5 - value)}
      </span>
      <span className="sr-only">Уверенность {value} из 5</span>
    </span>
  );
}
