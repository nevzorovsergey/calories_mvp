"""
Загрузка и разбор дампов Povarenok. Общая часть тикетов 02 и 04.

Дампа два, и это не избыточность.

`d0rj/povarenok_recipes_detail` (parquet, 154 158 рецептов, срез 2024-02) —
основной: КБЖУ, порции, категории, фотографии. Но его парсер теряет количество у
ингредиентов, которые сайт показывает с альтернативным названием через слэш
(«Мука пшеничная / Мука — 400 г» приходит как count=None). У муки потеряно 95.2%
количеств, у белокочанной капусты 89.7%, у молочного шоколада 84.7%.

`rogozinushka/povarenok-recipes` (csv, 146 582 рецепта, срез 2021-06) — беднее
(только url, название, ингредиенты), но количества у него на месте: та же мука
теряется в 5.1% случаев. Пересечение по url — 146 063 рецепта, 94.7% основного
дампа.

Поэтому: количества из rogozinushka подставляются ТОЛЬКО туда, где в d0rj пусто,
и никогда не переписывают заполненное. Причина не в доверии к источнику, а в
согласованности: масса блюда считается из КБЖУ d0rj, а его сайт посчитал по
своему списку ингредиентов на 2024 год. Рецепт мог измениться — там, где оба
дампа дают количество, они расходятся в 64 436 позициях. Смешивать их нельзя.

После слияния без количества остаётся 12.4% позиций против 17.0% до, и это уже
честное «по вкусу»: соль как была 38.7%, так и осталась.
"""

import ast
import csv
import glob
import re
import sys
from pathlib import Path

import pyarrow as pa
import pyarrow.parquet as pq

ROOT = Path(__file__).resolve().parents[2]
DUMP = ROOT / "data" / "povarenok"
ROGOZINUSHKA = DUMP / "rogozinushka.csv"

# Меры, граммовку которых восстанавливать не надо — она известна по определению.
# «мл» и «л» приравнены к воде: для молока, бульона и сока ошибка в пределах 3%,
# для масла около 8%, и это меньше разброса между самими рецептами.
#
# «по вкусу» и пустое количество — тоже известная величина, и она равна нулю.
# Это не допущение, а измерение: на рецептах, где каждый ингредиент задан либо в
# г/мл, либо «по вкусу», отношение восстановленной массы к прямой сумме граммов
# равно 1.000 (медиана, n=2147) — ровно как на рецептах вообще без таких позиций
# (1.000, n=2073). Сайт их в массу не включает.
#
# Пока они моделировались как неизвестные с положительным весом, они растаскивали
# массу у настоящих мер: оценка яйца уезжала на 34 г, лука на 39 г.
KNOWN_UNITS = {
    "г": 1.0,
    "гр": 1.0,
    "грамм": 1.0,
    "мл": 1.0,
    "кг": 1000.0,
    "л": 1000.0,
    "по вкусу": 0.0,
    "": 0.0,
}

# Бытовые меры, которые надо восстановить, и априорная граммовка каждой.
# Априор нужен редким парам «ингредиент × мера»: коэффициент, выведенный из трёх
# рецептов, хуже разумной константы.
UNIT_PRIORS = {
    "шт": 100.0,
    "ст. л.": 15.0,
    "ч. л.": 5.0,
    "стак.": 200.0,
    "зуб.": 4.0,
    "пуч.": 50.0,
    "щепот.": 1.0,
    "бан.": 400.0,
    "пакет.": 10.0,
    "пач.": 200.0,
    "ломт.": 20.0,
    "горст.": 30.0,
    "веточ.": 3.0,
    "упак.": 200.0,
    "дол.": 30.0,
    "капл.": 0.05,
    "вилок": 1500.0,
    "бут.": 500.0,
}

# Отсечки по массе блюда: за ними не рецепт, а мусор в исходных числах.
MASS_MIN, MASS_MAX = 20.0, 30000.0

_QTY_RE = re.compile(r"^\s*(\d+(?:[.,]\d+)?(?:\s*[/\\]\s*\d+)?)?\s*(.*?)\s*$")
_MIXED_RE = re.compile(r"^(\d+)\s*(?:-|\+)\s*(\d+)\s*[/\\]\s*(\d+)\s+(.*)$")


