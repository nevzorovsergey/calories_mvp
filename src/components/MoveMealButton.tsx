"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Dialog, DialogButton } from "konsta/react";
import { formatMealDate, shiftIsoDate } from "@/lib/format";

/**
 * FR-DET-7: перенос приёма пищи на другую дату.
 *
 * Дата ставится в момент съёмки, а листать дни на «Сегодня» можно свободно —
 * значит, еда регулярно попадает не в тот день, который человек имел в виду.
 * Состав при этом верный, и переснимать нечего: не хватает только правки даты.
 *
 * Быстрые кнопки «Сегодня» и «Вчера» стоят рядом с полем даты, потому что
 * промах почти всегда на день-два: набирать дату целиком приходится редко.
 */
export default function MoveMealButton({
  mealId,
  mealDate,
  today,
}: {
  mealId: string;
  mealDate: string;
  today: string;
}) {
  const router = useRouter();
  const [asking, setAsking] = useState(false);
  const [date, setDate] = useState(mealDate);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function open() {
    setDate(mealDate);
    setError(null);
    setAsking(true);
  }

  async function move() {
    setSaving(true);
    setError(null);
    try {
      const response = await fetch(`/api/meals/${mealId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ meal_date: date }),
      });
      const data = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(data.error ?? `Ошибка сервера (${response.status})`);

      setAsking(false);
      // Уводим на день, куда перенесли: там видно и приём пищи на новом месте, и
      // пересчитанный дневной итог — то самое, ради чего перенос и делали.
      router.push(`/today?date=${date}`);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  const quick = [today, shiftIsoDate(today, -1)].filter((d) => d !== mealDate);

  return (
    <>
      {/* Тот же вид, что у соседей по строке действий («Проверить другой
          моделью»): это правка приёма пищи, а не опасная операция. */}
      <button
        type="button"
        onClick={open}
        disabled={saving}
        className="tap-target inline-flex items-center rounded-xl bg-card px-4 py-2 text-accent"
      >
        Перенести на другую дату
      </button>

      <Dialog
        opened={asking}
        onBackdropClick={() => !saving && setAsking(false)}
        title="Перенести на другую дату?"
        content={
          <div className="pt-2 text-left">
            <p className="mb-3 text-caption text-ink-secondary">
              Сейчас этот приём пищи в дне «{formatMealDate(mealDate, today)}» и
              считается в его итогах. Время дня сохранится.
            </p>

            {quick.length > 0 && (
              <div className="mb-3 flex flex-wrap gap-2">
                {quick.map((option) => (
                  <button
                    key={option}
                    type="button"
                    onClick={() => setDate(option)}
                    aria-pressed={date === option}
                    className={`rounded-xl px-3 py-2 text-caption ${
                      date === option ? "bg-accent text-white" : "bg-card text-accent"
                    }`}
                  >
                    {formatMealDate(option, today)}
                  </button>
                ))}
              </div>
            )}

            <label className="mb-1 block text-caption text-ink-secondary" htmlFor="move-date">
              Дата приёма пищи
            </label>
            <input
              id="move-date"
              type="date"
              value={date}
              max={today}
              disabled={saving}
              onChange={(event) => setDate(event.target.value)}
              className="w-full rounded-xl bg-card p-3 text-body"
            />

            {error && (
              <p className="mt-3 text-caption text-error" role="alert">
                {error}
              </p>
            )}
          </div>
        }
        buttons={
          <>
            <DialogButton onClick={() => setAsking(false)} disabled={saving}>
              Отмена
            </DialogButton>
            <DialogButton
              strong
              onClick={move}
              disabled={saving || !date || date === mealDate}
            >
              Перенести
            </DialogButton>
          </>
        }
      />
    </>
  );
}
