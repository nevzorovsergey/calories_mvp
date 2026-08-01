-- ── Лаборатория: просмотр справочника и правка его админом ──────────────────
--
-- Спека: .scratch/lab-explorer/spec.md
--
-- Три вещи:
--   1. `lab_catalog_page` — постраничный просмотр справочника с фильтрами.
--   2. `lab_catalog_facets` — значения фильтров с количествами.
--   3. RLS на запись для админа: `ingredients` и `ingredient_aliases`.
--
-- Миграция идемпотентна: npx tsx scripts/apply-migrations.ts --only 0017

-- ── Позиция справочника в приёмах пищи ──────────────────────────────────────
-- Карточка справочника отвечает на вопрос «где эта позиция реально всплывала», а
-- это select по `ingredient_id` — колонке, по которой индекса не было: 0001
-- проиндексировал `meal_items` только по `meal_id`.
create index if not exists meal_items_ingredient_idx
  on meal_items (ingredient_id)
  where ingredient_id is not null;

create index if not exists recognition_items_ingredient_idx
  on recognition_items (ingredient_id)
  where ingredient_id is not null;

-- ── Страница справочника ────────────────────────────────────────────────────
--
-- Одна функция вместо набора запросов PostgREST, и это не стилистика.
--
-- «Есть ли порции» PostgREST выражает встроенным `!inner` — то есть join,
-- который считается ДО limit, по всей таблице в 136 тысяч строк. Ровно тот
-- класс запроса, который в 0016 упирался в statement timeout.
--
-- Первая версия этой функции была обычным SQL и наступила на те же грабли:
-- 5.3 с без единого фильтра и `canceling statement due to statement timeout` на
-- «блюда без нутриентов». Замер показал две причины, и обе про то, что работа
-- делалась по всей таблице ради пятидесяти строк:
--
--   1. `count(*) over ()` ради общего числа заставлял материализовать весь
--      отбор — 136 тысяч строк, чтобы показать «136306».
--   2. `order by case when p_sort = … end` неиндексируем в принципе: под
--      выражение с ветвлением по параметру индекса не подобрать, и Postgres
--      каждый раз сортировал весь отбор целиком.
--
-- Отсюда plpgsql с динамическим SQL. Он даёт то, чего в статическом варианте
-- добиться нельзя: `order by` собирается ЛИТЕРАЛЬНЫМ выражением, под которое
-- есть индекс, а условия появляются в запросе, только когда их попросили. Та же
-- логика, что в 0016, где ветки поиска пришлось разложить с зашитым `kind`.
--
-- Работа идёт в два шага, и это дешевле одного «умного» запроса:
--   1. Достаём только ИДЕНТИФИКАТОРЫ — упорядоченный индексный проход, но не до
--      конца, а до потолка `cap`. Из одного массива берётся и страница, и
--      счётчик: точное число, пока помещается, и честное «более чем» дальше.
--      Ради счётчика в углу экрана перебирать 136 тысяч строк незачем, а
--      выполнять отбор ДВАЖДЫ — тем более. Первая редакция так и делала, и на
--      отрицательных фильтрах («блюда без нутриентов» — anti-join на 128 тысяч
--      проб, полторы секунды) два прохода упирались в statement timeout.
--   2. Достаём поля и счётчики полноты латералями — для полусотни строк.
--
-- Поиск сравнивает свёрнутую форму (`ru_norm` из 0008: «ё» → «е», пунктуация в
-- пробелы) — под неё есть полный триграммный индекс
-- `ingredients_name_ru_norm_trgm_idx`, а под `name_en` — `ingredients_name_en_idx`
-- из 0001. Оба неполные по kind, и это здесь как раз нужно: лаборатория смотрит
-- сырьё и блюда вместе, а частичные индексы 0015/0016 планировщик без литерала
-- `kind` применить не сможет.
--
-- Функция `stable`, не `security definer`: RLS применяется к вызывающему.
-- Справочник и так читается всеми аутентифицированными (0002), а `used_in_meals`
-- посчитается по тем приёмам пищи, которые вызывающему видны — для админа это
-- все, для остальных свои. Экран всё равно закрыт гейтом в layout.
--
-- Динамический SQL собирается только через `format` с `%L`: значения приезжают
-- из адресной строки, и склейка их в текст запроса кавычками была бы дырой.

-- Порядок по умолчанию — популярность. Без индекса выборка «первая страница
-- справочника» сортирует все 136 тысяч строк каждый раз.
create index if not exists ingredients_popularity_idx
  on ingredients (popularity_views desc, id);

