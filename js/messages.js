// Klasyfikacja linii z OCR: dopasowanie do szablonów komunikatów (systemmsg.js) odległością edycyjną,
// w której placeholdery pochłaniają dowolny fragment, a typowe pomyłki OCR kosztują mniej niż zwykły błąd.
// Potem kanonizacja pól do słowników bazy gry (gamedata.js): nazwa przedmiotu, potwora i umiejętności
// pochodzi z bazy, nigdy z OCR, więc jeden przedmiot to jedna pozycja.
(() => {

// id komunikatu -> [typ zdarzenia, mapowanie pól: nazwa -> placeholder lub "=stała"]
const MSG_TYPES = {
  35: ['dmg_dealt', { dmg: 's1' }], 36: ['dmg_received', { src: 'c1', dmg: 's2' }],
  2261: ['dmg_dealt', { src: 'c1', dmg: 's3', target: 'c2' }], 2281: ['dmg_dealt', { src: 'c1', dmg: 's3', target: 'c2' }],
  5176: ['dmg_dealt', { src: 's1', dmg: 's3', target: 's2' }],
  2262: ['dmg_received', { target: 'c1', dmg: 's3', src: 'c2' }], 2263: ['dmg_received', { target: 'c1', dmg: 's3', src: 'c2' }],
  2270: ['dmg_received', { target: 'c1', dmg: 's2' }], 5177: ['dmg_received', { target: 's1', dmg: 's3', src: 's2' }],
  1027: ['dmg_pet', { dmg: 's2', src: 'c1' }], 1130: ['dmg_dealt', { dmg: 's1' }],
  45: ['exp', { exp: 's1' }], 95: ['exp', { exp: 's1', sp: 's2' }], 3259: ['exp', { exp: 's1', sp: 's3' }],
  6011: ['exp', { exp: 's1', sp: 's2' }], 331: ['exp', { sp: 's1' }], 362: ['exp', { exp: 's1' }], 1014: ['exp_pet', { exp: 's1' }],
  28: ['item', { qty: 's1', item: '=Adena' }], 29: ['item', { qty: 's2', item: 's1' }], 30: ['item', { item: 's1' }],
  52: ['item', { qty: 's1', item: '=Adena' }], 53: ['item', { qty: 's2', item: 's1' }], 54: ['item', { item: 's1' }],
  277: ['item', { item: 's1' }], 369: ['item', { item: 's2' }], 1666: ['item', { item: 's2' }], 3073: ['item', { qty: 's2', item: 's1' }],
  299: ['item_party', { who: 'c1', qty: 's3', item: 's2' }], 300: ['item_party', { who: 'c1', item: 's2' }],
  1379: ['item_party', { who: 'c1', qty: 's2', item: '=Adena' }], 1661: ['item_party', { who: 'c1', qty: 's3', item: 's2' }],
  // łup ze spoila ("... by using sweeper."): pole spoil; gdy $c1 to gracz, zdarzenie staje się jego własnym łupem (item)
  608: ['item_party', { who: 'c1', qty: 's3', item: 's2', spoil: '=1' }], 609: ['item_party', { who: 'c1', item: 's2', spoil: '=1' }],
  343: ['sweep_fail', {}], 683: ['sweep_fail', {}],
  44: ['crit', {}], 2266: ['crit', { src: 'c1' }], 1017: ['crit_pet', {}], 1028: ['crit_pet', {}], 1280: ['crit', {}],
  43: ['miss', {}], 2264: ['miss', { who: 'c1', src: 'c2' }], 2265: ['miss', { src: 'c1' }], 2268: ['miss', { src: 'c1' }], 158: ['miss', {}],
  2267: ['resist', { who: 'c1', src: 'c2' }], 2269: ['resist', { who: 'c1', src: 'c2' }], 2271: ['resist', { who: 'c1', src: 'c2' }],
  111: ['block', {}], 1281: ['block', {}],
  46: ['skill', { skill: 's1' }], 47: ['skill', { skill: 's1' }], 48: ['cooldown', { skill: 's1' }], 2303: ['cooldown', { skill: 's1', sec: 's2' }],
  27: ['cast_fail', {}], 748: ['cast_fail', {}], 1299: ['cast_fail', { who: 'c1' }],
  22: ['range', {}], 2193: ['range', {}], 23: ['resource', { what: '=HP' }], 24: ['resource', { what: '=MP' }],
  112: ['resource', { what: '=arrows' }], 129: ['inventory', {}], 422: ['inventory', {}],
  55: ['pickup_fail', { qty: 's1', item: '=Adena' }], 56: ['pickup_fail', { item: 's1' }], 57: ['pickup_fail', { qty: 's2', item: 's1' }],
  96: ['level_up', {}], 2344: ['death', { src: 'c1' }],
  936: ['shot', { item: 's1' }],   // "Use $s1." - zużycie soulshotów/spiritshotów, w łupach jako ujemna ilość
  9001: ['msg', {}],
};
// Komunikaty spoza bazy klienta (identyfikatory od 9001), dopisywane do szablonów przy budowie.
const EXTRA_MSG = {
  9001: 'You have played for $s1 hour(s). Please take a break.',
};

// ---------- koszty pomyłek OCR ----------
// Zamiana znaku na inny kosztuje 1; w obrębie par mylonych przez OCR 0.3; znaki interpunkcyjne między sobą 0.2.
// Brakujący lub dodatkowy znak kosztuje 1, spacja 0.3. Pary dwuznakowe: "m" czytane jako "rn" i odwrotnie itp.
const CONF = 0.3, PUNCT = 0.2, GAP = 1, GAP_SPACE = 0.3;
const PAIRS = ['o0', 'l1', 'li', 'l|', 'l!', 'i1', 'ij', '1|', 's5', 'b8', 'ec', 'ao', 'ag', 'gq', 'uv', 'vy', 'yj', 'nh', 'tf', 'lt', 'np', 'pg', 'eg', 'z2', 'cg', 'oe', 'hb', 'rt', 'ft', 'nu'];
const MULTI = [['m', 'rn'], ['n', 'ri'], ['d', 'cl'], ['h', 'li'], ['w', 'vv'], ['h', 'fr'], ['m', 'ni']];
const confSet = new Set();
for (const p of PAIRS) { confSet.add(p); confSet.add(p[1] + p[0]); }
const isPunct = ch => !/[a-z0-9 ]/.test(ch);
function sub(a, b) {
  if (a === b) return 0;
  if (confSet.has(a + b)) return CONF;
  if (isPunct(a) && isPunct(b)) return PUNCT;
  if (isPunct(a) || isPunct(b)) return 0.6;
  return 1;
}

/**
 * Koszt dopasowania wzorca (lista jednostek: { c } znak literalny albo { ph } placeholder) do tekstu.
 * Placeholder pochłania co najmniej jeden znak za darmo. Zwraca { cost, ops, W } albo null, gdy koszt
 * przekracza `bound` (wtedy liczenie jest przerywane wcześniej). `ops` (gdy trace) służy do odtworzenia,
 * które znaki tekstu pochłonął każdy placeholder.
 */
function align(units, text, bound, trace) {
  const T = units.length, L = text.length, W = L + 1;
  const D = new Float64Array((T + 1) * W).fill(Infinity);
  const ops = trace ? new Uint8Array((T + 1) * W) : null;
  D[0] = 0;
  for (let i = 0; i <= T; i++) {
    const row = i * W, nrow = row + W, u = i < T ? units[i] : null, prevPh = i > 0 && !!units[i - 1].ph;
    let rowMin = Infinity;
    for (let j = 0; j <= L; j++) {
      if (j > 0) {   // dodatkowy znak w tekście; po placeholderze darmowy, bo to on go pochłania
        const c = D[row + j - 1] + (prevPh ? 0 : (text[j - 1] === ' ' ? GAP_SPACE : GAP));
        // przy remisie placeholder woli ciągnąć się dalej niż zacząć później: wtedy "$s2 $s1" dzieli
        // "3 Animal Bone" na "3" i "Animal Bone", a nie na "3 Animal" i "Bone"
        if (c < D[row + j] || (c === D[row + j] && prevPh)) { D[row + j] = c; if (ops) ops[row + j] = 3; }
      }
      const base = D[row + j];
      if (base < rowMin) rowMin = base;
      if (base === Infinity || u === null) continue;
      if (u.ph) {
        if (j < L && base < D[nrow + j + 1]) { D[nrow + j + 1] = base; if (ops) ops[nrow + j + 1] = 1; }   // początek placeholdera
        continue;
      }
      const cDel = base + (u.c === ' ' ? GAP_SPACE : GAP);   // znak wzorca, którego OCR nie oddał
      if (cDel < D[nrow + j]) { D[nrow + j] = cDel; if (ops) ops[nrow + j] = 2; }
      if (j >= L) continue;
      const cSub = base + sub(u.c, text[j]);
      if (cSub < D[nrow + j + 1]) { D[nrow + j + 1] = cSub; if (ops) ops[nrow + j + 1] = 1; }
      for (const [one, two] of MULTI) {
        if (u.c === one && j + 1 < L && text[j] === two[0] && text[j + 1] === two[1]) {
          const c = base + CONF; if (c < D[nrow + j + 2]) { D[nrow + j + 2] = c; if (ops) ops[nrow + j + 2] = 4; }
        }
        if (u.c === two[0] && text[j] === one && i + 1 < T && !units[i + 1].ph && units[i + 1].c === two[1]) {
          const c = base + CONF, k = nrow + W + j + 1; if (c < D[k]) { D[k] = c; if (ops) ops[k] = 5; }
        }
      }
    }
    if (rowMin > bound) return null;
  }
  const cost = D[T * W + L];
  return cost > bound ? null : { cost, ops, W };
}

/** Odtwarza z `ops` fragmenty tekstu pochłonięte przez placeholdery: { nazwa: tekst }. */
function groupsOf(units, text, { ops, W }) {
  const parts = units.map(() => []);
  let i = units.length, j = text.length;
  while (i > 0 || j > 0) {
    const op = ops[i * W + j];
    if (op === 1) { i--; j--; if (units[i].ph) parts[i].push(text[j]); }
    else if (op === 2) { i--; }
    else if (op === 3) { j--; if (i > 0 && units[i - 1].ph) parts[i - 1].push(text[j]); }
    else if (op === 4) { i--; j -= 2; }
    else if (op === 5) { i -= 2; j--; }
    else break;
  }
  const groups = {};
  units.forEach((u, k) => { if (u.ph) groups[u.ph] = parts[k].reverse().join('').trim(); });
  return groups;
}

/** Zwykła odległość Levenshteina krótkich słów (do zawężania kandydatów). */
function lev(a, b) {
  const m = a.length, n = b.length;
  if (!m) return n; if (!n) return m;
  let prev = new Array(n + 1), cur = new Array(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    cur[0] = i;
    for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    [prev, cur] = [cur, prev];
  }
  return prev[n];
}
const tol = w => w.length <= 3 ? 1 : w.length <= 6 ? 2 : 3;

/** Tekst do porównań: pojedyncze spacje, bez końcowej interpunkcji; małe litery, chyba że keepCase. */
function normText(s, keepCase) { const t = s.replace(/\s+/g, ' ').replace(/[\s.,;:!]+$/, '').trim(); return keepCase ? t : t.toLowerCase(); }
/** Klucz słownika: tylko litery i cyfry, więc "Spiritshot: No Grade" i "Spiritshot - No Grade" są tym samym. */
function normKey(s) { return s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(); }
const unitsOf = s => Array.from(s).map(c => ({ c }));
/** Histogram znaków klucza (a-z, 0-9, spacja): tanie dolne ograniczenie kosztu edycji przed pełnym liczeniem. */
function histOf(key) {
  const h = new Uint8Array(37);
  for (const ch of key) { const c = ch.charCodeAt(0); h[c >= 97 ? c - 97 : c >= 48 && c <= 57 ? 26 + c - 48 : 36]++; }
  return h;
}
function histGap(a, b) { let d = 0; for (let i = 0; i < 37; i++) d += Math.abs(a[i] - b[i]); return d / 2; }

// ---------- szablony komunikatów ----------
const templates = [], candCache = new Map();
let anchored = [];      // szablony zaczynające się od placeholdera (kandydaci po słowie kotwicznym)
const opts = { playerName: '' };
const ACCEPT = 0.25;   // maksymalny koszt na literę stałą szablonu
/** Dopuszczalny koszt dopasowania: krótkie szablony (np. "Use $s1") prawie bez błędów, długie do ACCEPT na literę. */
const acceptCost = literal => literal < 6 ? 0.5 : literal < 10 ? 1 : literal < 20 ? 0.2 * literal : ACCEPT * literal;

function build(dbm) {
  templates.length = 0; candCache.clear();
  for (const [idStr, raw] of Object.entries({ ...EXTRA_MSG, ...dbm })) {
    if (/<br>|<font|\$s\d\$|^\$[sc]\d\.?$/.test(raw)) continue;
    const text = normText(raw);
    const parts = text.split(/(\$[sc]\d)/), seen = new Set(), units = [];
    let literal = 0, ok = true;
    for (const part of parts) {
      if (/^\$[sc]\d$/.test(part)) {
        const name = part.slice(1);
        if (seen.has(name)) { ok = false; break; }
        seen.add(name); units.push({ ph: name });
      } else if (part) {
        literal += part.replace(/\s/g, '').length;
        for (const c of part) units.push({ c });
      }
    }
    if (!ok || literal < 3) continue;   // "Use $s1." ma tylko 3 litery stałe, a jest potrzebne (zużycie shotów)
    // słowa do zawężania kandydatów: dwa pierwsze słowa, gdy szablon zaczyna się od tekstu;
    // inaczej pierwsze stałe słowo o co najmniej 4 literach (np. "inflicted" w "$c1 has inflicted ...")
    const lead = units[0].ph ? [] : text.split(' ').slice(0, 2).filter(w => !w.startsWith('$'));
    const anchor = lead.length ? null : (text.replace(/\$[sc]\d/g, ' ').split(/\s+/).find(w => w.replace(/[^a-z]/g, '').length >= 4) || null);
    templates.push({ id: +idStr, text, units, literal, phCount: seen.size, lead, anchor: anchor && anchor.replace(/[^a-z0-9']/g, '') });
  }
  templates.sort((a, b) => b.literal - a.literal || b.phCount - a.phCount);
  anchored = templates.filter(t => !t.lead.length);
  return templates.length;
}

/** Kandydaci dla linii: szablony o zgodnych dwóch pierwszych słowach (z pamięcią) plus zakotwiczone w dowolnym słowie. */
function candidates(text) {
  const words = text.split(' '), key = words.slice(0, 2).join(' ');
  let lead = candCache.get(key);
  if (!lead) {
    lead = templates.filter(t => t.lead.length && t.lead.every((w, k) => words[k] !== undefined && lev(w, words[k]) <= tol(w)));
    if (candCache.size > 500) candCache.clear();
    candCache.set(key, lead);
  }
  const byAnchor = anchored.filter(t => !t.anchor || words.some(w => lev(t.anchor, w) <= tol(t.anchor)));
  return lead.concat(byAnchor).filter(t => t.literal <= text.length + 4);
}

/**
 * Szablony pasujące do linii, od najlepszego: [{ id, cost, norm, groups }]. Przyjmowane są dopasowania
 * o koszcie do acceptCost; szablony wyraźnie gorsze od najlepszego są pomijane w trakcie. Przy podobnym
 * koszcie na literę wygrywa szablon z większą liczbą liter stałych ("You have obtained $s1 Adena" przed
 * "$s1 Adena", który pochłonąłby całą linię).
 */
function matches(line) {
  const text = normText(line), out = [];
  let orig = normText(line, true);
  if (orig.length !== text.length) orig = text;
  let bestNorm = Infinity;
  for (const t of candidates(text)) {
    const bound = Math.min(acceptCost(t.literal), (bestNorm + 0.1) * t.literal);
    const r = align(t.units, text, bound, true);
    if (!r) continue;
    const norm = r.cost / t.literal;
    if (norm < bestNorm) bestNorm = norm;
    out.push({ id: t.id, cost: r.cost, norm, literal: t.literal, score: norm - t.literal / 200, groups: groupsOf(t.units, orig, r) });
  }
  return out.filter(m => m.norm <= bestNorm + 0.1).sort((a, b) => a.score - b.score);
}

/** Najlepszy szablon dla linii (bez walidacji pól), do testów z konsoli. */
function match(line) { return matches(line)[0] || null; }

// ---------- słowniki bazy gry ----------
const dicts = { items: [], monsters: [], skills: [] };
let gd = null;
const ctx = { recentMonsters: [], recentDrops: new Set() };   // kontekst: ostatnio spotkane potwory i ich tabele dropu

function buildDicts(data) {
  gd = data || null;
  for (const k of Object.keys(dicts)) dicts[k] = [];
  if (!gd) return 0;
  const add = (list, id, name) => { const key = normKey(name || ''); if (key) list.push({ id: +id, name, key, units: unitsOf(key), hist: histOf(key) }); };
  for (const [id, v] of Object.entries(gd.items || {})) add(dicts.items, id, v[0]);
  for (const [id, v] of Object.entries(gd.monsters || {})) add(dicts.monsters, id, v[0]);
  for (const [id, v] of Object.entries(gd.skills || {})) add(dicts.skills, id, v);
  for (const list of Object.values(dicts)) list.exact = new Map(list.map(e => [e.key, e]));
  return dicts.items.length + dicts.monsters.length + dicts.skills.length;
}

/**
 * Najbliższa nazwa ze słownika: { id, name, norm } albo null. Koszt edycyjny z pomyłkami OCR podzielony
 * przez długość dłuższej nazwy; przyjmowane do 0.25. Przedmioty z tabel dropu ostatnio spotkanych potworów
 * mają niewielką premię, więc przy dwóch podobnych nazwach wygrywa ta, która może tu wypaść.
 */
/**
 * Dopasowanie nazwy nie może zamieniać całych słów: "Adamantite Ore" (przedmiot questowy, spoza bazy) wychodziło jako
 * "Adamantite Ring" z kosztem 0.22, bo długi wspólny przedrostek rozmywa koszt całkiem innego słowa. Każde słowo musi
 * mieć odpowiednik na tej samej pozycji w granicach tolerancji literówek; inna liczba słów (sklejone albo rozbite
 * przez OCR) przechodzi tylko przy bardzo bliskim dopasowaniu całości.
 */
const CLOSE = 0.12;
function wordsAgree(q, key) {
  const a = q.split(' '), b = key.split(' ');
  return a.length === b.length && a.every((w, i) => lev(w, b[i]) <= tol(w));
}
function canon(value, dictName) {
  const list = dicts[dictName];
  if (!list || !list.length) return null;
  const q = normKey(value);
  if (!q) return null;
  const ex = list.exact.get(q);
  if (ex) return { id: ex.id, name: ex.name, norm: 0 };
  const boost = dictName === 'items' ? ctx.recentDrops : null, qh = histOf(q), qu = unitsOf(q);
  let best = null, bestScore = ACCEPT;
  const slack = Math.max(3, Math.round(q.length * 0.35));
  for (const e of list) {
    if (Math.abs(e.key.length - q.length) > slack) continue;
    const len = Math.max(e.key.length, q.length), bonus = boost && boost.has(e.id) ? 0.06 : 0, bound = (bestScore + bonus) * len;
    if (histGap(e.hist, qh) * CONF > bound) continue;   // każdy niepasujący znak kosztuje co najmniej CONF
    const r = align(e.units, q, bound, false);
    if (!r) continue;
    const score = r.cost / len - bonus;
    if (score < bestScore && (r.cost / len <= CLOSE || wordsAgree(q, e.key))) { bestScore = score; best = { id: e.id, name: e.name, norm: r.cost / len }; }
  }
  return best;
}

/** Zapamiętuje spotkanego potwora; jego drop i spoil stają się kontekstem dla kanonizacji łupów. */
function noteMonster(id) {
  if (ctx.recentMonsters[0] === id) return;
  ctx.recentMonsters = [id, ...ctx.recentMonsters.filter(m => m !== id)].slice(0, 5);
  ctx.recentDrops = new Set();
  for (const m of ctx.recentMonsters) for (const table of [gd.drops, gd.spoils]) for (const d of (table && table[m]) || []) ctx.recentDrops.add(d[0]);
}

// ---------- pola ----------
/**
 * Liczba z fragmentu OCR po poprawieniu typowych pomyłek (O->0, l->1, S->5, B->8); null, gdy to nie liczba.
 * Samotna dziewiątka w czcionce czatu czyta się jako "©" (albo "@" przy zakazie "©"): sprawdzone przez wstawienie
 * glifów 0-8 w to samo miejsce, wszystkie czytają się poprawnie, więc "©" i "@" oznaczają 9.
 */
function toNum(v) {
  const s = v.trim().replace(/[©@]/g, '9').replace(/[oOQ]/g, '0').replace(/[lI|!]/g, '1').replace(/[sS$]/g, '5').replace(/B/g, '8').replace(/[zZ]/g, '2').replace(/[,.\s]/g, '');
  return /^\d+$/.test(s) ? parseInt(s, 10) : null;
}

const NAME_CHARS = /^[A-Za-z][A-Za-z0-9 .,'’:+\-()]*$/;
/**
 * Czy tekst wygląda jak nazwa (przedmiotu, umiejętności, postaci): zwykłe znaki, co najmniej trzy litery,
 * bez jednoznakowych śmieci z OCR ("55 t", "-1 -", "TD 5] (4") i bez słów XP/SP. Dla wartości spoza słowników.
 */
function validName(v) {
  if (!NAME_CHARS.test(v)) return false;
  if (/\b(XP|SP)\b/.test(v)) return false;
  if ((v.match(/[A-Za-z]/g) || []).length < 3) return false;
  return v.split(/\s+/).every(t => t.replace(/[^A-Za-z0-9]/g, '').length >= 2 || /^\+?\d+$/.test(t) || /^[-:]$/.test(t));
}

const NUM_FIELDS = /^(dmg|exp|sp|qty|sec)$/, OPTIONAL_NUM = /^(sp|sec)$/, NAME_FIELDS = /^(item|skill|src|target|who)$/;
const DICT_FOR = { item: 'items', skill: 'skills', src: 'monsters', target: 'monsters' };   // who (łup drużyny) to gracz: bez słownika

/** Czy wartość to imię gracza (z tolerancją na pomyłki OCR). */
function isPlayer(v) {
  const me = normKey(opts.playerName || '');
  if (!me) return false;
  const q = normKey(v);
  return !!align(unitsOf(me), q, 0.34 * Math.max(me.length, q.length), false);
}

/**
 * Zdarzenie z dopasowania do szablonu albo null, gdy pole liczbowe nie jest liczbą (np. "You have obtained
 * $s2 $s1." z "Necklace of Anguish Chain" jako ilością) albo nazwa spoza słownika wygląda na śmieci:
 * wtedy próbowany jest następny szablon. Nazwy ze słowników są podmieniane na nazwy z bazy (plus pole *Id).
 */
function fromMatch(m) {
  const def = MSG_TYPES[m.id], fields = { id: m.id };
  let type = 'msg';
  if (def) {
    type = def[0];
    for (const [name, ph] of Object.entries(def[1])) {
      const v = ph.startsWith('=') ? ph.slice(1) : m.groups[ph];
      if (v === undefined || v === '') continue;
      if (NUM_FIELDS.test(name)) {
        fields[name] = toNum(v);
        if (fields[name] === null) {
          if (!OPTIONAL_NUM.test(name)) return null;
          // pole poboczne (SP przy XP, sekundy odnowienia) nieczytelne: zdarzenie zostaje, z zastrzeżeniem
          delete fields[name]; fields.reason = 'bad_number'; fields.badField = name;
        }
      } else if (NAME_FIELDS.test(name)) {
        if (name !== 'item' && name !== 'skill' && isPlayer(v)) { fields[name] = opts.playerName.trim(); continue; }
        const c = canon(v, DICT_FOR[name]);
        if (c) { fields[name] = c.name; fields[name + 'Id'] = c.id; if (DICT_FOR[name] === 'monsters') noteMonster(c.id); }
        else if (name === 'item' && canon(v, 'skills')) {
          // "You have earned Weapon Mastery.": ten sam szablon co zdobycie przedmiotu, ale nazwa jest umiejętnością
          const sk = canon(v, 'skills'); fields.skill = sk.name; fields.skillId = sk.id; type = 'msg';
        } else if (name === 'skill' && canon(v, 'items')) {
          // "You use Scroll of Escape.": ten sam szablon co użycie umiejętności, ale nazwa jest przedmiotem
          const it = canon(v, 'items'); fields.item = it.name; fields.itemId = it.id; type = 'use_item';
        } else {
          if (!validName(v)) return null;
          fields[name] = v;
          if (name === 'item' || name === 'skill') fields.reason = 'unknown_' + name;   // zdarzenie zostaje, ale trafia też do "nierozpoznanych"
        }
      } else fields[name] = v;
    }
    const me = (opts.playerName || '').trim();
    if (me) {
      if (type === 'dmg_dealt' && fields.src && fields.src !== me) type = 'dmg_other';
      if (type === 'dmg_received' && fields.target && fields.target !== me) type = 'dmg_other';
      if (type === 'item_party' && fields.spoil && fields.who === me) { type = 'item'; delete fields.who; }
    }
  } else {
    for (const [k, v] of Object.entries(m.groups)) if (v) fields[k] = v;
  }
  fields.conf = +(1 - m.norm).toFixed(2);
  return { type, fields };
}

/**
 * Zdarzenie dla linii: { type, fields } albo { type: 'other', fields, reason } z powodem odrzucenia
 * (no_template: żaden szablon nie pasuje, bad_fields: pasuje, ale pola nie przechodzą walidacji).
 * Dopasowanie z nazwą spoza bazy (fields.reason = unknown_item/unknown_skill) ustępuje innemu bez zastrzeżeń.
 */
function classify(text) {
  if (templates.length) {
    const ms = matches(text);
    let flagged = null;
    for (const m of ms) {
      const r = fromMatch(m);
      if (!r) continue;
      if (!r.fields.reason) return r;
      if (!flagged) flagged = r;
    }
    if (flagged) return flagged;
    if (ms.length) return { type: 'other', fields: { id: ms[0].id }, reason: 'bad_fields' };
  }
  return { type: 'other', fields: {}, reason: 'no_template' };
}

L2GL.messages = { MSG_TYPES, opts, ctx, build, buildDicts, match, matches, canon, classify, toNum, validName, count: () => templates.length };
})();
