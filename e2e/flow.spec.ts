import { join } from "node:path";
import { test, expect } from "./helpers/fixtures";
import { admin, seedRecognisedMeal } from "./helpers/db";
import { clickReact, fillReact, waitForHydration } from "./helpers/actions";

/**
 * Полный путь пользователя: снял → распознали → поправил → сохранил →
 * ответил «откуда вес» → посмотрел историю.
 *
 * Вызов модели в этих тестах подменяется: он стоит денег, занимает полминуты и
 * каждый раз отвечает по-разному, а проверяем мы здесь интерфейс. Настоящий
 * вызов проверяют scripts/test-flow.ts и e2e/live.spec.ts.
 */

const PHOTO = join(process.cwd(), "fixtures", "sent-dish-4.jpg");

test.describe("Съёмка и распознавание", () => {
  test("предпросмотр, подсказка и переход на правку", async ({
    page,
    user,
    signIn,
    catalogIds,
  }) => {
    // Готовим результат заранее и подменяем ответ маршрута: клиентская часть
    // (сжатие, предпросмотр, прогресс) при этом работает по-настоящему.
    const meal = await seedRecognisedMeal(user.id, { catalogIds });
    await page.route("**/api/meals", async (route) => {
      if (route.request().method() !== "POST") return route.fallback();
      await new Promise((r) => setTimeout(r, 300)); // чтобы увидеть прогресс
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          meal_id: meal.mealId,
          status: "ready",
          recognition_id: meal.recognitionId,
          model: { id: "openai/gpt-5.1", label: "GPT-5.1" },
        }),
      });
    });

    await signIn(user);
    await page.setInputFiles('input[type="file"]', PHOTO);

    // Экран предпросмотра (FR-CAP-2, FR-CAP-3)
    await expect(page.getByRole("heading", { name: "Проверьте кадр" })).toBeVisible();
    await expect(page.getByAltText("Предпросмотр снимка")).toBeVisible();
    await expect(page.getByText(/Положите рядом банковскую карту/)).toBeVisible();

    await fillReact(page.getByLabel(/Подсказка/), "завтрак, жарил на масле");
    await clickReact(page.getByRole("button", { name: "Распознать" }));

    // FR-CAP-5: во время распознавания видно, какая модель вызывается.
    await expect(page.getByText(/Распознаём моделью «GPT-5.1»/)).toBeVisible();

    await page.waitForURL(`**/meal/${meal.mealId}/edit`, { timeout: 30_000 });
    await expect(page.getByLabel("Блюдо")).toHaveValue("Тост с беконом и яичницей");
  });

  test("отмена на предпросмотре возвращает на «Сегодня»", async ({ page, user, signIn }) => {
    await signIn(user);
    await page.setInputFiles('input[type="file"]', PHOTO);
    await expect(page.getByRole("heading", { name: "Проверьте кадр" })).toBeVisible();

    await clickReact(page.getByRole("button", { name: "Отмена" }));
    // Konsta оставляет попап в DOM и просто уводит его за экран, поэтому
    // проверяем исчезновение самого предпросмотра, а не заголовка окна.
    await expect(page.getByAltText("Предпросмотр снимка")).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "Сегодня" })).toBeVisible();
  });
});

