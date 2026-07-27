-- ═══════════════════════════════════════════════════════════════════════
-- Все миграции одним файлом — для первого применения в SQL Editor Supabase.
-- Порядок важен: схема → RLS → вьюхи → справочник нутриентов.
-- Файл сгенерирован из 0001–0004; правьте исходные файлы, а не этот.
-- ═══════════════════════════════════════════════════════════════════════

-- ───────── 0001_schema.sql ─────────
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

-- ───────── 0002_rls.sql ─────────
-- ═══════════════════════════════════════════════════════════════════════════
-- 0002 — Row Level Security (§10.2 PRD)
--
-- Каждый пользователь видит только свои meals / recognitions / meal_items /
-- weight_evidence. Админ (profiles.is_admin = true) видит всё. Справочники —
-- read-only для всех аутентифицированных.
--
-- Приложение ходит в БД от имени пользователя (anon key + cookie-сессия), а не
-- сервисным ключом, поэтому RLS — реальная граница, а не украшение.
-- ═══════════════════════════════════════════════════════════════════════════

-- Проверка админства через security definer: прямой select из profiles внутри
-- политики на profiles ушёл бы в бесконечную рекурсию.
create function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((select is_admin from profiles where id = auth.uid()), false);
$$;

-- Владелец приёма пищи — тоже security definer, иначе политики дочерних таблиц
-- потребуют прав на чтение meals и будут зависеть от порядка проверок.
create function public.owns_meal(m_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from meals
    where meals.id = m_id
      and (meals.user_id = auth.uid() or public.is_admin())
  );
$$;

-- ── Профили ─────────────────────────────────────────────────────────────────
alter table profiles enable row level security;

create policy profiles_select on profiles for select to authenticated
  using (id = auth.uid() or public.is_admin());

create policy profiles_update_own on profiles for update to authenticated
  using (id = auth.uid()) with check (id = auth.uid());

-- ── Справочники: read-only для аутентифицированных ──────────────────────────
alter table nutrients enable row level security;
create policy nutrients_read on nutrients for select to authenticated using (true);

alter table ingredients enable row level security;
create policy ingredients_read on ingredients for select to authenticated using (true);

alter table ingredient_nutrients enable row level security;
create policy ingredient_nutrients_read on ingredient_nutrients
  for select to authenticated using (true);

alter table ingredient_aliases enable row level security;
create policy ingredient_aliases_read on ingredient_aliases
  for select to authenticated using (true);

-- FR-CAT-1: привязывая unmatched-ингредиент к справочнику, пользователь
-- создаёт алиас. Справочник самообучается на использовании.
create policy ingredient_aliases_insert on ingredient_aliases
  for insert to authenticated
  with check (source = 'user_mapping' and created_by = auth.uid());

-- ── Приёмы пищи и всё, что к ним привязано ──────────────────────────────────
alter table meals enable row level security;

create policy meals_select on meals for select to authenticated
  using (user_id = auth.uid() or public.is_admin());
create policy meals_insert on meals for insert to authenticated
  with check (user_id = auth.uid());
create policy meals_update on meals for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy meals_delete on meals for delete to authenticated
  using (user_id = auth.uid());

alter table recognitions enable row level security;
create policy recognitions_select on recognitions for select to authenticated
  using (public.owns_meal(meal_id));
create policy recognitions_insert on recognitions for insert to authenticated
  with check (public.owns_meal(meal_id));
-- update разрешён только для is_primary (пометка основного распознавания);
-- содержательные поля неизменяемы по FR-EDIT-10.
create policy recognitions_update on recognitions for update to authenticated
  using (public.owns_meal(meal_id)) with check (public.owns_meal(meal_id));

alter table recognition_items enable row level security;
create policy recognition_items_select on recognition_items for select to authenticated
  using (exists (
    select 1 from recognitions r
    where r.id = recognition_id and public.owns_meal(r.meal_id)
  ));
create policy recognition_items_insert on recognition_items for insert to authenticated
  with check (exists (
    select 1 from recognitions r
    where r.id = recognition_id and public.owns_meal(r.meal_id)
  ));

alter table meal_items enable row level security;
create policy meal_items_all on meal_items for all to authenticated
  using (public.owns_meal(meal_id)) with check (public.owns_meal(meal_id));

alter table meal_removed_items enable row level security;
create policy meal_removed_items_all on meal_removed_items for all to authenticated
  using (public.owns_meal(meal_id)) with check (public.owns_meal(meal_id));

alter table weight_evidence enable row level security;
create policy weight_evidence_all on weight_evidence for all to authenticated
  using (public.owns_meal(meal_id)) with check (public.owns_meal(meal_id));

alter table user_reference_objects enable row level security;
create policy user_reference_objects_all on user_reference_objects for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- ── Служебные таблицы: только админ ─────────────────────────────────────────
alter table model_pricing_snapshots enable row level security;
create policy model_pricing_snapshots_read on model_pricing_snapshots
  for select to authenticated using (public.is_admin());

alter table model_configs enable row level security;
create policy model_configs_read on model_configs
  for select to authenticated using (public.is_admin());