-- Тот же порядок внутри вида: «покажи блюда» — самый частый фильтр, и без
-- составного индекса он снова упирается в полную сортировку.
create index if not exists ingredients_kind_popularity_idx
  on ingredients (kind, popularity_views desc, id);

-- `create or replace` не меняет список выходных колонок — при повторном
-- применении миграции после правки набора полей он падает на «cannot change
-- return type of existing function». Явный drop делает миграцию идемпотентной
-- по-настоящему.
drop function if exists public.lab_catalog_page(
  text, text, text, text, boolean, boolean, boolean, boolean, boolean, text, int, int
);

create function public.lab_catalog_page(
  q                text    default null,
  p_kind           text    default null,
  p_source         text    default null,
  p_category       text    default null,
  p_active         boolean default null,
  p_service        boolean default null,
  p_has_portions   boolean default null,
  p_has_components boolean default null,
  p_has_nutrients  boolean default null,
  p_sort           text    default 'popularity',
  p_limit          int     default 50,
  p_offset         int     default 0
)
returns table (
  id                   int,
  name_ru              text,
  name_en              text,
  category             text,
  source               text,
  source_id            text,
  kind                 text,
  state                text,
  is_active            boolean,
  is_service           boolean,
  popularity_views     bigint,
  portion_source_level int,
  portions_count       bigint,
  components_count     bigint,
  nutrients_count      bigint,
  aliases_count        bigint,
  kcal_per_100g        numeric,
  used_in_meals        bigint,
  -- Сколько строк подошло под фильтры. Точное число, пока оно не упирается в
  -- потолок счёта; дальше — нижняя оценка, и об этом говорит `total_capped`.
  total_count          bigint,
  total_capped         boolean
)
language plpgsql
stable
as $$
declare
  -- Потолок счётчика. Две тысячи — это сорок страниц по пятьдесят: дальше
  -- листают не глазами, а фильтром, и точное число там уже ничего не решает.
  cap         constant int := 2000;
  where_ok    text := 'true';
  order_by    text;
  matched_ids int[];
  page_ids    int[];
  found       bigint;
  fetch_n     int;
  first_row   int;
begin
  if p_kind     is not null then where_ok := where_ok || format(' and i.kind = %L', p_kind); end if;
  if p_source   is not null then where_ok := where_ok || format(' and i.source = %L', p_source); end if;
  if p_category is not null then where_ok := where_ok || format(' and i.category = %L', p_category); end if;
  if p_active   is not null then where_ok := where_ok || format(' and i.is_active = %L', p_active); end if;
  if p_service  is not null then where_ok := where_ok || format(' and i.is_service = %L', p_service); end if;

  if q is not null and btrim(q) <> '' then
    where_ok := where_ok || format(
      ' and (public.ru_norm(i.name_ru) like %L or i.name_en ilike %L or i.source_id = %L)',
      '%' || public.ru_norm(q) || '%',
      '%' || btrim(q) || '%',
      btrim(q)
    );
  end if;

  -- `exists` против `not exists`, а не `= exists(...)`: сравнение с булевым
  -- параметром планировщик разворачивает в фильтр по каждой строке, а явное
  -- отрицание даёт ему право взять anti-join.
  if p_has_portions is not null then
    where_ok := where_ok || format(
      ' and %s exists (select 1 from ingredient_portions p where p.ingredient_id = i.id)',
      case when p_has_portions then '' else 'not' end);
  end if;
  if p_has_components is not null then
    where_ok := where_ok || format(
      ' and %s exists (select 1 from ingredient_components c where c.dish_id = i.id)',
      case when p_has_components then '' else 'not' end);
  end if;
  if p_has_nutrients is not null then
    where_ok := where_ok || format(
      ' and %s exists (select 1 from ingredient_nutrients n where n.ingredient_id = i.id)',
      case when p_has_nutrients then '' else 'not' end);
  end if;

  order_by := case p_sort
    when 'name' then 'public.ru_norm(i.name_ru) asc, i.id asc'
    when 'id'   then 'i.id asc'
    else             'i.popularity_views desc, i.id asc'
  end;

  first_row := greatest(p_offset, 0) + 1;
  -- Потолок ограничивает счётчик, но не листание: до запрошенной страницы
  -- дойти надо в любом случае, иначе на сороковой странице справочник просто
  -- кончился бы. Плюс одна строка — чтобы отличить «ровно столько» от
  -- «столько и ещё сколько-то».
  fetch_n := greatest(cap, first_row - 1 + greatest(p_limit, 1)) + 1;

  execute format(
    'select array(select i.id from ingredients i where %s order by %s limit %s)',
    where_ok, order_by, fetch_n
  ) into matched_ids;

  found := coalesce(cardinality(matched_ids), 0);
  -- Срез массива в Postgres по 1, а не по 0, и выход за границы даёт пустой
  -- массив, а не ошибку — то есть страница за концом выдачи вернёт ноль строк,
  -- как и должна.
  page_ids := matched_ids[first_row : first_row - 1 + greatest(p_limit, 1)];

  return query
  select
    i.id, i.name_ru, i.name_en, i.category, i.source, i.source_id,
    i.kind, i.state, i.is_active, i.is_service,
    i.popularity_views, i.portion_source_level,
    (select count(*) from ingredient_portions p where p.ingredient_id = i.id),
    (select count(*) from ingredient_components c where c.dish_id = i.id),
    (select count(*) from ingredient_nutrients n where n.ingredient_id = i.id),
    (select count(*) from ingredient_aliases a where a.ingredient_id = i.id),
    (select inut.amount_per_100g
       from ingredient_nutrients inut
       join nutrients n on n.id = inut.nutrient_id
      where inut.ingredient_id = i.id and n.code = 'energy_kcal'
      limit 1),
    (select count(*) from meal_items mi where mi.ingredient_id = i.id),
    found,
    -- Упёрлись в потолок — значит найденного больше, чем сосчитано. Число всё
    -- равно отдаём: оно заведомо больше конца текущей страницы, и пагинатор по
    -- нему верно решает, что «Дальше» есть.
    found = fetch_n
  from unnest(page_ids) with ordinality as u(ingredient_id, ord)
  join ingredients i on i.id = u.ingredient_id
  -- Порядок задан на первом шаге; без него join вернул бы строки как попало.
  order by u.ord;
