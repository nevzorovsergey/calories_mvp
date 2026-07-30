import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { config as loadEnv } from "dotenv";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

loadEnv({ path: ".env.local" });

/**
 * Подготовка данных для браузерных тестов.
 *
 * Пишем напрямую сервисным ключом: цель этих тестов — интерфейс, а серверный
 * конвейер уже покрыт scripts/test-flow.ts. Зато данные настоящие, со всеми
 * связями, поэтому экраны рисуются ровно так же, как у живого пользователя.
 */

export const TEST_PASSWORD = "e2e-password-4Kd8vQ";

export function admin(): SupabaseClient {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Нужны NEXT_PUBLIC_SUPABASE_URL и сервисный ключ");
  return createClient(url, key, { auth: { persistSession: false } });
}

export interface TestUser {
  id: string;
  email: string;
  password: string;
}

export async function createTestUser(
  opts: { isAdmin?: boolean; displayName?: string } = {},
): Promise<TestUser> {
  const db = admin();
  const email = `e2e+${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.com`;
  const { data, error } = await db.auth.admin.createUser({
    email,
    password: TEST_PASSWORD,
    email_confirm: true,
    user_metadata: { display_name: opts.displayName ?? "Тестировщик" },
  });
  if (error || !data.user) throw new Error(`Не удалось создать пользователя: ${error?.message}`);

  await db
    .from("profiles")
    .update({
      display_name: opts.displayName ?? "Тестировщик",
      is_admin: opts.isAdmin ?? false,
    })
    .eq("id", data.user.id);

  return { id: data.user.id, email, password: TEST_PASSWORD };
}

export async function deleteTestUser(userId: string): Promise<void> {
  const db = admin();
  const { data: meals } = await db
    .from("meals")
    .select("photo_sent_path, photo_original_path")
    .eq("user_id", userId);
  const paths = (meals ?? [])
    .flatMap((m) => [m.photo_sent_path, m.photo_original_path])
    .filter((p): p is string => !!p);
  // Наследие прежней схемы: оригинал заливался из браузера напрямую в Storage
  // до создания приёма пищи и в тестах с подменённым маршрутом не попадал ни в
  // одну строку meals. Сейчас архивный кадр кладёт сервер рядом с `sent`, но
  // уборка старых папок пусть остаётся — она дешёвая.
  const { data: originals } = await db.storage.from("meals").list(`${userId}/originals`);
  paths.push(...(originals ?? []).map((o) => `${userId}/originals/${o.name}`));
  if (paths.length > 0) await db.storage.from("meals").remove(paths);
  await db.auth.admin.deleteUser(userId);
}

/** Три позиции справочника — чтобы работали поиск, замена и «посчитано по справочнику». */
export async function seedCatalog(): Promise<number[]> {
  const db = admin();
  const items = [
    { name_en: "egg, fried", name_ru: "яйцо жареное", energy_kcal: 196, protein: 13.6, fat: 14.8, carbs: 0.8 },
    { name_en: "bacon, cooked", name_ru: "бекон жареный", energy_kcal: 541, protein: 37, fat: 42, carbs: 1.4 },
    { name_en: "bread, toasted", name_ru: "хлеб тостовый", energy_kcal: 293, protein: 9, fat: 3.6, carbs: 55 },
  ];

  const { data: nutrients } = await db.from("nutrients").select("id, code");
  const idByCode = new Map((nutrients ?? []).map((n) => [n.code as string, n.id as number]));

  const ids: number[] = [];
  for (const item of items) {
    const { data } = await db
      .from("ingredients")
      .upsert(
        {
          source: "manual",
          source_id: `e2e-${item.name_en}`,
          name_en: item.name_en,
          name_ru: item.name_ru,
          state: "cooked",
        },
        { onConflict: "source,source_id" },
      )
      .select("id")
      .single();
    if (!data) continue;
    ids.push(data.id as number);
    await db.from("ingredient_nutrients").upsert(
      (["energy_kcal", "protein", "fat", "carbs"] as const).map((code) => ({
        ingredient_id: data.id as number,
        nutrient_id: idByCode.get(code)!,
        amount_per_100g: item[code],
      })),
      { onConflict: "ingredient_id,nutrient_id" },
    );
  }
  return ids;
}

