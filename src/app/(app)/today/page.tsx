import Link from "next/link";
import { redirect } from "next/navigation";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { getDayMeals, getProfile } from "@/lib/data/meals";
import { formatMealDate, formatTime, localDateIso, shiftIsoDate } from "@/lib/format";
import NutrientPanel from "@/components/NutrientPanel";
import CaptureButton from "@/components/CaptureButton";
import MealThumb from "@/components/MealThumb";

/**
 * Главный экран «Сегодня» (§11.2).
 *
 * Крупная сводка за день, лента приёмов пищи, переключение даты стрелками и
 * плавающая кнопка съёмки — основное целевое действие.
 */
export const dynamic = "force-dynamic";

export default async function TodayPage({
  searchParams,
}: {
  searchParams: Promise<{ date?: string }>;
}) {
  const { date: dateParam } = await searchParams;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const profile = await getProfile(supabase, user.id);
  const today = localDateIso(profile?.timezone);
  const date = dateParam ?? today;

  const { meals, totals } = await getDayMeals(supabase, user.id, date);

  return (
    <div className="px-4 pt-4">
      <header className="mb-4 flex items-center justify-between">
        <Link
          href={`/today?date=${shiftIsoDate(date, -1)}`}
          className="tap-target flex items-center justify-center text-accent"
          aria-label="Предыдущий день"
        >
          <ChevronLeft size={24} />
        </Link>
        <h1 className="text-section font-semibold">{formatMealDate(date, today)}</h1>
        {date < today ? (
          <Link
            href={`/today?date=${shiftIsoDate(date, 1)}`}
            className="tap-target flex items-center justify-center text-accent"
            aria-label="Следующий день"
          >
            <ChevronRight size={24} />
          </Link>
        ) : (
          <span className="tap-target" aria-hidden />
        )}
      </header>

      <NutrientPanel totals={totals} />

      <h2 className="mt-6 mb-2 text-caption text-ink-secondary uppercase">
        Приёмы пищи
      </h2>

      {meals.length === 0 ? (
        // §13.8: пустой экран говорит, что делать, а не констатирует пустоту.
        <div className="rounded-2xl bg-card p-6 text-center">
          <p className="mb-1 font-medium">Пока пусто</p>
          <p className="text-caption text-ink-secondary">
            Сфотографируйте первое блюдо — модель разберёт его на ингредиенты, а
            вы поправите, что не так.
          </p>
        </div>
      ) : (
        <ul className="overflow-hidden rounded-2xl bg-card">
          {meals.map((meal) => (
            <li key={meal.id} className="border-b border-separator last:border-0">
              <Link
                href={`/meal/${meal.id}`}
                className="flex items-center gap-3 p-3"
              >
                <MealThumb src={meal.thumbUrl} alt="" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium">
                    {meal.status === "processing"
                      ? "Распознаём…"
                      : meal.status === "failed"
                        ? "Не получилось распознать"
                        : (meal.dish_name_ru ?? "Без названия")}
                  </span>
                  <span className="block text-caption text-ink-secondary">
                    {formatTime(meal.eaten_at)}
                    {meal.untouched && meal.status === "ready" && " · без правок"}
                  </span>
                </span>
                {meal.status === "processing" ? (
                  <span className="skeleton h-4 w-14" aria-label="Загрузка" />
                ) : (
                  <span
                    className={`tnum text-body ${meal.untouched ? "text-warning" : ""}`}
                  >
                    {meal.untouched && <span aria-hidden>≈</span>}
                    {Math.round(meal.kcal)}
                    <span className="ml-1 text-caption text-ink-secondary">ккал</span>
                  </span>
                )}
              </Link>
            </li>
          ))}
        </ul>
      )}

      <CaptureButton mealDate={date} />
    </div>
  );
}
