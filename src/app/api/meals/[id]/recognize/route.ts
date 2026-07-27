import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getModel } from "@config/models";
import { runRecognition } from "@/lib/recognition/run";

/**
 * Перепрогон другой моделью (FR-DET-4, §11.7).
 *
 * Использует ТОТ ЖЕ файл `photo_sent_path`, который отправлялся первой модели —
 * иначе сравнение недействительно (FR-CMP-4). Пользовательскую версию и
 * `primary_recognition_id` не меняет (FR-CMP-5).
 */
export const maxDuration = 300;
export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
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

  const body = (await request.json()) as {
    model_id?: string;
    prompt_version?: string;
  };
  if (!body.model_id) {
    return NextResponse.json({ error: "Не указан model_id" }, { status: 400 });
  }

  const model = getModel(body.model_id, body.prompt_version);
  if (!model) {
    return NextResponse.json(
      { error: `Модель ${body.model_id} отсутствует в конфиге` },
      { status: 400 },
    );
  }
  if (!model.enabled) {
    // FR-CONF-3: выключенная модель недоступна для нового прогона, но её
    // прошлые результаты остаются в истории.
    return NextResponse.json({ error: "Модель выключена" }, { status: 400 });
  }

  const { data: meal, error: mealError } = await supabase
    .from("meals")
    .select("id, user_id, photo_sent_path, user_hint")
    .eq("id", mealId)
    .single();
  if (mealError || !meal) {
    return NextResponse.json({ error: "Приём пищи не найден" }, { status: 404 });
  }

  const { data: file, error: downloadError } = await supabase.storage
    .from("meals")
    .download(meal.photo_sent_path);
  if (downloadError || !file) {
    return NextResponse.json(
      { error: `Не удалось прочитать фото: ${downloadError?.message}` },
      { status: 500 },
    );
  }

  const imageBase64 = Buffer.from(await file.arrayBuffer()).toString("base64");

  try {
    const recognition = await runRecognition({
      supabase,
      mealId,
      // Эталоны берём владельца приёма пищи, а не того, кто смотрит: админ
      // может перепрогонять чужие фото, и подсказка должна остаться прежней.
      userId: meal.user_id,
      model,
      imageBase64,
      imageMimeType: file.type || "image/jpeg",
      userHint: meal.user_hint,
      isPrimary: false,
    });

    return NextResponse.json({
      recognition_id: recognition.recognitionId,
      status: recognition.status,
      error: recognition.errorText,
      model: { id: model.id, label: model.label, prompt_version: model.promptVersion },
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}
