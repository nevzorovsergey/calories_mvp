import type { Metadata, Viewport } from "next";
import HydrationMarker from "@/components/HydrationMarker";
import "./globals.css";

export const metadata: Metadata = {
  title: "Что я ем",
  description: "Прототип распознавания состава и калорийности блюда по фото",
  manifest: "/manifest.webmanifest",
  appleWebApp: {
    capable: true,
    statusBarStyle: "default",
    title: "Что я ем",
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 5,
  // Без viewport-fit=cover в standalone-режиме PWA на iPhone нижняя панель
  // уедет под системную полосу (§13.7).
  viewportFit: "cover",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f2f2f7" },
    { media: "(prefers-color-scheme: dark)", color: "#000000" },
  ],
};

// Konsta переключает тёмную тему по классу .dark на <html>, а отдельного
// переключателя в MVP нет (§13.5) — синхронизируем класс с системной темой
// до первой отрисовки, чтобы не было вспышки светлой темы.
const THEME_SYNC = `(function(){var m=window.matchMedia("(prefers-color-scheme: dark)");
var a=function(e){document.documentElement.classList.toggle("dark",e.matches)};a(m);
m.addEventListener("change",a)})();`;

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html
      lang="ru"
      className="h-full antialiased"
      // Класс .dark навешивает инлайн-скрипт ниже — до гидратации, поэтому
      // разметка сервера и клиента здесь расходится намеренно.
      suppressHydrationWarning
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_SYNC }} />
      </head>
      <body className="safe-areas ios min-h-full">
        {children}
        <HydrationMarker />
      </body>
    </html>
  );
}
