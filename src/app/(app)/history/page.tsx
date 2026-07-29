import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getProfile, signThumbs } from "@/lib/data/meals";
import { formatMealDate, formatNumber, localDateIso } from "@/lib/format";
import MealThumb from "@/components/MealThumb";
import KcalChart from "@/components/KcalChart";

/**
 * История (§11.8): список дней от новых к старым, дневные итоги, полоска
 * миниатюр и простой график калорий за 14 дней. Без аналитики и трендов —
 * просто столбики.
 */
export const dynamic = "force-dynamic";

export default async function HistoryPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const profile = await getProfile(supabase, user.id);
  const today = localDateIso(profile?.timezone);

  const { data: days } = await supabase
    .from("v_daily_totals")
    .select("meal_date, meals_count, kcal, protein, fat, carbs")
    .eq("user_id", user.id)
    .order("meal_date", { ascending: false })
    .limit(60);

  const dayRows = days ?? [];

  const { data: photos } = await supabase
    .from("meals")
    .select("meal_date, photo_sent_path")
    .eq("user_id", user.id)
    .order("eaten_at", { ascending: true })
    .limit(400);

  // Приёмы пищи из справочника фотографии не имеют (0006), поэтому путь здесь
  // и правда бывает пустым — в полоске превью за день их просто нет.
  const thumbs = await signThumbs(
    supabase,
    (photos ?? []).map((p) => p.photo_sent_path as string | null),
  );
  const photosByDate = new Map<string, string[]>();
  for (const photo of photos ?? []) {
    const date = photo.meal_date as string;
    const path = photo.photo_sent_path as string | null;
    const url = path ? thumbs.get(path) : undefined;
    if (!url) continue;
    const list = photosByDate.get(date) ?? [];
    if (list.length < 8) list.push(url);
    photosByDate.set(date, list);
  }

  return (
    <div className="px-4 pt-4">
      <h1 className="mb-4 text-title font-semibold">История</h1>

      <KcalChart
        days={dayRows
          .slice(0, 14)
          .map((d) => ({ date: d.meal_date as string, kcal: Number(d.kcal ?? 0) }))
          .reverse()}
        today={today}
      />

      {dayRows.length === 0 ? (
        <div className="mt-4 rounded-2xl bg-card p-6 text-center">
          <p className="mb-1 font-medium">Истории пока нет</p>
          <p className="text-caption text-ink-secondary">
            Она появится после первого сохранённого приёма пищи.
          </p>
        </div>
      ) : (
        <ul className="mt-4 space-y-2">
          {dayRows.map((day) => {
            const date = day.meal_date as string;
            return (
              <li key={date}>
                <Link
                  href={`/today?date=${date}`}
                  className="block rounded-2xl bg-card p-3"
                >
                  <div className="flex items-baseline justify-between">
                    <span className="font-medium">{formatMealDate(date, today)}</span>
                    <span className="tnum">
                      {formatNumber(Number(day.kcal ?? 0), 0)}
                      <span className="ml-1 text-caption text-ink-secondary">ккал</span>
                    </span>
                  </div>
                  <div className="mt-0.5 text-caption text-ink-secondary">
                    Б {formatNumber(Number(day.protein ?? 0), 0)} · Ж{" "}
                    {formatNumber(Number(day.fat ?? 0), 0)} · У{" "}
                    {formatNumber(Number(day.carbs ?? 0), 0)} ·{" "}
                    {day.meals_count} приём(а/ов)
                  </div>
                  <div className="mt-2 flex gap-1 overflow-hidden">
                    {(photosByDate.get(date) ?? []).map((url, index) => (
                      <MealThumb key={index} src={url} alt="" size={40} />
                    ))}
                  </div>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
