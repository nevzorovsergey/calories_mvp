import { after, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getIngredientsModel } from "@config/models";
import { processMeal } from "@/lib/recognition/process";

/**
 * Запасной путь с экрана выбора блюда: «распознать состав нейросетью».
 *
 * Нужного названия среди трёх не оказалось — значит справочник этого блюда не
 * знает, и спрашивать модель надо не «что это?», а «из чего это и сколько
 * весит», как до справочника. По той же фотографии, что уже лежит в Storage.
 *
 * Отдельный роут, а не флаг к `recognize`: тот заведён для сравнения моделей и
 * намеренно не трогает ни пользовательскую версию, ни `primary_recognition_id`
 * (FR-CMP-5). Здесь всё наоборот — новый разбор становится основой приёма пищи
 * и порождает первичные `meal_items`.
 *
 * Три названия и их привязка к справочнику остаются в базе нетронутыми:
 * «пользователь не нашёл своё блюдо среди предложенных» — это и есть замер H7,
 * и стирать его вместе с попыткой было бы стиранием отрицательного результата.
 */
export const maxDuration = 300;
export const dynamic = "force-dynamic";

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: mealId } = await params;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Не авторизован" }, { status: 401 });
  }

  const { data: meal, error: mealError } = await supabase
    .from("meals")
    .select("id, user_id, status, photo_sent_path, user_hint")
    .eq("id", mealId)
    .single();
  if (mealError || !meal) {
    return NextResponse.json({ error: "Приём пищи не найден" }, { status: 404 });
  }
  // Только с экрана выбора: из 'processing' это была бы вторая модель по тому
  // же фото одновременно с первой, из 'ready' — молчаливая замена состава,
  // который пользователь уже видел и, возможно, правил.
  if (meal.status !== "awaiting_choice") {
    return NextResponse.json(
      { error: "Состав можно распознать только пока блюдо не выбрано" },
      { status: 409 },
    );
  }

  const model = getIngredientsModel();

  // Статус меняем до ответа: экран сразу перерисуется в «Распознаём состав» с
  // опросом, и повторное нажатие упрётся в проверку выше.
  const { data: taken, error: statusError } = await supabase
    .from("meals")
    .update({ status: "processing" })
    .eq("id", mealId)
    .eq("status", "awaiting_choice")
    .select("id")
    .maybeSingle();
  if (statusError) {
    return NextResponse.json({ error: statusError.message }, { status: 500 });
  }
  if (!taken) {
    return NextResponse.json({ error: "Это не ваш приём пищи" }, { status: 403 });
  }

  after(async () => {
    // Сервисный клиент: ответ уже отправлен, cookie сессии обновлять некуда.
    // Владельца проверил `update` выше — он прошёл через RLS.
    const admin = createAdminClient();
    try {
      const { data: file, error: downloadError } = await admin.storage
        .from("meals")
        .download(meal.photo_sent_path as string);
      if (downloadError || !file) {
        throw new Error(`не удалось прочитать фото: ${downloadError?.message}`);
      }

      await processMeal({
        supabase: admin,
        mealId,
        userId: meal.user_id as string,
        model,
        imageBase64: Buffer.from(await file.arrayBuffer()).toString("base64"),
        imageMimeType: file.type || "image/jpeg",
        userHint: (meal.user_hint as string | null) ?? null,
        // Автоматический прогон при съёмке был первым, этот запросил человек.
        isPrimary: false,
        // Модель не ответила — возвращаем на экран выбора: три названия никуда
        // не делись, и они всё ещё лучше, чем пустой экран с ошибкой.
        statusOnFailure: "awaiting_choice",
      });
    } catch (error) {
      console.error("ingredients fallback failed", mealId, error);
      await admin
        .from("meals")
        .update({ status: "awaiting_choice" })
        .eq("id", mealId);
    }
  });

  return NextResponse.json({
    meal_id: mealId,
    status: "processing",
    model: { id: model.id, label: model.label, prompt_version: model.promptVersion },
  });
}
