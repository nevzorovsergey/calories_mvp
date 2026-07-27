import { defineConfig, devices } from "@playwright/test";

/**
 * Браузерные тесты интерфейса.
 *
 * Прогон идёт против настоящего приложения и настоящей базы: подделывать
 * Supabase бессмысленно, потому что половина логики продукта — это RLS,
 * триггеры и вьюхи, а они живут в БД. Единственное, что тесты подменяют, —
 * вызов модели: он стоит денег и недетерминирован. Для сценариев, где важен
 * именно ответ модели, есть отдельный «живой» прогон (см. e2e/live.spec.ts).
 *
 * Приложение поднимается автоматически, если оно ещё не запущено.
 */
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false, // тесты делят одну базу, гонки нам не нужны
  workers: 1,
  retries: 0,
  timeout: 90_000,
  expect: { timeout: 10_000 },
  reporter: [["list"], ["html", { open: "never", outputFolder: "e2e/report" }]],

  use: {
    baseURL: process.env.TEST_APP_URL ?? "http://localhost:3000",
    // Продукт мобильный-first (§13.7) — и проверять его надо на телефоне.
    ...devices["iPhone 14"],
    locale: "ru-RU",
    timezoneId: "Europe/Moscow",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "off",
  },

  webServer: {
    command: "npm run dev",
    url: process.env.TEST_APP_URL ?? "http://localhost:3000",
    reuseExistingServer: true,
    timeout: 120_000,
  },
});
