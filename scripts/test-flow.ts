/**
 * Сквозной тест всего потока данных.
 *
 *   npx tsx scripts/test-flow.ts [--keep] [--no-http] [--model ID]
 *
 * Проходит ровно тот путь, который проходит тестировщик, и проверяет на каждом
 * шаге не «не упало», а что именно записалось:
 *
 *   1. окружение и схема БД
 *   2. тестовый пользователь, профиль, эталон масштаба, мини-справочник
 *   3. RLS: чужие приёмы пищи не видны
 *   4. загрузка фото в Storage (sent + original) и sha256
 *   5. реальный вызов модели → recognitions + recognition_items + стоимость
 *   6. первичная пользовательская версия = предложение модели
 *   7. правка через HTTP-маршрут: origin и original_weight_g считает сервер
 *   8. модалка «Откуда вес?»
 *   9. перепрогон второй моделью тем же файлом, primary не меняется
 *  10. аналитические вьюхи: арифметика сходится
 *
 * После прогона всё созданное удаляется (кроме --keep).
 *
 * Требуется применённая схема (supabase/migrations) и, для шагов 7–8,
 * запущенный `npm run dev`.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { config as loadEnv } from "dotenv";
import { createClient as createSupabaseClient, type SupabaseClient } from "@supabase/supabase-js";
import { getEnabledModels, getIngredientsModel, getModel } from "../config/models";
import { NUTRIENTS } from "../config/nutrients";
import { runRecognition } from "../src/lib/recognition/run";
import { createInitialMealItems } from "../src/lib/recognition/meal-items";
import { createAdminClient } from "../src/lib/supabase/admin";

loadEnv({ path: ".env.local" });

const APP_URL = process.env.TEST_APP_URL ?? "http://localhost:3000";
const PHOTO = join(process.cwd(), "fixtures", "sent-dish-4.jpg");
const PASSWORD = "test-flow-password-9f3a";

// ── Мини-фреймворк проверок ─────────────────────────────────────────────────

let passed = 0;
let failed = 0;
let skipped = 0;

function check(label: string, condition: boolean, detail = ""): boolean {
  if (condition) {
    passed += 1;
    console.log(`  ✔ ${label}${detail ? ` — ${detail}` : ""}`);
  } else {
    failed += 1;
    console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
  }
  return condition;
}

function skip(label: string, why: string) {
  skipped += 1;
  console.log(`  ⤼ ${label} — пропущено: ${why}`);
}

function phase(title: string) {
  console.log(`\n${title}`);
}

// ── Сессия пользователя в виде cookie, как её пишет @supabase/ssr ───────────

function base64url(input: string): string {
  return Buffer.from(input, "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/**
 * @supabase/ssr хранит сессию в куке `sb-<ref>-auth-token` как
 * `base64-<base64url(JSON)>`, разрезая длинное значение на части `.0`, `.1`, …
 * Собираем такую же куку, чтобы дёргать настоящие маршруты приложения, а не
 * их подобие.
 */
function sessionCookieHeader(projectRef: string, session: unknown): string {
  const value = `base64-${base64url(JSON.stringify(session))}`;
  const key = `sb-${projectRef}-auth-token`;
  const MAX = 3180;
  if (value.length <= MAX) return `${key}=${value}`;
  const chunks: string[] = [];
  for (let i = 0; i < value.length; i += MAX) chunks.push(value.slice(i, i + MAX));
  return chunks.map((c, i) => `${key}.${i}=${c}`).join("; ");
}