/**
 * Готовое блюдо с порциями и раскладкой — как позиции FNDDS после импорта.
 *
 * Своё, а не настоящее из справочника: реальные 5432 блюда приезжают импортом,
 * их состав и порции меняются со сменой версии дампа, и тест, завязанный на
 * «Lasagna with meat», сломается от обновления данных, а не от поломки кода.
 *
 * Компоненты ссылаются на позиции из `seedCatalog`, поэтому она обязана
 * отработать раньше — состав без привязки к справочнику проверял бы только
 * ветку fallback.
 */
export async function seedCatalogDish(ingredientIds: number[]): Promise<number> {
  const db = admin();

  const { data: dish } = await db
    .from("ingredients")
    .upsert(
      {
        source: "manual",
        source_id: "e2e-dish-lasagna",
        name_en: "e2e test lasagna",
        name_ru: "лазанья тестовая",
        kind: "dish",
        state: "cooked",
      },
      { onConflict: "source,source_id" },
    )
    .select("id")
    .single();
  if (!dish) throw new Error("не удалось завести тестовое блюдо");
  const dishId = dish.id as number;

  const { data: nutrients } = await db.from("nutrients").select("id, code");
  const idByCode = new Map((nutrients ?? []).map((n) => [n.code as string, n.id as number]));
  const per100g = { energy_kcal: 140, protein: 7.5, fat: 5, carbs: 16 } as const;
  await db.from("ingredient_nutrients").upsert(
    (Object.keys(per100g) as (keyof typeof per100g)[]).map((code) => ({
      ingredient_id: dishId,
      nutrient_id: idByCode.get(code)!,
      amount_per_100g: per100g[code],
    })),
    { onConflict: "ingredient_id,nutrient_id" },
  );

  // Полная перезапись, а не upsert: у порций и компонентов нет естественного
  // ключа, по которому повторный прогон отличил бы свою строку от прошлой.
  await db.from("ingredient_portions").delete().eq("ingredient_id", dishId);
  await db.from("ingredient_portions").insert([
    { ingredient_id: dishId, seq: 1, label_en: "Quantity not specified", label_ru: "обычная порция", gram_weight: 250, is_default: true },
    { ingredient_id: dishId, seq: 2, label_en: "1 piece", label_ru: "1 кусок", gram_weight: 206, is_default: false },
  ]);

  await db.from("ingredient_components").delete().eq("dish_id", dishId);
  await db.from("ingredient_components").insert([
    { dish_id: dishId, seq: 1, ingredient_id: ingredientIds[0] ?? null, name_en_fallback: "egg, fried", gram_weight: 60, share: 0.6 },
    { dish_id: dishId, seq: 2, ingredient_id: ingredientIds[1] ?? null, name_en_fallback: "bacon, cooked", gram_weight: 40, share: 0.4 },
  ]);

  return dishId;
}

/**
 * Приём пищи, который сервер уже принял, но ещё не распознал (§5.1).
 *
 * `ageMs` сдвигает время строки в прошлое: по нему экран решает, идёт обработка
 * или зависла, так что состаренная строка — единственный способ проверить
 * ветку «не завершилось», не выжидая три минуты в тесте.
 *
 * Стареет и `updated_at`: отсчёт идёт от него, потому что в `processing` можно
 * попасть и позже съёмки — с экрана выбора блюда, запустив разбор состава.
 * Триггер `meals_touch_updated_at` стоит на update, вставке он не мешает.
 */
