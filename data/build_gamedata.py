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
# Poprawki nazw z wiki: 2388 to Zubei's Leather Gaiters (wiki ma "Shirt", ikona i cena spodni), inaczej nazwa dubluje 2384.
NAME_FIX = {'2388': "Zubei's Leather Gaiters"}

items = {}
raw_items = {}
for r in rows('items.csv'):
    # przedmioty testowe twórców klienta: 13 broni z opisem "A temporary item for Kamex" (id 1295-1307) dubluje nazwy
    # prawdziwych broni (Long Sword, Apprentice's Rod, ...) z innymi cenami, bez dropu i handlu; wypadają z bazy
    if 'temporary item' in r['description'].lower():
        continue
    grade = r['crystal_type'].upper() if r['crystal_type'] not in ('none', 'crystal_free', '') else ''
    # klient pokazuje "No Grade", w CSV jeden wpis ma "None Grade" (Blessed Spiritshot)
    name = NAME_FIX.get(r['item_id'], r['name']).replace('None Grade', 'No Grade')
    icon = r['icon'].strip().rsplit('.', 1)[-1]   # "icon.weapon_x_i00" i "Lineage2C1.etc_x_i00" -> plik img/items/<icon>.png (data/fetch_icons.py)
    items[r['item_id']] = [name, r['item_type'], grade, num(r['default_price']), icon]
    raw_items[r['item_id']] = r

# ---- miejsce przedmiotu w swojej kategorii: [miejsce, liczba w kategorii, nazwa kategorii] jako 6. pole ----
# Kategoria to rodzaj plus klasa (łuki D, szaty góra NG, pierścienie C). Bronie porządkuje obrażenia fizyczne
# (remis: cena), zbroje i biżuterię cena, bo wiki nie podaje obrony. Miejsce dzielone przy remisie (1, 2, 2, 4).
WEAPON_LABEL = {('sword', 'rhand'): 'mieczy jednoręcznych', ('sword', 'lrhand'): 'mieczy dwuręcznych',
                ('blunt', 'rhand'): 'obuchów jednoręcznych', ('blunt', 'lrhand'): 'obuchów dwuręcznych',
                ('dagger', 'rhand'): 'sztyletów', ('bow', 'lrhand'): 'łuków', ('dual', 'lrhand'): 'mieczy podwójnych',
                ('dualfist', 'lrhand'): 'pięści', ('pole', 'lrhand'): 'włóczni', ('etc', 'rhand'): 'innych broni'}
ARMOR_LABEL = {'light': 'lekkich zbroi', 'heavy': 'ciężkich zbroi', 'magic': 'szat'}
PART_LABEL = {'chest': 'góra', 'legs': 'dół', 'onepiece': 'całe'}
SLOT_LABEL = {'feet': 'butów', 'gloves': 'rękawic', 'head': 'hełmów', 'lhand': 'tarcz',
              'neck': 'naszyjników', 'rear;lear': 'kolczyków', 'rfinger;lfinger': 'pierścieni'}


def category(r):
    t, slot, grade = r['item_type'], r['slot_bit_type'], (items[r['item_id']][2] or 'NG')
    if t == 'weapon':
        lab = WEAPON_LABEL.get((r['weapon_type'], slot))
        return (lab and f'{lab} {grade}', 'dmg')
    if t == 'armor' and r['armor_type'] in ARMOR_LABEL and slot in PART_LABEL:
        return (f'{ARMOR_LABEL[r["armor_type"]]} ({PART_LABEL[slot]}) {grade}', 'price')
    if t in ('armor', 'accessary') and slot in SLOT_LABEL:
        return (f'{SLOT_LABEL[slot]} {grade}', 'price')
    return (None, None)


groups = {}
for iid, r in raw_items.items():
    cat, key = category(r)
    if cat:
        groups.setdefault(cat, []).append((iid, key))
