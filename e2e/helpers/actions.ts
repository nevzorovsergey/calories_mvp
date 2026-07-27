import { expect, type Locator, type Page } from "@playwright/test";

/**
 * Ввод в поле, которое управляется React.
 *
 * `fill()` проставляет значение в DOM и шлёт событие input. Если React ещё не
 * успел привязать обработчики (гидратация идёт своим темпом), событие уходит в
 * пустоту: состояние компонента остаётся прежним, следующий перерисовыв
 * затирает введённое, и тест падает на ровном месте. Повторяем ввод, пока
 * значение не закрепится — это ждёт именно готовности страницы, а не «ещё
 * секунду на всякий случай».
 */
export async function fillReact(field: Locator, value: string): Promise<void> {
  await expect(async () => {
    await field.fill(value);
    await expect(field).toHaveValue(value, { timeout: 1000 });
  }).toPass({ timeout: 15_000 });
}

/** Клик по элементу, который начинает работать только после гидратации. */
export async function clickReact(target: Locator): Promise<void> {
  await expect(target).toBeVisible();
  await expect(target).toBeEnabled();
  await target.click();
}

/**
 * Ждём, пока приложение действительно живо: React смонтирован и таббар
 * откликается на переходы.
 */
export async function waitForHydration(page: Page): Promise<void> {
  await page.waitForLoadState("domcontentloaded");
  await page.waitForFunction(
    () => document.querySelector("[data-hydrated='true']") !== null,
    undefined,
    { timeout: 20_000 },
  );
}
