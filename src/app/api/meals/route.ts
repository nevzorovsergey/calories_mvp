import { after, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getDefaultModel } from "@config/models";
import { processMeal } from "@/lib/recognition/process";

/**
 * Приём фотографии (§5.1 PRD).
 *
 * Роут делает ровно то, чего пользователь ждёт стоя: проверяет сессию, кладёт
 * кадры в Storage, заводит `meals` со `status = 'processing'` — и отвечает. Всё
 * остальное (вызов модели, `recognitions`, маппинг, первичные `meal_items` —
 * шаги 5–11) уходит в `after()` и доживает там своим ходом.
 *
 * Раньше эти шаги выполнялись внутри запроса, и пользователь смотрел на
 * спиннер все 10–40 с работы модели, не имея права закрыть экран. PRD §5.1
 * закладывал такой переход как запасной путь; поводом стало то, что ожидание
 * склеивалось с отправкой фотографии, и любой сетевой затык выглядел как
 * зависшее распознавание.
 *
 * `maxDuration` остаётся 300 с и теперь ограничивает не ответ, а жизнь
 * инвокейшна вместе с фоновой частью: 10–40 с на vision-запрос укладываются с
 * четырёхкратным запасом.
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
  // плюс sha256; архивная — крупнее, для будущих экспериментов.
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

  // Архивный кадр приходит тем же запросом и уезжает в Storage отсюда, с
  // сервера. Прежде его заливал в Storage сам браузер, и на плохом мобильном
  // канале это оказалось самым хрупким звеном потока (§5.2). Кадр остаётся
  // необязательным: не залился — распознавание всё равно идёт.
  const archive = form.get("archive");
  let archivePath: string | null = null;
  if (archive instanceof File) {
    const path = `${basePath}/archive.jpg`;
    const { error } = await supabase.storage
      .from("meals")
      .upload(path, new Uint8Array(await archive.arrayBuffer()), {
        contentType: archive.type || "image/jpeg",
      });
    if (error) console.error("archive upload failed", error);
    else archivePath = path;
  }

  const { error: mealError } = await supabase.from("meals").insert({
    id: mealId,
    user_id: user.id,
    meal_date: mealDate,
    photo_sent_path: sentPath,
    photo_original_path: archivePath,
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

  after(() =>
    processMeal({
      // Сервисный клиент, а не запросный: к моменту запуска ответ уже отправлен,
      // и обновлять cookie сессии некуда. Пользователь проверен выше, приём
      // пищи заведён от его имени.
      supabase: createAdminClient(),
      mealId,
      userId: user.id,
      model,
      imageBase64,
      imageMimeType: sent.type || "image/jpeg",
      userHint,
    }),
  );

  return NextResponse.json({
    meal_id: mealId,
    status: "processing",
    model: { id: model.id, label: model.label },
  });
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