# cats: kategoria -> lista od najlepszego: bronie [id, p.atk, m.atk], reszta [id, cena]; przedmiot dostaje [miejsce, ile, kategoria]
cats = {}
for cat, members in groups.items():
    key = members[0][1]
    score = (lambda i: (num(raw_items[i]['physical_damage']), num(raw_items[i]['default_price']))) if key == 'dmg' else (lambda i: (num(raw_items[i]['default_price']),))
    ordered = sorted((i for i, _ in members), key=score, reverse=True)
    cats[cat] = [[int(i), num(raw_items[i]['physical_damage']), num(raw_items[i]['magical_damage'])] if key == 'dmg' else [int(i), num(raw_items[i]['default_price'])] for i in ordered]
    rank, prev = 0, None
    for pos, i in enumerate(ordered, 1):
        s = score(i)
        if s != prev:
            rank, prev = pos, s
        items[i].append([rank, len(ordered), cat])

dup = {}
for i, v in items.items():
    dup.setdefault(v[0].lower(), []).append(i)
dup = {k: v for k, v in dup.items() if len(v) > 1}
if dup:
    raise SystemExit(f'zduplikowane nazwy przedmiotów: {dup}')

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

# ---- receptury i kluczowe składniki: id -> id produktu (tylko gdy produkt ma kategorię) ----
# Nazwa produktu najpierw z nazwy przedmiotu ("Recipe: Skull Smasher" -> Skull Smasher; "Silver Axe Head" -> Silver Axe,
# czyli bez ostatniego słowa), potem z opisu ("A recipe for making a Broad Sword."). Opisy bywają ze starymi nazwami
# (Leather Hose, War Pick, Skull Breaker), dlatego nazwa ma pierwszeństwo, a dopasowania rozmytego nie ma.
# Porównanie po normalizacji (małe litery, bez znaków) z tolerancją liczby mnogiej, wśród broni, zbroi i biżuterii.
norm = lambda s: re.sub(r'[^a-z0-9]', '', s.lower())
equip = {norm(items[i][0]): i for i, r in raw_items.items() if len(items[i]) > 5}
made = {}
for iid, r in raw_items.items():
    d, name = r['description'], r['name']
    is_recipe, is_key = name.startswith('Recipe'), bool(re.search(r'key material|main ingredient', d, re.I))
    if not (is_recipe or is_key):
        continue
    cands = []
    if is_recipe:
        cands.append(name.split(':', 1)[-1].strip())
    else:
        words = name.split(' ')
        if len(words) > 1:
            cands.append(' '.join(words[:-1]))
    m = re.search(r'(?:for making|use to make|used to make|to make)\s+(?:a |an |the )?([^.]+?)\s*\.', d, re.I)
    if m:
        cands.append(m.group(1))
    target = None
    for c in cands:
        for v in (c, c + 's', c[:-1] if c.endswith('s') else c, c + 'es'):
            if norm(v) in equip:
                target = equip[norm(v)]
                break
        if target:
            break
    if target and target != iid:
        made[iid] = int(target)

data = {'items': items, 'monsters': monsters, 'drops': drops, 'spoils': spoils, 'skills': skills, 'cats': cats, 'made': made}
out = os.path.join(root, 'gamedata.js')
with open(out, 'w', encoding='utf-8', newline='\n') as f:
    f.write('// Okrojona baza gry dla aplikacji. Wygenerowane przez data/build_gamedata.py z gamedb/*.csv, nie edytować ręcznie.\n')
    f.write('// items: id -> [nazwa, typ, klasa, cena w Adenie, ikona (img/items/<ikona>.png), opcjonalnie [miejsce, ile, kategoria]];\n')
    f.write('// monsters: id -> [nazwa, poziom, hp, exp, sp, agresywny, typ]; cats: kategoria -> [[id, p.atk, m.atk] | [id, cena], ...] od najlepszego;\n')
    f.write('// made: id receptury lub kluczowego składnika -> id produktu.\n')
    f.write('// drops/spoils: monster_id -> [[item_id, szansa %, ilość min, ilość max], ...]; skills: id -> nazwa.\n')
    f.write('window.L2_GAMEDATA = ' + json.dumps(data, ensure_ascii=False, separators=(',', ':')) + ';\n')

print(f'receptury i składniki z produktem: {len(made)}')
print(f'items {len(items)}, monsters {len(monsters)}, drops dla {len(drops)} potworów ({sum(map(len, drops.values()))} wpisów), '
      f'spoils dla {len(spoils)} ({sum(map(len, spoils.values()))} wpisów), skills {len(skills)}; {os.path.getsize(out) // 1024} KB -> {os.path.relpath(out, root)}')