-- ── Storage ─────────────────────────────────────────────────────────────────
-- Бакет `meals` создаётся в дашборде как приватный. Путь к файлу начинается с
-- user_id, поэтому чужие фото недоступны даже по прямой ссылке.
insert into storage.buckets (id, name, public)
values ('meals', 'meals', false)
on conflict (id) do nothing;

create policy meal_photos_read on storage.objects for select to authenticated
  using (
    bucket_id = 'meals'
    and ((storage.foldername(name))[1] = auth.uid()::text or public.is_admin())
  );

create policy meal_photos_insert on storage.objects for insert to authenticated
  with check (
    bucket_id = 'meals' and (storage.foldername(name))[1] = auth.uid()::text
  );

create policy meal_photos_delete on storage.objects for delete to authenticated
  using (
    bucket_id = 'meals' and (storage.foldername(name))[1] = auth.uid()::text
  );

-- ───────── 0003_views.sql ─────────
-- ═══════════════════════════════════════════════════════════════════════════
-- 0003 — аналитические представления (§12 PRD)
--
-- Это, по сути, результат всего прототипа: отсюда считаются MAPE веса и
-- калорий, precision/recall по составу, эффект эталона (H4) и эффект
-- масштабной цепочки (H6).
--
-- security_invoker = on обязателен: иначе вьюха выполнялась бы с правами
-- владельца и обошла RLS, показав пользователю чужие приёмы пищи.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── Вспомогательная: пользовательские позиции с нутриентами на 100 г ────────
-- Нутриенты берём из снимка на строке meal_items (он зафиксирован в момент
-- сохранения), а если его нет — доливаем из справочника.
create view meal_items_with_nutrition with (security_invoker = on) as
select
  mi.id,
  mi.meal_id,
  mi.ingredient_id,
  mi.name_ru,
  mi.weight_g,
  mi.origin,
  mi.nutrition_source,
  mi.original_weight_g,
  coalesce(mi.kcal_per_100g,    cat.energy_kcal) as kcal_per_100g,
  coalesce(mi.protein_per_100g, cat.protein)     as protein_per_100g,
  coalesce(mi.fat_per_100g,     cat.fat)         as fat_per_100g,
  coalesce(mi.carbs_per_100g,   cat.carbs)       as carbs_per_100g
from meal_items mi
left join lateral (
  select
    max(inut.amount_per_100g) filter (where n.code = 'energy_kcal') as energy_kcal,
    max(inut.amount_per_100g) filter (where n.code = 'protein')     as protein,
    max(inut.amount_per_100g) filter (where n.code = 'fat')         as fat,
    max(inut.amount_per_100g) filter (where n.code = 'carbs')       as carbs
  from ingredient_nutrients inut
  join nutrients n on n.id = inut.nutrient_id
  where inut.ingredient_id = mi.ingredient_id
) cat on true;

-- ── Итоги по приёму пищи в пользовательской версии ──────────────────────────
create view v_meal_user_totals with (security_invoker = on) as
select
  meal_id,
  count(*)                                                   as item_count,
  sum(weight_g)                                              as user_weight_g,
  sum(weight_g * coalesce(kcal_per_100g, 0) / 100)           as user_kcal,
  sum(weight_g * coalesce(protein_per_100g, 0) / 100)        as user_protein,
  sum(weight_g * coalesce(fat_per_100g, 0) / 100)            as user_fat,
  sum(weight_g * coalesce(carbs_per_100g, 0) / 100)          as user_carbs
from meal_items_with_nutrition
group by meal_id;

-- ── Дневные итоги (главный экран и история) ─────────────────────────────────
create view v_daily_totals with (security_invoker = on) as
select
  m.user_id,
  m.meal_date,
  count(distinct m.id)          as meals_count,
  sum(t.user_kcal)              as kcal,
  sum(t.user_protein)           as protein,
  sum(t.user_fat)               as fat,
  sum(t.user_carbs)             as carbs
from meals m
join v_meal_user_totals t on t.meal_id = m.id
group by m.user_id, m.meal_date;

-- ── Отклонение модели от пользовательской версии ────────────────────────────
create view v_model_vs_user with (security_invoker = on) as
select
  r.id as recognition_id,
  r.meal_id,
  m.user_id,
  m.meal_date,
  r.model_id,
  r.model_label,
  r.prompt_version,
  r.is_primary,
  r.total_weight_g                       as model_weight_g,
  u.user_weight_g,
  r.total_weight_g - u.user_weight_g     as weight_delta_g,
  case when u.user_weight_g > 0
       then abs(r.total_weight_g - u.user_weight_g) / u.user_weight_g
  end                                    as weight_ape,
  (r.nutrition_catalog->>'energy_kcal')::numeric  as model_kcal,
  u.user_kcal,
  case when u.user_kcal > 0
       then abs((r.nutrition_catalog->>'energy_kcal')::numeric - u.user_kcal) / u.user_kcal
  end                                    as kcal_ape,
  r.cost_rub_actual,
  r.cost_direct_usd,
  r.latency_ms,
  r.has_scale_ref,
  r.scale_mode,
  r.scale_size_error,
  -- Согласована ли масштабная цепочка сама с собой (§7.5.2): проверки делает
  -- бэкенд, здесь только достаём результат. NULL — цепочки не было вовсе
  -- (промпт v1-plain), и это не то же самое, что «сошлось»: иначе срез по
  -- prompt_version для H6 показал бы у v1-plain идеальную согласованность.
  case
    when r.scale_chain ? 'consistency_flags'
      then jsonb_array_length(r.scale_chain->'consistency_flags') = 0
  end                                    as scale_chain_consistent,
  we.had_reference,
  we.method                              as weight_method,
  we.self_confidence
