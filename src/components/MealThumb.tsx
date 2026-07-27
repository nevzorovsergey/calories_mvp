/* eslint-disable @next/next/no-img-element */

/**
 * Миниатюра фото приёма пищи.
 *
 * Обычный <img>, а не next/image: ссылки подписанные и живут час, оптимизатор
 * Next кэшировал бы их по URL и на Hobby-плане быстро съел бы квоту
 * трансформаций ради картинок 56×56.
 */
export default function MealThumb({
  src,
  alt,
  size = 56,
}: {
  src: string | null;
  alt: string;
  size?: number;
}) {
  if (!src) {
    return (
      <span
        className="skeleton shrink-0 rounded-xl"
        style={{ width: size, height: size }}
        aria-hidden
      />
    );
  }
  return (
    <img
      src={src}
      alt={alt}
      width={size}
      height={size}
      loading="lazy"
      className="shrink-0 rounded-xl object-cover"
      style={{ width: size, height: size }}
    />
  );
}