end;
$$;

-- ── Значения фильтров ───────────────────────────────────────────────────────
--
-- Три group by по одной таблице в одном ответе: список источников и категорий
-- заранее неизвестен (Povarenok принёс свои), а хардкодить его в интерфейсе
-- значит расходиться с базой при следующем импорте.
--
-- Категорий у Povarenok порядка сотни, поэтому выдача обрезана по частоте:
-- фильтр по категории, встречающейся дважды, — это не фильтр, а шум в списке.
create or replace function public.lab_catalog_facets()
returns table (
  facet text,
  value text,
  n     bigint
)
language sql
stable
as $$
  select 'kind'::text, i.kind, count(*)
  from ingredients i
  group by i.kind
  union all
  select 'source'::text, i.source, count(*)
  from ingredients i
  group by i.source
  union all
  select 'category'::text, c.category, c.n
  from (
    select i.category, count(*) as n
    from ingredients i
    where i.category is not null
    group by i.category
    order by count(*) desc
    limit 60
  ) c
  order by 1, 3 desc;
$$;

-- ── Правка справочника админом (FR-LABX-4) ──────────────────────────────────
--
-- Политики складываются по ИЛИ: у обычного пользователя остаётся ровно то, что
-- было в 0002 (чтение справочника и создание своих синонимов при привязке
-- unmatched-позиции), админ дополнительно получает запись.
--
-- Удаления позиций справочника нет намеренно: на `ingredients` ссылаются
-- `meal_items.ingredient_id` и `recognition_items.ingredient_id`, и снести
-- строку значит проделать дыру в истории эксперимента. Выключение —
-- `is_active = false`, поиск такие позиции уже не отдаёт.
drop policy if exists ingredients_admin_update on ingredients;
create policy ingredients_admin_update on ingredients
  for update to authenticated
  using (public.is_admin()) with check (public.is_admin());

drop policy if exists ingredient_aliases_admin_write on ingredient_aliases;
create policy ingredient_aliases_admin_write on ingredient_aliases
  for insert to authenticated
  with check (public.is_admin());

drop policy if exists ingredient_aliases_admin_update on ingredient_aliases;
create policy ingredient_aliases_admin_update on ingredient_aliases
  for update to authenticated
  using (public.is_admin()) with check (public.is_admin());

drop policy if exists ingredient_aliases_admin_delete on ingredient_aliases;
create policy ingredient_aliases_admin_delete on ingredient_aliases
  for delete to authenticated
  using (public.is_admin());

analyze meal_items;
analyze recognition_items;
