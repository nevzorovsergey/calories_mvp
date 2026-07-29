import { test, expect } from "./helpers/fixtures";
import { admin, seedCatalogDish } from "./helpers/db";
import { clickReact, fillReact, waitForHydration } from "./helpers/actions";

/**
 * Добавление приёма пищи по справочнику, без фотографии.
 *
 * Проверяем не только то, что экран отрисовался, но и происхождение записи:
 * `status = 'manual'` и отсутствие фотографии — это метки, по которым такие
 * приёмы пищи исключаются из выборок гипотез H1–H6. Если сохранение затрёт их
 * на 'ready', интерфейс будет выглядеть исправным, а аналитика молча смешает
 * ручной ввод с распознаванием.
 */

test.describe("Добавление по справочнику", () => {
  test("блюдо с порцией и составом попадает в день", async ({
    page,
    user,
    signIn,
    catalogIds,
  }) => {
    const dishId = await seedCatalogDish(catalogIds);

    await signIn(user);

    await clickReact(page.getByRole("button", { name: "Добавить фото" }));
    await clickReact(page.getByText("Найти в справочнике"));
    await page.waitForURL("**/add**", { timeout: 30_000 });
    await waitForHydration(page);

    await fillReact(page.getByPlaceholder("Что вы съели?"), "лазанья тестовая");
    await clickReact(
      page.getByRole("button", { name: /лазанья тестовая/ }).first(),
    );

    // Порция по умолчанию предлагается первой и сразу задаёт вес: человек не
    // должен знать, сколько это в граммах — в этом весь смысл экрана.
    await expect(page.getByRole("button", { name: /обычная порция/ })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await expect(page.getByLabel("Вес, г")).toHaveValue("250");
    await expect(page.getByText("350")).toBeVisible(); // 140 ккал/100 г × 250 г

    // Состав виден и отмасштабирован на выбранный вес (доли 0.6 / 0.4).
    await expect(page.getByText("яйцо жареное")).toBeVisible();
    await expect(page.getByText("150 г")).toBeVisible();

    // Другая порция пересчитывает и вес, и калорийность.
    await clickReact(page.getByRole("button", { name: /1 кусок/ }));
    await expect(page.getByLabel("Вес, г")).toHaveValue("206");
    await expect(page.getByText("288")).toBeVisible();

    await clickReact(page.getByRole("button", { name: "Добавить" }));
    await page.waitForURL(/\/meal\/[0-9a-f-]{36}$/, { timeout: 30_000 });
    await expect(
      page.getByRole("heading", { name: "лазанья тестовая" }),
    ).toBeVisible();

    const mealId = page.url().split("/").pop()!;
    const db = admin();

    const { data: meal } = await db
      .from("meals")
      .select("status, photo_sent_path, photo_sha256, dish_name_ru, primary_recognition_id")
      .eq("id", mealId)
      .single();
    expect(meal?.status).toBe("manual");
    expect(meal?.photo_sent_path).toBeNull();
    expect(meal?.photo_sha256).toBeNull();
    expect(meal?.primary_recognition_id).toBeNull();
    expect(meal?.dish_name_ru).toBe("лазанья тестовая");

    const { data: items } = await db
      .from("meal_items")
      .select("ingredient_id, weight_g, origin, nutrition_source, kcal_per_100g")
      .eq("meal_id", mealId);
    expect(items).toHaveLength(1);
    expect(items?.[0].ingredient_id).toBe(dishId);
    expect(Number(items?.[0].weight_g)).toBe(206);
    expect(items?.[0].origin).toBe("user_added");
    // Нутриенты пришли из справочника, а не от модели: у блюда собственный
    // профиль, и он точнее суммы компонентов.
    expect(items?.[0].nutrition_source).toBe("catalog");
    expect(Number(items?.[0].kcal_per_100g)).toBe(140);

    // Лента дня показывает приём пищи без фотографии и с его калорийностью.
    // Локатор — именно строка ленты: те же 288 ккал стоят и в итоге за день,
    // и проверка «где-то на странице есть 288» ничего бы не различала.
    await page.goto("/today");
    await waitForHydration(page);
    const row = page.getByRole("link", { name: /лазанья тестовая/ });
    await expect(row).toBeVisible();
    await expect(row).toContainText("288");
  });

  test("поиск для правки распознанного состава блюда не предлагает", async ({
    page,
    user,
    signIn,
    catalogIds,
  }) => {
    // Тот же справочник, но экран другой: здесь чинят привязку позиции, которую
    // предложила модель, и подставить туда готовое блюдо значило бы записать в
    // приём пищи не то, что человек ел.
    await seedCatalogDish(catalogIds);
    await signIn(user);

    await page.goto("/add");
    await waitForHydration(page);
    await fillReact(page.getByPlaceholder("Что вы съели?"), "лазанья тестовая");
    await expect(
      page.getByRole("button", { name: /лазанья тестовая/ }).first(),
    ).toBeVisible();

    const { data: dish } = await admin()
      .from("ingredients")
      .select("id")
      .eq("source_id", "e2e-dish-lasagna")
      .single();

    // Тот же запрос через RPC с фильтром экрана правки — блюда в выдаче нет.
    const { data: onlyIngredients } = await admin().rpc("search_ingredients", {
      q: "лазанья тестовая",
      max_results: 20,
      kinds: ["ingredient"],
    });
    const ids = ((onlyIngredients ?? []) as { id: number }[]).map((r) => r.id);
    expect(ids).not.toContain(dish?.id);
  });
});
