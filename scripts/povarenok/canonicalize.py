"""
Тикеты 04 и 06: свод 154 158 рецептов в позиции справочника блюд.

Схлопываются ТОЛЬКО одинаковые названия. Похожий состав при разных названиях —
не повод объединять: «Ласточкино гнездо» и «Котлеты с яйцом» состоят из одного и
того же, но это два разных ответа на вопрос «что ты сфотографировал», и
пользователю нужны оба.

Что для канонизации НЕ работает (проверено, не повторять):

  * `recipe_variants_urls` — 2 млн рёбер, из них 1.65 млн несимметричных;
    связные компоненты дают одну компоненту на 154 068 рецептов из 154 158. Это
    блок «похожие рецепты», а не отношение эквивалентности.
  * Ставка на то, что нормализация много схлопнет: 135 612 уникальных заголовков
    превращаются в 131 960. Русские рецепты названы индивидуально, 122 256
    заголовков встречаются ровно один раз.

Поэтому справочник получается большим, и задача переезжает с дедупликации на
ранжирование — отсюда `views` и `recipes` в выходе.

    .venv/bin/python scripts/povarenok/canonicalize.py

Результат: data/povarenok/dishes.jsonl (не коммитится, воспроизводится отсюда)
"""

import collections
import json
import re
import statistics
from pathlib import Path

from dump import (
    KNOWN_UNITS,
    UNIT_PRIORS,
    dish_mass,
    iter_recipes,
    load,
    parse_count,
    portion_mass,
)

ROOT = Path(__file__).resolve().parents[2]
MEASURES = ROOT / "data" / "povarenok-measures.json"
OUT = ROOT / "data" / "povarenok" / "dishes.jsonl"

# Ингредиент попадает в состав блюда, если встречается не реже чем в этой доле
# рецептов группы. Иначе состав распухает хвостом из авторских добавок.
MIN_INGREDIENT_FREQUENCY = 0.4

# Категории, которые пользователь не фотографирует как блюдо. Не выбрасываем —
# понижаем в ранжировании, решение принимает поиск (тикет 08).
SERVICE_CATEGORIES = {
    "Заготовки",
    "Соусы",
    "Украшения для блюд",
    "Маринад, панировка",
    "Приготовление молочных продуктов",
}

_PUNCT_RE = re.compile(r"[^\w\s]", re.UNICODE)
_SPACE_RE = re.compile(r"\s+")


def canonical_key(title):
    """
    Ключ канонизации — мешок токенов названия.

    Так «Салат "Оливье"» и «Оливье салат» сходятся, а «Оливье с курицей» — нет,
    и это правильно: с курицей — другое блюдо и другой состав.
    """
    t = (title or "").lower().replace("ё", "е")
    t = _PUNCT_RE.sub(" ", t)
    tokens = _SPACE_RE.sub(" ", t).strip().split()
    return " ".join(sorted(set(tokens)))


def load_measures():
    payload = json.loads(MEASURES.read_text(encoding="utf-8"))
    return payload["measures"]


def ingredient_grams(item, measures):
    """Граммы одной позиции рецепта. None — меру не разобрать."""
    parsed = parse_count(item["count"])
    if parsed is None:
        return None
    qty, unit = parsed
    name = (item["name"] or "").strip()
    if not name:
        return None
    if unit in KNOWN_UNITS:
        return name, qty * KNOWN_UNITS[unit]
    if unit not in UNIT_PRIORS:
        return None
    per_unit = measures.get(name, {}).get(unit)
    if per_unit is None:
        per_unit = UNIT_PRIORS[unit]
    return name, qty * per_unit


