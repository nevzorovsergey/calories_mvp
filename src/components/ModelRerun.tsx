"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button, Popup, Preloader } from "konsta/react";

/**
 * «Проверить другой моделью» (FR-DET-4).
 *
 * Перепрогон использует тот же файл, который отправлялся первой модели
 * (FR-CMP-4), и не меняет ни пользовательскую версию, ни
 * `primary_recognition_id` (FR-CMP-5) — всё это обеспечивает серверный
 * маршрут, здесь только выбор модели.
 */
export default function ModelRerun({
  mealId,
  models,
  label = "Проверить другой моделью",
}: {
  mealId: string;
  models: { id: string; label: string; promptVersion: string }[];
  label?: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [running, setRunning] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (models.length === 0) return null;

  async function run(model: { id: string; label: string; promptVersion: string }) {
    setRunning(model.label);
    setError(null);
    try {
      const response = await fetch(`/api/meals/${mealId}/recognize`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model_id: model.id,
          prompt_version: model.promptVersion,
        }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? `Ошибка ${response.status}`);
      if (data.status === "failed") {
        setError(`Модель не справилась: ${data.error ?? "неизвестная причина"}`);
        setRunning(null);
        return;
      }
      setOpen(false);
      setRunning(null);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setRunning(null);
    }
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="tap-target inline-flex items-center rounded-xl bg-card px-4 py-2 text-accent"
      >
        {label}
      </button>

      <Popup opened={open} onBackdropClick={() => !running && setOpen(false)}>
        <div className="mx-auto max-w-screen-sm p-4">
          <h2 className="mb-1 text-section font-semibold">Выберите модель</h2>
          <p className="mb-3 text-caption text-ink-secondary">
            Прогон пойдёт по тому же снимку. Ваша версия состава не изменится.
          </p>

          {running ? (
            <div className="flex flex-col items-center gap-2 py-6 text-center">
              <Preloader />
              <p>Спрашиваем «{running}»…</p>
              <p className="text-caption text-ink-secondary">
                Обычно занимает 10–40 секунд.
              </p>
            </div>
          ) : (
            <ul className="overflow-hidden rounded-xl bg-card">
              {models.map((model) => (
                <li
                  key={`${model.id}@${model.promptVersion}`}
                  className="border-b border-separator last:border-0"
                >
                  <button
                    type="button"
                    onClick={() => run(model)}
                    className="tap-target w-full px-3 py-3 text-left"
                  >
                    <span className="block text-body">{model.label}</span>
                    <span className="block text-micro text-ink-secondary">
                      промпт {model.promptVersion}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}

          {error && (
            <p className="mt-3 text-caption text-error" role="alert">
              {error}
            </p>
          )}

          {!running && (
            <div className="mt-4">
              <Button outline onClick={() => setOpen(false)}>
                Закрыть
              </Button>
            </div>
          )}
        </div>
      </Popup>
    </>
  );
}
