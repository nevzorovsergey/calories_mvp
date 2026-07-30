"""
Тикет 02: восстановление граммовки бытовых мер Povarenok.

В граммах и миллилитрах задано лишь 34% упоминаний. Остальное — «1 шт»,
«2 ст. л.», «стакан». Сайт пересчитывает это в граммы, но коэффициент не
публикует, а без него не считается ни КБЖУ блюда по нашему справочнику, ни его
масса.

Масса блюда при этом известна (см. dump.dish_mass), значит каждый рецепт — это
уравнение

    Σ_j  qty_j · g(name_j, unit_j)  =  масса − известные граммы

с неизвестными g(ингредиент, мера).

Почему не МНК. Первая версия решала это через lsq_linear и дала холдаут 20.9% по
медиане при 31.6% попаданий в ±10%, а на контрольных величинах — 75 г за яйцо и
19 г за зубчик чеснока. Две причины, и обе неустранимы в рамках МНК:

  1. Хвосты. Отношение восстановленной массы к прямой сумме граммов доходит до
     25× на отдельных рецептах. Квадрат ошибки отдаёт таким рецептам вес,
     пропорциональный квадрату их бессмыслицы.
  2. Коллинеарность. Лук и чеснок стоят вместе в тысячах рецептов, и сумма их
     масс определена куда лучше, чем каждая по отдельности. МНК свободно
     перекладывает массу между ними.

Покоординатный спуск по медианам тоже не подошёл, и по поучительной причине:
оценка пары считается как «остаток минус вклад соседей, делённое на количество»,
и если отбрасывать отрицательные оценки, то мелкие ингредиенты систематически
задираются — у них разброс соседского шума больше собственного вклада, и обрезка
снизу превращается в смещение вверх. Чеснок уезжал на 17 г за зубчик, а лук,
который стоит с ним в тысячах рецептов, компенсировал это вниз до 46 г.

Неотрицательный МНК с нормировкой на остаток и отсевом выбросов тоже не подошёл:
он обнулял лук и морковь, отдавая их массу чесноку. Это не дефект реализации, а
свойство задачи — для коррелированных ингредиентов сумма определена, а слагаемые
нет, и солвер вправе положить любое из них на границу.

Что работает: послойное снятие (см. fit). Решаются только те пары, у которых
нашлись рецепты, где эта пара — единственная нерешённая; такой рецепт даёт
прямую оценку без соседей. Решённое объявляется известным, круг повторяется.
Холдаут: медиана 3.1%, в пределах 10% — 70.7%.

Чего снятие не даёт. Мелкие вкладчики определены плохо: когда пара снимается
последней, на неё садится вся накопленная ошибка уже решённых соседей, и
относительно собственного маленького вклада эта ошибка велика. Чеснок так
получал 24 г за зубчик при настоящих 4–6. Поэтому пары, объясняющие меньше
MIN_CONTRIBUTION остатка, остаются на априоре по мере: данные их не определяют,
и априор тут не приближение, а лучшая доступная оценка.

Запуск:

    python3 -m venv .venv && .venv/bin/pip install pyarrow numpy
    .venv/bin/python scripts/povarenok/measures.py

Результат: data/povarenok-measures.json
"""

import collections
import json
from pathlib import Path

import numpy as np

from dump import KNOWN_UNITS, UNIT_PRIORS, iter_recipes, load

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "data" / "povarenok-measures.json"

# Пар с меньшим числом наблюдений не решаем: берём априор по мере.
MIN_OBS = 5

# Сколько кругов послойного снятия делать.
PEEL_ROUNDS = 12

# Пара должна по медиане объяснять хотя бы такую долю остатка, иначе её оценка
# состоит в основном из накопленной ошибки соседей — см. про чеснок в шапке.
MIN_CONTRIBUTION = 0.10

HOLDOUT_EVERY = 10  # каждый десятый рецепт не участвует в подгонке

# Контрольные величины: проверяются отдельно от метрики, потому что хорошая
# метрика при абсурдных коэффициентах — это ровно то, что случилось с МНК.
SANITY = [
    ("Яйцо куриное", "шт", 45, 65),
    ("Лук репчатый", "шт", 70, 120),
    ("Чеснок", "зуб.", 3, 8),
    ("Картофель", "шт", 70, 150),
    ("Морковь", "шт", 60, 120),
    # Столовая ложка муки: 20 г без горки, 30 г с горкой — в русских
    # кулинарных таблицах разброс именно такой, вилка не должна быть уже.
    ("Мука пшеничная", "ст. л.", 15, 32),
    ("Сахар", "ч. л.", 4, 10),
    ("Масло растительное", "ст. л.", 10, 20),
    ("Сметана", "ст. л.", 15, 30),
    ("Молоко", "стак.", 180, 260),
]


def collect(data):
    rows, pair_index, pair_names = [], {}, []
    for _, mass, known, unknown in iter_recipes(data):
        if not unknown:
            continue
        residual = mass - known
        if residual <= 0:
            continue
        packed = []
        for key, qty in unknown.items():
            idx = pair_index.get(key)
            if idx is None:
                idx = pair_index[key] = len(pair_names)
                pair_names.append(key)
            packed.append((idx, qty))
        rows.append((residual, packed))
    return rows, pair_names