def parse_count(raw):
    """«2-1/2 ст. л.» → (2.5, 'ст. л.'). None — строку разобрать не удалось."""
    if raw is None:
        return 1.0, ""
    s = str(raw).strip().lower()
    if not s:
        return 1.0, ""

    mixed = _MIXED_RE.match(s)
    if mixed:
        whole, num, den, unit = mixed.groups()
        if float(den) == 0:
            return None
        return float(whole) + float(num) / float(den), unit.strip()

    m = _QTY_RE.match(s)
    if not m:
        return None
    qty_raw, unit = m.group(1), (m.group(2) or "").strip()

    if qty_raw is None:
        qty = 1.0
    else:
        qty_raw = qty_raw.replace(",", ".").replace("\\", "/").replace(" ", "")
        if "/" in qty_raw:
            num, den = qty_raw.split("/", 1)
            if float(den) == 0:
                return None
            qty = float(num) / float(den)
        else:
            qty = float(qty_raw)

    if qty <= 0:
        return None
    return qty, unit


def dish_mass(nae):
    """
    Сумма граммов, которую сложил сайт: kcal(готового) / kcal(100 г) × 100.

    Проверено на 1693 рецептах, где все ингредиенты заданы в г/мл: медиана
    отношения к прямой сумме 1.000, в ±2% укладываются 78%.

    None — посчитать нельзя или получилось неправдоподобное число.
    """
    if not nae:
        return None
    per100, whole = nae.get("100 г блюда"), nae.get("Готового блюда")
    if not per100 or not whole:
        return None
    a, b = per100.get("kcal"), whole.get("kcal")
    if not a or not b or a <= 0 or b <= 0:
        return None
    m = b / a * 100.0
    return m if MASS_MIN <= m <= MASS_MAX else None


def portion_mass(nae):
    """Масса одной порции по той же логике. Есть у 83 462 рецептов из 154 158."""
    if not nae:
        return None
    per100, portion = nae.get("100 г блюда"), nae.get("Порции")
    if not per100 or not portion:
        return None
    a, b = per100.get("kcal"), portion.get("kcal")
    if not a or not b or a <= 0 or b <= 0:
        return None
    m = b / a * 100.0
    return m if 1.0 <= m <= MASS_MAX else None


def _load_rogozinushka():
    if not ROGOZINUSHKA.exists():
        print(
            f"warning: {ROGOZINUSHKA} нет — количества у муки и ещё пяти "
            "ингредиентов останутся потерянными, см. data/README.md",
            file=sys.stderr,
        )
        return {}
    csv.field_size_limit(10**7)
    out = {}
    with ROGOZINUSHKA.open(encoding="utf-8") as f:
        for row in csv.DictReader(f):
            try:
                out[row["url"]] = ast.literal_eval(row["ingredients"])
            except (ValueError, SyntaxError):
                continue
    return out


def load(merge_quantities=True):
    """
    Дамп d0rj как словарь колонок, с починенными количествами.

    Возвращает тот же pydict, что и parquet, но `ingredients[i][j]['count']`
    уже дополнен из rogozinushka там, где был None.
    """
    files = sorted(glob.glob(str(DUMP / "*.parquet")))
    if not files:
        sys.exit(f"нет дампа в {DUMP} — см. data/README.md")
    data = pa.concat_tables([pq.read_table(f) for f in files]).to_pydict()

    if not merge_quantities:
        return data

    rog = _load_rogozinushka()
    if not rog:
        return data

    repaired = 0
    for i, items in enumerate(data["ingredients"]):
        if not items:
            continue
        source = rog.get(data["page_url"][i])
        if not source:
            continue
        for it in items:
            if it["count"] is not None:
                continue
            fix = source.get((it["name"] or "").strip())
            if fix:
                it["count"] = fix
                repaired += 1
    print(f"количеств восстановлено из rogozinushka: {repaired}", file=sys.stderr)
    return data


def iter_recipes(data):
    """
    Рецепты, пригодные для расчёта: с известной массой и разобранными мерами.

    Отдаёт (индекс, масса, известные граммы, {(имя, мера): суммарное количество}).
    Рецепт с неразбираемой или нестандартной мерой пропускается целиком: выкинуть
    одну позицию нельзя, уравнение станет неверным на её вклад.
    """
    for i, items in enumerate(data["ingredients"]):
        mass = dish_mass(data["nae_value"][i])
        if mass is None or not items:
            continue

        known, unknown, bad = 0.0, {}, False
        for it in items:
            parsed = parse_count(it["count"])
            if parsed is None:
                bad = True
                break
            qty, unit = parsed
            name = (it["name"] or "").strip()
            if not name:
                bad = True
                break
            if unit in KNOWN_UNITS:
                known += qty * KNOWN_UNITS[unit]
            elif unit in UNIT_PRIORS:
                key = (name, unit)
                unknown[key] = unknown.get(key, 0.0) + qty
            else:
                bad = True
                break
        if bad:
            continue
        yield i, mass, known, unknown
