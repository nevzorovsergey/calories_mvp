-- ── Распознавание по названию: кандидаты и выбор пользователя ───────────────
--
-- v3-dish меняет единицу распознавания. Модель больше не разбирает блюдо на
-- ингредиенты с граммами — она отвечает «что это» тремя вариантами и оценивает
-- размер порции. Состав и вес приходят из справочника, пользователь делает два
-- выбора вместо правки списка.
--
-- Ключевой принцип §1.3 PRD не меняется: предложение модели и версия
-- пользователя хранятся обе и никогда не перезаписывают друг друга. Меняется
-- только то, что предложение теперь — три названия.
--
-- Миграция идемпотентна: npx tsx scripts/apply-migrations.ts --only 0009

-- ── Три гипотезы модели ─────────────────────────────────────────────────────
create table if not exists recognition_dish_candidates (
  id              uuid primary key default gen_random_uuid(),
  recognition_id  uuid not null references recognitions(id) on delete cascade,
  position        int not null,                  -- 1..3, порядок модели
  name_ru         text not null,                 -- как сказала модель
  confidence      numeric,
  why             text,                          -- зацепка из кадра, идёт в интерфейс
  -- Пусто, если название не нашлось в справочнике. Это штатный исход, а не
  -- ошибка: доля таких случаев — метрика покрытия справочника (тикет 11).
  ingredient_id   int references ingredients(id) on delete set null,
  match_score     numeric,
  match_source    text,                          -- 'povarenok' | 'usda_fndds'
  unique (recognition_id, position)
);
create index if not exists recognition_dish_candidates_recognition_idx
  on recognition_dish_candidates (recognition_id);

-- Денормализация из parsed — как уже сделано для dish_name_ru и scale_mode.
alter table recognitions
  add column if not exists portion_size text;          -- small | medium | large
alter table recognitions
  add column if not exists portion_reasoning text;

-- ── Что выбрал пользователь ─────────────────────────────────────────────────
alter table meals
  add column if not exists selected_dish_id int references ingredients(id);
alter table meals
  add column if not exists selected_candidate_position int;
alter table meals
  add column if not exists selected_portion_size text;  -- small|medium|large|custom

-- Приём пищи, где распознавание готово, но пользователь ещё не выбрал блюдо, не
-- имеет ни состава, ни калорийности. Без отдельного состояния он попал бы в
-- дневной итог нулём — то есть выглядел бы как честно посчитанная еда без
-- калорий. `meals.status` остаётся текстовым (как в 0001), значение добавляется
-- соглашением: 'awaiting_choice'.

-- ── RLS ─────────────────────────────────────────────────────────────────────
alter table recognition_dish_candidates enable row level security;

drop policy if exists recognition_dish_candidates_select on recognition_dish_candidates;
create policy recognition_dish_candidates_select on recognition_dish_candidates
  for select to authenticated
  using (exists (
    select 1 from recognitions r
    where r.id = recognition_id and public.owns_meal(r.meal_id)
  ));

drop policy if exists recognition_dish_candidates_insert on recognition_dish_candidates;
create policy recognition_dish_candidates_insert on recognition_dish_candidates
  for insert to authenticated
  with check (exists (
    select 1 from recognitions r
    where r.id = recognition_id and public.owns_meal(r.meal_id)
  ));

-- ── Поиск блюд ──────────────────────────────────────────────────────────────
--
-- Отдельная функция, а не параметр к search_ingredients. Причина не в чистоте, а
-- в том, что это разные задачи. Сырья 8 тысяч, и поиск по нему решает «найти
-- совпадение». Блюд теперь 128 тысяч, и поиск решает «выбрать три из сотни
-- одинаково похожих»: по запросу «пирог» триграммное сходство почти одинаково у
-- тысяч позиций, и без внешнего сигнала выдача случайна.
--
-- Отличия от search_ingredients, каждое вынужденное:
--
--  1. Сравнение идёт по ru_norm (миграция 0008): в справочнике «мёд» и «свёкла»,
--     а пользователь и модель пишут «мед» и «свекла». Старый поиск на этом
--     промахивается, и это его настоящий дефект — но чинить его надо с
--     перезамером H1/H2, поэтому здесь он не трогается.
--  2. К похожести добавлена популярность: log от суммарных просмотров рецептов,
--     свёрнутых в позицию. Расхожее название и есть правильный ответ на вопрос
--     «что ты сфотографировал», а просмотры — прямая мера расхожести.
--  3. Служебные позиции (заготовки, соусы, украшения) понижаются, но не
--     исключаются: соус бывает и самостоятельным ответом.
--  4. При равной оценке выигрывает Povarenok — русская кухня закрыта рецептами,
--     западная остаётся за FNDDS.
create or replace function public.search_dishes(
  q text,
  max_results int default 10
)
returns table (
  id int,
  name_ru text,
  category text,
  source text,
  popularity_views bigint,
  is_service boolean,
  match_score numeric,
  rank_score numeric
)
language sql
stable
as $$
  with norm as (
    select public.ru_norm(q) as term
  ),
  candidates as (
    select i.id, i.name_ru, i.category, i.source,
           i.popularity_views, i.is_service,
           case
             when public.ru_norm(i.name_ru) = norm.term then 1.0
             else similarity(public.ru_norm(i.name_ru), norm.term)
           end::numeric as match_score
    from ingredients i, norm
    where i.is_active
      and i.kind = 'dish'
      and (public.ru_norm(i.name_ru) % norm.term
        or public.ru_norm(i.name_ru) = norm.term)
  )
  select c.id, c.name_ru, c.category, c.source,
         c.popularity_views, c.is_service,
         c.match_score,
         (
           c.match_score
           + 0.03 * ln(1 + c.popularity_views)
           - case when c.is_service then 0.25 else 0 end
         )::numeric as rank_score
  from candidates c
  order by rank_score desc,
           (c.source = 'povarenok') desc,
           length(c.name_ru) asc,
           c.id asc
  limit max_results;
$$;
