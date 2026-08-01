import { VERDICT_RU, type Verdict } from "@/lib/data/lab-review";

/**
 * Вердикт приёма пищи одним словом.
 *
 * Цвет несёт смысл, но не единственный: подпись читается и без него. Слепой к
 * цвету человек и чёрно-белая распечатка — не крайние случаи для экрана, по
 * которому принимают решения о моделях (§13.9).
 */

const TONE: Record<Verdict, string> = {
  kept: "bg-success/15 text-success",
  dish: "bg-success/15 text-success",
  edited: "bg-warning/15 text-warning",
  manual: "bg-accent/15 text-accent",
  awaiting: "bg-ink-secondary/15 text-ink-secondary",
  processing: "bg-ink-secondary/15 text-ink-secondary",
  failed: "bg-error/15 text-error",
};

export default function VerdictBadge({ verdict }: { verdict: Verdict }) {
  return (
    <span
      className={`inline-block shrink-0 rounded-md px-2 py-0.5 text-micro whitespace-nowrap ${TONE[verdict]}`}
    >
      {VERDICT_RU[verdict]}
    </span>
  );
}
