"""Analiza próbek z trybu debug: maska tekstu, segmentacja linii, odciski i dopasowanie kolejnych klatek.

Narzędzie deweloperskie, nie jest częścią strony (przeglądarka nie pobiera plików z tools/).
Wymaga: Python 3 z pillow i numpy  (python -m pip install --user pillow numpy).

Użycie:
  python tools/ocr_fingerprint.py samples/debug/<sesja>          # metryki dopasowania kolejnych klatek
  python tools/ocr_fingerprint.py samples/debug/<sesja> --vis     # dodatkowo obrazki do podglądu w samples/debug/<sesja>/analysis/

Co liczy:
  1. maska tekstu: piksele o barwie tekstu czatu (beżowy/żółty, turkusowy, czerwony) leżące przy ciemnej obwódce glifów;
  2. linie: pasy wierszy z atramentem w profilu poziomym;
  3. odcisk linii: maska pasa; odległość = 1 - pokrycie pikseli tekstu (z tolerancją przesunięcia ±2 px);
  4. dla każdej pary kolejnych klatek: przesunięcie k (liczba nowych linii) o najniższej średniej odległości,
     margines do drugiego najlepszego k, oraz porównanie k z liczbą zdarzeń wygenerowanych przez stronę.
"""
import argparse
import json
import os
import sys

import numpy as np
from PIL import Image


# ---------------- maska tekstu ----------------
def hsv(rgb):
    r, g, b = [rgb[..., i].astype(np.float32) / 255 for i in range(3)]
    mx = np.maximum(np.maximum(r, g), b)
    mn = np.minimum(np.minimum(r, g), b)
    v = mx
    s = np.where(mx > 0, (mx - mn) / np.maximum(mx, 1e-6), 0)
    d = np.maximum(mx - mn, 1e-6)
    h = np.where(mx == r, (60 * ((g - b) / d) + 360) % 360, 0)
    h = np.where(mx == g, 60 * ((b - r) / d) + 120, h)
    h = np.where(mx == b, 60 * ((r - g) / d) + 240, h)
    return h, s, v


def dilate(mask, r):
    out = mask.copy()
    for dy in range(-r, r + 1):
        for dx in range(-r, r + 1):
            out |= np.roll(np.roll(mask, dy, 0), dx, 1)
    return out


def text_mask(rgb, use_outline=True):
    """Tekst czatu: barwa z listy + (opcjonalnie) ciemna obwódka glifu w promieniu 2 px."""
    h, s, v = hsv(rgb)
    beige = (v > 0.64) & (s > 0.10) & (s < 0.72) & (h > 25) & (h < 75)   # "biały" systemowy (przez podkładkę beżowy) i żółty dropów
    cyan = (v > 0.55) & (s > 0.30) & (h > 165) & (h < 210)
    red = (v > 0.55) & (s > 0.45) & ((h < 15) | (h > 345))
    color = beige | cyan | red
    if not use_outline:
        return color
    return color & dilate(v < 0.33, 2)


# ---------------- linie i odciski ----------------
def segment(m, min_rows=6, min_ink=4):
    ink = m.sum(axis=1)
    rows = ink >= min_ink
    out, y = [], 0
    while y < len(rows):
        if rows[y]:
            y0 = y
            while y < len(rows) and rows[y]:
                y += 1
            if y - y0 >= min_rows:
                out.append({'y0': y0, 'y1': y, 'mask': m[y0:y, :]})
        else:
            y += 1
    return out


def dist(a, b):
    """1 - IoU pikseli tekstu, najlepsze z przesunięć ±2 px w pionie i ±1 px w poziomie (tekst jest wyrównany do lewej)."""
    best = 1.0
    for dy in (-2, -1, 0, 1, 2):
        for dx in (-1, 0, 1):
            h = min(a.shape[0], b.shape[0]) - abs(dy)
            w = min(a.shape[1], b.shape[1]) - abs(dx)
            if h <= 0 or w <= 0:
                continue
            ay, by = (dy, 0) if dy >= 0 else (0, -dy)
            ax, bx = (dx, 0) if dx >= 0 else (0, -dx)
            A = a[ay:ay + h, ax:ax + w]
            B = b[by:by + h, bx:bx + w]
            inter = (A & B).sum()
            union = (A | B).sum()
            best = min(best, 1 - inter / max(union, 1))
    return best


def align(prev, cur):
    """Dla każdego przesunięcia k: (k, średnia odległość nałożonych linii, maks, liczba nałożeń)."""
    res = []
    n = min(len(prev), len(cur))
    for k in range(0, n):
        pairs = [(prev[i + k]['mask'], cur[i]['mask']) for i in range(n - k)]
        if len(pairs) < 3:
            break
        ds = [dist(x, y) for x, y in pairs]
        res.append((k, float(np.mean(ds)), float(np.max(ds)), len(ds)))
    return res


