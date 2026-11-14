"""Buduje gamedata.js (window.L2_GAMEDATA) z bazy gry w gamedb/*.csv.

Do aplikacji trafia tylko to, czego potrzebuje: nazwy i podstawowe parametry potworów, nazwy przedmiotów
z typem i klasą, dropy i spoile (przedmiot, szansa, ilość) oraz nazwy umiejętności. Lokalizacje potworów,
poziomy i atrybuty umiejętności zostają w gamedb jako źródło.

Użycie: python build_gamedata.py
"""
import csv
import json
import os
import re

here = os.path.dirname(os.path.abspath(__file__))
root = os.path.join(here, '..')
gamedb = os.path.join(root, 'gamedb')


def rows(name):
    with open(os.path.join(gamedb, name), encoding='utf-8', newline='') as f:
        yield from csv.DictReader(f)


def num(v, default=0):
    try:
        return int(float(v))
    except (TypeError, ValueError):
        return default


# ---- przedmioty: id -> [nazwa, typ, klasa] ----
items = {}
for r in rows('items.csv'):
    grade = r['crystal_type'].upper() if r['crystal_type'] not in ('none', 'crystal_free', '') else ''
    items[r['item_id']] = [r['name'], r['item_type'], grade]

# ---- potwory: id -> [nazwa, poziom, hp, exp, sp, agresywny, typ] ----
monsters = {}
for r in rows('monsters.csv'):
    monsters[r['npc_id']] = [r['name'], num(r['level']), num(r['hp']), num(r['exp']), num(r['sp']), num(r['is_aggressive']), r['type']]

# ---- dropy i spoile: monster_id -> [[item_id, szansa %, ilość min, ilość max], ...] ----
CHANCE = re.compile(r'([\d.]+)\s*%\s*(\d+)(?:\s*-\s*(\d+))?')


def relations(name):
    out = {}
    for r in rows(name):
        m = CHANCE.search(r['raw_text'])
        if not m:
            continue
        chance = round(float(m.group(1)), 4)
        qmin = int(m.group(2))
        qmax = int(m.group(3)) if m.group(3) else qmin
        out.setdefault(r['monster_id'], []).append([int(r['item_id']), chance, qmin, qmax])
    return out


drops = relations('monster_drops.csv')
spoils = relations('monster_spoils.csv')

# ---- umiejętności: id -> nazwa ----
skills = {r['skill_id']: r['name'] for r in rows('skills.csv')}

data = {'items': items, 'monsters': monsters, 'drops': drops, 'spoils': spoils, 'skills': skills}
out = os.path.join(root, 'gamedata.js')
with open(out, 'w', encoding='utf-8', newline='\n') as f:
    f.write('// Okrojona baza gry dla aplikacji. Wygenerowane przez data/build_gamedata.py z gamedb/*.csv, nie edytować ręcznie.\n')
    f.write('// items: id -> [nazwa, typ, klasa]; monsters: id -> [nazwa, poziom, hp, exp, sp, agresywny, typ];\n')
    f.write('// drops/spoils: monster_id -> [[item_id, szansa %, ilość min, ilość max], ...]; skills: id -> nazwa.\n')
    f.write('window.L2_GAMEDATA = ' + json.dumps(data, ensure_ascii=False, separators=(',', ':')) + ';\n')

print(f'items {len(items)}, monsters {len(monsters)}, drops dla {len(drops)} potworów ({sum(map(len, drops.values()))} wpisów), '
      f'spoils dla {len(spoils)} ({sum(map(len, spoils.values()))} wpisów), skills {len(skills)}; {os.path.getsize(out) // 1024} KB -> {os.path.relpath(out, root)}')
