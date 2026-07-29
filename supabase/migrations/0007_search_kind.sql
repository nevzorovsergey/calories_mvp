-- ── Поиск с разделением сырья и блюд (§8.4) ─────────────────────────────────
--
-- 0006 добавила в справочник 5432 готовых блюда FNDDS. Пока search_ingredients о
-- них не знает, они конкурируют с сырьём за одни и те же запросы — и выигрывают,
-- потому что описания FNDDS короче и чаще дают точное совпадение. Замеренная
-- выдача по «chicken breast» сразу после импорта: четыре блюда в первой пятёрке,
-- в том числе на первом месте.
--
-- Для маппинга распознанных ингредиентов (src/lib/catalog/match.ts) это прямая
-- порча данных: моделью названный «chicken breast» получил бы КБЖУ тушёной
-- грудки с кожей вместо сырой грудки, и метрики H1 поехали бы вместе с ним.
-- Поэтому фильтр по kind — обязательный параметр поведения, а не опция, и
-- значение по умолчанию совпадает с тем, как функция вела себя до FNDDS.
--
-- Миграция идемпотентна: npx tsx scripts/apply-migrations.ts --only 0007

create index if not exists ingredients_kind_active_idx
  on ingredients (kind) where is_active;

-- Старую сигнатуру убираем явно: Postgres различает функции по параметрам, и без
-- drop в схеме остались бы две search_ingredients, а PostgREST выбирал бы между
-- ними по форме запроса — то есть поведение зависело бы от того, передал ли
-- вызывающий kinds. Один вызов без параметра молча получал бы старую функцию без
-- фильтра.
drop function if exists public.search_ingredients(text, int);

create or replace function public.search_ingredients(
  q text,
  max_results int default 20,
  kinds text[] default array['ingredient']
)
returns table (
  id int,
  name_ru text,
  name_en text,
  category text,
  kind text,
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
    select i.id, i.name_ru, i.name_en, i.category, i.kind,
           'exact'::text as match_status, 1.0::numeric as match_score
    from ingredients i, norm
    where i.is_active
      and i.kind = any(kinds)
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
    select i.id, i.name_ru, i.name_en, i.category, i.kind,
           'exact'::text as match_status, 0.9::numeric as match_score
    from ingredients i, norm
    where i.is_active
      and i.kind = any(kinds)
      and (lower(regexp_replace(split_part(i.name_en, ',', 1), '[^\w\s]', '', 'g')) = norm.term
        or lower(regexp_replace(split_part(i.name_ru, ',', 1), '[^\w\s]', '', 'g')) = norm.term)
  ),
  fuzzy_match as (
    select i.id, i.name_ru, i.name_en, i.category, i.kind,
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
      and i.kind = any(kinds)
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
  -- При равенстве скоров выигрывает exact: у позиции, чьё name_en буквально
  -- равно запросу, триграммное сходство тоже 1.0, и без этого условия строка
  -- могла бы приехать со статусом 'fuzzy'. А на 'exact' короткозамыкается
  -- matchIngredient (src/lib/catalog/match.ts) и завязаны проверки test-flow.
  best as (
    select distinct on (r.id) r.*
    from ranked r
    order by r.id, r.match_score desc, (r.match_status = 'exact') desc
  )
  select b.id, b.name_ru, b.name_en, b.category, b.kind, b.match_status, b.match_score
  from best b
  -- Меньше уточнений в названии = более каноничная позиция: по запросу «broccoli»
  -- «Broccoli, raw» должна стоять выше «Broccoli, cooked, boiled, drained».
  -- Последним id — чтобы выдача не менялась между одинаковыми запросами.
  --
  -- Отдельного предпочтения по kind здесь намеренно нет. Оно кажется разумным
  -- («сырьё важнее блюда»), но на смешанном поиске съедает блюда целиком: у
  -- сырья SR те же точные совпадения, и на первой странице по запросу «lasagna»
  -- оказываются три замороженных полуфабриката вместо самой лазаньи. Счёт
  -- запятых справляется лучше: у названий FNDDS уточнений меньше, и они
  -- поднимаются сами.
  order by b.match_score desc,
           (length(b.name_en) - length(replace(b.name_en, ',', ''))) asc,
           length(b.name_ru) asc,
           b.id asc
  limit max_results;
$$;
