-- ═══════════════════════════════════════════════════════════════════════════
-- 0001 — схема данных (§10.1 PRD)
-- Применять в SQL-редакторе Supabase по порядку: 0001 → 0002 → 0003 → 0004.
-- ═══════════════════════════════════════════════════════════════════════════

create extension if not exists pg_trgm;

-- ── Пользователи ────────────────────────────────────────────────────────────
-- auth.users — встроенная таблица Supabase Auth. Регистрация ОТКЛЮЧЕНА,
-- пользователи заводятся вручную через дашборд.

create table profiles (
  id            uuid primary key references auth.users(id) on delete cascade,
  display_name  text not null,
  is_admin      boolean not null default false,
  timezone      text not null default 'Europe/Moscow',
  created_at    timestamptz not null default now()
);

-- Профиль создаётся автоматически при заведении пользователя в дашборде,
-- иначе он войдёт и упрётся в пустой экран. display_name потом правится руками.
create function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, display_name)
  values (new.id, coalesce(new.raw_user_meta_data->>'display_name', split_part(new.email, '@', 1)))
  on conflict (id) do nothing;
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ── Справочник ──────────────────────────────────────────────────────────────
create table nutrients (
  id            serial primary key,
  code          text unique not null,        -- 'energy_kcal', 'vitamin_c', 'iron'
  name_ru       text not null,
  unit          text not null,               -- 'kcal', 'g', 'mg', 'mcg'
  group_code    text not null,               -- 'macro' | 'vitamin' | 'mineral'
  rdi_default   numeric,                     -- суточная норма для % DV
  sort_order    int not null default 0
);

create table ingredients (
  id                serial primary key,
  source            text not null,           -- 'usda_sr' | 'usda_foundation' | 'usda_fndds' | 'manual'
  source_id         text,                    -- fdc_id
  name_ru           text not null,
  name_en           text not null,
  category          text,
  state             text,                    -- 'raw' | 'cooked' | 'unknown'
  density_g_per_ml  numeric,                 -- для жидкостей, на будущее
  yield_factor      numeric,                 -- коэффициент уварки, вне MVP
  is_active         boolean not null default true,
  created_at        timestamptz not null default now()
);
create index on ingredients using gin (name_ru gin_trgm_ops);
create index on ingredients using gin (name_en gin_trgm_ops);
-- Индекс намеренно не частичный: PostgREST-овский upsert (on_conflict=source,
-- source_id) не умеет попадать в частичный уникальный индекс. NULL в source_id
-- (ручные позиции) уникальность не нарушают — в Postgres NULL-ы различны.
create unique index ingredients_source_key on ingredients (source, source_id);

create table ingredient_aliases (
  id             serial primary key,
  ingredient_id  int not null references ingredients(id) on delete cascade,
  alias          text not null,
  lang           text not null,              -- 'ru' | 'en'
  source         text not null,              -- 'import' | 'user_mapping'
  created_by     uuid references profiles(id),
  created_at     timestamptz not null default now(),
  unique (alias, lang)
);
create index on ingredient_aliases (ingredient_id);

create table ingredient_nutrients (
  ingredient_id   int not null references ingredients(id) on delete cascade,
  nutrient_id     int not null references nutrients(id),
  amount_per_100g numeric not null,
  primary key (ingredient_id, nutrient_id)
);

-- ── Приёмы пищи ─────────────────────────────────────────────────────────────
create table meals (
  id                  uuid primary key default gen_random_uuid(),
  user_id             uuid not null references profiles(id) on delete cascade,
  meal_date           date not null,            -- локальная дата пользователя
  eaten_at            timestamptz not null default now(),
  photo_original_path text,
  photo_sent_path     text not null,
  photo_sha256        text not null,
  photo_width         int,
  photo_height        int,
  user_hint           text,                     -- подсказка пользователя перед распознаванием
  status              text not null default 'processing',
                                                -- processing | ready | failed | manual
  dish_name_ru        text,                     -- пользовательская версия названия
  primary_recognition_id uuid,                  -- какое распознавание взято за основу
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);
create index on meals (user_id, meal_date);

