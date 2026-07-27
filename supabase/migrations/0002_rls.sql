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
