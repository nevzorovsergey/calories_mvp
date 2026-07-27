/**
 * Справочник нутриентов MVP (§8.3 PRD): энергия и макро + 13 витаминов + 10 минералов.
 *
 * `usdaNames` — как нутриент называется в `nutrient.csv` USDA FoodData Central.
 * Импорт (scripts/import-usda.ts) резолвит id по имени + единице измерения, а не
 * по хардкоженным номерам: номера в дампах USDA стабильны, но сверка по имени
 * защищает от молчаливого рассинхрона при смене версии дампа. `usdaFallbackId` —
 * страховка на случай, если имя в дампе поменяли.
 *
 * ВАЖНО: `usdaNames` — это список **по убыванию приоритета**, а не набор
 * равноправных синонимов. У одного продукта в дампе может быть сразу несколько
 * подходящих нутриентов (у калорийности их три), и импорт берёт первый
 * найденный по этому порядку. Дописывать новое имя в конец безопасно, вставлять
 * в начало — значит менять то, какое значение попадёт в справочник.
 *
 * `rdi` — суточная норма, одна общая для всех (без учёта пола и возраста, §8.3).
 * Значения — Daily Value FDA для взрослых.
 */

export type NutrientGroup = "macro" | "vitamin" | "mineral";

export interface NutrientDef {
  /** Код в БД (`nutrients.code`) и ключ в jsonb `nutrition_catalog` / `nutrition_model`. */
  code: string;
  nameRu: string;
  /** kcal | g | mg | mcg */
  unit: string;
  group: NutrientGroup;
  /** Суточная норма для «% от нормы». */
  rdi: number;
  sortOrder: number;
  usdaNames: string[];
  usdaUnit: "KCAL" | "G" | "MG" | "UG";
  usdaFallbackId: number;
}

