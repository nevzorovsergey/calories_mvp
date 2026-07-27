"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { ChevronLeft } from "lucide-react";

/**
 * Явная кнопка «назад» в стиле iOS-навбара.
 *
 * Свайп от края — не универсальный жест: в Android-браузере и в PWA его может
 * не быть, поэтому выход с вложенного экрана всегда должен быть виден (§13.7).
 *
 * `confirmMessage` нужен там, где на экране есть несохранённые правки: тогда
 * это не ссылка, а кнопка со спросом — иначе переход молча потеряет работу.
 */
export default function BackLink({
  href,
  label = "Назад",
  confirmMessage,
}: {
  href: string;
  label?: string;
  confirmMessage?: string | null;
}) {
  const router = useRouter();
  const className = "tap-target -ml-1 flex items-center text-accent";

  if (!confirmMessage) {
    return (
      <Link href={href} className={className}>
        <ChevronLeft size={24} aria-hidden />
        <span className="text-body">{label}</span>
      </Link>
    );
  }

  return (
    <button
      type="button"
      onClick={() => {
        if (!window.confirm(confirmMessage)) return;
        router.push(href);
      }}
      className={className}
    >
      <ChevronLeft size={24} aria-hidden />
      <span className="text-body">{label}</span>
    </button>
  );
}
