"use client";

/* eslint-disable @next/next/no-img-element */

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { ChevronDown, ChevronRight, Link2, Plus, Trash2, Undo2 } from "lucide-react";
import { Button } from "konsta/react";
import { apiFetch, apiPost } from "@/lib/api";
import {
  formatInputNumber,
  formatNumber,
  formatNutrient,
  parseInputNumber,
} from "@/lib/format";
import { NUTRIENTS } from "@config/nutrients";
import NutrientPanel from "@/components/NutrientPanel";
import Per100gLine from "@/components/Per100gLine";
import BackLink from "@/components/BackLink";
import IngredientSearch, { type IngredientOption } from "@/components/IngredientSearch";
import WeightEvidenceSheet from "@/components/WeightEvidenceSheet";

/**
 * Экран правки — ключевой экран продукта (§11.4).
 *
 * Сохранение не изменяет `recognitions` и `recognition_items`: пользовательская
 * версия пишется в `meal_items` / `meal_removed_items` с проставленным
 * `origin` (FR-EDIT-10). Origin вычисляет сервер, здесь мы только шлём состав.
 */

export type NutrientMap = Record<string, number>;

export interface EditorItem {
  key: string;
  source_item_id: string | null;
  ingredient_id: number | null;
  name_ru: string;
  weight_g: number;
  /** Что предлагала модель для этой позиции; null для добавленных вручную. */
  modelWeight: number | null;
  /** false — ингредиент выведен логически, не виден на фото (FR-EDIT-6). */
  visible: boolean;
  nutrition_source: "catalog" | "model";
  per100g: NutrientMap;
}

