"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

/**
 * Выбор блюда и размера порции (тикет 10 спеки .scratch/russian-dish-catalog).
 *
 * Два выбора вместо правки списка ингредиентов — в этом весь смысл v3-dish.
 * Оба сделаны предвыбранными: если человек согласен с моделью (а чаще всего он
 * согласен), он не должен делать ничего, кроме подтверждения.
 *
 * Предвыбран не «обычный» размер, а тот, что предложила модель. Иначе её оценка
 * пропадает зря, и H8 — «типовой вес точнее модельной оценки» — становится
 * нечем проверять: сравнивать будет не с чем.
 */

export interface DishOption {
  position: number;
  /** Название от модели — показывается, даже если в справочнике его нет. */
  name_ru: string;
  /** Каноничное название справочника; null, если не сматчилось. */
  catalog_name_ru: string | null;
  why: string | null;
  ingredient_id: number | null;
  portions: { size: "small" | "medium" | "large"; grams: number; kcal: number | null }[];
}

const SIZE_LABELS: Record<string, string> = {
  small: "маленькая",
  medium: "обычная",
  large: "большая",
};

export default function DishChoice({
  mealId,
  options,
  suggestedPortion,
}: {
  mealId: string;
  options: DishOption[];
  suggestedPortion: "small" | "medium" | "large" | null;
}) {
  const router = useRouter();
  const matched = options.filter((o) => o.ingredient_id !== null);
  const [dish, setDish] = useState<DishOption | null>(matched[0] ?? null);
  const [size, setSize] = useState<"small" | "medium" | "large">(
    suggestedPortion ?? "medium",
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const portion = dish?.portions.find((p) => p.size === size) ?? null;

  async function save() {
    if (!dish?.ingredient_id) return;
    setSaving(true);
    setError(null);
    const response = await fetch(`/api/meals/${mealId}/dish`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        dish_id: dish.ingredient_id,
        candidate_position: dish.position,
        portion_size: size,
      }),
    });
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      setError(body.error ?? "Не удалось сохранить");
      setSaving(false);
      return;
    }
    router.refresh();
  }

  return (
    <div className="flex flex-col gap-4">
      <section className="rounded-2xl bg-card p-4">
        <h1 className="mb-1 text-section font-semibold">Что это?</h1>
        <p className="mb-3 text-caption text-ink-secondary">
          Модель предложила несколько вариантов. Выберите тот, что ближе.
        </p>

        <ul className="flex flex-col gap-2">
          {options.map((option) => {
            const selected = dish?.position === option.position;
            const unavailable = option.ingredient_id === null;
            return (
              <li key={option.position}>
                <button
                  type="button"
                  disabled={unavailable}
                  aria-pressed={selected}
                  onClick={() => setDish(option)}
                  className={`tap-target w-full rounded-xl px-4 py-3 text-left ${
                    selected ? "bg-accent/10 ring-2 ring-accent" : "bg-surface"
                  } ${unavailable ? "opacity-50" : ""}`}
                >
                  <span className="block font-medium">
                    {option.catalog_name_ru ?? option.name_ru}
                  </span>
                  {option.why && (
                    <span className="block text-micro text-ink-secondary">
                      {option.why}
                    </span>
                  )}
                  {unavailable && (
                    <span className="block text-micro text-ink-secondary">
                      нет в справочнике — состав придётся ввести руками
                    </span>
                  )}
                </button>
              </li>
            );
          })}
        </ul>
      </section>

      {dish && (
        <section className="rounded-2xl bg-card p-4">
          <h2 className="mb-1 text-section font-semibold">Сколько?</h2>
          <p className="mb-3 text-caption text-ink-secondary">
            Размеры взяты из типовых порций этого блюда.
          </p>

          <div className="flex flex-col gap-2">
            {dish.portions.map((p) => {
              const selected = size === p.size;
              return (
                <button
                  key={p.size}
                  type="button"
                  aria-pressed={selected}
                  onClick={() => setSize(p.size)}
                  className={`tap-target w-full rounded-xl px-4 py-3 text-left ${
                    selected ? "bg-accent/10 ring-2 ring-accent" : "bg-surface"
                  }`}
                >
                  <span className="font-medium">{SIZE_LABELS[p.size]}</span>
                  <span className="text-ink-secondary">
                    {" "}
                    · {Math.round(p.grams)} г
                    {p.kcal !== null && ` · ${Math.round(p.kcal)} ккал`}
                  </span>
                </button>
              );
            })}
          </div>
        </section>
      )}

      {error && <p className="text-caption text-danger">{error}</p>}

      <button
        type="button"
        onClick={save}
        disabled={!dish?.ingredient_id || saving}
        className="tap-target w-full rounded-xl bg-accent px-4 py-3 font-medium text-white disabled:opacity-50"
      >
        {saving
          ? "Сохраняем…"
          : portion
            ? `Сохранить · ${Math.round(portion.grams)} г`
            : "Сохранить"}
      </button>

      <a
        href={`/meal/${mealId}/edit`}
        className="tap-target inline-flex justify-center rounded-xl bg-card px-4 py-3 text-accent"
      >
        Ничего не подходит — ввести вручную
      </a>
    </div>
  );
}
