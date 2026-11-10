"""Wyciąga komunikaty systemowe z SystemMessageId.java (L2J Mobius, High Five)
do systemmsg.tsv (id<TAB>tekst, format --msgs sniffera) i ../systemmsg.js (dla strony OCR)."""
import json
import os
import re

here = os.path.dirname(os.path.abspath(__file__))
src = open(os.path.join(here, 'SystemMessageId.java'), encoding='utf-8').read()
rx = re.compile(r'@ClientString\(id = (\d+), message = "((?:[^"\\]|\\.)*)"\)')

msgs = {}
for m in rx.finditer(src):
    mid = int(m.group(1))
    text = m.group(2).replace('\\"', '"').replace('\\\\', '\\')
    msgs.setdefault(mid, text)

ids = sorted(msgs)
with open(os.path.join(here, 'systemmsg.tsv'), 'w', encoding='utf-8', newline='\n') as f:
    f.write('# id\ttekst (źródło: L2J Mobius CT 2.6 High Five, SystemMessageId.java)\n')
    for i in ids:
        f.write(f'{i}\t{msgs[i]}\n')

with open(os.path.join(here, '..', 'systemmsg.js'), 'w', encoding='utf-8', newline='\n') as f:
    f.write('// Komunikaty systemowe Lineage 2 (High Five), id -> szablon. Wygenerowane przez data/extract_systemmsg.py\n')
    f.write('window.L2_SYSTEMMSG = ' + json.dumps({str(i): msgs[i] for i in ids}, ensure_ascii=False, indent=0) + ';\n')

print('komunikatów:', len(ids), 'zakres id:', ids[0], '-', ids[-1])
