"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { apiFetch, apiPost } from "@/lib/api";
import { REFERENCE_PRESETS, type ReferencePreset } from "@config/reference-objects";

/**
 * «Мои эталоны» (§7.5.4, FR-SCALE-4, FR-AUTH-4).
 *
 * Чекбоксы по готовому списку предметов известного размера. Смысл не в
 * настройке ради настройки: зная точный размер, мы (а) сообщаем его модели —
 * «используй, не угадывай», убирая целый класс ошибок, и (б) получаем
 * знаменатель для `scale_size_error`. Пустой реестр допустим — тогда подсказка
 * просто не подставляется.
 */
export default function ReferenceObjectsEditor({
  initial,
}: {
  initial: {
    id: string;
    type: string;
    label: string;
    true_size_mm: number;
    size_axis: string;
  }[];
}) {
  const router = useRouter();
  const [saving, setSaving] = useState<string | null>(null);
  const [rows, setRows] = useState(initial);
  const [error, setError] = useState<string | null>(null);

  const selectedByLabel = new Map(rows.map((r) => [r.label, r]));

  async function toggle(preset: ReferencePreset) {
    setSaving(preset.key);
    setError(null);
    const existing = selectedByLabel.get(preset.label);

    // Список меняем только после ответа сервера. Галочка, которая встала сразу,
    // а на деле не сохранилась, — это молчаливая потеря настройки: человек
    // уверен, что сообщил модели размер, а его в подсказке нет.
    try {
      if (existing) {
        const response = await apiFetch(
          `/api/profile/reference-objects?id=${encodeURIComponent(existing.id)}`,
          { method: "DELETE" },
        );
        if (!response.ok) throw new Error(`сервер ответил ${response.status}`);
        setRows((current) => current.filter((r) => r.id !== existing.id));
      } else {
        const response = await apiPost("/api/profile/reference-objects", {
          key: preset.key,
        });
        if (!response.ok) throw new Error(`сервер ответил ${response.status}`);
        const { object } = (await response.json()) as {
          object: {
            id: string;
            type: string;
            label: string;
            true_size_mm: number | string;
            size_axis: string;
          };
        };
        setRows((current) => [
          ...current,
          { ...object, true_size_mm: Number(object.true_size_mm) },
        ]);
      }
      router.refresh();
    } catch (err) {
      console.error(err);
      setError("Не удалось сохранить — проверьте связь и попробуйте ещё раз.");
    } finally {
      setSaving(null);
    }
  }

  return (
    <section>
      <h2 className="mb-1 text-section font-semibold">Мои эталоны</h2>
      <p className="mb-3 text-caption text-ink-secondary">
        Отметьте, что у вас есть и что вы обычно кладёте в кадр. Мы сообщим
        модели точные размеры — так она не будет их угадывать, а мы сможем
        измерить, насколько она ошибается.
      </p>

      <ul className="overflow-hidden rounded-2xl bg-card">
        {REFERENCE_PRESETS.map((preset) => {
          const checked = selectedByLabel.has(preset.label);
          return (
            <li key={preset.key} className="border-b border-separator last:border-0">
              <label className="tap-target flex items-center gap-3 px-3 py-2">
                <input
                  type="checkbox"
                  checked={checked}
                  disabled={saving === preset.key}
                  onChange={() => toggle(preset)}
                  className="accent-accent"
                />
                <span className="min-w-0 flex-1">
                  <span className="block text-body">{preset.label}</span>
                  <span className="block text-micro text-ink-secondary">
                    {preset.trueSizeMm} мм
                    {preset.reliability === "exact" && " · размер стандартизирован"}
                    {preset.reliability === "model_dependent" && " · зависит от модели"}
                    {preset.reliability === "approximate" && " · приблизительно"}
                  </span>
                </span>
              </label>
            </li>
          );
        })}
      </ul>

      {error && (
        <p className="mt-2 text-caption text-error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