-- ── Распознавания (по одному на каждый вызов модели) ────────────────────────
create table recognitions (
  id                uuid primary key default gen_random_uuid(),
  meal_id           uuid not null references meals(id) on delete cascade,
  model_id          text not null,
  model_label       text not null,
  vendor            text not null,
  prompt_version    text not null,
  image_detail      text,
  is_primary        boolean not null default false,   -- автоматический при съёмке
  status            text not null,                    -- ok | failed
  error_text        text,

  raw_response      jsonb,        -- полный ответ API как есть
  parsed            jsonb,        -- разобранный JSON по схеме §7.3

  -- денормализованные поля из parsed для быстрых запросов
  dish_name_ru       text,
  total_weight_g     numeric,
  overall_confidence numeric,
  scale_refs_count   int,
  has_scale_ref      boolean,
  image_angle        text,

  -- масштабная цепочка (см. §7.5)
  scale_mode           text,      -- 'reference' | 'container' | 'prior'
  scale_ref_type       text,      -- тип эталона, который модель заявила ведущим
  scale_ref_true_mm    numeric,   -- истинный размер эталона, если известен из профиля
  scale_ref_claimed_mm numeric,   -- размер, который модель приписала эталону
  scale_size_error     numeric,   -- |claimed - true| / true, NULL если истинный неизвестен
  scale_chain          jsonb,     -- цепочка расчёта + consistency_flags бэкенда

  -- нутриенты в двух вариантах
  nutrition_catalog jsonb,        -- {"energy_kcal": 640, "protein": 32, ...}
  nutrition_model   jsonb,

  -- стоимость и производительность
  latency_ms        int,
  prompt_tokens     int,
  completion_tokens int,
  cached_tokens     int,
  reasoning_tokens  int,
  usage_raw         jsonb,
  cost_rub_actual   numeric,     -- факт, ₽ (из usage.cost_rub)
  cost_direct_usd   numeric,     -- гипотетически напрямую, $
  vendor_pricing_snapshot jsonb,

  created_at        timestamptz not null default now()
);
create index on recognitions (meal_id);
create index on recognitions (model_id, created_at);

alter table meals
  add constraint meals_primary_recognition_fk
  foreign key (primary_recognition_id) references recognitions(id) on delete set null;

-- ── Ингредиенты, предложенные моделью ───────────────────────────────────────
create table recognition_items (
  id                uuid primary key default gen_random_uuid(),
  recognition_id    uuid not null references recognitions(id) on delete cascade,
  position          int not null,
  name_ru           text not null,
  name_en           text not null,
  weight_g          numeric not null,
  weight_confidence numeric,
  cooking_method    text,
  state             text,
  visible           boolean,
  kcal_per_100g     numeric,
  protein_per_100g  numeric,
  fat_per_100g      numeric,
  carbs_per_100g    numeric,
  ingredient_id     int references ingredients(id),
  match_status      text not null,      -- exact | fuzzy | unmatched
  match_score       numeric
);
create index on recognition_items (recognition_id);

-- ── Итоговая (пользовательская) версия блюда ────────────────────────────────
create table meal_items (
  id                uuid primary key default gen_random_uuid(),
  meal_id           uuid not null references meals(id) on delete cascade,
  position          int not null,
  ingredient_id     int references ingredients(id),
  name_ru           text not null,
  weight_g          numeric not null,
  nutrition_source  text not null,      -- 'catalog' | 'model'
  -- происхождение позиции: ключевое поле для аналитики
  origin            text not null,      -- 'model_kept' | 'model_edited' | 'user_added'
  source_item_id    uuid references recognition_items(id) on delete set null,
  original_weight_g numeric,            -- что предлагала модель, если origin='model_edited'
  -- нутриенты на 100 г, зафиксированные в момент сохранения: для 'model' их
  -- негде взять из справочника, а для 'catalog' это защита от последующей
  -- правки справочника, которая иначе переписала бы историю
  kcal_per_100g     numeric,
  protein_per_100g  numeric,
  fat_per_100g      numeric,
  carbs_per_100g    numeric,
  created_at        timestamptz not null default now()
);
create index on meal_items (meal_id);

-- удалённые пользователем позиции модели фиксируем отдельно, а не теряем
create table meal_removed_items (
  id                uuid primary key default gen_random_uuid(),
  meal_id           uuid not null references meals(id) on delete cascade,
  source_item_id    uuid not null references recognition_items(id) on delete cascade,
  removed_at        timestamptz not null default now(),
  unique (meal_id, source_item_id)
);

