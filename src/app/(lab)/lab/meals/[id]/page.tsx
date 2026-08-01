/* eslint-disable @next/next/no-img-element */

import Link from "next/link";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { loadMealReview, PORTION_SIZE_RU } from "@/lib/data/lab-meal";
import { formatNumber, formatTime } from "@/lib/format";
import { formatPercent } from "@/lib/data/lab";
import { referenceObjectLabel, weightMethodLabel } from "@/lib/weight-evidence";
import VerdictBadge from "@/components/lab/VerdictBadge";
import ConfidenceStars from "@/components/lab/ConfidenceStars";

/**
 * Разбор одного приёма пищи (FR-LABX-7).
 *
 * Экран показывает три слоя, которые схема хранит отдельно и никогда не
 * перезаписывает друг другом (§1.3 PRD): предложение модели, версию человека и
 * его же рассказ о том, откуда он взял вес. Порядок на странице обратный
 * хронологическому — сначала итог, потом как к нему пришли: разбирают ведь
 * всегда от результата.
 */
export const dynamic = "force-dynamic";

const SCALE_MODE_RU: Record<string, string> = {
  reference: "по эталонному объекту",
  container: "по типовому размеру посуды",
  prior: "по общему представлению о порции",
};

const FLAG_RU: Record<string, string> = {
  scale_mismatch: "масштаб не сходится с якорем",
  volume_mismatch: "объём не сходится с размерами пятна еды",
  mass_mismatch: "масса не сходится с объёмом и плотностью",
  anchor_incomplete: "режим «по эталону», но чисел якоря нет",
};

const ORIGIN_RU: Record<string, string> = {
  model_kept: "как у модели",
  model_edited: "изменено",
  user_added: "добавлено человеком",
  catalog_dish: "из раскладки блюда",
};