def fit(rows, pair_names, train):
    """
    Послойное снятие: на каждом круге решаются только те пары, для которых
    нашлись рецепты, где эта пара — единственная нерешённая. Такой рецепт даёт
    прямую оценку g = остаток / количество, без всякой подгонки и без соседей,
    между которыми можно перекладывать массу. Медиана по таким оценкам и есть
    ответ.

    Решённые пары объявляются известными, их вклад уходит в правую часть, и на
    следующем круге единственными нерешёнными становятся новые пары. Круги идут,
    пока слой не окажется пустым.

    Пары, до которых снятие не добралось (в каждом их рецепте есть ещё хотя бы
    одна нерешённая), остаются на априоре по мере. Это честнее, чем выдать
    число, которое данные не определяют: именно попытка определить их всё равно
    обнуляла лук и морковь в МНК.
    """
    grams = np.full(len(pair_names), np.nan)
    active = [i for i, keep in enumerate(train) if keep]

    for step in range(PEEL_ROUNDS):
        estimates = collections.defaultdict(list)
        for i in active:
            residual, packed = rows[i]
            rest, pending = 0.0, []
            for idx, qty in packed:
                if np.isnan(grams[idx]):
                    pending.append((idx, qty))
                else:
                    rest += grams[idx] * qty
            if len(pending) != 1:
                continue
            idx, qty = pending[0]
            value = (residual - rest) / qty
            estimates[idx].append(value)

        solved = 0
        for idx, values in estimates.items():
            if len(values) < MIN_OBS:
                continue
            # Медиана без обрезки отрицательных: обрезка снизу — это и есть то
            # смещение вверх, на котором сломался покоординатный спуск.
            value = float(np.median(values))
            grams[idx] = max(value, 0.0)
            solved += 1

        known = int((~np.isnan(grams)).sum())
        print(f"  круг {step + 1}: решено пар {solved}, всего известно {known}")
        if solved == 0:
            break

    return grams


def evaluate(rows, train, grams):
    errors = []
    for keep, (residual, packed) in zip(train, rows):
        if keep:
            continue
        predicted = sum(grams[idx] * qty for idx, qty in packed)
        errors.append(abs(predicted - residual) / residual)
    errors.sort()
    return errors


def main():
    data = load()
    rows, pair_names = collect(data)
    print(f"уравнений: {len(rows)}, неизвестных пар: {len(pair_names)}")

    obs = collections.Counter()
    for _, packed in rows:
        for idx, _ in packed:
            obs[idx] += 1

    train = [i % HOLDOUT_EVERY != 0 for i in range(len(rows))]
    grams = fit(rows, pair_names, train)

    # Какую долю остатка пара объясняет по медиане своих рецептов.
    shares = collections.defaultdict(list)
    for residual, packed in rows:
        for idx, qty in packed:
            if not np.isnan(grams[idx]):
                shares[idx].append(grams[idx] * qty / residual)

    reasons = collections.Counter()
    from_data_idx = []
    for idx, (_, unit) in enumerate(pair_names):
        if np.isnan(grams[idx]):
            reason = "снятие не добралось"
        elif obs[idx] < MIN_OBS:
            reason = "мало наблюдений"
        elif float(np.median(shares[idx])) < MIN_CONTRIBUTION:
            reason = "вклад ниже порога"
        else:
            from_data_idx.append(idx)
            continue
        grams[idx] = UNIT_PRIORS[unit]
        reasons[reason] += 1

    print(f"пар на априоре: {sum(reasons.values())} из {len(pair_names)}")
    for reason, n in reasons.most_common():
        print(f"    {reason}: {n}")
    from_data = sum(obs[i] for i in from_data_idx)
    print(
        "доля упоминаний, покрытых числом из данных: "
        f"{from_data / max(sum(obs.values()), 1):.1%}"
    )

    errors = evaluate(rows, train, grams)
    n = len(errors)
    print(
        f"holdout ({n} рецептов): медиана {errors[n // 2]:.1%}, "
        f"p75 {errors[int(n * 0.75)]:.1%}, p90 {errors[int(n * 0.9)]:.1%}, "
        f"в пределах 10% — {sum(1 for e in errors if e <= 0.10) / n:.1%}"
    )

    lookup = {p: i for i, p in enumerate(pair_names)}
    print("\nконтрольные величины:")
    failed = []
    for name, unit, low, high in SANITY:
        idx = lookup.get((name, unit))
        if idx is None:
            print(f"  {name} / {unit}: пары нет в данных")
            continue
        value = grams[idx]
        ok = low <= value <= high
        if not ok:
            failed.append((name, unit, value, low, high))
        print(
            f"  {'ok ' if ok else 'НЕТ'} {name} / {unit}: {value:.0f} г "
            f"(ожидалось {low}–{high}, наблюдений {obs[idx]})"
        )

    out = collections.defaultdict(dict)
    for idx, (name, unit) in enumerate(pair_names):
        out[name][unit] = round(float(grams[idx]), 2)
    OUT.write_text(
        json.dumps(
            {"known_units": KNOWN_UNITS, "measures": {k: out[k] for k in sorted(out)}},
            ensure_ascii=False,
            indent=1,
        ),
        encoding="utf-8",
    )
    print(f"\nзаписано {OUT} — {len(out)} ингредиентов, {len(pair_names)} пар")
    if failed:
        print(f"ВНИМАНИЕ: контрольных величин не прошло {len(failed)}")


if __name__ == "__main__":
    main()