-- ── Как пользователь узнал вес (гипотеза H4) ────────────────────────────────
create table weight_evidence (
  id                uuid primary key default gen_random_uuid(),
  meal_id           uuid not null references meals(id) on delete cascade,
  method            text,
        -- 'scale'          — взвесил на кухонных весах
        -- 'package_label'  — указано на упаковке
        -- 'menu'           — указано в меню / на ценнике
        -- 'recipe'         — сам готовил, знаю раскладку
        -- 'measuring'      — мерная посуда (стакан, ложка)
        -- 'eyeball'        — прикинул на глаз
        -- NULL             — пользователь нажал «Не знаю» (FR-WE-4)
  self_confidence   int,               -- 1..5, субъективная уверенность
  reference_objects text[],            -- что реально было в кадре (см. enum §7.3)
  had_reference     boolean not null,
  comment           text,
  created_at        timestamptz not null default now(),
  unique (meal_id)
);

-- ── Эталоны масштаба, которыми располагает пользователь (см. §7.5) ──────────
create table user_reference_objects (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references profiles(id) on delete cascade,
  type          text not null,      -- тот же enum, что в scale_references
  label         text not null,      -- «Моя карта Сбера», «Apple Watch 45 мм»
  true_size_mm  numeric not null,   -- истинный характерный размер
  size_axis     text not null,      -- 'diameter' | 'width' | 'length' | 'case_height'
  is_default    boolean not null default false,
  created_at    timestamptz not null default now()
);
create index on user_reference_objects (user_id);

-- ── Служебное ───────────────────────────────────────────────────────────────
create table model_pricing_snapshots (
  id            serial primary key,
  model_id      text not null,
  provider      text,
  prompt_per_million_rub     numeric,
  completion_per_million_rub numeric,
  raw           jsonb,
  captured_at   timestamptz not null default now()
);
create index on model_pricing_snapshots (model_id, captured_at desc);

-- Копия config/models.ts, чтобы конфиг был виден из SQL при анализе (§6).
create table model_configs (
  id             serial primary key,
  model_id       text not null,
  label          text not null,
  vendor         text not null,
  enabled        boolean not null,
  prompt_version text not null,
  config         jsonb not null,
  synced_at      timestamptz not null default now(),
  unique (model_id, prompt_version)
);

-- ── Триггер updated_at ──────────────────────────────────────────────────────
create function public.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger meals_touch_updated_at
  before update on meals
  for each row execute function public.touch_updated_at();

-- ── Поиск по справочнику (§8.4, шаги 1–2) ───────────────────────────────────
-- Возвращает кандидатов: точное совпадение по имени/алиасу, затем триграммы.
create function public.search_ingredients(q text, max_results int default 20)
returns table (
  id int,
  name_ru text,
  name_en text,
  category text,
  match_status text,
  match_score numeric
)
language sql
stable
as $$
  with norm as (
    select lower(regexp_replace(trim(q), '[^\w\s]', '', 'g')) as term
  ),
  exact_match as (
    select i.id, i.name_ru, i.name_en, i.category,
           'exact'::text as match_status, 1.0::numeric as match_score
    from ingredients i, norm
    where i.is_active
      and (lower(regexp_replace(i.name_en, '[^\w\s]', '', 'g')) = norm.term
        or lower(regexp_replace(i.name_ru, '[^\w\s]', '', 'g')) = norm.term
        or exists (
          select 1 from ingredient_aliases a
          where a.ingredient_id = i.id
            and lower(regexp_replace(a.alias, '[^\w\s]', '', 'g')) = norm.term
        ))
  ),
  fuzzy_match as (
    select i.id, i.name_ru, i.name_en, i.category,
           'fuzzy'::text as match_status,
           greatest(similarity(i.name_en, q), similarity(i.name_ru, q))::numeric as match_score
    from ingredients i
    where i.is_active
      and (i.name_en % q or i.name_ru % q)
      and i.id not in (select id from exact_match)
  )
  select * from exact_match
  union all
  select * from fuzzy_match order by match_score desc
  limit max_results;
$$;