export const NUTRIENTS: NutrientDef[] = [
  // ── Энергия и макронутриенты ──────────────────────────────────────────────
  {
    code: "energy_kcal",
    nameRu: "Калорийность",
    unit: "kcal",
    group: "macro",
    rdi: 2000,
    sortOrder: 10,
    // Дамп Foundation 2026 постепенно переезжает на явные факторы Атуотера:
    // «Energy» (1008) есть только у 135 из 469 позиций, 2047 — у 347, 2048 — у 312.
    // SR Legacy целиком на 1008. Порядок — от самого общего к частному.
    usdaNames: [
      "Energy",
      "Energy (Atwater General Factors)",
      "Energy (Atwater Specific Factors)",
    ],
    usdaUnit: "KCAL",
    usdaFallbackId: 1008,
  },
  {
    code: "protein",
    nameRu: "Белки",
    unit: "g",
    group: "macro",
    rdi: 50,
    sortOrder: 20,
    usdaNames: ["Protein"],
    usdaUnit: "G",
    usdaFallbackId: 1003,
  },
  {
    code: "fat",
    nameRu: "Жиры",
    unit: "g",
    group: "macro",
    rdi: 78,
    sortOrder: 30,
    usdaNames: ["Total lipid (fat)"],
    usdaUnit: "G",
    usdaFallbackId: 1004,
  },
  {
    code: "fat_saturated",
    nameRu: "в т.ч. насыщенные",
    unit: "g",
    group: "macro",
    rdi: 20,
    sortOrder: 40,
    usdaNames: ["Fatty acids, total saturated"],
    usdaUnit: "G",
    usdaFallbackId: 1258,
  },
  {
    code: "carbs",
    nameRu: "Углеводы",
    unit: "g",
    group: "macro",
    rdi: 275,
    sortOrder: 50,
    usdaNames: ["Carbohydrate, by difference"],
    usdaUnit: "G",
    usdaFallbackId: 1005,
  },
  {
    code: "sugars",
    nameRu: "в т.ч. сахара",
    unit: "g",
    group: "macro",
    rdi: 50,
    sortOrder: 60,
    // «Sugars, Total» — написание id 2000 в дампе SR Legacy 2018.
    usdaNames: ["Total Sugars", "Sugars, Total", "Sugars, total including NLEA"],
    usdaUnit: "G",
    usdaFallbackId: 2000,
  },
  {
    code: "fiber",
    nameRu: "Клетчатка",
    unit: "g",
    group: "macro",
    rdi: 28,
    sortOrder: 70,
    usdaNames: ["Fiber, total dietary"],
    usdaUnit: "G",
    usdaFallbackId: 1079,
  },

  // ── Витамины (13, §8.3) ───────────────────────────────────────────────────
  {
    code: "vitamin_a",
    nameRu: "Витамин A",
    unit: "mcg",
    group: "vitamin",
    rdi: 900,
    sortOrder: 100,
    usdaNames: ["Vitamin A, RAE"],
    usdaUnit: "UG",
    usdaFallbackId: 1106,
  },
  {
    code: "vitamin_d",
    nameRu: "Витамин D",
    unit: "mcg",
    group: "vitamin",
    rdi: 20,
    sortOrder: 110,
    usdaNames: ["Vitamin D (D2 + D3)"],
    usdaUnit: "UG",
    usdaFallbackId: 1114,
  },
  {
    code: "vitamin_e",
    nameRu: "Витамин E",
    unit: "mg",
    group: "vitamin",
    rdi: 15,
    sortOrder: 120,
    usdaNames: ["Vitamin E (alpha-tocopherol)"],
    usdaUnit: "MG",
    usdaFallbackId: 1109,
  },
  {
    code: "vitamin_k",
    nameRu: "Витамин K",
    unit: "mcg",
    group: "vitamin",
    rdi: 120,
    sortOrder: 130,
    usdaNames: ["Vitamin K (phylloquinone)"],
    usdaUnit: "UG",
    usdaFallbackId: 1185,
  },
  {
    code: "vitamin_c",
    nameRu: "Витамин C",
    unit: "mg",
    group: "vitamin",
    rdi: 90,
    sortOrder: 140,
    usdaNames: ["Vitamin C, total ascorbic acid"],
    usdaUnit: "MG",
    usdaFallbackId: 1162,
  },
  {
    code: "vitamin_b1",
    nameRu: "B1, тиамин",
    unit: "mg",
    group: "vitamin",
    rdi: 1.2,
    sortOrder: 150,
    usdaNames: ["Thiamin"],
    usdaUnit: "MG",
    usdaFallbackId: 1165,
  },
  {
    code: "vitamin_b2",
    nameRu: "B2, рибофлавин",
    unit: "mg",
    group: "vitamin",
    rdi: 1.3,
    sortOrder: 160,
    usdaNames: ["Riboflavin"],
    usdaUnit: "MG",
    usdaFallbackId: 1166,
  },
  {
    code: "vitamin_b3",
    nameRu: "B3, ниацин",
    unit: "mg",
    group: "vitamin",
    rdi: 16,
    sortOrder: 170,
    usdaNames: ["Niacin"],
    usdaUnit: "MG",
    usdaFallbackId: 1167,
  },
  {
    code: "vitamin_b5",
    nameRu: "B5, пантотеновая",
    unit: "mg",
    group: "vitamin",
    rdi: 5,
    sortOrder: 180,
    usdaNames: ["Pantothenic acid"],
    usdaUnit: "MG",
    usdaFallbackId: 1170,
  },
  {
    code: "vitamin_b6",
    nameRu: "B6",
    unit: "mg",
    group: "vitamin",
    rdi: 1.7,
    sortOrder: 190,
    usdaNames: ["Vitamin B-6"],
    usdaUnit: "MG",
    usdaFallbackId: 1175,
  },
  {
    code: "vitamin_b7",
    nameRu: "B7, биотин",
    unit: "mcg",
    group: "vitamin",
    rdi: 30,
    sortOrder: 200,
    usdaNames: ["Biotin"],
    usdaUnit: "UG",
    usdaFallbackId: 1176,
  },
  {
    code: "vitamin_b9",
    nameRu: "B9, фолаты",
    unit: "mcg",
    group: "vitamin",
    rdi: 400,
    sortOrder: 210,
    usdaNames: ["Folate, DFE"],
    usdaUnit: "UG",
    usdaFallbackId: 1190,
  },
  {
    code: "vitamin_b12",
    nameRu: "B12",
    unit: "mcg",
    group: "vitamin",
    rdi: 2.4,
    sortOrder: 220,
    usdaNames: ["Vitamin B-12"],
    usdaUnit: "UG",
    usdaFallbackId: 1178,
  },

  // ── Минералы (10, §8.3) ───────────────────────────────────────────────────
  {
    code: "calcium",
    nameRu: "Кальций",
    unit: "mg",
    group: "mineral",
    rdi: 1300,
    sortOrder: 300,
    usdaNames: ["Calcium, Ca"],
    usdaUnit: "MG",
    usdaFallbackId: 1087,
  },
  {
    code: "iron",
    nameRu: "Железо",
    unit: "mg",
    group: "mineral",
    rdi: 18,
    sortOrder: 310,
    usdaNames: ["Iron, Fe"],
    usdaUnit: "MG",
    usdaFallbackId: 1089,
  },
  {
    code: "magnesium",
    nameRu: "Магний",
    unit: "mg",
    group: "mineral",
    rdi: 420,
    sortOrder: 320,
    usdaNames: ["Magnesium, Mg"],
    usdaUnit: "MG",
    usdaFallbackId: 1090,
  },
  {
    code: "phosphorus",
    nameRu: "Фосфор",
    unit: "mg",
    group: "mineral",
    rdi: 1250,
    sortOrder: 330,
    usdaNames: ["Phosphorus, P"],
    usdaUnit: "MG",
    usdaFallbackId: 1091,
  },
  {
    code: "potassium",
    nameRu: "Калий",
    unit: "mg",
    group: "mineral",
    rdi: 4700,
    sortOrder: 340,
    usdaNames: ["Potassium, K"],
    usdaUnit: "MG",
    usdaFallbackId: 1092,
  },
  {
    code: "sodium",
    nameRu: "Натрий",
    unit: "mg",
    group: "mineral",
    rdi: 2300,
    sortOrder: 350,
    usdaNames: ["Sodium, Na"],
    usdaUnit: "MG",
    usdaFallbackId: 1093,
  },
  {
    code: "zinc",
    nameRu: "Цинк",
    unit: "mg",
    group: "mineral",
    rdi: 11,
    sortOrder: 360,
    usdaNames: ["Zinc, Zn"],
    usdaUnit: "MG",
    usdaFallbackId: 1095,
  },
  {
    code: "copper",
    nameRu: "Медь",
    unit: "mg",
    group: "mineral",
    rdi: 0.9,
    sortOrder: 370,
    usdaNames: ["Copper, Cu"],
    usdaUnit: "MG",
    usdaFallbackId: 1098,
  },
  {
    code: "manganese",
    nameRu: "Марганец",
    unit: "mg",
    group: "mineral",
    rdi: 2.3,
    sortOrder: 380,
    usdaNames: ["Manganese, Mn"],
    usdaUnit: "MG",
    usdaFallbackId: 1101,
  },
  {
    code: "selenium",
    nameRu: "Селен",
    unit: "mcg",
    group: "mineral",
    rdi: 55,
    sortOrder: 390,
    usdaNames: ["Selenium, Se"],
    usdaUnit: "UG",
    usdaFallbackId: 1103,
  },
];

export const NUTRIENTS_BY_CODE: Record<string, NutrientDef> = Object.fromEntries(
  NUTRIENTS.map((n) => [n.code, n]),
);

/** Нутриенты, которые модель отдаёт напрямую в JSON (§7.3) — на 100 г. */
export const MODEL_NUTRIENT_FIELDS: Record<string, string> = {
  energy_kcal: "kcal_per_100g",
  protein: "protein_per_100g",
  fat: "fat_per_100g",
  carbs: "carbs_per_100g",
};

export const MACRO_CODES = ["energy_kcal", "protein", "fat", "carbs"] as const;
