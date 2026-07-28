"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

const POLL_MS = 3000;

/**
 * Опрос статуса, пока приём пищи в `processing` (§5.1).
 *
 * Ничего не рисует: экран уже отрисован сервером, задача — заметить, что
 * фоновая обработка закончилась, и перерисовать страницу. Поэтому дёргается
 * лёгкий `GET /api/meals/{id}` (он для этого и заведён), а полный
 * `router.refresh()` вызывается ровно один раз — когда статус сменился.
 *
 * Скрытую вкладку не опрашиваем: на телефоне это расход батареи ради
 * результата, которого никто не видит. Вернулись на экран — проверяем сразу,
 * не дожидаясь очередного тика.
 *
 * `giveUpAfterMs` — сколько ещё этому приёму пищи позволено висеть в `processing`,
 * считая от момента рендера. Когда время вышло, тоже перерисовываем: сервер
 * покажет «не завершилось» с кнопкой «Повторить». Без этого экран остался бы
 * с бесконечным «Распознаём…» — той самой болезнью, от которой уходили.
 */
export default function RecognitionWatcher({
  mealId,
  giveUpAfterMs,
}: {
  mealId: string;
  giveUpAfterMs: number;
}) {
  const router = useRouter();

  useEffect(() => {
    const deadline = Date.now() + giveUpAfterMs;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const schedule = (delay: number) => {
      clearTimeout(timer);
      if (!stopped) timer = setTimeout(check, delay);
    };

    const finish = () => {
      stopped = true;
      clearTimeout(timer);
      router.refresh();
    };

    async function check() {
      if (stopped) return;
      // Проснёмся по visibilitychange — переспрашивать нечего.
      if (document.visibilityState !== "visible") return;
      if (Date.now() > deadline) return finish();

      try {
        const response = await fetch(`/api/meals/${mealId}`, { cache: "no-store" });
        if (response.ok) {
          const data = (await response.json()) as { status?: string };
          if (data.status && data.status !== "processing") return finish();
        }
      } catch {
        // Сеть моргнула — не повод сдаваться, следующая попытка через POLL_MS.
      }
      schedule(POLL_MS);
    }

    const onVisibility = () => {
      if (document.visibilityState === "visible") schedule(0);
    };

    document.addEventListener("visibilitychange", onVisibility);
    schedule(POLL_MS);

    return () => {
      stopped = true;
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [mealId, giveUpAfterMs, router]);

  return null;
}
