/**
 * Клиентское сжатие перед отправкой (FR-CAP-4, §4.4).
 *
 * Из одного снимка готовим два кадра:
 * - `sent` — 1024 px, JPEG q0.8. Снижает и стоимость токенов, и трафик, и
 *   держит размер в пределах 500 КБ (§14). Именно эти байты уходят в модель и
 *   хранятся вместе с sha256: при повторном прогоне другой моделью отправляется
 *   тот же самый файл (§5.2, FR-CMP-4). Побайтовая точность требуется только
 *   от него.
 * - `archive` — 2048 px, JPEG q0.9. Это версия «для будущих экспериментов»
 *   из §5.2. Раньше в неё клали снимок ровно как с устройства и заливали прямо
 *   из браузера в Supabase Storage. На плохом мобильном канале эти 2–3.5 МБ до
 *   региона Supabase не доезжали, и поток вставал целиком — хотя для
 *   распознавания оригинал не нужен вовсе. Теперь оба кадра уходят одним
 *   запросом на сервер, а в Storage их кладёт он.
 *
 * Вдвоём кадры весят ~0.5–0.7 МБ против прежних 2–3.5 МБ у одного оригинала.
 */

export const MAX_SIDE = 1024;
export const JPEG_QUALITY = 0.8;
export const ARCHIVE_MAX_SIDE = 2048;
export const ARCHIVE_QUALITY = 0.9;

export interface PreparedFrame {
  blob: Blob;
  width: number;
  height: number;
}

export interface PreparedPhoto {
  sent: PreparedFrame;
  /** null, если снимок и так не больше `sent`: архивный кадр был бы его копией. */
  archive: PreparedFrame | null;
  previewUrl: string;
}

async function renderFrame(
  bitmap: ImageBitmap,
  maxSide: number,
  quality: number,
): Promise<PreparedFrame> {
  const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
  const width = Math.round(bitmap.width * scale);
  const height = Math.round(bitmap.height * scale);

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Браузер не дал доступ к canvas — сжать фото не получилось");
  ctx.drawImage(bitmap, 0, 0, width, height);

  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, "image/jpeg", quality),
  );
  if (!blob) throw new Error("Не удалось сжать фотографию");

  return { blob, width, height };
}

export async function preparePhoto(file: File): Promise<PreparedPhoto> {
  const bitmap = await createImageBitmap(file);
  try {
    const sent = await renderFrame(bitmap, MAX_SIDE, JPEG_QUALITY);
    const archive =
      Math.max(bitmap.width, bitmap.height) > MAX_SIDE
        ? await renderFrame(bitmap, ARCHIVE_MAX_SIDE, ARCHIVE_QUALITY)
        : null;
    return { sent, archive, previewUrl: URL.createObjectURL(sent.blob) };
  } finally {
    bitmap.close?.();
  }
}
