import { randomUUID } from "node:crypto";
import { test, expect } from "./helpers/fixtures";
import { admin, seedCatalogDish, seedRecognisedMeal } from "./helpers/db";
import { clickReact, fillReact, waitForHydration } from "./helpers/actions";

/**
 * Лаборатория: справочник и разбор по пользователям (спека
 * .scratch/lab-explorer/spec.md).
 *
 * Метрики на `/lab` проверяются в screens.spec.ts и здесь не дублируются.
 *
 * Позиция справочника для правки заводится своя и одноразовая. Трогать позиции
 * из `seedCatalog` нельзя: они общие для всех тестов и переживают прогон, а
 * переименование «яйца жареного» уронило бы соседний тест не там, где сломался
 * код.
 */

interface LabItem {
  id: number;
  nameRu: string;
}

async function seedLabItem(): Promise<LabItem> {
  const suffix = randomUUID().slice(0, 8);
  const nameRu = `лабораторная проба ${suffix}`;
  const { data, error } = await admin()
    .from("ingredients")
    .insert({
      source: "manual",
      source_id: `e2e-lab-${suffix}`,
      name_ru: nameRu,
      name_en: `lab probe ${suffix}`,
      category: "Пробы",
      state: "cooked",
    })
    .select("id")
    .single();
  if (error) throw new Error(`Не удалось завести позицию справочника: ${error.message}`);
  return { id: data!.id as number, nameRu };
}

async function dropLabItem(id: number): Promise<void> {
  // На позицию никто не ссылается — она создана этим же тестом, поэтому её
  // можно именно удалить, а не выключить.
  await admin().from("ingredients").delete().eq("id", id);
}