test.describe("Правка состава", () => {
  test("правка веса, удаление, добавление и модалка «Откуда вес?»", async ({
    page,
    user,
    signIn,
    catalogIds,
  }) => {
    const meal = await seedRecognisedMeal(user.id, { catalogIds });
    await signIn(user);
    await page.goto(`/meal/${meal.mealId}/edit`);
    await waitForHydration(page);

    // Ингредиент без справочника помечен «≈» и предлагает привязку (FR-CAT-2).
    await expect(page.getByText("масло для жарки")).toBeVisible();
    await expect(page.getByText(/нет в справочнике/)).toBeVisible();

    // Правка веса одной позиции
    await fillReact(page.getByLabel("Вес: бекон жареный"), "80");

    // Удаление другой
    await clickReact(page.getByLabel("Удалить: масло для жарки"));
    await expect(page.getByText("масло для жарки")).toBeHidden();

    // Добавление из справочника (FR-EDIT-4)
    await clickReact(page.getByRole("button", { name: "Добавить ингредиент" }));
    await fillReact(page.getByPlaceholder("Найти в справочнике"), "яйцо");
    await clickReact(
      page
        .getByRole("list", { name: "Результаты поиска" })
        .getByRole("button", { name: /яйцо жареное/ })
        .first(),
    );
    // Нутриенты подтягиваются запросом, позиция появляется в списке не мгновенно.
    // Ждём её появления, иначе можно сохранить состав без только что добавленного.
    await expect(
      page.getByRole("list", { name: "Ингредиенты" }).getByText("яйцо жареное"),
    ).toHaveCount(2);

    await clickReact(page.getByRole("button", { name: "Сохранить" }));

    // FR-EDIT-8: модалка появляется, потому что правки были.
    await expect(page.getByRole("heading", { name: "Откуда вес?" })).toBeVisible();
    // FR-WE-2: вопрос про эталон предзаполнен тем, что нашла модель.
    await expect(page.getByRole("checkbox", { name: "Столовые приборы" })).toBeChecked();

    await clickReact(page.getByText("Взвесил на весах"));
    await clickReact(page.getByRole("button", { name: "4", exact: true }));
    await clickReact(page.getByRole("button", { name: "Готово" }));

    await page.waitForURL(`**/meal/${meal.mealId}`, { timeout: 30_000 });

    // Проверяем, что записалось именно то, что нужно для датасета.
    const db = admin();
    const { data: items } = await db
      .from("meal_items")
      .select("name_ru, weight_g, origin, original_weight_g")
      .eq("meal_id", meal.mealId)
      .order("position");

    const bacon = items!.find((i) => i.name_ru === "бекон жареный");
    expect(bacon?.origin).toBe("model_edited");
    expect(Number(bacon?.original_weight_g)).toBe(55);
    expect(Number(bacon?.weight_g)).toBe(80);
    expect(items!.some((i) => i.origin === "user_added")).toBe(true);

    const { data: removed } = await db
      .from("meal_removed_items")
      .select("id")
      .eq("meal_id", meal.mealId);
    expect(removed).toHaveLength(1);

    const { data: evidence } = await db
      .from("weight_evidence")
      .select("method, self_confidence, had_reference")
      .eq("meal_id", meal.mealId)
      .single();
    expect(evidence!.method).toBe("scale");
    expect(evidence!.self_confidence).toBe(4);
    expect(evidence!.had_reference).toBe(true);

    // FR-EDIT-10: предложение модели осталось нетронутым.
    const { data: modelItems } = await db
      .from("recognition_items")
      .select("weight_g")
      .eq("recognition_id", meal.recognitionId)
      .order("position");
    expect(modelItems!.map((i) => Number(i.weight_g))).toEqual([60, 55, 70, 5]);
  });

  test("правка общего веса пересчитывает всё пропорционально и отменяется", async ({
    page,
    user,
    signIn,
    catalogIds,
  }) => {
    const meal = await seedRecognisedMeal(user.id, { catalogIds });
    await signIn(user);
    await page.goto(`/meal/${meal.mealId}/edit`);
    await waitForHydration(page);

    const total = page.getByLabel("Общий вес, г");
    const bacon = page.getByLabel("Вес: бекон жареный");
    await expect(total).toHaveValue("190");
    await expect(bacon).toHaveValue("55");

    // FR-EDIT-5: пересчёт включён по умолчанию.
    await fillReact(total, "380");
    await page.getByLabel("Блюдо").click(); // снимаем фокус, чтобы применилось
    await expect(bacon).toHaveValue("110");

    // …и отменяется одним тапом.
    await clickReact(page.getByRole("button", { name: "Отменить пересчёт" }));
    await expect(bacon).toHaveValue("55");
    await expect(total).toHaveValue("190");
  });

  test("«Сохранить без изменений» — тоже сигнал, и модалка не появляется", async ({
    page,
    user,
    signIn,
    catalogIds,
  }) => {
    const meal = await seedRecognisedMeal(user.id, { catalogIds });
    await signIn(user);
    await page.goto(`/meal/${meal.mealId}/edit`);
    await waitForHydration(page);

    // FR-EDIT-9
    await clickReact(page.getByRole("button", { name: "Сохранить без изменений" }));
    await page.waitForURL(`**/meal/${meal.mealId}`, { timeout: 30_000 });
    await expect(page.getByRole("heading", { name: "Откуда вес?" })).toBeHidden();

    const { data: items } = await admin()
      .from("meal_items")
      .select("origin")
      .eq("meal_id", meal.mealId);
    expect(items!.every((i) => i.origin === "model_kept")).toBe(true);
  });

  test("привязка позиции к справочнику создаёт алиас", async ({
    page,
    user,
    signIn,
    catalogIds,
  }) => {
    const meal = await seedRecognisedMeal(user.id, { catalogIds });
    await signIn(user);
    await page.goto(`/meal/${meal.mealId}/edit`);
    await waitForHydration(page);

    await clickReact(page.getByRole("button", { name: "Подробнее: масло для жарки" }));
    await clickReact(page.getByRole("button", { name: "Привязать к справочнику" }));
    await fillReact(page.getByPlaceholder("Найти в справочнике"), "хлеб");
    await clickReact(
      page
        .getByRole("list", { name: "Результаты поиска" })
        .getByRole("button", { name: /хлеб тостовый/ })
        .first(),
    );

    // FR-CAT-1: справочник самообучается на использовании.
    await expect(async () => {
      const { data } = await admin()
        .from("ingredient_aliases")
        .select("alias, source")
        .eq("alias", "масло для жарки")
        .maybeSingle();
      expect(data?.source).toBe("user_mapping");
    }).toPass({ timeout: 10_000 });

    await admin().from("ingredient_aliases").delete().eq("alias", "масло для жарки");
  });
});

