"""Pobiera ikony przedmiotów z lineage2wiki.org do img/items/<ikona>.png (ikona z kolumny `icon` w gamedb/items.csv,
bez przedrostka "icon."). Pomija pliki, które już są. Kilka pobrań naraz, z przerwą, żeby nie obciążać wiki.

Użycie: python data/fetch_icons.py
"""
import csv
import os
import sys
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor

here = os.path.dirname(os.path.abspath(__file__))
root = os.path.join(here, '..')
out_dir = os.path.join(root, 'img', 'items')
BASE = 'https://lineage2wiki.org/wp-content/themes/wiki_theme/images/item_icons/'
os.makedirs(out_dir, exist_ok=True)

icons = set()
with open(os.path.join(root, 'gamedb', 'items.csv'), encoding='utf-8', newline='') as f:
    for r in csv.DictReader(f):
        if 'temporary item' in r['description'].lower():
            continue
        ic = r['icon'].strip().rsplit('.', 1)[-1]   # "icon.weapon_x_i00" i "Lineage2C1.etc_x_i00" -> nazwa pliku na wiki
        if ic:
            icons.add(ic)

todo = sorted(ic for ic in icons if not os.path.exists(os.path.join(out_dir, ic + '.png')))
print(f'ikon: {len(icons)}, do pobrania: {len(todo)}', flush=True)


def fetch(ic):
    url = BASE + ic + '.png'
    path = os.path.join(out_dir, ic + '.png')
    try:
        req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0 (icon fetch)'})
        data = urllib.request.urlopen(req, timeout=30).read()
        if not data.startswith(b'\x89PNG'):
            return ic, 'nie PNG'
        with open(path, 'wb') as f:
            f.write(data)
        time.sleep(0.15)
        return ic, 'ok'
    except Exception as e:  # noqa: BLE001 - raportujemy i idziemy dalej
        return ic, f'błąd: {e}'


failed = []
with ThreadPoolExecutor(max_workers=4) as ex:
    for i, (ic, st) in enumerate(ex.map(fetch, todo), 1):
        if st != 'ok':
            failed.append((ic, st))
        if i % 100 == 0:
            print(f'{i}/{len(todo)}', flush=True)

print(f'pobrano {len(todo) - len(failed)}, nieudane {len(failed)}')
for ic, st in failed[:40]:
    print('  ', ic, st)
sys.exit(1 if failed else 0)