export default function MealEditor({
  mealId,
  photoUrl,
  initialDishName,
  initialItems,
  detectedReferences,
  hasEvidence,
}: {
  mealId: string;
  photoUrl: string | null;
  initialDishName: string;
  initialItems: EditorItem[];
  detectedReferences: string[];
  hasEvidence: boolean;
}) {
  const router = useRouter();

  const [dishName, setDishName] = useState(initialDishName);
  const [items, setItems] = useState<EditorItem[]>(initialItems);
  const [removed, setRemoved] = useState<string[]>([]);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [rebinding, setRebinding] = useState<string | null>(null);
  const [undoSnapshot, setUndoSnapshot] = useState<EditorItem[] | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [evidenceOpen, setEvidenceOpen] = useState(false);

  const totalWeight = items.reduce((sum, item) => sum + item.weight_g, 0);
  const [weightDraft, setWeightDraft] = useState<string | null>(null);

  const totals = useMemo(() => {
    const acc: NutrientMap = {};
    for (const item of items) {
      const factor = item.weight_g / 100;
      for (const [code, per100] of Object.entries(item.per100g)) {
        acc[code] = (acc[code] ?? 0) + per100 * factor;
      }
    }
    return acc;
  }, [items]);

  const changed =
    removed.length > 0 ||
    dishName !== initialDishName ||
    items.length !== initialItems.length ||
    items.some((item, i) => {
      const initial = initialItems[i];
      return (
        !initial ||
        initial.key !== item.key ||
        Math.abs(initial.weight_g - item.weight_g) > 0.001 ||
        initial.ingredient_id !== item.ingredient_id
      );
    });

  function updateWeight(key: string, weight: number) {
    setItems((current) =>
      current.map((item) =>
        item.key === key ? { ...item, weight_g: Math.max(0, weight) } : item,
      ),
    );
  }

  /**
   * FR-EDIT-5: правка общего веса пропорционально пересчитывает веса всех
   * ингредиентов. Это самый быстрый способ поправить главную ошибку модели,
   * поэтому пересчёт включён по умолчанию — но одним тапом отменяется.
   */
  function applyTotalWeight(next: number) {
    if (!Number.isFinite(next) || next <= 0 || totalWeight <= 0) return;
    const factor = next / totalWeight;
    setUndoSnapshot(items);
    setItems((current) =>
      current.map((item) => ({
        ...item,
        weight_g: Math.round(item.weight_g * factor * 10) / 10,
      })),
    );
  }

  function undoRescale() {
    if (!undoSnapshot) return;
    setItems(undoSnapshot);
    setUndoSnapshot(null);
    setWeightDraft(null);
  }

  function removeItem(item: EditorItem) {
    setItems((current) => current.filter((i) => i.key !== item.key));
    // Удалённые позиции модели фиксируем отдельно, а не теряем (§10.1).
    if (item.source_item_id) {
      setRemoved((current) => [...current, item.source_item_id!]);
    }
  }

  // Пустая карта — не ошибка, а «КБЖУ у позиции нет»: вызывающий код по этому
  // признаку оставляет значения от модели и помечает источник как `model`.
  async function fetchNutrients(ingredientId: number): Promise<NutrientMap> {
    try {
      const response = await apiFetch(`/api/catalog/${ingredientId}`);
      if (!response.ok) return {};
      const { entry } = (await response.json()) as { entry: { per100g: NutrientMap } };
      return entry.per100g;
    } catch (error) {
      console.error(error);
      return {};
    }
  }

  /**
   * Привязка позиции к справочнику. Если позиция была `unmatched`, попутно
   * создаём алиас (FR-CAT-1) — справочник самообучается на использовании.
   */
  async function bindIngredient(key: string, option: IngredientOption) {
    const target = items.find((i) => i.key === key);
    const per100g = await fetchNutrients(option.id);

    setItems((current) =>
      current.map((item) =>
        item.key === key
          ? {
              ...item,
              ingredient_id: option.id,
              name_ru: option.name_ru,
              nutrition_source: Object.keys(per100g).length > 0 ? "catalog" : "model",
              per100g: Object.keys(per100g).length > 0 ? per100g : item.per100g,
            }
          : item,
      ),
    );
    setRebinding(null);

    if (target && target.ingredient_id === null && target.name_ru) {
      // Привязка уже показана на экране, и человек её не ждёт: алиас — это
      // польза для будущих распознаваний, а не часть текущего действия.
      // Поэтому промах здесь только логируем, а не выносим в интерфейс.
      try {
        await apiPost("/api/catalog/aliases", {
          ingredient_id: option.id,
          alias: target.name_ru.trim(),
        });
      } catch (error) {
        console.error(error);
      }
    }
  }

  async function addIngredient(option: IngredientOption) {
    const per100g = await fetchNutrients(option.id);
    setItems((current) => [
      ...current,
      {
        key: `new-${crypto.randomUUID()}`,
        source_item_id: null,
        ingredient_id: option.id,
        name_ru: option.name_ru,
        weight_g: 100,
        modelWeight: null,
        visible: true,
        nutrition_source: Object.keys(per100g).length > 0 ? "catalog" : "model",
        per100g,
      },
    ]);
    setAdding(false);
  }

  async function save() {
    setSaving(true);
    setError(null);

    const response = await fetch(`/api/meals/${mealId}/items`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        dish_name_ru: dishName,
        items: items.map((item) => ({
          source_item_id: item.source_item_id,
          ingredient_id: item.ingredient_id,
          name_ru: item.name_ru,
          weight_g: item.weight_g,
        })),
        removed_source_item_ids: removed,
      }),
    });

    const data = await response.json();
    setSaving(false);

    if (!response.ok) {
      setError(data.error ?? "Не удалось сохранить");
      return;
    }

    // FR-EDIT-8: модалка «Откуда вес?» — один раз на приём пищи, только если
    // пользователь что-то менял.
    if (data.should_ask_weight_evidence && !hasEvidence) {
      setEvidenceOpen(true);
      return;
    }
    finish();
  }

  function finish() {
    router.push(`/meal/${mealId}`);
    router.refresh();
  }

  return (
    <div className="px-4 pt-4">
      <header className="mb-3">
        <BackLink
          href={`/meal/${mealId}`}
          label="Приём пищи"
          confirmMessage={
            changed ? "Изменения не сохранены. Выйти без сохранения?" : null
          }
        />
      </header>

      {photoUrl && (
        <img
          src={photoUrl}
          alt="Фото блюда"
          className="mb-4 w-full rounded-2xl object-cover"
        />
      )}

      <label className="mb-1 block text-caption text-ink-secondary" htmlFor="dish">
        Блюдо
      </label>
      <input
        id="dish"
        value={dishName}
        onChange={(e) => setDishName(e.target.value)}
        className="tap-target mb-4 w-full rounded-xl bg-card px-3 py-2 text-body"
      />

      <div className="mb-4 rounded-2xl bg-card p-4">
        <label className="mb-1 block text-caption text-ink-secondary" htmlFor="total">
          Общий вес, г
        </label>
        <div className="flex items-center gap-2">
          <input
            id="total"
            type="text"
            inputMode="decimal"
            value={weightDraft ?? formatInputNumber(totalWeight, 0)}
            onChange={(e) => setWeightDraft(e.target.value)}
            onBlur={() => {
              if (weightDraft !== null) {
                applyTotalWeight(parseInputNumber(weightDraft));
                setWeightDraft(null);
              }
            }}
            className="tap-target w-32 rounded-xl bg-screen px-3 py-2 text-body"
          />
          {undoSnapshot && (
            <button
              type="button"
              onClick={undoRescale}
              className="tap-target flex items-center gap-1 text-caption text-accent"
            >
              <Undo2 size={16} /> Отменить пересчёт
            </button>
          )}
        </div>
        <p className="mt-1 text-micro text-ink-secondary">
          Изменение общего веса пропорционально пересчитает все ингредиенты.
        </p>
      </div>

      <NutrientPanel totals={totals} totalWeightG={totalWeight} />

      <h2 className="mt-6 mb-2 text-caption text-ink-secondary uppercase">
        Ингредиенты
      </h2>

      <ul aria-label="Ингредиенты" className="overflow-hidden rounded-2xl bg-card">
        {items.map((item) => {
          const isOpen = expanded === item.key;
          const kcal = ((item.per100g.energy_kcal ?? 0) * item.weight_g) / 100;
          const edited =
            item.modelWeight !== null &&
            Math.abs(item.modelWeight - item.weight_g) > 0.001;

          return (
            <li key={item.key} className="border-b border-separator last:border-0">
              <div className="flex items-center gap-2 p-3">
                <button
                  type="button"
                  onClick={() => setExpanded(isOpen ? null : item.key)}
                  aria-expanded={isOpen}
                  aria-label={`Подробнее: ${item.name_ru}`}
                  className="tap-target flex min-w-0 flex-1 items-center gap-2 text-left"
                >
                  {isOpen ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                  <span className="min-w-0">
                    <span className="block truncate text-body">
                      {item.name_ru}
                      {item.nutrition_source === "model" && (
                        <span
                          className="ml-1 text-warning"
                          title="Нутриенты из оценки модели, не из справочника"
                        >
                          ≈
                        </span>
                      )}
                    </span>
                    <span className="block text-micro text-ink-secondary">
                      {Math.round(kcal)} ккал
                      {!item.visible && " · выведено логически"}
                      {item.ingredient_id === null && " · нет в справочнике"}
                    </span>
                    {/* FR-EDIT-12: сверять и сравнивать продукты можно только
                        по значениям на 100 г — калории порции зависят от
                        оценки веса, которую мы как раз и правим. */}
                    <Per100gLine per100g={item.per100g} />
                  </span>
                </button>

                <input
                  type="text"
                  inputMode="decimal"
                  aria-label={`Вес: ${item.name_ru}`}
                  value={formatInputNumber(
                    item.weight_g,
                    item.weight_g % 1 === 0 ? 0 : 1,
                  )}
                  onChange={(e) =>
                    updateWeight(item.key, parseInputNumber(e.target.value))
                  }
                  className={`tap-target w-20 rounded-xl bg-screen px-2 py-2 text-right text-body tnum ${
                    edited ? "font-semibold" : ""
                  }`}
                />
                <span className="text-caption text-ink-secondary">г</span>

                <button
                  type="button"
                  onClick={() => removeItem(item)}
                  aria-label={`Удалить: ${item.name_ru}`}
                  className="tap-target flex items-center justify-center text-error"
                >
                  <Trash2 size={18} />
                </button>
              </div>

              {isOpen && (
                <div className="border-t border-separator px-3 pt-2 pb-3">
                  <input
                    type="range"
                    min={0}
                    max={Math.max(400, Math.round((item.modelWeight ?? item.weight_g) * 3))}
                    step={5}
                    value={item.weight_g}
                    onChange={(e) => updateWeight(item.key, Number(e.target.value))}
                    aria-label={`Быстрая правка веса: ${item.name_ru}`}
                    className="mb-3 w-full accent-accent"
                  />

                  {edited && item.modelWeight !== null && (
                    <p className="mb-2 text-caption text-ink-secondary">
                      Модель предлагала{" "}
                      <span className="line-through">
                        {formatNumber(item.modelWeight, 0)} г
                      </span>
                    </p>
                  )}

                  <ul className="mb-3 grid grid-cols-3 gap-2">
                    {[
                      { code: "protein", label: "Белки" },
                      { code: "fat", label: "Жиры" },
                      { code: "carbs", label: "Углеводы" },
                    ].map(({ code, label }) => (
                      <li key={code} className="rounded-xl bg-screen p-2 text-center">
                        <div className="tnum text-body">
                          {formatNutrient(
                            ((item.per100g[code] ?? 0) * item.weight_g) / 100,
                          )}
                        </div>
                        <div className="text-micro text-ink-secondary">{label}, г</div>
                      </li>
                    ))}
                  </ul>

                  {Object.keys(item.per100g).length > 4 && (
                    <details className="mb-3">
                      <summary className="tap-target cursor-pointer text-caption text-accent">
                        Полный состав нутриентов
                      </summary>
                      <ul className="mt-1 divide-y divide-separator">
                        {NUTRIENTS.filter((n) => item.per100g[n.code] !== undefined).map(
                          (n) => (
                            <li
                              key={n.code}
                              className="flex justify-between py-1 text-caption"
                            >
                              <span>{n.nameRu}</span>
                              <span className="tnum">
                                {formatNutrient(
                                  (item.per100g[n.code] * item.weight_g) / 100,
                                )}
                              </span>
                            </li>
                          ),
                        )}
                      </ul>
                    </details>
                  )}

                  {rebinding === item.key ? (
                    <IngredientSearch
                      autoFocus
                      initialQuery={item.name_ru}
                      onSelect={(option) => bindIngredient(item.key, option)}
                    />
                  ) : (
                    <button
                      type="button"
                      onClick={() => setRebinding(item.key)}
                      className="tap-target flex items-center gap-1 text-caption text-accent"
                    >
                      <Link2 size={16} />
                      {item.ingredient_id === null
                        ? "Привязать к справочнику"
                        : "Заменить ингредиент"}
                    </button>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ul>

      {adding ? (
        <div className="mt-3">
          <IngredientSearch autoFocus onSelect={addIngredient} />
          <button
            type="button"
            onClick={() => setAdding(false)}
            className="tap-target mt-2 text-caption text-ink-secondary"
          >
            Отмена
          </button>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setAdding(true)}
          className="tap-target mt-3 flex items-center gap-1 text-body text-accent"
        >
          <Plus size={18} /> Добавить ингредиент
        </button>
      )}

      {error && (
        <p className="mt-4 text-caption text-error" role="alert">
          {error}
        </p>
      )}

      <div className="mt-6 mb-4">
        <Button large onClick={save} disabled={saving} className="tap-target">
          {saving
            ? "Сохраняем…"
            : changed
              ? "Сохранить"
              : // FR-EDIT-9: «сохранить без изменений» — тоже ценный сигнал:
                // модель угадала.
                "Сохранить без изменений"}
        </Button>
      </div>

      <WeightEvidenceSheet
        mealId={mealId}
        opened={evidenceOpen}
        detectedReferences={detectedReferences}
        onClose={() => {
          setEvidenceOpen(false);
          finish();
        }}
      />
    </div>
  );
}
