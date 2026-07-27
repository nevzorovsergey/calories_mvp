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
