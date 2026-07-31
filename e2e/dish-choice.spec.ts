import { test, expect } from "./helpers/fixtures";
import {
  admin,
  seedAwaitingChoiceMeal,
  seedIngredientsRun,
  seedRecognisedMeal,
  seedRussianDish,
} from "./helpers/db";
import { clickReact, waitForHydration } from "./helpers/actions";

/**
 * Выбор блюда — экран, на который приводит распознавание по названию (v3-dish,
 * спека .scratch/russian-dish-catalog).
 *
 * Проверяется не только отрисовка, но и происхождение состава: он обязан
 * приехать из справочника с `origin = 'catalog_dish'`. Если сохранение
 * запишет его как предложение модели, экран будет выглядеть исправным, а H7
 * («доля приёмов пищи, где выбран один из трёх вариантов») начнёт считать
 * выбор справочника наравне с разбором на ингредиенты.
 */

test.describe("Выбор блюда", () => {
  test("два выбора вместо правки состава: блюдо, размер — и приём пищи готов", async ({
    page,
    user,
    signIn,
    catalogIds,
  }) => {
    const dishId = await seedRussianDish(catalogIds);
    const { mealId } = await seedAwaitingChoiceMeal(user.id, dishId);

    await signIn(user);

    // Лента дня не показывает ноль калорий: состава ещё нет, и это видно.
    await expect(page.getByRole("link", { name: /Выбрать блюдо/ })).toBeVisible();

    await page.goto(`/meal/${mealId}`);
    await waitForHydration(page);

    await expect(page.getByRole("heading", { name: "Что это?" })).toBeVisible();

    // Показывается название справочника, а не модели: выбирают то, что реально
    // ляжет в приём пищи.
    const catalogOption = page.getByRole("button", { name: /борщ тестовый/ });
    await expect(catalogOption).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByText("свёкла и капуста в бульоне")).toBeVisible();

    // Вариант без справочника остаётся на экране, но нажать его нельзя.
    const unmatched = page.getByRole("button", { name: /щи/ }).first();
    await expect(unmatched).toBeDisabled();
    await expect(page.getByText(/нет в справочнике/).first()).toBeVisible();

    // Предвыбран размер, который назвала модель (large), а не «обычный».
    await expect(page.getByRole("button", { name: /большая/ })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await expect(page.getByRole("button", { name: /большая/ })).toContainText("450 г");
    await expect(page.getByRole("button", { name: /большая/ })).toContainText("270 ккал");

    // Смена размера пересчитывает и граммы, и цену: 300 г × 60 ккал/100 г.
    await clickReact(page.getByRole("button", { name: /обычная/ }));
    await expect(page.getByRole("button", { name: /обычная/ })).toContainText("180 ккал");

    await clickReact(page.getByRole("button", { name: /Сохранить · 300 г/ }));

    await expect(page.getByRole("heading", { name: "борщ тестовый" })).toBeVisible({
      timeout: 30_000,
    });

    const db = admin();
    const { data: meal } = await db
      .from("meals")
      .select("status, selected_dish_id, selected_candidate_position, selected_portion_size")
      .eq("id", mealId)
      .single();
    expect(meal?.status).toBe("ready");
    expect(meal?.selected_dish_id).toBe(dishId);
    expect(meal?.selected_candidate_position).toBe(1);
    expect(meal?.selected_portion_size).toBe("medium");

    // Состав — раскладка справочника, отмасштабированная долями 0.6 / 0.4.
    const { data: items } = await db
      .from("meal_items")
      .select("name_ru, weight_g, origin, nutrition_source")
      .eq("meal_id", mealId)
      .order("position");
    expect(items).toHaveLength(2);
    expect(Number(items?.[0].weight_g)).toBe(180);
    expect(Number(items?.[1].weight_g)).toBe(120);
    expect(items?.every((i) => i.origin === "catalog_dish")).toBe(true);
    expect(items?.every((i) => i.nutrition_source === "catalog")).toBe(true);

    // Предложение модели не перезаписано выбором человека (§1.3 PRD).
    const { data: candidates } = await db
      .from("recognition_dish_candidates")
      .select("position")
      .eq("recognition_id", (await recognitionOf(mealId)) ?? "");
    expect(candidates).toHaveLength(3);
  });

  test("нужного блюда нет — с того же экрана запускается разбор состава", async ({
    page,
    user,
    signIn,
    catalogIds,
  }) => {
    const dishId = await seedRussianDish(catalogIds);
    const { mealId } = await seedAwaitingChoiceMeal(user.id, dishId);

    await signIn(user);
    await page.goto(`/meal/${mealId}`);
    await waitForHydration(page);

    // Запасной путь виден рядом с ручным вводом и объясняет, что произойдёт:
    // без него единственным выходом из «моего блюда здесь нет» остаётся
    // набивание состава руками.
    const fallback = page.getByRole("button", {
      name: /Распознать состав нейросетью/,
    });
    await expect(fallback).toBeVisible();
    await expect(fallback).toContainText("10–40 секунд");
    await expect(page.getByRole("link", { name: /Ввести состав вручную/ })).toBeVisible();

    // Сам прогон здесь не запускаем: он стоит денег и идёт до минуты — это
    // проверяет e2e/live.spec.ts. Проверяем то, что от модели не зависит:
    // разбор состава доступен только пока блюдо не выбрано. Иначе кнопка
    // «Назад» в браузере молча заменяла бы состав, который человек уже правил.
    const ready = await seedRecognisedMeal(user.id, { catalogIds });
    const response = await page.request.post(`/api/meals/${ready.mealId}/ingredients`);
    expect(response.status()).toBe(409);

    const { data: meal } = await admin()
      .from("meals")
      .select("status")
      .eq("id", ready.mealId)
      .single();
    expect(meal?.status).toBe("ready");
  });

  test("в сравнении моделей у распознавания по названию есть вес и БЖУ", async ({
    page,
    user,
    signIn,
    catalogIds,
  }) => {
    // Ровно то, что делает человек: сфотографировал, названия не подошли,
    // запустил разбор состава. В таблице сравнения оказываются оба прогона.
    const dishId = await seedRussianDish(catalogIds);
    const { mealId } = await seedAwaitingChoiceMeal(user.id, dishId);
    await seedIngredientsRun(mealId, catalogIds);

    await signIn(user);
    await page.goto(`/meal/${mealId}`);
    await waitForHydration(page);

    await expect(page.getByRole("heading", { name: "Сравнение моделей" })).toBeVisible();

    // Колонка v3-dish идёт первой: распознавания упорядочены по created_at.
    // У неё нет ни `recognition_items`, ни `nutrition_catalog` — и до тикета
    // она стояла нулевой, а сравнивать «блюдо целиком» было не с чем.
    const rowByLabel = (label: string) =>
      page
        .getByRole("row")
        .filter({ has: page.getByRole("rowheader", { name: label, exact: true }) });

    // Модель предложила большую порцию, у блюда это 450 г (seedRussianDish).
    await expect(rowByLabel("Общий вес, г").getByRole("cell").first()).toHaveText("450");

    for (const label of ["Калории, ккал", "Белки, г", "Жиры, г", "Углеводы, г"]) {
      await expect(rowByLabel(label).getByRole("cell").first()).not.toHaveText("0");
    }

    // Цифры посчитаны, а не измерены моделью — и страница обязана это сказать,
    // иначе колонка выглядит как оценка веса, которой модель не делала.
    await expect(
      page.getByText(/борщ, большая порция — вес и БЖУ посчитаны по справочнику/),
    ).toBeVisible();
  });
});

async function recognitionOf(mealId: string): Promise<string | null> {
  const { data } = await admin()
    .from("meals")
    .select("primary_recognition_id")
    .eq("id", mealId)
    .single();
  return (data?.primary_recognition_id as string | null) ?? null;
}
