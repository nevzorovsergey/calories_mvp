/* eslint-disable @next/next/no-img-element */

import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { computeTotals, getMealItems, signPhoto } from "@/lib/data/meals";
import { formatMealDate, formatNumber, formatTime, localDateIso } from "@/lib/format";
import NutrientPanel from "@/components/NutrientPanel";
import ModelRerun from "@/components/ModelRerun";
import DeleteMealButton from "@/components/DeleteMealButton";
import ModelProposal from "@/components/ModelProposal";
import ComparisonTable from "@/components/ComparisonTable";
import { getEnabledModels } from "@config/models";

/**
 * Детальный экран приёма пищи (§11.6) и сравнение моделей (§11.7).
 */
export const dynamic = "force-dynamic";

export default async function MealPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: meal } = await supabase
    .from("meals")
    .select(
      "id, meal_date, eaten_at, status, dish_name_ru, photo_sent_path, user_hint, primary_recognition_id",
    )
    .eq("id", id)
    .single();
  if (!meal) notFound();

  const [items, photoUrl] = await Promise.all([
    getMealItems(supabase, id),
    signPhoto(supabase, meal.photo_sent_path),
  ]);
  const totals = await computeTotals(supabase, items);

  const { data: recognitions } = await supabase
    .from("recognitions")
    .select(
      "id, model_id, model_label, prompt_version, status, error_text, is_primary, total_weight_g, nutrition_catalog, scale_mode, has_scale_ref, scale_size_error, scale_chain, latency_ms, created_at",
    )
    .eq("meal_id", id)
    .order("created_at");

  const okRecognitions = (recognitions ?? []).filter((r) => r.status === "ok");
  const primary = okRecognitions.find((r) => r.id === meal.primary_recognition_id);

  // Позиции всех успешных распознаваний: нужны и для блока «что предложила
  // модель», и для построчного сравнения составов (FR-CMP-2).
  const { data: allRecognitionItems } = await supabase
    .from("recognition_items")
    .select("id, recognition_id, name_ru, weight_g, visible, match_status, ingredient_id, position")
    .in(
      "recognition_id",
      okRecognitions.map((r) => r.id),
    )
    .order("position");

  const itemsByRecognition = new Map<string, typeof allRecognitionItems>();
  for (const item of allRecognitionItems ?? []) {
    const list = itemsByRecognition.get(item.recognition_id as string) ?? [];
    list.push(item);
    itemsByRecognition.set(item.recognition_id as string, list);
  }
  const primaryItems = primary ? (itemsByRecognition.get(primary.id) ?? []) : [];

  const untouched = items.every((i) => i.origin === "model_kept");
  const today = localDateIso();

  // Модели для перепрогона: enabled, исключая уже прогнанные варианты (FR-DET-4).
  const alreadyRun = new Set(
    (recognitions ?? []).map((r) => `${r.model_id}@${r.prompt_version}`),
  );
  const availableModels = getEnabledModels()
    .filter((m) => !alreadyRun.has(`${m.id}@${m.promptVersion}`))
    .map((m) => ({
      id: m.id,
      label: m.label,
      promptVersion: m.promptVersion,
    }));

  if (meal.status === "failed" || okRecognitions.length === 0) {
    const lastError = (recognitions ?? []).at(-1)?.error_text;
    return (
      <div className="px-4 pt-4">
        {photoUrl && (
          <img src={photoUrl} alt="Фото блюда" className="mb-4 w-full rounded-2xl" />
        )}
        <div className="rounded-2xl bg-card p-4">
          <h1 className="mb-1 text-section font-semibold">Не получилось распознать</h1>
          <p className="mb-3 text-caption text-ink-secondary">
            Модель не ответила или вернула непонятный результат. Можно повторить
            другой моделью или ввести состав руками — фотография сохранена.
          </p>
          {lastError && (
            <p className="mb-3 text-micro text-ink-secondary">Причина: {lastError}</p>
          )}
          <div className="flex flex-wrap gap-2">
            <ModelRerun mealId={id} models={availableModels} label="Повторить" />
            <Link
              href={`/meal/${id}/edit`}
              className="tap-target inline-flex items-center rounded-xl bg-card px-4 py-2 text-accent"
            >
              Ввести вручную
            </Link>
          </div>
        </div>
        <div className="mt-4">
          <DeleteMealButton mealId={id} />
        </div>
      </div>
    );
  }

  return (
    <div className="px-4 pt-4">
      {photoUrl && (
        <img
          src={photoUrl}
          alt="Фото блюда"
          className="mb-4 w-full rounded-2xl object-cover"
        />
      )}

      <h1 className="text-section font-semibold">
        {meal.dish_name_ru ?? "Без названия"}
      </h1>
      <p className="mb-4 text-caption text-ink-secondary">
        {formatMealDate(meal.meal_date, today)}, {formatTime(meal.eaten_at)} ·{" "}
        {formatNumber(
          items.reduce((sum, i) => sum + Number(i.weight_g), 0),
          0,
        )}{" "}
        г
        {untouched && " · состав как предложила модель"}
      </p>

      <NutrientPanel totals={totals} estimated={untouched} />

      <h2 className="mt-6 mb-2 text-caption text-ink-secondary uppercase">Состав</h2>
      <ul className="overflow-hidden rounded-2xl bg-card">
        {items.map((item) => (
          <li
            key={item.id}
            className="flex items-baseline justify-between border-b border-separator p-3 last:border-0"
          >
            <span className="min-w-0 flex-1 truncate">
              {item.name_ru}
              {item.nutrition_source === "model" && (
                <span className="ml-1 text-warning" title="Оценка модели">
                  ≈
                </span>
              )}
            </span>
            <span className="tnum ml-2">
              {item.origin === "model_edited" && item.original_weight_g !== null ? (
                <>
                  <span className="font-semibold">
                    {formatNumber(Number(item.weight_g), 0)} г
                  </span>
                  <span className="ml-1 text-caption text-ink-secondary line-through">
                    {formatNumber(Number(item.original_weight_g), 0)}
                  </span>
                </>
              ) : (
                <span className={item.origin === "model_kept" ? "text-warning" : ""}>
                  {item.origin === "model_kept" && <span aria-hidden>≈</span>}
                  {formatNumber(Number(item.weight_g), 0)} г
                </span>
              )}
            </span>
          </li>
        ))}
      </ul>

      <div className="mt-4 flex flex-wrap gap-2">
        <Link
          href={`/meal/${id}/edit`}
          className="tap-target inline-flex items-center rounded-xl bg-accent px-4 py-2 text-white"
        >
          Редактировать
        </Link>
        <ModelRerun mealId={id} models={availableModels} />
      </div>

      {primary && (
        <ModelProposal
          recognition={{
            model_label: primary.model_label,
            prompt_version: primary.prompt_version,
            total_weight_g: Number(primary.total_weight_g),
            scale_mode: primary.scale_mode,
            scale_size_error: primary.scale_size_error,
            scale_chain: primary.scale_chain as Record<string, unknown> | null,
            latency_ms: primary.latency_ms,
          }}
          modelItems={primaryItems.map((i) => ({
            id: i.id as string,
            name_ru: i.name_ru as string,
            weight_g: Number(i.weight_g),
            visible: i.visible as boolean,
            match_status: i.match_status as string,
          }))}
          userItems={items.map((i) => ({
            source_item_id: i.source_item_id,
            name_ru: i.name_ru,
            weight_g: Number(i.weight_g),
            origin: i.origin,
          }))}
        />
      )}

      {okRecognitions.length > 1 && (
        <ComparisonTable
          recognitions={okRecognitions.map((r) => ({
            id: r.id,
            model_label: r.model_label,
            prompt_version: r.prompt_version,
            total_weight_g: Number(r.total_weight_g),
            nutrition: (r.nutrition_catalog ?? {}) as Record<string, number>,
            scale_mode: r.scale_mode,
            latency_ms: r.latency_ms,
            items: (itemsByRecognition.get(r.id) ?? []).map((i) => ({
              name_ru: i.name_ru as string,
              weight_g: Number(i.weight_g),
              ingredient_id: (i.ingredient_id as number | null) ?? null,
            })),
          }))}
          userTotals={totals}
          userWeight={items.reduce((sum, i) => sum + Number(i.weight_g), 0)}
          userItems={items.map((i) => ({
            name_ru: i.name_ru,
            weight_g: Number(i.weight_g),
            ingredient_id: i.ingredient_id,
          }))}
        />
      )}

      <div className="mt-6 mb-4">
        <DeleteMealButton mealId={id} />
      </div>
    </div>
  );
}
