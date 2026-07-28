import { join } from "node:path";
import { test, expect } from "./helpers/fixtures";
import { admin } from "./helpers/db";
import { clickReact, fillReact, waitForHydration } from "./helpers/actions";

/**
 * Тот же путь, но с настоящим вызовом модели — без подмены маршрута.
 *
 * Включается флагом, потому что стоит денег (~2–4 ₽ за прогон) и занимает до
 * минуты:
 *
 *   E2E_LIVE=1 npx playwright test e2e/live.spec.ts
 *
 * Проверяет то, что подменённый ответ проверить не может: что фотография
 * действительно сжимается и доезжает до модели, что ответ разбирается по схеме,
 * что стоимость и масштабная цепочка записываются, и что пользователь видит
 * осмысленный состав, а не заглушку.
 */

const PHOTO = join(process.cwd(), "fixtures", "sent-dish-4.jpg");

test.describe("Живое распознавание", () => {
  test.skip(process.env.E2E_LIVE !== "1", "нужен E2E_LIVE=1 — прогон платный");
  test.setTimeout(180_000);

  test("снял → распознали → поправил → сохранилось", async ({ page, user, signIn }) => {
    await signIn(user);

    await page.setInputFiles('input[data-source="camera"]', PHOTO);
    await expect(page.getByRole("heading", { name: "Проверьте кадр" })).toBeVisible();
    await fillReact(page.getByLabel(/Подсказка/), "завтрак: бекон, яичница и тост");
    await clickReact(page.getByRole("button", { name: "Отправить" }));

    // Ждём только отправку — дальше экран приёма пищи сам дождётся модели.
    await expect(page.getByText(/Отправляем фото|Сохраняем/)).toBeVisible();
    await page.waitForURL(/\/meal\/[0-9a-f-]+$/, { timeout: 60_000 });

    const mealId = page.url().match(/\/meal\/([0-9a-f-]+)$/)![1];

    // Экран сам опрашивает статус и перерисовывается, когда фоновая обработка
    // закончится (§5.1) — проверяем именно это, а не только запись в БД.
    await expect(
      page.getByRole("heading", { name: "Распознаём состав" }),
    ).toBeHidden({ timeout: 150_000 });

    await page.goto(`/meal/${mealId}/edit`);
    await waitForHydration(page);

    // Модель должна была разобрать блюдо на несколько позиций с весами.
    const rows = page.getByRole("list", { name: "Ингредиенты" }).getByRole("listitem");
    expect(await rows.count()).toBeGreaterThanOrEqual(3);

    const totalWeight = Number(await page.getByLabel("Общий вес, г").inputValue());
    expect(totalWeight).toBeGreaterThan(50);
    expect(totalWeight).toBeLessThan(1000);

    // Что записалось на сервере — то, ради чего вся затея (§9, §7.5).
    const db = admin();
    const { data: recognition } = await db
      .from("recognitions")
      .select(
        "status, model_label, total_weight_g, cost_rub_actual, prompt_tokens, completion_tokens, scale_chain, nutrition_catalog, nutrition_model, latency_ms",
      )
      .eq("meal_id", mealId)
      .single();

    expect(recognition!.status).toBe("ok");
    expect(Number(recognition!.total_weight_g)).toBeGreaterThan(0);
    expect(Number(recognition!.cost_rub_actual)).toBeGreaterThan(0);
    expect(Number(recognition!.prompt_tokens)).toBeGreaterThan(0);
    expect(recognition!.nutrition_catalog).toBeTruthy();
    expect(recognition!.nutrition_model).toBeTruthy();
    console.log(
      `  модель ${recognition!.model_label}: ${recognition!.total_weight_g} г, ` +
        `${recognition!.cost_rub_actual} ₽, ${Math.round(Number(recognition!.latency_ms) / 1000)} с`,
    );

    // Правим вес первой позиции и сохраняем — проверяем, что правка доехала.
    const firstWeight = rows.first().getByRole("textbox").first();
    const before = Number(await firstWeight.inputValue());
    await fillReact(firstWeight, String(before + 30));
    await clickReact(page.getByRole("button", { name: "Сохранить" }));

    await expect(page.getByRole("heading", { name: "Откуда вес?" })).toBeVisible();
    await clickReact(page.getByRole("button", { name: "Не знаю" }));
    await page.waitForURL(`**/meal/${mealId}`, { timeout: 30_000 });

    const { data: items } = await db
      .from("meal_items")
      .select("origin, original_weight_g, weight_g")
      .eq("meal_id", mealId)
      .order("position");
    const edited = items!.filter((i) => i.origin === "model_edited");
    expect(edited).toHaveLength(1);
    expect(Number(edited[0].weight_g) - Number(edited[0].original_weight_g)).toBe(30);
  });
});