def main():
    measures = load_measures()
    data = load()

    groups = collections.defaultdict(
        lambda: {
            "titles": collections.Counter(),
            "views": 0,
            "recipes": 0,
            "leaves": collections.Counter(),
            "roots": collections.Counter(),
            "dish_masses": [],
            "portion_masses": [],
            "cooking_times": [],
            # имя ингредиента → список долей по рецептам, где он есть
            "shares": collections.defaultdict(list),
            "urls": [],
        }
    )

    for i, title in enumerate(data["title"]):
        key = canonical_key(title)
        if not key:
            continue
        g = groups[key]
        g["titles"][title] += 1
        g["views"] += data["views"][i] or 0
        g["recipes"] += 1
        kroshki = data["kroshki"][i] or []
        if kroshki:
            g["leaves"][kroshki[-1]] += 1
            g["roots"][kroshki[0]] += 1
        if len(g["urls"]) < 5:
            g["urls"].append(data["page_url"][i])

        mass = dish_mass(data["nae_value"][i])
        if mass:
            g["dish_masses"].append(mass)
        portion = portion_mass(data["nae_value"][i])
        if portion:
            g["portion_masses"].append(portion)

        items = data["ingredients"][i]
        if not items or not mass:
            continue
        grams = {}
        for it in items:
            resolved = ingredient_grams(it, measures)
            if resolved is None:
                continue
            name, value = resolved
            if value > 0:
                grams[name] = grams.get(name, 0.0) + value
        total = sum(grams.values())
        if total <= 0:
            continue
        for name, value in grams.items():
            g["shares"][name].append(value / total)

    print(f"позиций справочника: {len(groups)}")

    out_lines, kept_singleton = [], 0
    for key, g in groups.items():
        composition = []
        for name, shares in g["shares"].items():
            frequency = len(shares) / g["recipes"]
            if frequency < MIN_INGREDIENT_FREQUENCY:
                continue
            composition.append(
                {
                    "name": name,
                    "share": round(statistics.median(shares), 6),
                    "frequency": round(frequency, 3),
                }
            )
        # Доли считались по разным рецептам, их сумма не обязана равняться
        # единице — нормируем, иначе КБЖУ блюда поедет вместе с ней.
        total = sum(c["share"] for c in composition)
        if total > 0:
            for c in composition:
                c["share"] = round(c["share"] / total, 6)
        composition.sort(key=lambda c: -c["share"])

        root = g["roots"].most_common(1)[0][0] if g["roots"] else None
        if g["recipes"] == 1:
            kept_singleton += 1

        out_lines.append(
            {
                "key": key,
                "title": g["titles"].most_common(1)[0][0],
                "recipes": g["recipes"],
                "views": g["views"],
                "category": g["leaves"].most_common(1)[0][0] if g["leaves"] else None,
                "category_root": root,
                "is_service": root in SERVICE_CATEGORIES,
                "dish_mass": summarize(g["dish_masses"]),
                "portion_mass": summarize(g["portion_masses"]),
                "composition": composition,
                "sample_urls": g["urls"],
            }
        )

    OUT.parent.mkdir(parents=True, exist_ok=True)
    with OUT.open("w", encoding="utf-8") as f:
        for row in out_lines:
            f.write(json.dumps(row, ensure_ascii=False) + "\n")

    with_composition = sum(1 for r in out_lines if r["composition"])
    with_portion = sum(1 for r in out_lines if r["portion_mass"])
    service = sum(1 for r in out_lines if r["is_service"])
    print(f"  из одного рецепта: {kept_singleton}")
    print(f"  с непустым составом: {with_composition}")
    print(f"  с данными о порции: {with_portion}")
    print(f"  служебных (заготовки, соусы, украшения): {service}")
    sizes = sorted((r["recipes"] for r in out_lines), reverse=True)
    print(f"  крупнейшие группы: {sizes[:8]}")
    print(f"записано {OUT}")


def summarize(values):
    if not values:
        return None
    values = sorted(values)
    n = len(values)
    return {
        "n": n,
        "p25": round(values[int(n * 0.25)], 1),
        "p50": round(values[n // 2], 1),
        "p75": round(values[int(n * 0.75)], 1),
    }


if __name__ == "__main__":
    main()
