import { join } from "node:path";
import { test, expect } from "./helpers/fixtures";
import { admin, seedRecognisedMeal } from "./helpers/db";
import { clickReact, waitForHydration } from "./helpers/actions";

/**
 * День, к которому привязана еда (FR-CAP-8, FR-DET-7).
 *
 * `meal_date` — единственное, что решает, в чей дневной итог попадёт приём пищи
 * (§10.1). Промахнуться легко: экран «Сегодня» листается по дням, и человек
 * фотографирует обед, стоя во вчера. Проверяем оба конца: вопрос до отправки и
 * перенос уже сохранённого приёма пищи.
 *
 * Часовой пояс берём тот же, что стоит в профиле по умолчанию: приложение
 * считает «сегодня» по нему, а не по UTC, и между полуночью и тремя часами ночи
 * тест с UTC-датой падал бы на ровном месте.
 */

const PHOTO = join(process.cwd(), "fixtures", "sent-dish-4.jpg");
const TZ = "Europe/Moscow";

function isoDate(shiftDays = 0): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(Date.now() + shiftDays * 86_400_000));
}

/** Дата из multipart-тела: остальное там — байты JPEG, разбирать их незачем. */
function mealDateFromForm(body: Buffer | null): string | null {
  const text = body?.toString("latin1") ?? "";
  return text.match(/name="meal_date"\r?\n\r?\n(\d{4}-\d{2}-\d{2})/)?.[1] ?? null;
}

test.describe("День приёма пищи", () => {
  test("вне сегодняшнего дня спрашиваем дату, и «съел сегодня» меняет её", async ({
    page,
    user,
    signIn,
    catalogIds,
  }) => {
    const meal = await seedRecognisedMeal(user.id, { catalogIds });
    let sentDate: string | null = null;
    await page.route("**/api/meals", async (route) => {
      if (route.request().method() !== "POST") return route.fallback();
      sentDate = mealDateFromForm(route.request().postDataBuffer());
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          meal_id: meal.mealId,
          status: "processing",
          model: { id: "openai/gpt-5.1", label: "GPT-5.1" },
        }),
      });
    });

    await signIn(user);
    await page.goto(`/today?date=${isoDate(-1)}`);
    await waitForHydration(page);
    await page.setInputFiles('input[data-source="camera"]', PHOTO);

    // Вопрос стоит до предпросмотра: отвечать на него, уже нажав «Отправить»,
    // было бы поздно.
    await expect(page.getByRole("heading", { name: "К какому дню отнести?" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Да, к «Вчера»" })).toBeVisible();

    await clickReact(page.getByRole("button", { name: "Нет, я съел это сегодня" }));

    // Ответ виден на предпросмотре — отправлять вслепую не приходится.
    await expect(page.getByRole("heading", { name: "Проверьте кадр" })).toBeVisible();
    await expect(page.getByText(/День приёма пищи:\s*Сегодня/)).toBeVisible();

    await clickReact(page.getByRole("button", { name: "Отправить" }));
    await page.waitForURL(`**/meal/${meal.mealId}`, { timeout: 30_000 });

    // Главное: на сервер ушла сегодняшняя дата, а не открытый вчерашний день.
    expect(sentDate).toBe(isoDate());
  });

  test("в сегодняшнем дне лишнего вопроса нет", async ({ page, user, signIn }) => {
    await signIn(user);
    await page.setInputFiles('input[data-source="camera"]', PHOTO);

    await expect(page.getByRole("heading", { name: "Проверьте кадр" })).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "К какому дню отнести?" }),
    ).toHaveCount(0);
    await expect(page.getByText(/День приёма пищи:/)).toHaveCount(0);
  });

  test("готовый приём пищи переносится в другой день вместе со временем", async ({
    page,
    user,
    signIn,
    catalogIds,
  }) => {
    const { mealId } = await seedRecognisedMeal(user.id, {
      date: isoDate(),
      catalogIds,
    });
    const db = admin();
    const { data: before } = await db
      .from("meals")
      .select("eaten_at")
      .eq("id", mealId)
      .single();

    await signIn(user);
    await page.goto(`/meal/${mealId}`);
    await waitForHydration(page);

    await clickReact(page.getByRole("button", { name: "Перенести на другую дату" }));
    await clickReact(page.getByRole("button", { name: "Вчера" }));
    // Именно кнопка диалога: «Перенести на другую дату» на экране тоже подходит
    // под нестрогое совпадение по имени.
    await clickReact(page.getByRole("button", { name: "Перенести", exact: true }));

    // После переноса показываем тот день, куда перенесли: там и приём пищи, и
    // пересчитанный итог.
    await page.waitForURL(`**/today?date=${isoDate(-1)}`, { timeout: 30_000 });
    await expect(
      page.getByRole("link", { name: /Тост с беконом и яичницей/ }),
    ).toBeVisible();

    const { data: after } = await db
      .from("meals")
      .select("meal_date, eaten_at")
      .eq("id", mealId)
      .single();
    expect(after?.meal_date).toBe(isoDate(-1));
    // Время дня сохранилось: метка съезжает ровно на сутки, иначе приём пищи
    // встал бы в ленте нового дня не на своё место.
    expect(
      new Date(before!.eaten_at as string).getTime() -
        new Date(after!.eaten_at as string).getTime(),
    ).toBe(86_400_000);
  });
});
