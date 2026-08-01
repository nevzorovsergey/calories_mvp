"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { BookOpen, FlaskConical, Images, Users } from "lucide-react";

/**
 * Навигация лаборатории.
 *
 * Не Konsta-таббар: тот сделан под большой палец и три вкладки внизу экрана,
 * а здесь разделов больше и смотрят их с клавиатурой. На узком экране колонка
 * превращается в горизонтальную ленту — раздел должен открываться с телефона,
 * даже если разбирать данные там неудобно.
 */

const SECTIONS = [
  { href: "/lab", label: "Метрики", Icon: FlaskConical, exact: true },
  { href: "/lab/catalog", label: "Справочник", Icon: BookOpen, exact: false },
  { href: "/lab/users", label: "Пользователи", Icon: Users, exact: false },
  { href: "/lab/meals", label: "Приёмы пищи", Icon: Images, exact: false },
];

export default function LabNav() {
  const pathname = usePathname();

  return (
    <nav
      aria-label="Разделы лаборатории"
      className="flex gap-1 overflow-x-auto border-b border-separator p-2 md:h-dvh md:w-52 md:shrink-0 md:flex-col md:overflow-y-auto md:border-r md:border-b-0 md:p-3"
    >
      <p className="hidden px-2 pt-1 pb-3 text-caption text-ink-secondary uppercase md:block">
        Лаборатория
      </p>
      {SECTIONS.map(({ href, label, Icon, exact }) => {
        const active = exact ? pathname === href : pathname.startsWith(href);
        return (
          <Link
            key={href}
            href={href}
            aria-current={active ? "page" : undefined}
            className={`tap-target flex shrink-0 items-center gap-2 rounded-xl px-3 py-2 text-body ${
              active ? "bg-accent text-white" : "text-ink hover:bg-card"
            }`}
          >
            <Icon size={18} strokeWidth={1.75} aria-hidden />
            {label}
          </Link>
        );
      })}
      <div className="grow" />
      <Link
        href="/today"
        className="tap-target hidden shrink-0 items-center rounded-xl px-3 py-2 text-caption text-ink-secondary hover:bg-card md:flex"
      >
        ← В приложение
      </Link>
    </nav>
  );
}
