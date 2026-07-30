"""
Тикеты 05 и 06: сборка данных для заливки справочника блюд.

Здесь считается всё, что требует parquet и питона, и ничего не пишется в базу —
это делает scripts/povarenok/import-dishes.ts, который читает готовый NDJSON.
Разделение не косметическое: заливка идёт из России в Огайо часами и рвётся,
её надо уметь перезапускать с середины, не пересчитывая ничего.

    .venv/bin/python scripts/povarenok/build_import.py

Вход:  data/povarenok/dishes.jsonl        (canonicalize.py)
       data/povarenok-ingredients.json    (merge_ingredient_map.py)
       data/povarenok/nutrients-cache.json (export-nutrients.ts)
Выход: data/povarenok/import/dishes.ndjson
"""

import collections
import json
import statistics
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
DISHES = ROOT / "data" / "povarenok" / "dishes.jsonl"
MAP = ROOT / "data" / "povarenok-ingredients.json"
NUTRIENTS = ROOT / "data" / "povarenok" / "nutrients-cache.json"
OUT = ROOT / "data" / "povarenok" / "import" / "dishes.ndjson"

# Ниже этой доли массы, покрытой нутриентами, блюдо не импортируется: числа
# получились бы не приблизительными, а выдуманными.
MIN_NUTRITION_COVERAGE = 0.5

# Порции считаются по квантилям группы, только если рецептов с порцией хватает.
MIN_PORTION_SAMPLES = 5

# Запасные коэффициенты S/L относительно M, если категорийных не хватило.
FALLBACK_SMALL, FALLBACK_LARGE = 0.7, 1.4


def load_dishes():
    with DISHES.open(encoding="utf-8") as f:
        return [json.loads(line) for line in f]


def category_stats(dishes):
    """
    Категорийные приоры: медианный вес порции и отношения S/M и L/M.

    Считаются по тем группам, где данных достаточно, и применяются к тем, где
    их нет. То есть это тоже из данных, а не выдуманные числа.
    """
    masses = collections.defaultdict(list)
    small_ratio = collections.defaultdict(list)
    large_ratio = collections.defaultdict(list)

    for d in dishes:
        pm = d.get("portion_mass")
        if not pm or pm["n"] < MIN_PORTION_SAMPLES or pm["p50"] <= 0:
            continue
        for key in (d.get("category"), d.get("category_root")):
            if not key:
                continue
            masses[key].append(pm["p50"])
            small_ratio[key].append(pm["p25"] / pm["p50"])
            large_ratio[key].append(pm["p75"] / pm["p50"])

    out = {}
    for key, values in masses.items():
        if len(values) < 5:
            continue
        out[key] = {
            "median": statistics.median(values),
            "small": statistics.median(small_ratio[key]),
            "large": statistics.median(large_ratio[key]),
        }
    return out


def portions_for(dish, stats):
    """
    Три порции и уровень доверия к ним.

    1 — квантили самой группы; 2 — медиана группы, а S и L от категорийных
    коэффициентов; 3 — всё от категории. Уровень пишется в файл: в аналитике
    H8 (тикет 11) числа из данных и числа из приора обязаны считаться порознь,
    иначе метрика измерит не то.
    """
    pm = dish.get("portion_mass")
    category = dish.get("category")
    root = dish.get("category_root")
    prior = stats.get(category) or stats.get(root)

    if pm and pm["n"] >= MIN_PORTION_SAMPLES:
        small, medium, large = pm["p25"], pm["p50"], pm["p75"]
        level = 1
    elif pm and pm["p50"] > 0:
        medium = pm["p50"]
        small = medium * (prior["small"] if prior else FALLBACK_SMALL)
        large = medium * (prior["large"] if prior else FALLBACK_LARGE)
        level = 2
    elif prior:
        medium = prior["median"]
        small = medium * prior["small"]
        large = medium * prior["large"]
        level = 3
    else:
        return None

    # Квантили группы могут совпасть — на одном-двух рецептах это обычное дело,
    # а порции обязаны строго различаться, иначе выбор из трёх бессмыслен.
    if not (small < medium < large):
        small = min(small, medium * FALLBACK_SMALL)
        large = max(large, medium * FALLBACK_LARGE)
    return {
        "small": round(small, 1),
        "medium": round(medium, 1),
        "large": round(large, 1),
        "level": level,
    }


def main():
    dishes = load_dishes()
    mapping = json.loads(MAP.read_text(encoding="utf-8"))
    nutrients = json.loads(NUTRIENTS.read_text(encoding="utf-8"))
    stats = category_stats(dishes)
    print(f"категорийных приоров: {len(stats)}")

    OUT.parent.mkdir(parents=True, exist_ok=True)
    skipped = collections.Counter()
    levels = collections.Counter()
    written = 0

    with OUT.open("w", encoding="utf-8") as out:
        for dish in dishes:
            composition = dish.get("composition") or []
            if not composition:
                skipped["без состава"] += 1
                continue

            components, totals, coverage = [], collections.defaultdict(float), 0.0
            for seq, item in enumerate(composition, start=1):
                entry = mapping.get(item["name"]) or {}
                ingredient_id = entry.get("ingredient_id")
                per100 = nutrients.get(str(ingredient_id)) if ingredient_id else None
                if per100:
                    coverage += item["share"]
                    for code, value in per100.items():
                        totals[code] += value * item["share"]
                components.append(
                    {
                        "seq": seq,
                        "ingredient_id": ingredient_id,
                        "name": item["name"],
                        "share": item["share"],
                    }
                )

            if coverage < MIN_NUTRITION_COVERAGE:
                skipped["мало покрыто нутриентами"] += 1
                continue

            # Непокрытую часть считаем похожей на покрытую — иначе КБЖУ блюда
            # занижался бы ровно на долю несматченных ингредиентов, а это хуже,
            # чем допущение: «Специи» и «Зелень» массы почти не несут, но в
            # долях состава присутствуют.
            nutrition = {code: round(value / coverage, 4) for code, value in totals.items()}

            portions = portions_for(dish, stats)
            if not portions:
                skipped["нет порций и приора"] += 1
                continue
            levels[portions["level"]] += 1

            out.write(
                json.dumps(
                    {
                        "source_id": dish["key"],
                        "name_ru": dish["title"],
                        "category": dish.get("category"),
                        "is_service": dish.get("is_service", False),
                        "popularity_views": dish.get("views", 0),
                        "source_recipes": dish.get("recipes", 0),
                        "nutrition_coverage": round(coverage, 3),
                        "nutrition": nutrition,
                        "components": components,
                        "portions": portions,
                    },
                    ensure_ascii=False,
                )
                + "\n"
            )
            written += 1

    print(f"записано блюд: {written} → {OUT}")
    for reason, n in skipped.most_common():
        print(f"  пропущено — {reason}: {n}")
    print(f"  порции по уровням: {dict(sorted(levels.items()))}")
    total_components = sum(1 for _ in OUT.open(encoding="utf-8"))
    print(f"  строк в файле: {total_components}")


if __name__ == "__main__":
    main()
