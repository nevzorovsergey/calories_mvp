"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Button, Preloader } from "konsta/react";
import { createClient } from "@/lib/supabase/client";
import IngredientSearch, { type IngredientOption } from "@/components/IngredientSearch";
import {
  defaultWeight,
  loadCatalogEntry,
  type CatalogEntry,
} from "@/lib/catalog/entry";
import { formatInputNumber } from "@/lib/format";

/**
 * Добавление приёма пищи по справочнику, без фотографии.
 *
 * Поиск идёт и по сырью, и по готовым блюдам FNDDS (`kinds`), потому что здесь
 * человек описывает съеденное, а не чинит привязку распознанной позиции — в
 * отличие от экрана правки, где блюдо вместо ингредиента было бы ошибкой.
 *
 * Вес выбирается порцией, а не граммами. Это весь смысл затеи: «1 кусок» и
 * «1 стакан» человек знает, а сколько это граммов — нет, и именно поэтому до сих
 * пор фотографировал. Поле граммов остаётся для тех, кто взвесил.
 *
 * Состав блюда показывается сразу и только для чтения. КБЖУ при этом берётся у
 * самого блюда, а не суммированием компонентов: у FNDDS собственный профиль
 * точнее — он учитывает уварку, которой в раскладке нет.
 */
export default function CatalogAdd({ mealDate }: { mealDate: string }) {
  const router = useRouter();
  const supabase = useMemo(() => createClient(), []);

  const [entry, setEntry] = useState<CatalogEntry | null>(null);
  const [loading, setLoading] = useState(false);
  const [weight, setWeight] = useState(0);
  const [weightDraft, setWeightDraft] = useState<string | null>(null);
  const [portionSeq, setPortionSeq] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function select(option: IngredientOption) {
    setLoading(true);
    setError(null);
    const loaded = await loadCatalogEntry(supabase, option.id);
    setLoading(false);
    if (!loaded) {
      setError("Не удалось открыть позицию справочника");
      return;
    }
    setEntry(loaded);
    setWeight(defaultWeight(loaded));
    setWeightDraft(null);
    setPortionSeq(loaded.portions[0]?.seq ?? null);
  }

  function pickPortion(seq: number) {
    const portion = entry?.portions.find((p) => p.seq === seq);
    if (!portion) return;
    setPortionSeq(seq);
    setWeight(portion.gramWeight);
    setWeightDraft(null);
  }

  function editWeight(value: string) {
    setWeightDraft(value);
    const parsed = Number(value.replace(",", "."));
    if (Number.isFinite(parsed) && parsed > 0) {
      setWeight(parsed);
      // Ручной вес больше не соответствует ни одной порции — снимаем выбор,
      // иначе интерфейс утверждал бы, что это по-прежнему «1 стакан».
      setPortionSeq(null);
    }
  }

  function reset() {
    setEntry(null);
    setWeight(0);
    setWeightDraft(null);
    setPortionSeq(null);
    setError(null);
  }

  const kcal = entry ? ((entry.per100g.energy_kcal ?? 0) * weight) / 100 : 0;

  async function save() {
    if (!entry || weight <= 0) return;
    setSaving(true);
    setError(null);

    try {
      const created = await fetch("/api/meals/manual", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ meal_date: mealDate }),
      });
      const meal = (await created.json()) as { meal_id?: string; error?: string };
      if (!created.ok || !meal.meal_id) {
        throw new Error(meal.error ?? `Ошибка сервера (${created.status})`);
      }

      // Блюдо сохраняется одной позицией, а не раскладкой: КБЖУ берётся из его
      // собственного профиля. Разложить на ингредиенты можно потом на экране
      // правки — тогда состав станет редактируемым.
      const saved = await fetch(`/api/meals/${meal.meal_id}/items`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          dish_name_ru: entry.nameRu,
          items: [
            {
              ingredient_id: entry.id,
              name_ru: entry.nameRu,
              weight_g: weight,
            },
          ],
        }),
      });
      const result = (await saved.json()) as { error?: string };
      if (!saved.ok) {
        throw new Error(result.error ?? `Ошибка сервера (${saved.status})`);
      }

      router.push(`/meal/${meal.meal_id}`);
      router.refresh();
    } catch (err) {
      setSaving(false);
      setError(
        err instanceof Error ? `Не удалось сохранить: ${err.message}` : String(err),
      );
    }
  }

  if (!entry) {
    return (
      <div>
        <IngredientSearch
          autoFocus
          kinds={["ingredient", "dish"]}
          placeholder="Что вы съели?"
          onSelect={select}
        />
        {loading && (
          <p className="mt-3 text-caption text-ink-secondary" role="status">
            Открываем…
          </p>
        )}
        {error && (
          <p className="mt-3 text-caption text-error" role="alert">
            {error}
          </p>
        )}
        <p className="mt-4 text-caption text-ink-secondary">
          Найдите готовое блюдо или отдельный продукт. Вес можно указать порцией —
          «кусок», «стакан», «тарелка».
        </p>
      </div>
    );
  }

  return (
    <div>
      <div className="mb-4 rounded-2xl bg-card p-4">
        <p className="text-body font-medium">{entry.nameRu}</p>
        <p className="text-caption text-ink-secondary">{entry.nameEn}</p>
        {entry.category && (
          <p className="mt-1 text-caption text-ink-secondary">{entry.category}</p>
        )}
      </div>

      {entry.portions.length > 0 && (
        <>
          <h2 className="mb-2 text-caption text-ink-secondary uppercase">Порция</h2>
          <ul className="mb-4 overflow-hidden rounded-2xl bg-card">
            {entry.portions.map((portion) => (
              <li key={portion.seq} className="border-b border-separator last:border-0">
                <button
                  type="button"
                  aria-pressed={portionSeq === portion.seq}
                  onClick={() => pickPortion(portion.seq)}
                  className={`tap-target flex w-full items-center justify-between px-3 py-2 text-left ${
                    portionSeq === portion.seq ? "text-accent" : ""
                  }`}
                >
                  <span className="min-w-0 flex-1 truncate text-body">
                    {portion.label}
                  </span>
                  <span className="tnum ml-2 text-caption text-ink-secondary">
                    {formatInputNumber(portion.gramWeight, 0)} г
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </>
      )}

      <label className="mb-1 block text-caption text-ink-secondary" htmlFor="weight">
        Вес, г
      </label>
      <input
        id="weight"
        type="text"
        inputMode="decimal"
        value={weightDraft ?? formatInputNumber(weight, 0)}
        onChange={(e) => editWeight(e.target.value)}
        onBlur={() => setWeightDraft(null)}
        className="tap-target mb-4 w-full rounded-xl bg-card px-3 py-2 text-body"
      />

      <div className="mb-4 flex items-baseline justify-between rounded-2xl bg-card p-4">
        <span className="text-caption text-ink-secondary">Калорийность</span>
        <span className="tnum text-section font-semibold">
          {Math.round(kcal)}
          <span className="ml-1 text-caption font-normal text-ink-secondary">ккал</span>
        </span>
      </div>

      {entry.components.length > 0 && (
        <>
          <h2 className="mb-2 text-caption text-ink-secondary uppercase">Состав</h2>
          <ul className="mb-4 overflow-hidden rounded-2xl bg-card">
            {entry.components.map((component) => (
              <li
                key={component.seq}
                className="flex items-center justify-between border-b border-separator px-3 py-2 last:border-0"
              >
                <span className="min-w-0 flex-1 truncate text-body">
                  {component.name}
                </span>
                <span className="tnum ml-2 text-caption text-ink-secondary">
                  {formatInputNumber(component.share * weight, 0)} г
                </span>
              </li>
            ))}
          </ul>
        </>
      )}

      {error && (
        <p className="mb-3 text-caption text-error" role="alert">
          {error}
        </p>
      )}

      {saving ? (
        <div className="flex items-center justify-center gap-2 py-4">
          <Preloader />
          <span className="text-body" role="status">
            Сохраняем…
          </span>
        </div>
      ) : (
        <div className="flex gap-2 pb-8">
          <Button outline onClick={reset} className="tap-target">
            Другое блюдо
          </Button>
          <Button onClick={save} className="tap-target" disabled={weight <= 0}>
            Добавить
          </Button>
        </div>
      )}
    </div>
  );
}
