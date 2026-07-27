/**
 * Клиентское сжатие перед отправкой (FR-CAP-4, §4.4).
 *
 * Longest side 1024 px, JPEG q0.8 — снижает и стоимость токенов, и трафик, и
 * держит размер в пределах 500 КБ (§14). Именно эти байты уходят в модель и
 * сохраняются как `sent` вместе с sha256: при повторном прогоне другой моделью
 * отправляется тот же самый файл (§5.2, FR-CMP-4).
 */

export const MAX_SIDE = 1024;
export const JPEG_QUALITY = 0.8;

export interface CompressedImage {
  blob: Blob;
  width: number;
  height: number;
  previewUrl: string;
}

export async function compressImage(file: File): Promise<CompressedImage> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
  const width = Math.round(bitmap.width * scale);
  const height = Math.round(bitmap.height * scale);

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Браузер не дал доступ к canvas — сжать фото не получилось");
  ctx.drawImage(bitmap, 0, 0, width, height);
  bitmap.close?.();

  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, "image/jpeg", JPEG_QUALITY),
  );
  if (!blob) throw new Error("Не удалось сжать фотографию");

  return { blob, width, height, previewUrl: URL.createObjectURL(blob) };
}