export async function seedProcessingMeal(
  userId: string,
  opts: { ageMs?: number } = {},
): Promise<{ mealId: string }> {
  const db = admin();
  const mealId = randomUUID();
  const bytes = readFileSync(join(process.cwd(), "fixtures", "sent-dish-4.jpg"));
  const sentPath = `${userId}/${mealId}/sent.jpg`;
  await db.storage.from("meals").upload(sentPath, bytes, { contentType: "image/jpeg" });

  const createdAt = new Date(Date.now() - (opts.ageMs ?? 0)).toISOString();
  await db.from("meals").insert({
    id: mealId,
    user_id: userId,
    meal_date: new Date().toISOString().slice(0, 10),
    photo_sent_path: sentPath,
    photo_sha256: createHash("sha256").update(bytes).digest("hex"),
    photo_width: 1024,
    photo_height: 768,
    status: "processing",
    created_at: createdAt,
    updated_at: createdAt,
    eaten_at: createdAt,
  });

  return { mealId };
}

/**
 * Русское блюдо со справочными порциями S/M/L — как позиции Povarenok после
 * импорта. Отличается от `seedCatalogDish` не составом, а порциями: там две
 * штуки в терминах FNDDS («1 кусок»), здесь три в терминах экрана выбора, где
 * порядковый номер порции и есть размер.
 */
export async function seedRussianDish(ingredientIds: number[]): Promise<number> {
  const db = admin();

  const { data: dish } = await db
    .from("ingredients")
    .upsert(
      {
        source: "manual",
        source_id: "e2e-dish-borsch",
        name_en: "e2e test borsch",
        name_ru: "борщ тестовый",
        kind: "dish",
        state: "cooked",
      },
      { onConflict: "source,source_id" },
    )
    .select("id")
    .single();
  if (!dish) throw new Error("не удалось завести тестовое блюдо");
  const dishId = dish.id as number;

  const { data: nutrients } = await db.from("nutrients").select("id, code");
  const idByCode = new Map((nutrients ?? []).map((n) => [n.code as string, n.id as number]));
  const per100g = { energy_kcal: 60, protein: 3, fat: 2, carbs: 7 } as const;
  await db.from("ingredient_nutrients").upsert(
    (Object.keys(per100g) as (keyof typeof per100g)[]).map((code) => ({
      ingredient_id: dishId,
      nutrient_id: idByCode.get(code)!,
      amount_per_100g: per100g[code],
    })),
    { onConflict: "ingredient_id,nutrient_id" },
  );

  await db.from("ingredient_portions").delete().eq("ingredient_id", dishId);
  await db.from("ingredient_portions").insert([
    { ingredient_id: dishId, seq: 1, label_en: "small", label_ru: "маленькая", gram_weight: 180, is_default: false },
    { ingredient_id: dishId, seq: 2, label_en: "medium", label_ru: "обычная", gram_weight: 300, is_default: true },
    { ingredient_id: dishId, seq: 3, label_en: "large", label_ru: "большая", gram_weight: 450, is_default: false },
  ]);

  await db.from("ingredient_components").delete().eq("dish_id", dishId);
  await db.from("ingredient_components").insert([
    { dish_id: dishId, seq: 1, ingredient_id: ingredientIds[0] ?? null, name_en_fallback: "egg, fried", gram_weight: 180, share: 0.6 },
    { dish_id: dishId, seq: 2, ingredient_id: ingredientIds[1] ?? null, name_en_fallback: "bacon, cooked", gram_weight: 120, share: 0.4 },
  ]);

  return dishId;
}

export interface SeededChoice {
  mealId: string;
  recognitionId: string;
  dishId: number;
}

/**
 * Приём пищи, остановившийся на выборе блюда: распознавание v3-dish отработало,
 * три названия записаны, состава ещё нет.
 *
 * Третий кандидат намеренно без привязки к справочнику — это штатный исход
 * (см. match-dish.ts), и экран обязан показывать такой вариант нажатым, но
 * недоступным, а не прятать его.
 */
