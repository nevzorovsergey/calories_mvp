"use client";

import { useEffect, useState } from "react";

/**
 * Отметка «React смонтирован, страница отвечает на действия».
 *
 * Нужна браузерным тестам: без неё они начинают печатать в поля и жать кнопки
 * раньше, чем React привяжет обработчики, — ввод молча теряется, и падение
 * выглядит как случайное. Одна пустая точка в разметке дешевле, чем
 * расставленные по тестам паузы «на всякий случай».
 */
export default function HydrationMarker() {
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => setHydrated(true), []);
  return <span data-hydrated={hydrated ? "true" : "false"} hidden aria-hidden />;
}