export default async function LabMealPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const supabase = await createClient();
  const meal = await loadMealReview(supabase, id);
  if (!meal) notFound();

  const removedIds = new Set(meal.removed.map((r) => r.source_item_id));
  const userBySource = new Map(
    meal.items.filter((i) => i.source_item_id).map((i) => [i.source_item_id!, i]),
  );

  return (
    <div className="max-w-6xl">
      <Link href={`/lab/meals?user=${meal.user_id}`} className="text-caption text-accent">
        ← Приёмы пищи · {meal.display_name}
      </Link>

      <div className="mt-2 mb-4 flex flex-wrap items-baseline gap-2">
        <h1 className="text-title font-semibold">
          {meal.dish_name_ru ?? "Без названия"}
        </h1>
        <VerdictBadge verdict={meal.verdict} />
      </div>
      <p className="mb-4 text-caption text-ink-secondary">
        {meal.display_name} · {meal.meal_date}, {formatTime(meal.eaten_at)} · статус «
        {meal.status}» ·{" "}
        <Link href={`/meal/${meal.id}`} className="text-accent">
          открыть как пользователь
        </Link>
      </p>

      <div className="grid gap-4 md:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
        <div>
          {meal.photoUrl ? (
            <img
              src={meal.photoUrl}
              alt="Фотография приёма пищи"
              className="w-full rounded-2xl object-cover"
            />
          ) : (
            <div className="rounded-2xl bg-card p-6 text-center text-caption text-ink-secondary">
              Фотографии нет — приём пищи добавлен из справочника.
            </div>
          )}
          {meal.photoUrl && (
            <p className="mt-1 text-micro text-ink-secondary">
              {meal.photo_width && meal.photo_height
                ? `${meal.photo_width}×${meal.photo_height} px`
                : "размер не записан"}
              {meal.photo_sha256 && ` · sha256 ${meal.photo_sha256.slice(0, 12)}…`}
            </p>
          )}
          {meal.user_hint && (
            <div className="mt-3 rounded-2xl bg-card p-3">
              <h2 className="mb-1 text-caption text-ink-secondary uppercase">
                Подсказка перед распознаванием
              </h2>
              <p className="text-body">«{meal.user_hint}»</p>
            </div>
          )}
        </div>

        <div className="grid gap-4">
          {/* ── Что человек записал в итоге ─────────────────────────────── */}
          <section className="rounded-2xl bg-card p-4">
            <h2 className="mb-2 text-caption text-ink-secondary uppercase">
              Версия человека
            </h2>
            <p className="tnum mb-3 text-section font-semibold">
              {meal.userWeightG === null ? "—" : formatNumber(meal.userWeightG, 0)} г
              <span className="ml-2 text-body font-normal text-ink-secondary">
                {meal.userKcal === null ? "" : `${formatNumber(meal.userKcal, 0)} ккал`}
              </span>
            </p>

            {meal.selected_dish_name && (
              <p className="mb-2 text-caption">
                Выбрано блюдо: <strong>{meal.selected_dish_name}</strong>
                {meal.selected_candidate_position !== null &&
                  ` — вариант ${meal.selected_candidate_position} из трёх`}
                {meal.selected_portion_size &&
                  `, порция ${PORTION_SIZE_RU[meal.selected_portion_size] ?? meal.selected_portion_size}`}
              </p>
            )}

            {meal.items.length === 0 ? (
              <p className="text-caption text-ink-secondary">Состава нет.</p>
            ) : (
              <ul className="divide-y divide-separator text-caption">
                {meal.items.map((item) => (
                  <li key={item.id} className="flex items-baseline justify-between py-1">
                    <span className="min-w-0 flex-1 truncate">
                      {item.ingredient_id ? (
                        <Link
                          href={`/lab/catalog/${item.ingredient_id}`}
                          className="text-accent"
                        >
                          {item.name_ru}
                        </Link>
                      ) : (
                        <>
                          {item.name_ru}
                          <span className="ml-1 text-warning" title="Нет в справочнике">
                            ≈
                          </span>
                        </>
                      )}
                      <span className="ml-2 text-micro text-ink-secondary">
                        {ORIGIN_RU[item.origin] ?? item.origin}
                      </span>
                    </span>
                    <span className="tnum ml-2 shrink-0">
                      {formatNumber(item.weight_g, 0)} г
                      {item.original_weight_g !== null && (
                        <span className="ml-1 text-ink-secondary line-through">
                          {formatNumber(item.original_weight_g, 0)}
                        </span>
                      )}
                    </span>
                  </li>
                ))}
                {meal.removed.map((removed) => (
                  <li
                    key={removed.source_item_id}
                    className="flex items-baseline justify-between py-1 text-ink-secondary"
                  >
                    <span className="min-w-0 flex-1 truncate line-through">
                      {removed.name_ru}
                    </span>
                    <span className="tnum ml-2 shrink-0 text-error">
                      {formatNumber(removed.weight_g, 0)} г удалено
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          {/* ── Что человек рассказал о весе ────────────────────────────── */}
          <section className="rounded-2xl bg-card p-4">
            <h2 className="mb-2 text-caption text-ink-secondary uppercase">
              Откуда вес
            </h2>
            {meal.evidence === null ? (
              <p className="text-caption text-ink-secondary">
                Модалку не показывали или человек её закрыл. Это штатный исход:
                вопрос задаётся один раз и только после правок (FR-EDIT-8).
              </p>
            ) : (
              <dl className="text-caption">
                <Row
                  label="Как определил вес"
                  value={weightMethodLabel(meal.evidence.method)}
                />
                <div className="flex justify-between gap-3 border-b border-separator py-1">
                  <dt className="text-ink-secondary">Насколько уверен</dt>
                  <dd>
                    <ConfidenceStars value={meal.evidence.self_confidence} asked />
                  </dd>
                </div>
                <Row
                  label="Эталон в кадре"
                  value={meal.evidence.had_reference ? "был" : "не было"}
                />
                <Row
                  label="Что именно было в кадре"
                  value={
                    meal.evidence.reference_objects.length === 0
                      ? "—"
                      : meal.evidence.reference_objects
                          .map(referenceObjectLabel)
                          .join(", ")
                  }
                />
                {meal.evidence.comment && (
                  <Row label="Комментарий" value={meal.evidence.comment} />
                )}
              </dl>
            )}
          </section>
        </div>
      </div>

      {/* ── Что предлагали модели ──────────────────────────────────────── */}
      <h2 className="mt-6 mb-2 text-caption text-ink-secondary uppercase">
        Распознавания ({meal.recognitions.length})
      </h2>

      {meal.recognitions.length === 0 ? (
        <p className="mb-6 rounded-2xl bg-card p-4 text-caption text-ink-secondary">
          Распознаваний не было.
        </p>
      ) : (
        <div className="mb-6 grid gap-4 xl:grid-cols-2">
          {meal.recognitions.map((recognition) => {
            const flags = (recognition.scale_chain?.consistency_flags ?? []) as string[];
            const modelKcal = recognition.nutrition_catalog?.energy_kcal ?? null;

            return (
              <section key={recognition.id} className="rounded-2xl bg-card p-4">
                <div className="mb-2 flex flex-wrap items-baseline gap-2">
                  <h3 className="font-medium">{recognition.model_label}</h3>
                  <span className="text-micro text-ink-secondary">
                    {recognition.prompt_version} · {recognition.vendor}
                  </span>
                  {recognition.is_primary && (
                    <span className="rounded-md bg-accent/15 px-2 py-0.5 text-micro text-accent">
                      основное
                    </span>
                  )}
                  {recognition.status !== "ok" && (
                    <span className="rounded-md bg-error/15 px-2 py-0.5 text-micro text-error">
                      {recognition.status}
                    </span>
                  )}
                </div>

                {recognition.error_text && (
                  <p className="mb-2 text-caption text-error">
                    {recognition.error_text}
                  </p>
                )}

                <dl className="mb-3 text-caption">
                  <Row
                    label="Назвала блюдо"
                    value={recognition.dish_name_ru ?? "—"}
                  />
                  <Row
                    label="Вес"
                    value={
                      recognition.total_weight_g === null
                        ? "—"
                        : `${formatNumber(recognition.total_weight_g, 0)} г${
                            meal.userWeightG && meal.userWeightG > 0 &&
                            recognition.total_weight_g !== null
                              ? ` · ошибка ${formatPercent(Math.abs(recognition.total_weight_g - meal.userWeightG) / meal.userWeightG)}`
                              : ""
                          }`
                    }
                  />
                  <Row
                    label="Калорийность"
                    value={modelKcal === null ? "—" : `${formatNumber(modelKcal, 0)} ккал`}
                  />
                  {recognition.portion_size && (
                    <Row
                      label="Размер порции"
                      value={`${PORTION_SIZE_RU[recognition.portion_size] ?? recognition.portion_size}${
                        recognition.portion_reasoning
                          ? ` — ${recognition.portion_reasoning}`
                          : ""
                      }`}
                    />
                  )}
                  {recognition.scale_mode && (
                    <Row
                      label="Масштаб"
                      value={
                        SCALE_MODE_RU[recognition.scale_mode] ?? recognition.scale_mode
                      }
                    />
                  )}
                  {recognition.scale_size_error !== null && (
                    <Row
                      label="Ошибка в размере эталона"
                      value={formatPercent(Number(recognition.scale_size_error))}
                    />
                  )}
                  {recognition.scale_chain !== null && (
                    <div className="flex justify-between gap-3 border-b border-separator py-1">
                      <dt className="text-ink-secondary">Согласованность цепочки</dt>
                      <dd
                        className={`text-right ${flags.length > 0 ? "text-warning" : "text-success"}`}
                      >
                        {flags.length === 0
                          ? "числа сходятся"
                          : flags.map((f) => FLAG_RU[f] ?? f).join("; ")}
                      </dd>
                    </div>
                  )}
                  <Row
                    label="Латентность"
                    value={
                      recognition.latency_ms === null
                        ? "—"
                        : `${(recognition.latency_ms / 1000).toFixed(1)} с`
                    }
                  />
                  <Row
                    label="Стоимость"
                    value={[
                      recognition.cost_rub_actual !== null &&
                        `${Number(recognition.cost_rub_actual).toFixed(3)} ₽`,
                      recognition.cost_direct_usd !== null &&
                        `${Number(recognition.cost_direct_usd).toFixed(4)} $ напрямую`,
                    ]
                      .filter(Boolean)
                      .join(" · ") || "—"}
                  />
                  {(recognition.prompt_tokens !== null ||
                    recognition.completion_tokens !== null) && (
                    <Row
                      label="Токены"
                      value={`${recognition.prompt_tokens ?? 0} → ${recognition.completion_tokens ?? 0}`}
                    />
                  )}
                </dl>

                {recognition.candidates.length > 0 && (
                  <>
                    <h4 className="mb-1 text-micro text-ink-secondary uppercase">
                      Варианты названия
                    </h4>
                    <ul className="mb-3 divide-y divide-separator text-caption">
                      {recognition.candidates.map((candidate) => (
                        <li key={candidate.position} className="py-1">
                          <div className="flex items-baseline justify-between gap-2">
                            <span className="min-w-0 flex-1 truncate">
                              {candidate.position}. {candidate.name_ru}
                              {candidate.chosen && (
                                <span className="ml-2 text-success">← выбран</span>
                              )}
                              {candidate.ingredient_id === null && (
                                <span
                                  className="ml-1 text-warning"
                                  title="Название не нашлось в справочнике"
                                >
                                  ≈
                                </span>
                              )}
                            </span>
                            <span className="tnum shrink-0 text-ink-secondary">
                              {candidate.confidence === null
                                ? "—"
                                : formatPercent(candidate.confidence)}
                            </span>
                          </div>
                          {candidate.why && (
                            <p className="text-micro text-ink-secondary">
                              {candidate.why}
                            </p>
                          )}
                        </li>
                      ))}
                    </ul>
                  </>
                )}

                {recognition.items.length > 0 && (
                  <>
                    <h4 className="mb-1 text-micro text-ink-secondary uppercase">
                      Состав, предложенный моделью
                    </h4>
                    <ul className="divide-y divide-separator text-caption">
                      {recognition.items.map((item) => {
                        const user = userBySource.get(item.id);
                        const wasRemoved = removedIds.has(item.id);
                        const changed =
                          user && Math.abs(user.weight_g - item.weight_g) > 0.001;

                        return (
                          <li
                            key={item.id}
                            className="flex items-baseline justify-between py-1"
                          >
                            <span
                              className={`min-w-0 flex-1 truncate ${wasRemoved ? "text-ink-secondary line-through" : ""}`}
                            >
                              {item.name_ru}
                              {item.visible === false && (
                                <span className="ml-1 text-micro text-ink-secondary">
                                  (выведено логически)
                                </span>
                              )}
                              {item.match_status === "unmatched" ? (
                                <span className="ml-1 text-warning" title="Нет в справочнике">
                                  ≈
                                </span>
                              ) : (
                                <span className="ml-1 text-micro text-ink-secondary">
                                  {item.match_status}
                                  {item.match_score !== null &&
                                    ` ${Number(item.match_score).toFixed(2)}`}
                                </span>
                              )}
                            </span>
                            <span className="tnum ml-2 shrink-0">
                              {formatNumber(item.weight_g, 0)} г
                              {changed && (
                                <span className="ml-1 font-semibold">
                                  → {formatNumber(user!.weight_g, 0)}
                                </span>
                              )}
                              {wasRemoved && (
                                <span className="ml-1 text-micro text-error">удалено</span>
                              )}
                            </span>
                          </li>
                        );
                      })}
                    </ul>
                  </>
                )}
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-3 border-b border-separator py-1 last:border-0">
      <dt className="shrink-0 text-ink-secondary">{label}</dt>
      <dd className="min-w-0 text-right">{value}</dd>
    </div>
  );
}
