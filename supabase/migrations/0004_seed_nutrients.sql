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
