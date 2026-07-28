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
}

export async function processMeal(params: ProcessMealParams): Promise<void> {
  const { supabase, mealId, userId, model, imageBase64, imageMimeType, userHint } =
    params;

  try {
    const recognition = await runRecognition({
      supabase,
      mealId,
      userId,
      model,
      imageBase64,
      imageMimeType,
      userHint,
      isPrimary: true,
    });

    if (recognition.status === "failed") {
      // Причина уже записана в `recognitions.error_text` (FR-LLM-3) — экран
      // приёма пищи покажет её рядом с кнопкой «Повторить» (FR-LLM-1).
      await supabase.from("meals").update({ status: "failed" }).eq("id", mealId);
      return;
    }

    // Первичная пользовательская версия = предложение модели (§5.1, шаг 11).
    await createInitialMealItems(supabase, mealId, recognition.items);

    const { data: dish } = await supabase
      .from("recognitions")
      .select("dish_name_ru")
      .eq("id", recognition.recognitionId)
      .single();

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
