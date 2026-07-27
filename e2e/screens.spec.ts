import { test, expect } from "./helpers/fixtures";
import { seedRecognisedMeal } from "./helpers/db";
import { clickReact, fillReact, waitForHydration } from "./helpers/actions";

/**
 * Каждый экран открывается и рисуется без единой ошибки в консоли.
 *
 * Проверка «страница отдала 200 и в HTML есть нужное слово» такие поломки
 * пропускает: разметка приезжает с сервера, а падает компонент уже в браузере.
 * Поэтому здесь настоящий браузер и жёсткая ловушка на ошибки (см. fixtures).
 */

test.describe("Экраны открываются", () => {
  test("вход: форма работает и пускает внутрь", async ({ page, user }) => {
    await page.goto("/login");
    await waitForHydration(page);

    await expect(page.getByRole("heading", { name: "Что я ем" })).toBeVisible();
    await expect(page.getByLabel("Email")).toBeVisible();
    await expect(page.getByLabel("Пароль")).toBeVisible();

    await fillReact(page.getByLabel("Email"), user.email);
    await fillReact(page.getByLabel("Пароль"), user.password);
    await clickReact(page.getByRole("button", { name: "Войти" }));

    await expect(page).toHaveURL(/\/today/);
  });

  test("неверный пароль: понятное сообщение, а не код ошибки", async ({
    page,
    user,
    allowConsoleError,
  }) => {
    // Отказ во входе — это честный HTTP 400 от Supabase, браузер пишет его в
    // консоль. Проверяем именно его, поэтому ловушку на ошибки предупреждаем.
    allowConsoleError(/Failed to load resource|400/i);
    await page.goto("/login");
    await waitForHydration(page);
    await fillReact(page.getByLabel("Email"), user.email);
    await fillReact(page.getByLabel("Пароль"), "совсем-не-тот-пароль");
    await clickReact(page.getByRole("button", { name: "Войти" }));

    // §13.8: сообщение объясняет, что произошло и что делать.
    await expect(page.getByText("Неверный email или пароль")).toBeVisible();
    await expect(page).toHaveURL(/\/login/);
  });

  test("неавторизованного уводит на вход", async ({ page }) => {
    await page.goto("/today");
    await expect(page).toHaveURL(/\/login/);
  });

  test("«Сегодня» без данных зовёт сфотографировать, а не констатирует пустоту", async ({
    page,
    user,
    signIn,
  }) => {
    await signIn(user);

    await expect(page.getByRole("heading", { name: "Сегодня" })).toBeVisible();
    await expect(page.getByText("Пока пусто")).toBeVisible();
    await expect(page.getByText(/Сфотографируйте первое блюдо/)).toBeVisible();
    await expect(page.getByRole("button", { name: /Сфотографировать/ })).toBeVisible();
    await expect(page.getByText("Калорийность")).toBeVisible();
  });

  test("таббар переключает разделы", async ({ page, user, signIn }) => {
    await signIn(user);

    await page.getByRole("link", { name: "История" }).click();
    await expect(page).toHaveURL(/\/history/);
    await expect(page.getByRole("heading", { name: "История" })).toBeVisible();

    await page.getByRole("link", { name: "Профиль" }).click();
    await expect(page).toHaveURL(/\/profile/);
    await expect(page.getByRole("heading", { name: "Мои эталоны" })).toBeVisible();

    await page.getByRole("link", { name: "Сегодня" }).click();
    await expect(page).toHaveURL(/\/today/);
  });

  test("переключение даты стрелками", async ({ page, user, signIn }) => {
    await signIn(user);
    await page.getByRole("link", { name: "Предыдущий день" }).click();
    await expect(page.getByRole("heading", { name: "Вчера" })).toBeVisible();
    await page.getByRole("link", { name: "Следующий день" }).click();
    await expect(page.getByRole("heading", { name: "Сегодня" })).toBeVisible();
  });

  test("«Лаборатория» закрыта от обычного пользователя", async ({ page, user, signIn }) => {
    await signIn(user);
    await page.goto("/lab");
    await waitForHydration(page);
    await expect(page.getByText("Экран доступен только владельцу")).toBeVisible();
  });

  test("«Лаборатория» открыта владельцу", async ({ page, adminUser, signIn }) => {
    await signIn(adminUser);
    await page.getByRole("link", { name: "Профиль" }).click();
    await page.getByRole("link", { name: /Лаборатория/ }).click();

    await expect(page).toHaveURL(/\/lab/);
    await expect(page.getByRole("heading", { name: "Лаборатория" })).toBeVisible();
    await expect(page.getByText("Модели за всё время")).toBeVisible();
    await expect(page.getByRole("link", { name: "Скачать JSON" })).toBeVisible();
  });

  test("детальный экран приёма пищи", async ({ page, user, signIn, catalogIds }) => {
    const meal = await seedRecognisedMeal(user.id, { catalogIds });
    await signIn(user);
    await page.goto(`/meal/${meal.mealId}`);
    await waitForHydration(page);

    await expect(
      page.getByRole("heading", { name: "Тост с беконом и яичницей" }),
    ).toBeVisible();
    await expect(page.getByRole("img", { name: "Фото блюда" })).toBeVisible();
    await expect(page.getByText("яйцо жареное")).toBeVisible();
    await expect(page.getByRole("link", { name: "Редактировать" })).toBeVisible();

    // Возврат на день приёма пищи — кнопкой, а не системным жестом «назад».
    await clickReact(page.locator('a[href^="/today?date="]'));
    await expect(page).toHaveURL(/\/today\?date=/);
  });

  test("экран правки", async ({ page, user, signIn, catalogIds }) => {
    const meal = await seedRecognisedMeal(user.id, { catalogIds });
    await signIn(user);
    await page.goto(`/meal/${meal.mealId}/edit`);
    await waitForHydration(page);

    await expect(page.getByLabel("Блюдо")).toHaveValue("Тост с беконом и яичницей");
    await expect(page.getByLabel("Общий вес, г")).toHaveValue("190");
    await expect(page.getByRole("button", { name: /Сохранить/ })).toBeVisible();

    // Выйти с экрана можно кнопкой, а не только системным жестом «назад».
    await clickReact(page.getByRole("link", { name: "Приём пищи" }));
    await expect(page).toHaveURL(`/meal/${meal.mealId}`);
  });
});