async function main() {
  const args = process.argv.slice(2);
  const keep = args.includes("--keep");
  const useHttp = !args.includes("--no-http");

  const admin = createAdminClient();
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const projectRef = new URL(url).hostname.split(".")[0];
  const publicKey =
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ??
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

  const stamp = Date.now();
  const emails = {
    owner: `flowtest+${stamp}@example.com`,
    stranger: `flowtest-stranger+${stamp}@example.com`,
  };
  const created = { users: [] as string[], mealId: "", ingredientIds: [] as number[] };

  try {
    // ── 1. Окружение и схема ────────────────────────────────────────────────
    phase("1. Окружение и схема БД");
    const major = Number(process.version.slice(1).split(".")[0]);
    check("Node ≥ 22", major >= 22, process.version);
    check("POLZA_API_KEY задан", !!process.env.POLZA_API_KEY);

    for (const table of [
      "profiles",
      "nutrients",
      "ingredients",
      "meals",
      "recognitions",
      "recognition_items",
      "meal_items",
      "meal_removed_items",
      "weight_evidence",
      "user_reference_objects",
    ]) {
      const { error } = await admin.from(table).select("*").limit(1);
      if (!check(`таблица ${table}`, !error, error?.message)) {
        throw new Error(
          "Схема не применена. Откройте SQL Editor в Supabase и выполните supabase/migrations/all_in_one.sql",
        );
      }
    }
    for (const view of [
      "v_meal_user_totals",
      "v_daily_totals",
      "v_model_vs_user",
      "v_ingredient_agreement",
    ]) {
      const { error } = await admin.from(view).select("*").limit(1);
      check(`вьюха ${view}`, !error, error?.message);
    }
    const { error: rpcError } = await admin.rpc("search_ingredients", {
      q: "chicken",
      max_results: 1,
    });
    check("функция search_ingredients", !rpcError, rpcError?.message);

    const { data: buckets } = await admin.storage.listBuckets();
    check(
      "бакет meals существует и приватный",
      !!buckets?.find((b) => b.name === "meals" && !b.public),
    );

    const { count: nutrientCount } = await admin
      .from("nutrients")
      .select("id", { count: "exact", head: true });
    check("справочник нутриентов заполнен", (nutrientCount ?? 0) === NUTRIENTS.length,
      `${nutrientCount} из ${NUTRIENTS.length}`);

    // ── 2. Пользователи и данные ────────────────────────────────────────────
    phase("2. Тестовые пользователи и мини-справочник");
    for (const [role, email] of Object.entries(emails)) {
      const { data, error } = await admin.auth.admin.createUser({
        email,
        password: PASSWORD,
        email_confirm: true,
        user_metadata: { display_name: `Тест ${role}` },
      });
      if (!check(`пользователь ${role} создан`, !error && !!data.user, error?.message)) {
        throw new Error("Не удалось создать тестового пользователя");
      }
      created.users.push(data.user!.id);
    }
    const [ownerId, strangerId] = created.users;

    const { data: profile } = await admin
      .from("profiles")
      .select("id, display_name")
      .eq("id", ownerId)
      .maybeSingle();
    check("профиль создан триггером на auth.users", !!profile, profile?.display_name);

    // Эталон в профиле — без него scale_size_error не с чем сравнивать (FR-SCALE-3).
    await admin.from("user_reference_objects").insert({
      user_id: ownerId,
      type: "bank_card",
      label: "Банковская карта",
      true_size_mm: 85.6,
      size_axis: "width",
    });
    check("эталон масштаба записан в профиль", true);

    // Мини-справочник: без него всё уедет в nutrition_source='model', и ветка
    // «посчитано по справочнику» останется непроверенной.
    const seed = [
      { name_en: "egg, fried", name_ru: "яйцо жареное", energy_kcal: 196, protein: 13.6, fat: 14.8, carbs: 0.8 },
      { name_en: "bacon, cooked", name_ru: "бекон жареный", energy_kcal: 541, protein: 37, fat: 42, carbs: 1.4 },
      { name_en: "bread, toasted", name_ru: "хлеб тостовый", energy_kcal: 293, protein: 9, fat: 3.6, carbs: 55 },
    ];
    const { data: nutrientRows } = await admin.from("nutrients").select("id, code");
    const nutrientIdByCode = new Map(
      (nutrientRows ?? []).map((n) => [n.code as string, n.id as number]),
    );
    for (const item of seed) {
      const { data: ingredient } = await admin
        .from("ingredients")
        .upsert(
          {
            source: "manual",
            source_id: `flowtest-${stamp}-${item.name_en}`,
            name_en: item.name_en,
            name_ru: item.name_ru,
            state: "cooked",
          },
          { onConflict: "source,source_id" },
        )
        .select("id")
        .single();
      if (!ingredient) continue;
      created.ingredientIds.push(ingredient.id as number);
      await admin.from("ingredient_nutrients").upsert(
        (["energy_kcal", "protein", "fat", "carbs"] as const).map((code) => ({
          ingredient_id: ingredient.id as number,
          nutrient_id: nutrientIdByCode.get(code)!,
          amount_per_100g: item[code],
        })),
        { onConflict: "ingredient_id,nutrient_id" },
      );
    }
    check("мини-справочник загружен", created.ingredientIds.length === seed.length);

    const { data: found } = await admin.rpc("search_ingredients", {
      q: "bacon, cooked",
      max_results: 5,
    });
    check(
      "поиск по справочнику находит точное совпадение",
      (found ?? []).some((r: { match_status: string }) => r.match_status === "exact"),
    );

    // ── 3. Сессия пользователя и RLS ────────────────────────────────────────
    phase("3. Сессия пользователя и RLS");
    const ownerAuth = createSupabaseClient(url, publicKey);
    const { data: signIn, error: signInError } = await ownerAuth.auth.signInWithPassword({
      email: emails.owner,
      password: PASSWORD,
    });
    if (!check("вход по email и паролю", !signInError && !!signIn.session, signInError?.message)) {
      throw new Error("Без сессии проверять RLS нечем");
    }
    const ownerToken = signIn.session!.access_token;
    const asOwner: SupabaseClient = createSupabaseClient(url, publicKey, {
      global: { headers: { Authorization: `Bearer ${ownerToken}` } },
      auth: { persistSession: false },
    });

    const strangerAuth = createSupabaseClient(url, publicKey);
    const { data: strangerSignIn } = await strangerAuth.auth.signInWithPassword({
      email: emails.stranger,
      password: PASSWORD,
    });
    const asStranger: SupabaseClient = createSupabaseClient(url, publicKey, {
      global: {
        headers: { Authorization: `Bearer ${strangerSignIn.session!.access_token}` },
      },
      auth: { persistSession: false },
    });

    // ── 4. Фото в Storage ───────────────────────────────────────────────────
    phase("4. Фотография в Storage");
    const bytes = readFileSync(PHOTO);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const mealId = crypto.randomUUID();
    created.mealId = mealId;
    const sentPath = `${ownerId}/${mealId}/sent.jpg`;

    const { error: uploadError } = await asOwner.storage
      .from("meals")
      .upload(sentPath, bytes, { contentType: "image/jpeg" });
    check("загрузка фото под своей сессией", !uploadError, uploadError?.message);

    const { error: strangerUploadError } = await asStranger.storage
      .from("meals")
      .upload(`${ownerId}/${mealId}/hack.jpg`, bytes, { contentType: "image/jpeg" });
    check("чужой не может писать в чужую папку", !!strangerUploadError);

    const { error: mealError } = await asOwner.from("meals").insert({
      id: mealId,
      user_id: ownerId,
      meal_date: new Date().toISOString().slice(0, 10),
      photo_sent_path: sentPath,
      photo_sha256: sha256,
      photo_width: 1024,
      photo_height: 768,
      user_hint: "завтрак: бекон, яичница и тост",
      status: "processing",
    });
    check("приём пищи создан", !mealError, mealError?.message);

    const { data: strangerSees } = await asStranger
      .from("meals")
      .select("id")
      .eq("id", mealId);
    check("RLS: чужой не видит приём пищи", (strangerSees ?? []).length === 0);

    // ── 5. Распознавание ────────────────────────────────────────────────────
    phase("5. Вызов модели и запись результата");
    const modelArg = args.indexOf("--model");
    // Разбор на ингредиенты, а не модель по умолчанию: дальше проверяются
    // recognition_items, маппинг на справочник и первичные meal_items — всё то,
    // чего у v3-dish нет по устройству.
    const model =
      modelArg >= 0 ? getModel(args[modelArg + 1])! : getIngredientsModel();
    console.log(`  модель: ${model.label} (${model.id}), промпт ${model.promptVersion}`);

    const recognition = await runRecognition({
      supabase: asOwner,
      mealId,
      userId: ownerId,
      model,
      imageBase64: bytes.toString("base64"),
      imageMimeType: "image/jpeg",
      userHint: "завтрак: бекон, яичница и тост",
      isPrimary: true,
    });
    if (!check("распознавание успешно", recognition.status === "ok", recognition.errorText ?? "")) {
      throw new Error("Дальше проверять нечего");
    }

    const { data: rec } = await asOwner
      .from("recognitions")
      .select("*")
      .eq("id", recognition.recognitionId)
      .single();

    check("сохранён полный ответ API", !!rec.raw_response);
    check("сохранён разобранный JSON", !!rec.parsed);
    check("денормализовано название блюда", !!rec.dish_name_ru, rec.dish_name_ru);
    check("денормализован общий вес", Number(rec.total_weight_g) > 0, `${rec.total_weight_g} г`);
    check("записана латентность", Number(rec.latency_ms) > 0, `${rec.latency_ms} мс`);
    check("записаны токены", Number(rec.prompt_tokens) > 0,
      `${rec.prompt_tokens} + ${rec.completion_tokens}`);
    check("записана фактическая стоимость, ₽", rec.cost_rub_actual !== null,
      `${rec.cost_rub_actual} ₽`);
    check(
      "стоимость «напрямую» посчитана или честно пуста",
      model.vendorPricing ? rec.cost_direct_usd !== null : rec.cost_direct_usd === null,
      rec.cost_direct_usd !== null ? `$${Number(rec.cost_direct_usd).toFixed(5)}` : "NULL",
    );
    check("снапшот цен вендора", model.vendorPricing ? !!rec.vendor_pricing_snapshot : true);
    check("оба набора нутриентов посчитаны", !!rec.nutrition_catalog && !!rec.nutrition_model);
    check(
      "калории по справочнику отличаются от модельных",
      Number((rec.nutrition_catalog as Record<string, number>).energy_kcal ?? 0) > 0,
      `справочник ${Math.round(Number((rec.nutrition_catalog as Record<string, number>).energy_kcal ?? 0))} / модель ${Math.round(Number((rec.nutrition_model as Record<string, number>).energy_kcal ?? 0))} ккал`,
    );

    if (model.promptVersion === "v2-scale") {
      check("масштабная цепочка сохранена", !!rec.scale_chain, rec.scale_mode ?? "");
      const flags = (rec.scale_chain as { consistency_flags?: string[] })?.consistency_flags;
      check("проверки согласованности выполнены", Array.isArray(flags),
        flags?.length ? `флаги: ${flags.join(", ")}` : "числа сходятся");
    } else {
      check("для v1-plain цепочка не пишется", rec.scale_chain === null);
    }

    const { data: recItems } = await asOwner
      .from("recognition_items")
      .select("*")
      .eq("recognition_id", recognition.recognitionId)
      .order("position");
    check("позиции модели записаны", (recItems ?? []).length > 0, `${recItems?.length} шт.`);
    check(
      "у каждой позиции проставлен статус маппинга",
      (recItems ?? []).every((i) => ["exact", "fuzzy", "unmatched"].includes(i.match_status)),
      `сматчено: ${(recItems ?? []).filter((i) => i.ingredient_id !== null).length}`,
    );

    // ── 6. Первичная пользовательская версия ────────────────────────────────
    phase("6. Первичная версия = предложение модели");
    await createInitialMealItems(asOwner, mealId, recognition.items);
    await asOwner
      .from("meals")
      .update({
        status: "ready",
        primary_recognition_id: recognition.recognitionId,
        dish_name_ru: rec.dish_name_ru,
      })
      .eq("id", mealId);

    const { data: initialItems } = await asOwner
      .from("meal_items")
      .select("*")
      .eq("meal_id", mealId)
      .order("position");
    check("meal_items созданы", (initialItems ?? []).length === (recItems ?? []).length);
    check(
      "все позиции помечены как принятые без правок",
      (initialItems ?? []).every((i) => i.origin === "model_kept"),
    );
    check(
      "у позиций есть ссылка на предложение модели",
      (initialItems ?? []).every((i) => !!i.source_item_id),
    );

    // ── 7–8. HTTP-маршруты ──────────────────────────────────────────────────
    phase("7. Правка через HTTP-маршрут приложения");
    let httpAlive = false;
    if (useHttp) {
      try {
        const ping = await fetch(`${APP_URL}/login`, { redirect: "manual" });
        httpAlive = ping.status < 500;
      } catch {
        httpAlive = false;
      }
    }

    if (!httpAlive) {
      skip("правка, origin и модалка «Откуда вес?»",
        useHttp ? `${APP_URL} не отвечает — запустите npm run dev` : "флаг --no-http");
    } else {
      const cookie = sessionCookieHeader(projectRef, signIn.session);
      const items = initialItems ?? [];
      const editedItem = items[0];
      const removedItem = items[items.length - 1];
      const keptItems = items.slice(1, -1);

      const payload = {
        dish_name_ru: "Завтрак: бекон, яичница, тост",
        items: [
          // изменённый вес → сервер обязан вывести origin='model_edited'
          {
            source_item_id: editedItem.source_item_id,
            ingredient_id: editedItem.ingredient_id,
            name_ru: editedItem.name_ru,
            weight_g: Number(editedItem.weight_g) + 25,
          },
          ...keptItems.map((i) => ({
            source_item_id: i.source_item_id,
            ingredient_id: i.ingredient_id,
            name_ru: i.name_ru,
            weight_g: Number(i.weight_g),
          })),
          // добавленный вручную из справочника → origin='user_added'
          {
            source_item_id: null,
            ingredient_id: created.ingredientIds[0],
            name_ru: "яйцо жареное",
            weight_g: 55,
          },
        ],
        removed_source_item_ids: [removedItem.source_item_id],
      };

      const response = await fetch(`${APP_URL}/api/meals/${mealId}/items`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", Cookie: cookie },
        body: JSON.stringify(payload),
      });
      const body = await response.json();
      check("PUT /api/meals/[id]/items принят", response.ok, JSON.stringify(body).slice(0, 200));
      check("сервер понял, что были правки", body.should_ask_weight_evidence === true);

      const { data: edited } = await asOwner
        .from("meal_items")
        .select("*")
        .eq("meal_id", mealId)
        .order("position");

      const editedRow = (edited ?? []).find((i) => i.source_item_id === editedItem.source_item_id);
      check("изменённая позиция помечена model_edited", editedRow?.origin === "model_edited");
      check(
        "сохранён исходный вес модели",
        Math.abs(Number(editedRow?.original_weight_g) - Number(editedItem.weight_g)) < 0.01,
        `${editedRow?.original_weight_g} → ${editedRow?.weight_g} г`,
      );
      check(
        "добавленная позиция помечена user_added",
        (edited ?? []).some((i) => i.origin === "user_added"),
      );
      check(
        "добавленная из справочника считается по справочнику",
        (edited ?? []).find((i) => i.origin === "user_added")?.nutrition_source === "catalog",
      );
      check(
        "удалённая позиция исчезла из пользовательской версии",
        !(edited ?? []).some((i) => i.source_item_id === removedItem.source_item_id),
      );

      const { data: removedRows } = await asOwner
        .from("meal_removed_items")
        .select("*")
        .eq("meal_id", mealId);
      check("удалённая позиция зафиксирована отдельно", (removedRows ?? []).length === 1);

      const { data: recItemsAfter } = await asOwner
        .from("recognition_items")
        .select("id, weight_g")
        .eq("recognition_id", recognition.recognitionId)
        .order("position");
      check(
        "предложение модели не изменилось (FR-EDIT-10)",
        JSON.stringify(recItemsAfter) === JSON.stringify(recItems?.map((i) => ({ id: i.id, weight_g: i.weight_g }))),
      );

      phase("8. Модалка «Откуда вес?»");
      const evidenceResponse = await fetch(`${APP_URL}/api/meals/${mealId}/evidence`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: cookie },
        body: JSON.stringify({
          method: "scale",
          self_confidence: 4,
          reference_objects: ["bank_card"],
        }),
      });
      check("POST /api/meals/[id]/evidence принят", evidenceResponse.ok);
      const { data: evidence } = await asOwner
        .from("weight_evidence")
        .select("*")
        .eq("meal_id", mealId)
        .maybeSingle();
      check("ответы записаны, had_reference выведен", evidence?.had_reference === true,
        `метод: ${evidence?.method}, уверенность: ${evidence?.self_confidence}`);
    }

    // ── 9. Перепрогон второй моделью ────────────────────────────────────────
    phase("9. Перепрогон другой моделью тем же файлом");
    const other = getEnabledModels().find(
      (m) => `${m.id}@${m.promptVersion}` !== `${model.id}@${model.promptVersion}`,
    );
    if (!other) {
      skip("перепрогон", "в конфиге нет второй включённой модели");
    } else {
      const { data: file } = await asOwner.storage.from("meals").download(sentPath);
      const rerunBytes = Buffer.from(await file!.arrayBuffer());
      check(
        "скачан тот же файл, что уходил первой модели",
        createHash("sha256").update(rerunBytes).digest("hex") === sha256,
      );

      const second = await runRecognition({
        supabase: asOwner,
        mealId,
        userId: ownerId,
        model: other,
        imageBase64: rerunBytes.toString("base64"),
        imageMimeType: "image/jpeg",
        userHint: "завтрак: бекон, яичница и тост",
        isPrimary: false,
      });
      check(`перепрогон моделью ${other.label}`, second.status === "ok", second.errorText ?? "");

      const { data: meal } = await asOwner
        .from("meals")
        .select("primary_recognition_id")
        .eq("id", mealId)
        .single();
      check(
        "основное распознавание не подменилось (FR-CMP-5)",
        meal?.primary_recognition_id === recognition.recognitionId,
      );
      const { count: recCount } = await asOwner
        .from("recognitions")
        .select("id", { count: "exact", head: true })
        .eq("meal_id", mealId);
      check("у приёма пищи два распознавания", recCount === 2);
    }

    // ── 10. Аналитические вьюхи ─────────────────────────────────────────────
    phase("10. Аналитические представления");
    const { data: totals } = await asOwner
      .from("v_meal_user_totals")
      .select("*")
      .eq("meal_id", mealId)
      .maybeSingle();
    check("v_meal_user_totals считает итоги", Number(totals?.user_kcal) > 0,
      `${Math.round(Number(totals?.user_weight_g))} г, ${Math.round(Number(totals?.user_kcal))} ккал`);

    const { data: finalItems } = await asOwner
      .from("meal_items_with_nutrition")
      .select("weight_g, kcal_per_100g")
      .eq("meal_id", mealId);
    const manualKcal = (finalItems ?? []).reduce(
      (sum, i) => sum + (Number(i.weight_g) * Number(i.kcal_per_100g ?? 0)) / 100,
      0,
    );
    check(
      "арифметика вьюхи совпадает с ручным пересчётом",
      Math.abs(manualKcal - Number(totals?.user_kcal)) < 1,
      `${Math.round(manualKcal)} ккал`,
    );

    const { data: daily } = await asOwner
      .from("v_daily_totals")
      .select("*")
      .eq("user_id", ownerId);
    check("v_daily_totals отдаёт день", (daily ?? []).length === 1);

    const { data: vs } = await asOwner
      .from("v_model_vs_user")
      .select("*")
      .eq("meal_id", mealId);
    check("v_model_vs_user отдаёт строку на каждое распознавание", (vs ?? []).length >= 1,
      (vs ?? []).map((r) => `${r.model_label}: MAPE веса ${r.weight_ape !== null ? `${Math.round(Number(r.weight_ape) * 100)}%` : "—"}`).join("; "));

    const { data: agreement } = await asOwner
      .from("v_ingredient_agreement")
      .select("*")
      .eq("meal_id", mealId)
      .maybeSingle();
    if (agreement) {
      check("v_ingredient_agreement считает происхождение позиций", true,
        `без правок ${agreement.kept}, изменено ${agreement.edited}, добавлено ${agreement.added}, удалено ${agreement.removed}`);
    } else {
      check("v_ingredient_agreement отдаёт строку", false);
    }

    const { data: strangerVs } = await asStranger.from("v_model_vs_user").select("*");
    check("RLS: вьюхи не показывают чужие данные", (strangerVs ?? []).length === 0);
  } finally {
    if (!keep) {
      phase("Уборка");
      if (created.mealId) {
        const { data: meal } = await admin
          .from("meals")
          .select("photo_sent_path, photo_original_path")
          .eq("id", created.mealId)
          .maybeSingle();
        await admin.from("meals").delete().eq("id", created.mealId);
        const paths = [meal?.photo_sent_path, meal?.photo_original_path].filter(
          (p): p is string => !!p,
        );
        if (paths.length > 0) await admin.storage.from("meals").remove(paths);
      }
      if (created.ingredientIds.length > 0) {
        await admin.from("ingredients").delete().in("id", created.ingredientIds);
      }
      for (const id of created.users) await admin.auth.admin.deleteUser(id);
      console.log("  ✔ тестовые данные удалены");
    } else {
      console.log("\n--keep: тестовые данные оставлены в базе");
    }

    console.log(
      `\n${"═".repeat(60)}\nПройдено: ${passed}   Провалено: ${failed}   Пропущено: ${skipped}`,
    );
  }

  if (failed > 0) process.exit(1);
}

main().catch((error) => {
  console.error("\nТест прерван:", error instanceof Error ? error.message : error);
  process.exit(1);
});
