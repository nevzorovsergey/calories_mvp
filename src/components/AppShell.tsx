"use client";

import { App, Tabbar, TabbarLink } from "konsta/react";
import NextLink from "next/link";
import { usePathname } from "next/navigation";
import { CalendarDays, LineChart, User } from "lucide-react";

/**
 * Оболочка приложения: iOS-тема Konsta + нижний таббар из трёх вкладок (§13.7).
 * Кнопка съёмки живёт на экране «Сегодня», в зоне большого пальца.
 */

const TABS = [
  { href: "/today", label: "Сегодня", Icon: CalendarDays },
  { href: "/history", label: "История", Icon: LineChart },
  { href: "/profile", label: "Профиль", Icon: User },
];

export default function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();

  return (
    <App theme="ios" safeAreas className="min-h-dvh bg-screen text-ink">
      <div className="mx-auto flex min-h-dvh w-full max-w-screen-sm flex-col">
        <main className="flex-1 pb-24">{children}</main>

        <Tabbar
          labels
          icons
          className="fixed bottom-0 left-1/2 w-full max-w-screen-sm -translate-x-1/2"
        >
          {TABS.map(({ href, label, Icon }) => (
            <TabbarLink
              key={href}
              component={NextLink}
              linkProps={{ href }}
              active={pathname === href || pathname.startsWith(`${href}/`)}
              icon={<Icon size={22} strokeWidth={1.75} aria-hidden />}
              label={label}
              className="tap-target"
            />
          ))}
        </Tabbar>
      </div>
    </App>
  );
}
