-- ── Готовые блюда FNDDS: порции и раскладка на ингредиенты (§8.1 PRD) ───────
--
-- До сих пор справочник состоял только из сырья: SR Legacy + Foundation. FNDDS
-- (survey foods) добавляет 5432 готовых блюда, и у них есть две вещи, которых у
-- сырья нет:
--
--   1. Бытовые порции с граммовкой («1 кусок лазаньи — 206 г»). Без них ручное
--      добавление упирается в «введите вес в граммах» — то есть в ровно ту
--      задачу, ради которой человек и фотографирует еду.
--   2. Раскладка на компоненты: из чего блюдо состоит и в какой пропорции.
--
-- `kind` разделяет две популяции в одной таблице. Это не украшение: маппинг
-- распознанных ингредиентов (src/lib/catalog/match.ts) обязан продолжать искать
-- ТОЛЬКО по сырью, иначе «курица» начнёт попадать в «Chicken breast, fried,
-- coated, skin eaten, from pre-cooked», и метрики H1 поедут вместе с ней.
-- Фильтр по kind появится в search_ingredients следующей миграцией.
--
-- Миграция идемпотентна (if not exists / drop policy if exists): применяется
-- точечно — npx tsx scripts/apply-migrations.ts --only 0006

-- ── Сырьё против блюда ──────────────────────────────────────────────────────
alter table ingredients
  add column if not exists kind text not null default 'ingredient';

create index if not exists ingredients_kind_idx on ingredients (kind);

-- ── Порции ──────────────────────────────────────────────────────────────────
-- Таблица общая для сырья и блюд: food_portion.csv есть и в дампах SR/Foundation,
-- их порции — следующий заход, схему под них закладываем сразу.
--
-- `label_en` хранится как есть («1 piece (1/6 of 8" square)»), `label_ru`
-- заполняется на этапе перевода и до него пуст. Единицу измерения отдельной
-- колонкой не держим: в survey-дампе measure_unit_id у всех 22 тысяч строк равен
-- 9999 («не определено»), вся информация — в тексте описания.
create table if not exists ingredient_portions (
  id             serial primary key,
  ingredient_id  int not null references ingredients(id) on delete cascade,
  seq            int not null,
  label_en       text not null,
  label_ru       text,
  gram_weight    numeric not null check (gram_weight > 0),
  -- Порция FNDDS «Quantity not specified» — это официальный размер по умолчанию,
  -- то есть готовый ответ на «сколько обычно съедают за раз».
  is_default     boolean not null default false,
  unique (ingredient_id, seq)
);
create index if not exists ingredient_portions_ingredient_idx
  on ingredient_portions (ingredient_id);

-- ── Раскладка блюда на компоненты ───────────────────────────────────────────
-- `gram_weight` — как в дампе, БЕЗ нормировки: input_food.csv даёт рецепт то на
-- 100 г, то на выход целиком (медиана суммы 100.6 г, но у десятой части блюд она
-- больше 600 г). Поэтому долю считает импортёр и кладёт в `share` — только на
-- неё можно опираться при масштабировании состава на вес порции.
--
-- `ingredient_id` может быть пуст: 46 кодов компонентов из 2336 не резолвятся ни
-- в SR Legacy, ни в FNDDS. Терять такую строку нельзя — без неё состав блюда
-- молча станет неполным, а сумма долей перестанет сходиться к единице. Название
-- из дампа сохраняем в `name_en_fallback` и показываем как позицию без привязки.
create table if not exists ingredient_components (
  id                serial primary key,
  dish_id           int not null references ingredients(id) on delete cascade,
  seq               int not null,
  ingredient_id     int references ingredients(id) on delete set null,
  name_en_fallback  text,
  gram_weight       numeric not null,
  share             numeric not null check (share >= 0 and share <= 1),
  -- Коэффициент сохранности витаминов при готовке (USDA Nutrient Retention
  -- Factors). Вне MVP (§8.5), но выбрасывать значение из дампа незачем.
  retention_code    text,
  unique (dish_id, seq),
  constraint ingredient_components_named check (
    ingredient_id is not null or name_en_fallback is not null
  )
);
create index if not exists ingredient_components_dish_idx
  on ingredient_components (dish_id);
create index if not exists ingredient_components_ingredient_idx
  on ingredient_components (ingredient_id);

-- ── Приём пищи без фотографии ───────────────────────────────────────────────
-- Схема из 0001 писалась под единственный вход — камеру. Добавление по
-- справочнику даёт приём пищи, у которого фотографии нет и не будет
-- (`status = 'manual'`, он был предусмотрен в 0001 комментарием, но недостижим
-- из-за этих двух not null).
alter table meals alter column photo_sent_path drop not null;
alter table meals alter column photo_sha256 drop not null;

-- ── RLS: справочники read-only для аутентифицированных (как в 0002) ─────────
alter table ingredient_portions enable row level security;
drop policy if exists ingredient_portions_read on ingredient_portions;
create policy ingredient_portions_read on ingredient_portions
  for select to authenticated using (true);

alter table ingredient_components enable row level security;
drop policy if exists ingredient_components_read on ingredient_components;
create policy ingredient_components_read on ingredient_components
  for select to authenticated using (true);