# ---------------- główny bieg ----------------
def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('session', help='folder sesji debug z debug.jsonl i plikami *-crop.png')
    ap.add_argument('--vis', action='store_true', help='zapisz obrazki masek i nałożeń do <sesja>/analysis/')
    ap.add_argument('--threshold', type=float, default=0.25, help='próg odległości "ta sama linia" (domyślnie 0.25)')
    args = ap.parse_args()

    log = os.path.join(args.session, 'debug.jsonl')
    if not os.path.exists(log):
        sys.exit(f'brak {log}')
    entries = [json.loads(l) for l in open(log, encoding='utf-8')]
    frames = []
    for e in entries:
        img = np.array(Image.open(os.path.join(args.session, e['files']['crop'])).convert('RGB'))
        m = text_mask(img)
        frames.append({'name': e['files']['crop'][11:19], 'img': img, 'mask': m, 'segs': segment(m), 'entry': e})
        print(f"{frames[-1]['name']}: linii {len(frames[-1]['segs']):2d}, tekst {m.mean() * 100:.2f}% pikseli")

    print('\npara klatek      | k nowych linii | średnia | maks  | 2. najlepsze k | zdarzeń ze strony')
    aligned, others, mismatches = [], [], 0
    for fa, fb in zip(frames, frames[1:]):
        res = sorted(align(fa['segs'], fb['segs']), key=lambda r: r[1])
        if len(res) < 2:
            continue
        best, second = res[0], res[1]
        k = best[0]
        ev = len(fb['entry'].get('eventsSinceLast', []))
        flag = '  <- rozjazd' if ev > k + 1 else ''
        mismatches += ev > k + 1
        print(f"{fa['name']} -> {fb['name']} | {k:2d}             | {best[1]:.3f}   | {best[2]:.3f} | k={second[0]:2d} {second[1]:.3f}   | {ev}{flag}")
        n = min(len(fa['segs']), len(fb['segs']))
        aligned += [dist(fa['segs'][i + k]['mask'], fb['segs'][i]['mask']) for i in range(n - k)]
        others += [r[1] for r in res if r[0] != k]
    aligned = np.array(aligned)
    print(f"\nta sama linia w kolejnej klatce: n={len(aligned)} mediana {np.median(aligned):.3f} "
          f"p90 {np.percentile(aligned, 90):.3f} p99 {np.percentile(aligned, 99):.3f} max {aligned.max():.3f}")
    print(f"błędne przesunięcia (średnie):   min {min(others):.3f} mediana {np.median(others):.3f}")
    print(f"próg {args.threshold}: ta sama linia powyżej progu w {(aligned > args.threshold).mean() * 100:.2f}% nałożeń; "
          f"par klatek, gdzie strona dała więcej zdarzeń niż było nowych linii: {mismatches}")

    if args.vis:
        out = os.path.join(args.session, 'analysis')
        os.makedirs(out, exist_ok=True)
        f = frames[-1]
        vis = np.zeros((*f['mask'].shape, 3), np.uint8)
        vis[f['mask']] = (255, 255, 255)
        for s in f['segs']:
            vis[s['y0'], :, :] = (0, 160, 255)
            vis[s['y1'] - 1, :, :] = (0, 160, 255)
        Image.fromarray(np.concatenate([f['img'], vis], axis=1)).save(os.path.join(out, 'mask_last.png'))
        fa, fb = frames[-2], frames[-1]
        k = sorted(align(fa['segs'], fb['segs']), key=lambda r: r[1])[0][0]
        rows = []
        for i in range(min(10, min(len(fa['segs']), len(fb['segs'])) - k)):
            sa, sb = fa['segs'][i + k], fb['segs'][i]
            h = max(sa['y1'] - sa['y0'], sb['y1'] - sb['y0'])

            def strip(fr, s):
                im = fr['img'][s['y0']:s['y0'] + h, :]
                mk = np.zeros((im.shape[0], im.shape[1], 3), np.uint8)
                mm = s['mask'][:im.shape[0]]
                mk[:mm.shape[0]][mm] = (255, 255, 255)
                return np.concatenate([im, mk], axis=1)
            left, right = strip(fa, sa), strip(fb, sb)
            hh = min(left.shape[0], right.shape[0])
            rows.append(np.concatenate([left[:hh], np.full((hh, 8, 3), (255, 0, 255), np.uint8), right[:hh]], axis=1))
            rows.append(np.full((3, rows[-1].shape[1], 3), 60, np.uint8))
        v = np.concatenate(rows, axis=0)
        Image.fromarray(v).resize((v.shape[1] * 2, v.shape[0] * 2), Image.NEAREST).save(os.path.join(out, 'align_last.png'))
        print(f'obrazki: {out}')


if __name__ == '__main__':
    main()
