"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

/**
 * Правка позиции справочника (FR-LABX-4).
 *
 * Форма показывает ровно то, что можно менять, — четыре поля. Остальное на
 * карточке только для чтения, и это видно по тому, что оно вне формы: спрятать
 * недоступное было бы хуже, чем показать, — в справочнике важно видеть позицию
 * целиком, даже те её части, которыми управляет импорт.
 */
export default function CatalogItemEditor({
  id,
  initial,
}: {
  id: number;
  initial: {
    name_ru: string;
    category: string | null;
    is_active: boolean;
    is_service: boolean;
  };
}) {
  const router = useRouter();
  const [nameRu, setNameRu] = useState(initial.name_ru);
  const [category, setCategory] = useState(initial.category ?? "");
  const [isActive, setIsActive] = useState(initial.is_active);
  const [isService, setIsService] = useState(initial.is_service);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const dirty =
    nameRu !== initial.name_ru ||
    category !== (initial.category ?? "") ||
    isActive !== initial.is_active ||
    isService !== initial.is_service;

  async function save() {
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      const response = await fetch(`/api/lab/catalog/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name_ru: nameRu.trim(),
          category: category.trim() === "" ? null : category.trim(),
          is_active: isActive,
          is_service: isService,
        }),
      });
      const result = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(result.error ?? `Ошибка ${response.status}`);
      setSaved(true);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="rounded-2xl bg-card p-4">
      <h2 className="mb-3 text-caption text-ink-secondary uppercase">Правка</h2>

      <label className="mb-1 block text-micro text-ink-secondary uppercase" htmlFor="name_ru">
        Название по-русски
      </label>
      <input
        id="name_ru"
        value={nameRu}
        onChange={(e) => setNameRu(e.target.value)}
        className="tap-target mb-3 w-full rounded-xl bg-screen px-3 py-2 text-body"
      />

      <label className="mb-1 block text-micro text-ink-secondary uppercase" htmlFor="category">
        Категория
      </label>
      <input
        id="category"
        value={category}
        onChange={(e) => setCategory(e.target.value)}
        placeholder="без категории"
        className="tap-target mb-3 w-full rounded-xl bg-screen px-3 py-2 text-body"
      />

      <label className="tap-target mb-1 flex items-center gap-2 text-body">
        <input
          type="checkbox"
          checked={isActive}
          onChange={(e) => setIsActive(e.target.checked)}
          className="accent-accent"
        />
        Активна — попадает в поиск и в подсказки
      </label>

      <label className="tap-target mb-3 flex items-center gap-2 text-body">
        <input
          type="checkbox"
          checked={isService}
          onChange={(e) => setIsService(e.target.checked)}
          className="accent-accent"
        />
        Служебная — заготовка, соус, украшение; понижается в выдаче
      </label>

      {error && (
        <p className="mb-2 text-caption text-error" role="alert">
          {error}
        </p>
      )}
      {saved && !dirty && (
        <p className="mb-2 text-caption text-success" role="status">
          Сохранено.
        </p>
      )}

      <button
        type="button"
        onClick={save}
        disabled={saving || !dirty || nameRu.trim() === ""}
        className="tap-target inline-flex items-center rounded-xl bg-accent px-4 py-2 text-white disabled:opacity-40"
      >
        {saving ? "Сохраняем…" : "Сохранить"}
      </button>
    </div>
  );
}
