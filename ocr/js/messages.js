// Klasyfikacja linii: szablony z bazy komunikatów (systemmsg.js) + wzorce zapasowe.
(() => {
const NUM = "[0-9OolI|,.]+";

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
};

const DEFAULT_PATTERNS = [
  { type: "dmg_dealt",    regex: "^(?<src>[A-Za-z0-9_]+) has inflicted (?<dmg>" + NUM + ") damage on (?<target>.+?)[.,]?$" },
  { type: "dmg_received", regex: "^(?<target>[A-Za-z0-9_]+) has received (?<dmg>" + NUM + ") damage from (?<src>.+?)[.,]?$" },
  { type: "exp",          regex: "^You have acquired (?<exp>" + NUM + ") XP(?: and (?<sp>" + NUM + ") SP)?" },
  { type: "dmg_dealt",    regex: "^You hit (?:for )?(?<dmg>" + NUM + ") damage" },
  { type: "dmg_received", regex: "^(?<src>.+?) hit you for (?<dmg>" + NUM + ") damage" },
  { type: "exp",          regex: "^You have earned (?<exp>" + NUM + ") experience(?: and (?<sp>" + NUM + ") SP)?" },
  { type: "item",         regex: "^You have earned (?<qty>" + NUM + ") (?<item>.+?)[.,]?$" },
  { type: "item",         regex: "^You have earned (?<item>.+?)[.,]?$" },
  { type: "crit",         regex: "^Critical hit" },
  { type: "block",        regex: "shield defense has succeeded" },
  { type: "item",         regex: "^You have obtained (?<qty>" + NUM + ") (?<item>.+?)[.,]?$" },
  { type: "item",         regex: "^You have obtained (?<item>.+?)[.,]?$" },
  { type: "skill",        regex: "^You use (?<skill>.+?)[.,]?$" },
  { type: "cooldown",     regex: "re-use time" },
  { type: "miss",         regex: "^You have missed|has evaded|^You avoided|attack has failed" },
];

// Typowe pomyłki OCR w słowach kluczowych (rn czytane jako m itp.)
const OCR_FIXES = [
  [/\beamed\b/g, 'earned'], [/\bdarnage\b/g, 'damage'], [/\bobtamed\b/g, 'obtained'],
  [/\binfl[1i]cted\b/g, 'inflicted'], [/\brece[1i]ved\b/g, 'received'], [/\bacqu[1i]red\b/g, 'acquired'],
  [/\b5P\b/g, 'SP'], [/\bX[Pp]\b/g, 'XP'], [/\b(\d+)\s*5P\b/g, '$1 SP'],
];

const templates = [], tplIndex = new Map(), candCache = new Map();
let patterns = [];
const opts = { useDb: true, playerName: '' };

function toNum(v) {
  const s = v.replace(/[oO]/g, '0').replace(/[lI|]/g, '1').replace(/[^0-9]/g, '');
  return s ? parseInt(s, 10) : null;
}

function build(dbm) {
  const escape = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  for (const [idStr, raw] of Object.entries(dbm)) {
    if (/<br>|<font|\$s\d\$|^\$[sc]\d\.?$/.test(raw)) continue;
    const text = raw.trim().replace(/\s+/g, ' ').replace(/[.!]$/, '');
    const parts = text.split(/(\$[sc]\d)/), seen = new Set();
    let literal = 0, phCount = 0, src = '^';
    for (const part of parts) {
      if (/^\$[sc]\d$/.test(part)) {
        const name = part.slice(1); phCount++;
        src += seen.has(name) ? '(.+?)' : `(?<${name}>.+?)`;
        seen.add(name);
      } else if (part) {
        literal += part.replace(/\s/g, '').length;
        src += escape(part).replace(/ /g, '\\s+');
      }
    }
    if (literal < 4) continue;
    src += '\\s*[.,!]?$';
    let re;
    try { re = new RegExp(src, 'i'); } catch (e) { continue; }
    const first = /^[A-Za-z]/.test(text) ? text.split(/\s+/)[0].toLowerCase().replace(/[^a-z]/g, '') : '*';
    const t = { id: +idStr, re, literal, phCount, first };
    templates.push(t);
    if (!tplIndex.has(first)) tplIndex.set(first, []);
    tplIndex.get(first).push(t);
  }
  for (const list of tplIndex.values()) list.sort((a, b) => b.literal - a.literal || b.phCount - a.phCount);
  return templates.length;
}

function candidates(line) {
  const first = line.split(/\s+/)[0].toLowerCase().replace(/[^a-z]/g, '');
  let cands = candCache.get(first);
  if (!cands) {
    cands = (tplIndex.get(first) || []).concat(tplIndex.get('*') || []);
    cands.sort((a, b) => b.literal - a.literal || b.phCount - a.phCount);
    candCache.set(first, cands);
  }
  return cands;
}

/** Pierwszy szablon pasujący do linii (bez walidacji pól), do testów. */
function match(line) {
  for (const t of candidates(line)) { const m = t.re.exec(line); if (m) return { id: t.id, groups: m.groups || {} }; }
  return null;
}

/**
 * Zdarzenie z dopasowania do szablonu albo null, gdy pole liczbowe nie jest liczbą
 * (np. "You have obtained $s2 $s1." dopasowane do "Necklace of Anguish Chain"): wtedy próbujemy następny szablon.
 */
function fromTemplate(m) {
  const def = MSG_TYPES[m.id], fields = { id: m.id };
  let type = 'msg';
  if (def) {
    type = def[0];
    for (const [name, ph] of Object.entries(def[1])) {
      const v = ph.startsWith('=') ? ph.slice(1) : m.groups[ph];
      if (v === undefined) continue;
      if (/^(dmg|exp|sp|qty)$/.test(name)) {
        if (!/^[0-9OolI|,.]+$/.test(v.trim())) return null;
        fields[name] = toNum(v);
        if (fields[name] === null) return null;
      } else {
        fields[name] = v.trim();
      }
    }
    const me = (opts.playerName || '').trim().toLowerCase();
    if (me) {
      if (type === 'dmg_dealt' && fields.src && fields.src.toLowerCase() !== me) type = 'dmg_other';
      if (type === 'dmg_received' && fields.target && fields.target.toLowerCase() !== me) type = 'dmg_other';
    }
  } else {
    for (const [k, v] of Object.entries(m.groups)) if (v !== undefined) fields[k] = v.trim();
  }
  return { type, fields };
}

/** Kompiluje wzorce zapasowe z JSON; zwraca null albo komunikat błędu. */
function compilePatterns(text) {
  try {
    patterns = JSON.parse(text).map(p => ({ type: p.type, re: new RegExp(p.regex, 'i') }));
    return null;
  } catch (e) { return e.message; }
}

function classify(text) {
  if (opts.useDb && templates.length) {
    for (const t of candidates(text)) {
      const m = t.re.exec(text);
      if (!m) continue;
      const r = fromTemplate({ id: t.id, groups: m.groups || {} });
      if (r) return r;
    }
  }
  for (const p of patterns) {
    const m = p.re.exec(text);
    if (!m) continue;
    const fields = {};
    for (const [k, v] of Object.entries(m.groups || {})) { if (v === undefined) continue; fields[k] = /^(dmg|exp|sp|qty)$/.test(k) ? toNum(v) : v.trim(); }
    return { type: p.type, fields };
  }
  return { type: 'other', fields: {} };
}

L2GL.messages = { MSG_TYPES, DEFAULT_PATTERNS, OCR_FIXES, opts, build, match, classify, compilePatterns, toNum, count: () => templates.length };
})();