from recognitions r
join meals m on m.id = r.meal_id
join v_meal_user_totals u on u.meal_id = r.meal_id
left join weight_evidence we on we.meal_id = r.meal_id
where r.status = 'ok';

-- ── Качество состава: сколько позиций модели пользователь оставил как есть ──
create view v_ingredient_agreement with (security_invoker = on) as
select
  m.id as meal_id,
  m.user_id,
  count(*) filter (where mi.origin = 'model_kept')    as kept,
  count(*) filter (where mi.origin = 'model_edited')  as edited,
  count(*) filter (where mi.origin = 'user_added')    as added,
  (select count(*) from meal_removed_items r where r.meal_id = m.id) as removed
from meals m
join meal_items mi on mi.meal_id = m.id
group by m.id, m.user_id;

grant select on
  meal_items_with_nutrition,
  v_meal_user_totals,
  v_daily_totals,
  v_model_vs_user,
  v_ingredient_agreement
to authenticated;

-- ───────── 0004_seed_nutrients.sql ─────────
-- ═══════════════════════════════════════════════════════════════════════════
-- 0004 — справочник нутриентов (§8.3 PRD): энергия и макро + 13 витаминов + 10 минералов.
-- Сгенерировано из config/nutrients.ts. Скрипт импорта USDA делает такой же
-- upsert, поэтому файл безопасно применять повторно.
-- ═══════════════════════════════════════════════════════════════════════════

insert into nutrients (code, name_ru, unit, group_code, rdi_default, sort_order)
values
  ('energy_kcal', 'Калорийность', 'kcal', 'macro', 2000, 10),
  ('protein', 'Белки', 'g', 'macro', 50, 20),
  ('fat', 'Жиры', 'g', 'macro', 78, 30),
  ('fat_saturated', 'в т.ч. насыщенные', 'g', 'macro', 20, 40),
  ('carbs', 'Углеводы', 'g', 'macro', 275, 50),
  ('sugars', 'в т.ч. сахара', 'g', 'macro', 50, 60),
  ('fiber', 'Клетчатка', 'g', 'macro', 28, 70),
  ('vitamin_a', 'Витамин A', 'mcg', 'vitamin', 900, 100),
  ('vitamin_d', 'Витамин D', 'mcg', 'vitamin', 20, 110),
  ('vitamin_e', 'Витамин E', 'mg', 'vitamin', 15, 120),
  ('vitamin_k', 'Витамин K', 'mcg', 'vitamin', 120, 130),
  ('vitamin_c', 'Витамин C', 'mg', 'vitamin', 90, 140),
  ('vitamin_b1', 'B1, тиамин', 'mg', 'vitamin', 1.2, 150),
  ('vitamin_b2', 'B2, рибофлавин', 'mg', 'vitamin', 1.3, 160),
  ('vitamin_b3', 'B3, ниацин', 'mg', 'vitamin', 16, 170),
  ('vitamin_b5', 'B5, пантотеновая', 'mg', 'vitamin', 5, 180),
  ('vitamin_b6', 'B6', 'mg', 'vitamin', 1.7, 190),
  ('vitamin_b7', 'B7, биотин', 'mcg', 'vitamin', 30, 200),
  ('vitamin_b9', 'B9, фолаты', 'mcg', 'vitamin', 400, 210),
  ('vitamin_b12', 'B12', 'mcg', 'vitamin', 2.4, 220),
  ('calcium', 'Кальций', 'mg', 'mineral', 1300, 300),
  ('iron', 'Железо', 'mg', 'mineral', 18, 310),
  ('magnesium', 'Магний', 'mg', 'mineral', 420, 320),
  ('phosphorus', 'Фосфор', 'mg', 'mineral', 1250, 330),
  ('potassium', 'Калий', 'mg', 'mineral', 4700, 340),
  ('sodium', 'Натрий', 'mg', 'mineral', 2300, 350),
  ('zinc', 'Цинк', 'mg', 'mineral', 11, 360),
  ('copper', 'Медь', 'mg', 'mineral', 0.9, 370),
  ('manganese', 'Марганец', 'mg', 'mineral', 2.3, 380),
  ('selenium', 'Селен', 'mcg', 'mineral', 55, 390)
on conflict (code) do update set
  name_ru     = excluded.name_ru,
  unit        = excluded.unit,
  group_code  = excluded.group_code,
  rdi_default = excluded.rdi_default,
  sort_order  = excluded.sort_order;

