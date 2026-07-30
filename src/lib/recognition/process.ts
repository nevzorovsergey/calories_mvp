import type { SupabaseClient } from "@supabase/supabase-js";
import type { ModelConfig } from "@config/models";
import { runRecognition } from "./run";
import { createInitialMealItems } from "./meal-items";

/**
 * Фоновая часть потока «сделать фото → получить состав»: шаги 5–11 из §5.1.
 *
 * Вынесена из обработчика `POST /api/meals`, потому что теперь выполняется уже
 * после того, как ответ отправлен пользователю (`after()` из next/server).
 * Отсюда два следствия, которые определяют устройство функции:
 *
 * 1. Возвращать наверх нечего — жаловаться уже некому. Любая неудача обязана
 *    осесть в `meals.status = 'failed'`, иначе приём пищи навсегда останется
 *    в `processing`, и пользователь получит вечное «Распознаём…» вместо
 *    честного «не получилось, повторить».
 * 2. Клиент Supabase сюда нужно передавать сервисный, а не запросный: у
 *    запросного за спиной живут cookie сессии, а после отправки ответа
 *    записывать их уже некуда. Пользователя к этому моменту проверил вызывающий.
 */
export interface ProcessMealParams {
  supabase: SupabaseClient;
  mealId: string;
  userId: string;
  model: ModelConfig;
  imageBase64: string;
  imageMimeType: string;
  userHint: string | null;
  /**
   * Автоматический прогон при съёмке. Запасной разбор на ингредиенты — уже не
   * он: его запросил человек, и `is_primary` (по схеме — «автоматический при
   * съёмке») обязан остаться у первого. За основу берётся всё равно новый —
   * это `meals.primary_recognition_id`, и он ставится ниже независимо от флага.
   */
  isPrimary?: boolean;
  /**
   * Куда откатить приём пищи, если модель не ответила. По умолчанию 'failed' —
   * экран с причиной и кнопкой «Повторить». Запасной разбор передаёт сюда
   * 'awaiting_choice': там уже лежат три названия от первой модели, и терять
   * их из-за сбоя второй нельзя — выбор блюда должен остаться доступным.
   */
  statusOnFailure?: string;
}

export async function processMeal(params: ProcessMealParams): Promise<void> {
  const { supabase, mealId, userId, model, imageBase64, imageMimeType, userHint } =
    params;
  const statusOnFailure = params.statusOnFailure ?? "failed";

  try {
    const recognition = await runRecognition({
      supabase,
      mealId,
      userId,
      model,
      imageBase64,
      imageMimeType,
      userHint,
      isPrimary: params.isPrimary ?? true,
    });

    if (recognition.status === "failed") {
      // Причина уже записана в `recognitions.error_text` (FR-LLM-3) — экран
      // приёма пищи покажет её рядом с кнопкой «Повторить» (FR-LLM-1).
      await supabase
        .from("meals")
        .update({ status: statusOnFailure })
        .eq("id", mealId);
      return;
    }

    const { data: dish } = await supabase
      .from("recognitions")
      .select("dish_name_ru")
      .eq("id", recognition.recognitionId)
      .single();

    // v3-dish: состава ещё нет и до выбора пользователя не будет. Статус
    // 'awaiting_choice', а не 'ready': приём пищи без состава, помеченный
    // готовым, попал бы в дневной итог нулём — то есть выглядел бы как честно
    // посчитанная еда без калорий.
    //
    // Условие по версии промпта, а не по числу кандидатов: пустая тройка — это
    // «модель не поняла, что на фото», и такой приём пищи обязан доехать до
    // экрана выбора, где есть запасной разбор состава и ручной ввод. По
    // прошлому условию он молча становился 'ready' с нулевым составом.
    if (model.promptVersion === "v3-dish") {
      await supabase
        .from("meals")
        .update({
          status: "awaiting_choice",
          primary_recognition_id: recognition.recognitionId,
          dish_name_ru: dish?.dish_name_ru ?? null,
        })
        .eq("id", mealId);
      return;
    }

    // Первичная пользовательская версия = предложение модели (§5.1, шаг 11).
    await createInitialMealItems(supabase, mealId, recognition.items);

    await supabase
      .from("meals")
      .update({
        status: "ready",
        primary_recognition_id: recognition.recognitionId,
        dish_name_ru: dish?.dish_name_ru ?? null,
      })
      .eq("id", mealId);
  } catch (error) {
    console.error("processMeal failed", mealId, error);
    await supabase.from("meals").update({ status: "failed" }).eq("id", mealId);
  }
}
