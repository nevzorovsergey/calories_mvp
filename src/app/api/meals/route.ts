import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getDefaultModel } from "@config/models";
import { runRecognition } from "@/lib/recognition/run";
import { createInitialMealItems } from "@/lib/recognition/meal-items";

/**
 * Поток «сделать фото → получить состав» (§5.1 PRD).
 *
 * Синхронный вызов допустим: 300 с лимита Vercel с большим запасом покрывают
 * 10–40 с на vision-запрос. Если модель начнёт таймаутить — переключаемся на
 * схему «задача + polling»: в `meals` уже есть `status`, менять почти нечего.
 */
export const maxDuration = 300;
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Не авторизован" }, { status: 401 });
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return NextResponse.json({ error: "Ожидается multipart/form-data" }, { status: 400 });
  }

  const sent = form.get("sent");
  if (!(sent instanceof File)) {
    return NextResponse.json(
      { error: "Не передано сжатое изображение (поле sent)" },
      { status: 400 },
    );
  }

  const userHint = (form.get("user_hint") as string | null)?.trim() || null;
  // Локальная дата пользователя приходит с клиента: считать её на сервере по UTC
  // значило бы записать поздний ужин во «вчера» (§10.1, meal_date).
  const mealDate = (form.get("meal_date") as string | null) ?? todayIso();
  const width = numberOrNull(form.get("photo_width"));
  const height = numberOrNull(form.get("photo_height"));

  const sentBytes = new Uint8Array(await sent.arrayBuffer());
  const sha256 = await sha256Hex(sentBytes);
  const mealId = crypto.randomUUID();
  const basePath = `${user.id}/${mealId}`;

  // Храним две версии (§5.2): `sent` — ровно те байты, что уйдут в модель,
  // плюс sha256; `original` — как пришло с устройства, для будущих экспериментов.
  const sentPath = `${basePath}/sent.jpg`;
  const { error: uploadError } = await supabase.storage
    .from("meals")
    .upload(sentPath, sentBytes, { contentType: sent.type || "image/jpeg" });
  if (uploadError) {
    return NextResponse.json(
      { error: `Не удалось загрузить фото: ${uploadError.message}` },
      { status: 500 },
    );
  }

  // Оригинал клиент кладёт в Storage сам (тело запроса к функции ограничено
  // 4,5 МБ, а снимок с телефона бывает больше) — сюда приходит только путь.
  // Проверяем, что он ведёт в папку этого пользователя: `photo_original_path`
  // потом используется при удалении приёма пищи.
  const originalField = form.get("original_path");
  const originalPath =
    typeof originalField === "string" && originalField.startsWith(`${user.id}/`)
      ? originalField
      : null;

  const { error: mealError } = await supabase.from("meals").insert({
    id: mealId,
    user_id: user.id,
    meal_date: mealDate,
    photo_sent_path: sentPath,
    photo_original_path: originalPath,
    photo_sha256: sha256,
    photo_width: width,
    photo_height: height,
    user_hint: userHint,
    status: "processing",
  });
  if (mealError) {
    return NextResponse.json(
      { error: `Не удалось создать приём пищи: ${mealError.message}` },
      { status: 500 },
    );
  }

  const model = getDefaultModel();
  const imageBase64 = Buffer.from(sentBytes).toString("base64");

  try {
    const recognition = await runRecognition({
      supabase,
      mealId,
      userId: user.id,
      model,
      imageBase64,
      imageMimeType: sent.type || "image/jpeg",
      userHint,
      isPrimary: true,
    });

    if (recognition.status === "failed") {
      await supabase.from("meals").update({ status: "failed" }).eq("id", mealId);
      return NextResponse.json(
        {
          meal_id: mealId,
          status: "failed",
          error: recognition.errorText,
          model: { id: model.id, label: model.label },
        },
        { status: 200 },
      );
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

    return NextResponse.json({
      meal_id: mealId,
      status: "ready",
      recognition_id: recognition.recognitionId,
      model: { id: model.id, label: model.label },
    });
  } catch (error) {
    await supabase.from("meals").update({ status: "failed" }).eq("id", mealId);
    return NextResponse.json(
      {
        meal_id: mealId,
        status: "failed",
        error: error instanceof Error ? error.message : String(error),
      },
      { status: 500 },
    );
  }
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function numberOrNull(value: FormDataEntryValue | null): number | null {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