test.describe("Детальный экран и сравнение", () => {
  test("что предложила модель, сравнение и удаление", async ({
    page,
    user,
    signIn,
    catalogIds,
  }) => {
    const meal = await seedRecognisedMeal(user.id, { catalogIds });

    // Второе распознавание — чтобы появилась таблица сравнения (FR-CMP-1).
    const db = admin();
    const { data: second } = await db
      .from("recognitions")
      .insert({
        meal_id: meal.mealId,
        model_id: "x-ai/grok-4.5",
        model_label: "Grok 4.5",
        vendor: "xai",
        prompt_version: "v2-scale",
        is_primary: false,
        status: "ok",
        dish_name_ru: "Завтрак",
        total_weight_g: 260,
        nutrition_catalog: { energy_kcal: 610, protein: 25, fat: 40, carbs: 30 },
        latency_ms: 18000,
        cost_rub_actual: 1.4,
      })
      .select("id")
      .single();
    await db.from("recognition_items").insert([
      {
        recognition_id: second!.id,
        position: 0,
        name_ru: "яйцо жареное",
        name_en: "egg",
        weight_g: 70,
        ingredient_id: catalogIds[0],
        match_status: "exact",
      },
      {
        recognition_id: second!.id,
        position: 1,
        name_ru: "колбаса",
        name_en: "sausage",
        weight_g: 60,
        ingredient_id: null,
        match_status: "unmatched",
      },
    ]);

    await signIn(user);
    await page.goto(`/meal/${meal.mealId}`);
    await waitForHydration(page);

    // FR-DET-3: сворачиваемый блок с исходной версией модели.
    await clickReact(page.getByRole("button", { name: /Что предложила модель/ }));
    await expect(page.getByText(/Согласованность цепочки/)).toBeVisible();
    await expect(page.getByText("числа сходятся")).toBeVisible();

    // FR-CMP-1..3
    await expect(page.getByRole("heading", { name: "Сравнение моделей" })).toBeVisible();
    await expect(
      page.getByRole("columnheader", { name: "Ваша версия" }).first(),
    ).toBeVisible();
    await expect(page.getByText("Отклонение от вашей версии")).toBeVisible();
    await expect(page.getByText(/Совпало:/).first()).toBeVisible();
    await expect(page.getByText("колбаса")).toBeVisible();

    // FR-DET-5
    await clickReact(page.getByRole("button", { name: "Удалить приём пищи" }));
    await expect(page.getByText(/будут удалены безвозвратно/)).toBeVisible();
    await clickReact(page.getByRole("button", { name: "Удалить", exact: true }));

    await page.waitForURL("**/today", { timeout: 30_000 });
    const { data: gone } = await db.from("meals").select("id").eq("id", meal.mealId);
    expect(gone).toHaveLength(0);
  });
});

test.describe("История и профиль", () => {
  test("день попадает в историю и в дневные итоги", async ({
    page,
    user,
    signIn,
    catalogIds,
  }) => {
    await seedRecognisedMeal(user.id, { catalogIds });
    await signIn(user);

    // На «Сегодня» приём пищи виден в ленте с калориями.
    await expect(page.getByText("Тост с беконом и яичницей")).toBeVisible();

    await clickReact(page.getByRole("link", { name: "История" }));
    await expect(page.getByText(/Калории за последние/)).toBeVisible();
    // «Сегодня» есть и в таббаре — берём именно строку дня в списке истории.
    await expect(
      page.getByRole("link", { name: /Сегодня[\s\S]*ккал/ }),
    ).toBeVisible();
    await expect(page.getByText(/приём/)).toBeVisible();
  });

  test("эталон масштаба сохраняется в профиле", async ({ page, user, signIn }) => {
    await signIn(user);
    await clickReact(page.getByRole("link", { name: "Профиль" }));

    const card = page.getByRole("checkbox", { name: /Банковская карта/ });
    await expect(card).not.toBeChecked();
    await clickReact(card);
    await expect(card).toBeChecked();

    await expect(async () => {
      const { data } = await admin()
        .from("user_reference_objects")
        .select("type, true_size_mm")
        .eq("user_id", user.id);
      expect(data).toHaveLength(1);
      expect(data![0].type).toBe("bank_card");
      expect(Number(data![0].true_size_mm)).toBe(85.6);
    }).toPass({ timeout: 10_000 });
  });

  test("выход возвращает на экран входа", async ({ page, user, signIn }) => {
    await signIn(user);
    await clickReact(page.getByRole("link", { name: "Профиль" }));
    await clickReact(page.getByRole("button", { name: "Выйти" }));
    await page.waitForURL("**/login", { timeout: 30_000 });
  });
});
