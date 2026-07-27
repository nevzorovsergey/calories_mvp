import { formatNumber } from "@/lib/format";

/**
 * График калорий по дням за последние 14 дней (FR-HIST-4).
 * Просто столбики: без аналитики, трендов и библиотек графиков.
 */
export default function KcalChart({
  days,
  today,
}: {
  days: { date: string; kcal: number }[];
  today: string;
}) {
  if (days.length === 0) return null;

  const max = Math.max(...days.map((d) => d.kcal), 1);

  return (
    <figure className="rounded-2xl bg-card p-4">
      <figcaption className="mb-3 text-caption text-ink-secondary">
        Калории за последние {days.length} дн.
      </figcaption>
      <div className="flex h-32 items-end gap-1">
        {days.map((day) => {
          const height = Math.max(2, Math.round((day.kcal / max) * 100));
          const isToday = day.date === today;
          return (
            <div key={day.date} className="flex flex-1 flex-col items-center gap-1">
              <div
                className={`w-full rounded-t ${isToday ? "bg-accent" : "bg-accent/40"}`}
                style={{ height: `${height}%` }}
                title={`${day.date}: ${formatNumber(day.kcal, 0)} ккал`}
              />
              <span className="text-micro text-ink-secondary">
                {day.date.slice(8)}
              </span>
            </div>
          );
        })}
      </div>
    </figure>
  );
}