export async function seedAwaitingChoiceMeal(
  userId: string,
  dishId: number,
): Promise<SeededChoice> {
  const db = admin();
  const mealId = randomUUID();
  const bytes = readFileSync(join(process.cwd(), "fixtures", "sent-dish-3.jpg"));
  const sentPath = `${userId}/${mealId}/sent.jpg`;
  await db.storage.from("meals").upload(sentPath, bytes, { contentType: "image/jpeg" });

  await db.from("meals").insert({
    id: mealId,
    user_id: userId,
    meal_date: new Date().toISOString().slice(0, 10),
    photo_sent_path: sentPath,
    photo_sha256: createHash("sha256").update(bytes).digest("hex"),
    photo_width: 1024,
    photo_height: 768,
    status: "awaiting_choice",
    dish_name_ru: "борщ",
  });

  const { data: recognition } = await db
    .from("recognitions")
    .insert({
      meal_id: mealId,
      model_id: "google/gemini-3-flash-preview",
      model_label: "Gemini 3 Flash (по названию блюда)",
      vendor: "google",
      prompt_version: "v3-dish",
      image_detail: "high",
      is_primary: true,
      status: "ok",
      dish_name_ru: "борщ",
      overall_confidence: 0.8,
      // Модель предложила большую порцию — экран обязан предвыбрать именно её,
      // иначе её оценку не с чем сравнивать (H8).
      portion_size: "large",
      portion_reasoning: "глубокая тарелка полная до краёв",
      latency_ms: 7000,
      cost_rub_actual: 0.3,
    })
    .select("id")
    .single();
  const recognitionId = recognition!.id as string;

  await db.from("recognition_dish_candidates").insert([
    { recognition_id: recognitionId, position: 1, name_ru: "борщ", confidence: 0.8, why: "свёкла и капуста в бульоне", ingredient_id: dishId, match_score: 0.9, match_source: "povarenok" },
    { recognition_id: recognitionId, position: 2, name_ru: "щи", confidence: 0.15, why: "капуста без свёклы", ingredient_id: null, match_score: null, match_source: null },
    { recognition_id: recognitionId, position: 3, name_ru: "суп харчо", confidence: 0.05, why: "красный бульон", ingredient_id: null, match_score: null, match_source: null },
  ]);

  await db.from("meals").update({ primary_recognition_id: recognitionId }).eq("id", mealId);

  return { mealId, recognitionId, dishId };
}

export interface SeededMeal {
  mealId: string;
  recognitionId: string;
  itemIds: string[];
  /** Название позиции без справочника — уникально на прогон, см. seedRecognisedMeal. */
  unmatchedName: string;
}

/**
 * Приём пищи «как после распознавания»: фото в Storage, запись распознавания
 * с масштабной цепочкой и стоимостью, позиции модели и первичная
 * пользовательская версия, где всё ещё origin='model_kept'.
 */
