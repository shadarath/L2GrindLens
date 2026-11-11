"""Wyciąga pary (id, tekst) z próbek OCR okna "System Msg" (ocr/samples/*.txt),
poprawia typowe pomyłki OCR w placeholderach, zapisuje systemmsg_reborn.tsv
i buduje ../systemmsg.js = baza L2J (systemmsg.tsv) nadpisana wpisami z serwera.

Użycie: python extract_samples.py
"""
import glob
import json
import os
import re
from collections import defaultdict

here = os.path.dirname(os.path.abspath(__file__))
samples_dir = os.path.join(here, '..', 'samples')

# Poprawki OCR ograniczone do placeholderów i kilku słów; kolejność ma znaczenie.
END = r'(?![A-Za-z0-9])'
FIXES = [
    (r'\$s[lI1]is\b', '$s1 is'),                                   # "$slis" -> "$s1 is"
    (r'\$s[lI]1\b', '$s1'),                                        # "$sl1's" -> "$s1's"
    (r'[$%¢]\s?s\s?[lI!\]i]' + END, '$s1'),                        # $sl, $s!, $s], %s1, ¢s1 -> $s1
    (r'[$%¢]\s?s\s?5\s?([1-4])' + END, r'$s\1'),                  # $51, $s51 -> $s1
    (r'\$5([1-4])' + END, r'$s\1'),
    (r'[$%¢]\s?c\s?[lI!\]i]' + END, '$c1'),                        # $cl, $ci -> $c1
    (r'\$c\s?([1-4])' + END, r'$c\1'),
    (r'\$s(?=\s+has\b)', '$s1'),                                   # "$s has delivered" -> "$s1 has delivered"
    (r'\bexpel a dan\b', 'expel a clan'),
    (r'\s+\|\s*$', ''),                                            # pionowa kreska z krawędzi okna
]
MIN_ID_LINES = 2   # próbka z okna System Msg ma wiele linii "id tekst"; próbki z czatu gry (0-1 takich linii) są pomijane
LINE = re.compile(r'^\s*(\d{1,4})\s+(\S.*)$')


def clean(text):
    t = text.strip()
    for rx, rep in FIXES:
        t = re.sub(rx, rep, t)
    return re.sub(r'\s{2,}', ' ', t).strip()


def suspicious(t):
    """Im więcej znaków spoza zwykłego tekstu, tym gorsza wersja."""
    return len(re.findall(r'[^\w\s$%().,:;!?\'"<>/#+\-\[\]=&]', t)) + t.count('...')


def raw_sections():
    for path in sorted(glob.glob(os.path.join(samples_dir, '*.txt'))):
        txt = open(path, encoding='utf-8').read()
        m = re.search(r'## Surowy wynik OCR\n(.*?)\n## Linie po czyszczeniu', txt, re.S)
        if m:
            yield os.path.basename(path), m.group(1)


candidates = defaultdict(list)   # id -> [(text, source)]
used = 0
for name, raw in raw_sections():
    found = []
    for line in raw.split('\n'):
        m = LINE.match(line)
        if not m:
            continue
        text = clean(m.group(2))
        words = [w for w in re.findall(r'[A-Za-z]{3,}', text)]
        if len(words) < 2:
            continue
        found.append((int(m.group(1)), text))
    if len(found) < MIN_ID_LINES:
        continue
    used += 1
    for mid, text in found:
        candidates[mid].append((text, name))
print(f'próbek z okna System Msg: {used}')

# Wpisy z poprzednich uruchomień (systemmsg_reborn.tsv) zostają, nawet jeśli próbki już usunięto.
prev_tsv = os.path.join(here, 'systemmsg_reborn.tsv')
if os.path.exists(prev_tsv):
    for line in open(prev_tsv, encoding='utf-8'):
        if line.startswith('#') or line.count('\t') < 3:
            continue
        i, t, _status, src = line.rstrip('\n').split('\t', 3)
        for s in src.split(';'):
            candidates[int(i)].append((t, s))

# Wybór najlepszej wersji: nieucięta ("..."), najmniej podejrzanych znaków, najczęstsza.
chosen = {}
for mid, items in candidates.items():
    counts = defaultdict(int)
    for t, _ in items:
        counts[t] += 1
    best = min(counts, key=lambda t: (t.endswith('...'), suspicious(t), -counts[t], -len(t)))
    chosen[mid] = (best, sorted({s for t, s in items if t == best}))

# Baza L2J
base = {}
for line in open(os.path.join(here, 'systemmsg.tsv'), encoding='utf-8'):
    if line.startswith('#') or '\t' not in line:
        continue
    i, t = line.rstrip('\n').split('\t', 1)
    base[int(i)] = t

out_tsv = os.path.join(here, 'systemmsg_reborn.tsv')
with open(out_tsv, 'w', encoding='utf-8', newline='\n') as f:
    f.write('# id\ttekst\tstatus względem bazy L2J\tźródło (próbka OCR okna System Msg)\n')
    for mid in sorted(chosen):
        text, sources = chosen[mid]
        if mid not in base:
            status = 'nowy'
        elif base[mid] == text:
            status = 'taki sam'
        else:
            status = 'inny'
        if text.endswith('...'):
            status += ', ucięty w oknie'
        f.write(f'{mid}\t{text}\t{status}\t{";".join(sources)}\n')

merged = dict(base)
for mid, (text, _) in chosen.items():
    if not text.endswith('...'):
        merged[mid] = text

with open(os.path.join(here, '..', 'systemmsg.js'), 'w', encoding='utf-8', newline='\n') as f:
    f.write('// Komunikaty systemowe Lineage 2: baza L2J High Five nadpisana wpisami z klienta serwera (data/systemmsg_reborn.tsv).\n')
    f.write('// Wygenerowane przez data/extract_samples.py\n')
    f.write('window.L2_SYSTEMMSG = ' + json.dumps({str(i): merged[i] for i in sorted(merged)}, ensure_ascii=False, indent=0) + ';\n')

new = [m for m in chosen if m not in base]
diff = [m for m in chosen if m in base and base[m] != chosen[m][0]]
print(f'z próbek: {len(chosen)} komunikatów, nowych: {len(new)}, innych niż w L2J: {len(diff)}, baza po scaleniu: {len(merged)}')
for m in sorted(diff):
    print(f'  {m}\n    L2J:    {base[m]}\n    serwer: {chosen[m][0]}')
