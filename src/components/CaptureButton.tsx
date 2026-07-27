"use client";

/* eslint-disable @next/next/no-img-element */

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Camera, CreditCard } from "lucide-react";
import { Button, Fab, Popup, Preloader } from "konsta/react";
import { compressImage, type CompressedImage } from "@/lib/image";
import { getDefaultModel } from "@config/models";

/**
 * Съёмка (§11.3).
 *
 * Тап → камера устройства (`capture="environment"`, работает и в Safari iOS, и
 * в Chrome Android без нативного кода). Дальше предпросмотр с необязательной
 * подсказкой и ненавязчивым советом положить в кадр банковскую карту — именно
 * карту, а не монету: её размер стандартизирован ISO и одинаков во всём мире,
 * тогда как монету модель должна сначала опознать по стране и номиналу (§7.5.3).
 */
export default function CaptureButton({ mealDate }: { mealDate: string }) {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [original, setOriginal] = useState<File | null>(null);
  const [compressed, setCompressed] = useState<CompressedImage | null>(null);
  const [hint, setHint] = useState("");
  const [phase, setPhase] = useState<"idle" | "preview" | "sending">("idle");
  const [error, setError] = useState<string | null>(null);

  const model = getDefaultModel();

  async function handleFile(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = ""; // чтобы повторный выбор того же файла сработал
    if (!file) return;
    setError(null);
    try {
      const result = await compressImage(file);
      setOriginal(file);
      setCompressed(result);
      setPhase("preview");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  function reset() {
    if (compressed) URL.revokeObjectURL(compressed.previewUrl);
    setOriginal(null);
    setCompressed(null);
    setHint("");
    setPhase("idle");
  }

  async function recognize() {
    if (!compressed) return;
    setPhase("sending");
    setError(null);

    const form = new FormData();
    form.append("sent", compressed.blob, "sent.jpg");
    if (original) form.append("original", original, original.name);
    form.append("meal_date", mealDate);
    form.append("photo_width", String(compressed.width));
    form.append("photo_height", String(compressed.height));
    if (hint.trim()) form.append("user_hint", hint.trim());

    try {
      const response = await fetch("/api/meals", { method: "POST", body: form });
      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error ?? `Ошибка сервера (${response.status})`);
      }
      if (data.status === "failed") {
        // FR-LLM-1: показываем «Не получилось распознать» с понятными действиями.
        router.push(`/meal/${data.meal_id}`);
        return;
      }

      reset();
      router.push(`/meal/${data.meal_id}/edit`);
    } catch (err) {
      setPhase("preview");
      setError(
        err instanceof Error
          ? `Не удалось отправить фото: ${err.message}`
          : String(err),
      );
    }
  }

  return (
    <>
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        capture="environment"
        onChange={handleFile}
        className="hidden"
      />

      <Fab
        className="fixed right-4 bottom-24 z-20"
        icon={<Camera size={24} />}
        text="Сфотографировать"
        onClick={() => inputRef.current?.click()}
      />

      <Popup opened={phase !== "idle"} onBackdropClick={() => phase === "preview" && reset()}>
        <div className="mx-auto flex h-full max-w-screen-sm flex-col overflow-y-auto p-4">
          <h2 className="mb-3 text-section font-semibold">Проверьте кадр</h2>

          {compressed && (
            <img
              src={compressed.previewUrl}
              alt="Предпросмотр снимка"
              className="mb-3 w-full rounded-2xl object-cover"
            />
          )}

          <div className="mb-3 flex items-start gap-2 rounded-xl bg-card p-3 text-caption text-ink-secondary">
            <CreditCard size={18} className="mt-0.5 shrink-0 text-accent" />
            <span>
              Положите рядом банковскую карту — оценка веса будет точнее. Её
              размер одинаков во всём мире, поэтому это самый надёжный эталон.
            </span>
          </div>

          <label className="mb-1 block text-caption text-ink-secondary" htmlFor="hint">
            Подсказка (что это, как готовили) — необязательно
          </label>
          <textarea
            id="hint"
            value={hint}
            onChange={(e) => setHint(e.target.value)}
            rows={2}
            disabled={phase === "sending"}
            placeholder="Например: гречка с куриной грудкой, жарил на подсолнечном масле"
            className="mb-4 w-full rounded-xl bg-card p-3 text-body"
          />

          {error && (
            <p className="mb-3 text-caption text-error" role="alert">
              {error}
            </p>
          )}

          {phase === "sending" ? (
            <div className="flex flex-col items-center gap-2 py-4 text-center">
              <Preloader />
              {/* FR-CAP-5: прозрачность важна для эксперимента — показываем,
                  какая модель вызывается и сколько это обычно занимает. */}
              <p className="text-body">Распознаём моделью «{model.label}»</p>
              <p className="text-caption text-ink-secondary">
                Обычно занимает 10–40 секунд. Не закрывайте экран.
              </p>
            </div>
          ) : (
            <div className="flex gap-2">
              <Button outline onClick={reset} className="tap-target">
                Отмена
              </Button>
              <Button onClick={recognize} className="tap-target">
                Распознать
              </Button>
            </div>
          )}
        </div>
      </Popup>
    </>
  );
}