test.describe("Лаборатория", () => {
  test("разделы открываются из навигации", async ({ page, adminUser, signIn }) => {
    await signIn(adminUser);
    await page.goto("/lab");
    await waitForHydration(page);

    await clickReact(page.getByRole("link", { name: "Справочник" }));
    await expect(page).toHaveURL(/\/lab\/catalog/);
    await expect(page.getByRole("heading", { name: "Справочник" })).toBeVisible();

    await clickReact(page.getByRole("link", { name: "Пользователи" }));
    await expect(page).toHaveURL(/\/lab\/users/);
    await expect(page.getByRole("heading", { name: "Пользователи" })).toBeVisible();

    await clickReact(page.getByRole("link", { name: "Приёмы пищи" }));
    await expect(page).toHaveURL(/\/lab\/meals/);
    await expect(page.getByRole("heading", { name: "Приёмы пищи" })).toBeVisible();
  });

  test("справочник закрыт от обычного пользователя", async ({ page, user, signIn }) => {
    await signIn(user);
    await page.goto("/lab/catalog");
    await waitForHydration(page);

    await expect(page.getByText("Экран доступен только владельцу")).toBeVisible();
    await expect(page.getByRole("heading", { name: "Справочник" })).toHaveCount(0);
  });

  test("справочник: поиск находит позицию и ведёт в карточку", async ({
    page,
    adminUser,
    signIn,
  }) => {
    const item = await seedLabItem();
    try {
      await signIn(adminUser);
      await page.goto("/lab/catalog");
      await waitForHydration(page);

      await fillReact(page.getByLabel("Поиск"), item.nameRu);
      await clickReact(page.getByRole("button", { name: "Применить" }));

      // Фильтры живут в адресной строке — на это опирается и «поделиться
      // ссылкой на выборку», и сброс страницы при смене условий.
      await expect(page).toHaveURL(/q=/);
      await clickReact(page.getByRole("link", { name: item.nameRu }));

      await expect(page).toHaveURL(new RegExp(`/lab/catalog/${item.id}`));
      await expect(page.getByRole("heading", { name: item.nameRu })).toBeVisible();
      await expect(page.getByText("Происхождение")).toBeVisible();
      await expect(page.getByText("Использование")).toBeVisible();
    } finally {
      await dropLabItem(item.id);
    }
  });

  test("карточка блюда: порции и раскладка", async ({
    page,
    adminUser,
    signIn,
    catalogIds,
  }) => {
    // Единственное место, где карточка достаёт названия компонентов встроенным
    // join'ом, и join этот неоднозначный: `ingredient_components` ссылается на
    // `ingredients` дважды — блюдом и компонентом. Ошибись в имени внешнего
    // ключа — PostgREST ответит 400, и увидеть это можно только на блюде с
    // раскладкой.
    const dishId = await seedCatalogDish(catalogIds);
    await signIn(adminUser);
    await page.goto(`/lab/catalog/${dishId}`);
    await waitForHydration(page);

    await expect(page.getByRole("heading", { name: "лазанья тестовая" })).toBeVisible();
    await expect(page.getByText("Порции (2)")).toBeVisible();
    await expect(page.getByText("1 кусок")).toBeVisible();
    await expect(page.getByText("Раскладка (2)")).toBeVisible();
    // Компонент подтянулся из справочника по имени, а не остался fallback'ом.
    await expect(page.getByRole("link", { name: "яйцо жареное" })).toBeVisible();
    // Запятая, а не точка: числа форматируются ru-RU (см. lib/format).
    await expect(page.getByText("Сумма долей 100,0%")).toBeVisible();
  });

  test("карточка справочника: правка названия и синонимы сохраняются", async ({
    page,
    adminUser,
    signIn,
  }) => {
    const item = await seedLabItem();
    const renamed = `${item.nameRu} (правленая)`;
    const alias = `синоним ${randomUUID().slice(0, 8)}`;
    try {
      await signIn(adminUser);
      await page.goto(`/lab/catalog/${item.id}`);
      await waitForHydration(page);

      await fillReact(page.getByLabel("Название по-русски"), renamed);
      await clickReact(page.getByRole("button", { name: "Сохранить" }));
      await expect(page.getByText("Сохранено.")).toBeVisible();

      await fillReact(page.getByPlaceholder("новый синоним"), alias);
      await clickReact(page.getByRole("button", { name: "Добавить" }));
      await expect(page.getByText(alias)).toBeVisible();

      // Перезагрузка, а не доверие к состоянию формы: проверяем, что правка
      // доехала до базы, а не осталась в React.
      await page.reload();
      await waitForHydration(page);
      await expect(page.getByRole("heading", { name: renamed })).toBeVisible();
      await expect(page.getByText(alias)).toBeVisible();

      await clickReact(page.getByRole("button", { name: `Удалить синоним «${alias}»` }));
      await expect(page.getByText(alias)).toHaveCount(0);
    } finally {
      await dropLabItem(item.id);
    }
  });

  test("пользователь, его лента и разбор приёма пищи", async ({
    page,
    adminUser,
    signIn,
    catalogIds,
  }) => {
    const meal = await seedRecognisedMeal(adminUser.id, { catalogIds });
    await signIn(adminUser);

    await page.goto("/lab/users");
    await waitForHydration(page);
    await clickReact(page.getByRole("link", { name: "Владелец" }));

    // Ссылка из таблицы пользователей ведёт в ленту, уже отфильтрованную по
    // нему: иначе на живой базе он утонул бы среди чужих приёмов пищи.
    await expect(page).toHaveURL(new RegExp(`/lab/meals\\?user=${adminUser.id}`));

    // Проверяем строку ленты, а не страницу целиком: «принято как есть» есть
    // ещё и пунктом в фильтре вердиктов, и поиск по всей странице поймал бы его.
    const row = page.getByRole("link", { name: /Тост с беконом и яичницей/ });
    await expect(row).toBeVisible();
    // Состав засеян целиком как model_kept — человек ничего не правил.
    await expect(row).toContainText("принято как есть");
    await expect(row).toContainText("Подсказка: «завтрак»");

    await clickReact(row);
    await expect(page).toHaveURL(new RegExp(`/lab/meals/${meal.mealId}`));

    await expect(page.getByRole("heading", { name: "Тост с беконом и яичницей" })).toBeVisible();
    await expect(page.getByAltText("Фотография приёма пищи")).toBeVisible();
    await expect(page.getByText("Версия человека")).toBeVisible();
    await expect(page.getByText("Состав, предложенный моделью")).toBeVisible();
    // Стоимость и латентность прогона — то, ради чего разбор и открывают.
    await expect(page.getByText("GPT-5.1")).toBeVisible();
    await expect(page.getByText("1.710 ₽", { exact: false })).toBeVisible();
    // Модалку «Откуда вес?» этот приём пищи не проходил — так и должно быть
    // написано, а не пустым местом.
    await expect(page.getByText("Модалку не показывали")).toBeVisible();
  });
});
