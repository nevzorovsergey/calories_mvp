-- ── Поиск по справочнику на 8000 позиций (§8.4) ─────────────────────────────
--
-- Версия из 0001 писалась под справочник из трёх строк. На полном импорте USDA
-- она ломается в двух местах:
--
-- 1. Нет tiebreaker'а. Все точные совпадения и алиасы дают ровно 1.0, триграммные
--    скоры массово совпадают — какие 20 строк переживут limit, решает планировщик,
--    и выдача пляшет между одинаковыми запросами.
--
-- 2. Нет поиска по базовому имени. Описания USDA несут хвост уточнений, и
--    триграммы его не прощают: similarity('Broccoli, raw', 'broccoli') ≈ 0.64
--    проходит, а similarity('Broccoli, cooked, boiled, drained, without salt',
--    'broccoli') ≈ 0.22 — ниже дефолтного порога оператора % и сильно ниже
--    FUZZY_THRESHOLD = 0.45 в src/lib/catalog/match.ts. То есть варёная брокколи
--    для поиска не существует.
--
-- Миграция идемпотентна (create or replace / if not exists): ledger'а нет,
-- применяется точечно — npx tsx scripts/apply-migrations.ts --only 0005

-- Выражения индексов обязаны посимвольно совпадать с выражениями в теле функции,
-- иначе планировщик их не возьмёт. Не «улучшайте» regexp с одной стороны.
create index if not exists ingredients_name_en_norm_idx
  on ingredients (lower(regexp_replace(name_en, '[^\w\s]', '', 'g')));
create index if not exists ingredients_name_ru_norm_idx
  on ingredients (lower(regexp_replace(name_ru, '[^\w\s]', '', 'g')));
create index if not exists ingredients_name_en_head_idx
  on ingredients (lower(regexp_replace(split_part(name_en, ',', 1), '[^\w\s]', '', 'g')));
create index if not exists ingredients_name_ru_head_idx
  on ingredients (lower(regexp_replace(split_part(name_ru, ',', 1), '[^\w\s]', '', 'g')));
-- Русские названия не имеют запятой-структуры, поэтому синонимы — вся русская
-- поверхность поиска. Триграммного индекса по alias в 0001 не было.
create index if not exists ingredient_aliases_alias_trgm_idx
  on ingredient_aliases using gin (alias gin_trgm_ops);

create or replace function public.search_ingredients(q text, max_results int default 20)
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
  -- Точное совпадение полного имени или алиаса.
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
  -- Базовое имя USDA — всё до первой запятой. Достаёт «Broccoli, cooked, boiled,
  -- drained, without salt» по запросу «broccoli», куда триграммы не дотягиваются.
  head_match as (
    select i.id, i.name_ru, i.name_en, i.category,
           'exact'::text as match_status, 0.9::numeric as match_score
    from ingredients i, norm
    where i.is_active
      and (lower(regexp_replace(split_part(i.name_en, ',', 1), '[^\w\s]', '', 'g')) = norm.term
        or lower(regexp_replace(split_part(i.name_ru, ',', 1), '[^\w\s]', '', 'g')) = norm.term)
  ),
  fuzzy_match as (
    select i.id, i.name_ru, i.name_en, i.category,
           'fuzzy'::text as match_status,
           greatest(
             similarity(i.name_en, q),
             similarity(i.name_ru, q),
             coalesce((
               select max(similarity(a.alias, q))
               from ingredient_aliases a
               where a.ingredient_id = i.id and a.alias % q
             ), 0)
           )::numeric as match_score
    from ingredients i
    where i.is_active
      and (i.name_en % q or i.name_ru % q
        or exists (
          select 1 from ingredient_aliases a
          where a.ingredient_id = i.id and a.alias % q
        ))
  ),
  ranked as (
    select * from exact_match
    union all
    select * from head_match
    union all
    select * from fuzzy_match
  ),
  -- Одна строка может попасть в несколько ярусов — оставляем её лучший скор.
  best as (
    select distinct on (r.id) r.*
    from ranked r
    order by r.id, r.match_score desc
  )
  select b.id, b.name_ru, b.name_en, b.category, b.match_status, b.match_score
  from best b
  -- Меньше уточнений в названии = более каноничная позиция: по запросу «broccoli»
  -- «Broccoli, raw» должна стоять выше «Broccoli, cooked, boiled, drained».
  -- Последним id — чтобы выдача не менялась между одинаковыми запросами.
  order by b.match_score desc,
           (length(b.name_en) - length(replace(b.name_en, ',', ''))) asc,
           length(b.name_ru) asc,
           b.id asc
  limit max_results;
$$;
