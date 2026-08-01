"use client";

import { useState } from "react";
import { Button, Sheet } from "konsta/react";
import { REFERENCE_OBJECTS, WEIGHT_METHODS } from "@/lib/weight-evidence";

/**
 * Модалка «Откуда вес?» (§11.5).
 *
 * Показывается один раз на приём пищи, после первого сохранения с правками.
 * Не более 15 секунд на заполнение, любой вопрос пропускается кнопкой
 * «Не знаю» — записывается null и не блокирует сохранение (FR-WE-4).
 *
 * Вопрос 2 предзаполняется тем, что нашла модель в `scale_references`
 * (FR-WE-2). Это даёт бесплатную разметку «модель увидела эталон / эталон
 * реально был» — то есть точность самой детекции эталонов.
 */

// Сами варианты — в @/lib/weight-evidence: их читает ещё и лаборатория, когда
// показывает ответы словами, а не кодами.
const METHODS = WEIGHT_METHODS;
const REFERENCE_OPTIONS = REFERENCE_OBJECTS;

export default function WeightEvidenceSheet({
  mealId,
  opened,
  detectedReferences,
  onClose,
}: {
  mealId: string;
  opened: boolean;
  /** Типы эталонов, которые модель нашла в кадре — ими предзаполняем вопрос 2. */
  detectedReferences: string[];
  onClose: () => void;
}) {
  const [method, setMethod] = useState<string | null>(null);
  const [references, setReferences] = useState<string[]>(detectedReferences);
  const [confidence, setConfidence] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);

  async function submit(skipAll = false) {
    setSaving(true);
    await fetch(`/api/meals/${mealId}/evidence`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        method: skipAll ? null : method,
        self_confidence: skipAll ? null : confidence,
        reference_objects: skipAll ? [] : references,
      }),
    });
    setSaving(false);
    onClose();
  }

  function toggleReference(value: string) {
    setReferences((current) => {
      if (value === "none") return current.includes("none") ? [] : ["none"];
      const without = current.filter((v) => v !== "none");
      return without.includes(value)
        ? without.filter((v) => v !== value)
        : [...without, value];
    });
  }

  return (
    <Sheet opened={opened} onBackdropClick={onClose} className="pb-safe">
      <div className="max-h-[80vh] overflow-y-auto p-4">
        <h2 className="mb-1 text-section font-semibold">Откуда вес?</h2>
        <p className="mb-4 text-caption text-ink-secondary">
          Три вопроса на 15 секунд. Это самое ценное, что вы можете дать
          эксперименту — но любой вопрос можно пропустить.
        </p>

        <fieldset className="mb-4">
          <legend className="mb-2 text-caption text-ink-secondary">
            1. Как вы определили вес?
          </legend>
          <div className="overflow-hidden rounded-xl bg-card">
            {METHODS.map((option) => (
              <label
                key={option.value}
                className="tap-target flex items-center gap-3 border-b border-separator px-3 py-2 last:border-0"
              >
                <input
                  type="radio"
                  name="method"
                  checked={method === option.value}
                  onChange={() => setMethod(option.value)}
                  className="accent-accent"
                />
                <span className="text-body">{option.label}</span>
              </label>
            ))}
          </div>
        </fieldset>

        <fieldset className="mb-4">
          <legend className="mb-2 text-caption text-ink-secondary">
            2. Был ли в кадре предмет для оценки масштаба?
            {detectedReferences.length > 0 && (
              <span className="block text-micro">
                Отмечено то, что нашла модель — подтвердите или снимите галочку.
              </span>
            )}
          </legend>
          <div className="overflow-hidden rounded-xl bg-card">
            {REFERENCE_OPTIONS.map((option) => (
              <label
                key={option.value}
                className="tap-target flex items-center gap-3 border-b border-separator px-3 py-2 last:border-0"
              >
                <input
                  type="checkbox"
                  checked={references.includes(option.value)}
                  onChange={() => toggleReference(option.value)}
                  className="accent-accent"
                />
                <span className="text-body">{option.label}</span>
              </label>
            ))}
          </div>
        </fieldset>

        <fieldset className="mb-4">
          <legend className="mb-2 text-caption text-ink-secondary">
            3. Насколько уверены в весе?
          </legend>
          <div className="flex gap-2">
            {[1, 2, 3, 4, 5].map((value) => (
              <button
                key={value}
                type="button"
                onClick={() => setConfidence(value)}
                aria-pressed={confidence === value}
                className={`tap-target flex-1 rounded-xl py-2 text-body ${
                  confidence === value
                    ? "bg-accent text-white"
                    : "bg-card text-ink"
                }`}
              >
                {value}
              </button>
            ))}
          </div>
          <p className="mt-1 text-micro text-ink-secondary">
            1 — совсем не уверен, 5 — знаю точно
          </p>
        </fieldset>

        <div className="flex gap-2">
          <Button outline onClick={() => submit(true)} disabled={saving}>
            Не знаю
          </Button>
          <Button onClick={() => submit(false)} disabled={saving}>
            {saving ? "Сохраняем…" : "Готово"}
          </Button>
        </div>
      </div>
    </Sheet>
  );
}