export async function seedRecognisedMeal(
  userId: string,
  opts: { date?: string; catalogIds?: number[]; unmatchedName?: string } = {},
): Promise<SeededMeal> {
  const db = admin();
  const mealId = randomUUID();
  const date = opts.date ?? new Date().toISOString().slice(0, 10);
  // Привязка unmatched-позиции создаёт алиас, а уникальность
  // ingredient_aliases (alias, lang) — общая на весь справочник. С фиксированной
  // строкой тест конкурировал бы за алиас с импортом USDA: чей insert первый,
  // того и запись. Уникальное на прогон имя убирает этот класс флака целиком.
  const unmatchedName = opts.unmatchedName ?? `масло для жарки ${randomUUID().slice(0, 8)}`;

  const bytes = readFileSync(join(process.cwd(), "fixtures", "sent-dish-4.jpg"));
  const sentPath = `${userId}/${mealId}/sent.jpg`;
  await db.storage.from("meals").upload(sentPath, bytes, { contentType: "image/jpeg" });

  await db.from("meals").insert({
    id: mealId,
    user_id: userId,
    meal_date: date,
    photo_sent_path: sentPath,
    photo_sha256: createHash("sha256").update(bytes).digest("hex"),
    photo_width: 1024,
    photo_height: 768,
    user_hint: "завтрак",
    status: "ready",
    dish_name_ru: "Тост с беконом и яичницей",
  });

  const { data: recognition } = await db
    .from("recognitions")
    .insert({
      meal_id: mealId,
      model_id: "openai/gpt-5.1",
      model_label: "GPT-5.1",
      vendor: "openai",
      prompt_version: "v2-scale",
      image_detail: "high",
      is_primary: true,
      status: "ok",
      parsed: {
        scale_references: [{ type: "cutlery" }],
      },
      dish_name_ru: "Тост с беконом и яичницей",
      total_weight_g: 215,
      overall_confidence: 0.7,
      scale_refs_count: 1,
      has_scale_ref: true,
      image_angle: "45_degrees",
      scale_mode: "container",
      scale_chain: { scale_mode: "container", consistency_flags: [] },
      nutrition_catalog: { energy_kcal: 493, protein: 22, fat: 33, carbs: 26 },
      nutrition_model: { energy_kcal: 492, protein: 21, fat: 33, carbs: 26 },
      latency_ms: 21000,
      prompt_tokens: 5300,
      completion_tokens: 950,
      cost_rub_actual: 1.71,
      cost_direct_usd: 0.0161,
      vendor_pricing_snapshot: { currency: "USD", promptPerMillion: 1.25 },
    })
    .select("id")
    .single();

  const recognitionId = recognition!.id as string;
  const catalogIds = opts.catalogIds ?? [];

  const modelItems = [
    { name_ru: "яйцо жареное", name_en: "egg, fried", weight_g: 60, kcal: 196, protein: 13.6, fat: 14.8, carbs: 0.8, ingredient_id: catalogIds[0] ?? null, visible: true },
    { name_ru: "бекон жареный", name_en: "bacon, cooked", weight_g: 55, kcal: 541, protein: 37, fat: 42, carbs: 1.4, ingredient_id: catalogIds[1] ?? null, visible: true },
    { name_ru: "тост пшеничный", name_en: "bread, toasted", weight_g: 70, kcal: 293, protein: 9, fat: 3.6, carbs: 55, ingredient_id: catalogIds[2] ?? null, visible: true },
    // Позиция без справочника — проверяем пометку «≈» и «Привязать к справочнику».
    { name_ru: unmatchedName, name_en: "cooking oil", weight_g: 5, kcal: 884, protein: 0, fat: 100, carbs: 0, ingredient_id: null, visible: false },
  ];

  const { data: insertedItems } = await db
    .from("recognition_items")
    .insert(
      modelItems.map((item, position) => ({
        recognition_id: recognitionId,
        position,
        name_ru: item.name_ru,
        name_en: item.name_en,
        weight_g: item.weight_g,
        weight_confidence: 0.6,
        cooking_method: "fried",
        state: "cooked",
        visible: item.visible,
        kcal_per_100g: item.kcal,
        protein_per_100g: item.protein,
        fat_per_100g: item.fat,
        carbs_per_100g: item.carbs,
        ingredient_id: item.ingredient_id,
        match_status: item.ingredient_id ? "exact" : "unmatched",
        match_score: item.ingredient_id ? 1 : null,
      })),
    )
    .select("id, position");

  const itemIds = (insertedItems ?? [])
    .sort((a, b) => (a.position as number) - (b.position as number))
    .map((r) => r.id as string);

  await db.from("meal_items").insert(
    modelItems.map((item, position) => ({
      meal_id: mealId,
      position,
      ingredient_id: item.ingredient_id,
      name_ru: item.name_ru,
      weight_g: item.weight_g,
      nutrition_source: item.ingredient_id ? "catalog" : "model",
      origin: "model_kept",
      source_item_id: itemIds[position],
      kcal_per_100g: item.kcal,
      protein_per_100g: item.protein,
      fat_per_100g: item.fat,
      carbs_per_100g: item.carbs,
    })),
  );

  await db.from("meals").update({ primary_recognition_id: recognitionId }).eq("id", mealId);

  return { mealId, recognitionId, itemIds, unmatchedName };
}
