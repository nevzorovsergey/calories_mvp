import { test as base, expect, type Page } from "@playwright/test";
import { createTestUser, deleteTestUser, seedCatalog, TEST_PASSWORD, type TestUser } from "./db";
import { clickReact, fillReact, waitForHydration } from "./actions";

/**
 * Общая обвязка браузерных тестов.
 *
 * Главное здесь — ловушка на ошибки: любая ошибка в консоли браузера или
 * необработанное исключение на странице роняют тест. Без неё проверка «текст
 * на странице есть» пропускает ровно тот класс поломок, из-за которого
 * пользователь видит вместо интерфейса сообщение об ошибке: разметка
 * приезжает с сервера, а на клиенте компонент падает при гидратации.
 *
 * Негативные сценарии (неверный пароль — это честный HTTP 400) объявляют
 * ожидаемую ошибку через `allowConsoleError`, чтобы ловушка не путала
 * проверяемое поведение с поломкой.
 */

export interface Fixtures {
  user: TestUser;
  adminUser: TestUser;
  catalogIds: number[];
  signIn: (user: TestUser) => Promise<void>;
  allowConsoleError: (pattern: RegExp) => void;
}

// Шум, который не является поломкой приложения.
const IGNORED = [
  /Download the React DevTools/i,
  /\[Fast Refresh\]/i,
  /favicon\.ico/i,
];

export const test = base.extend<Fixtures & { allowedErrors: RegExp[] }>({
  allowedErrors: async ({}, use) => {
    await use([]);
  },

  allowConsoleError: async ({ allowedErrors }, use) => {
    await use((pattern: RegExp) => {
      allowedErrors.push(pattern);
    });
  },

  // Пользователь заводится на каждый тест и удаляется после: тесты не должны
  // зависеть от того, что натворил предыдущий.
  user: async ({}, use) => {
    const user = await createTestUser({ displayName: "Тестировщик" });
    await use(user);
    await deleteTestUser(user.id);
  },

  adminUser: async ({}, use) => {
    const user = await createTestUser({ displayName: "Владелец", isAdmin: true });
    await use(user);
    await deleteTestUser(user.id);
  },

  catalogIds: async ({}, use) => {
    await use(await seedCatalog());
  },

  signIn: async ({ page }, use) => {
    await use(async (user: TestUser) => {
      await page.goto("/login");
      await waitForHydration(page);
      await fillReact(page.getByLabel("Email"), user.email);
      await fillReact(page.getByLabel("Пароль"), user.password ?? TEST_PASSWORD);
      await clickReact(page.getByRole("button", { name: "Войти" }));
      await page.waitForURL("**/today", { timeout: 30_000 });
      await waitForHydration(page);
    });
  },

  page: async ({ page, allowedErrors }, use, testInfo) => {
    const errors: string[] = [];
    const isNoise = (text: string) =>
      IGNORED.some((re) => re.test(text)) || allowedErrors.some((re) => re.test(text));

    page.on("console", (message) => {
      if (message.type() !== "error") return;
      const text = message.text();
      if (isNoise(text)) return;
      errors.push(`console.error: ${text}`);
    });
    page.on("pageerror", (error) => {
      if (isNoise(error.message)) return;
      errors.push(`pageerror: ${error.message}`);
    });

    await use(page);

    // Отбрасываем задним числом то, что тест разрешил уже по ходу дела.
    const real = errors.filter((e) => !isNoise(e));
    if (real.length > 0 && testInfo.status === testInfo.expectedStatus) {
      throw new Error(
        `Страница сообщила об ошибках (${real.length}):\n  ${real.join("\n  ")}`,
      );
    }
  },
});

export { expect };
export type { Page };
