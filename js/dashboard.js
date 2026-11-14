// Dashboard jako komponent: ten sam układ (kafelki, wykresy, łupy, dziennik) w dwóch instancjach,
// "Aktualna sesja" (żywa, dopisywane zdarzenia) i "Historia sesji" (tylko odczyt zapisanych sesji).
(() => {
const { $, fmt, cssVar } = L2GL;

/** Tworzy instancję dashboardu w kontenerze `root`, który zawiera sklonowany szablon #dashTpl. */
function create(root) {
  const panel = { root, charts: {}, view: { session: null, events: [], live: false }, renderTimer: null };
  panel.q = id => root.querySelector(`[data-id="${id}"]`);
  panel.q('logFilter').addEventListener('change', () => redrawLog(panel));
  // przycisk rozszerzania w prawym górnym rogu każdego wykresu; rozszerzony może być tylko jeden
  const charts = root.querySelector('.charts');
  for (const sec of charts.querySelectorAll(':scope > section')) {
    const b = document.createElement('button');
    b.className = 'chart-expand'; b.type = 'button'; b.title = 'Rozszerz wykres'; b.textContent = '⤢';
    b.addEventListener('click', () => {
      const was = sec.classList.contains('expanded');
      for (const s of charts.querySelectorAll(':scope > section')) s.classList.remove('expanded');
      if (!was) sec.classList.add('expanded');
      charts.classList.toggle('has-expanded', !was);
      b.title = was ? 'Rozszerz wykres' : 'Zwiń wykres';
      for (const c of Object.values(panel.charts)) c.resize();
    });
    sec.prepend(b);
  }
  return panel;
}

async function setView(panel, sessionId, live) {
  panel.view.session = sessionId;
  panel.view.live = !!live;
  panel.view.events = sessionId ? await L2GL.db.eventsOf(sessionId) : [];
  panel.unknownN = -1;
  redrawLog(panel);
  scheduleRender(panel, true);
}

/** Dopisuje zdarzenia tylko do żywego widoku; historia nigdy nie dostaje nowych danych. */
function addEvents(panel, events) {
  if (!panel.view.live) return;
  for (const ev of events) { panel.view.events.push(ev); renderEvent(panel, ev); }
  scheduleRender(panel);
}

/** Lista zapisanych sesji do pola wyboru (bez sesji `exclude`, czyli tej, która właśnie trwa). */
async function fillSessionList(select, exclude) {
  const list = (await L2GL.db.sessions()).filter(s => s.id !== exclude).sort((a, b) => b.start - a.start);
  const prev = select.value;
  select.innerHTML = '';
  if (!list.length) select.append(new Option('brak zapisanych sesji', ''));
  for (const s of list) {
    const d = new Date(s.start);
    select.append(new Option(`${d.toLocaleDateString('pl-PL')} ${d.toLocaleTimeString('pl-PL', { hour: '2-digit', minute: '2-digit' })} · ${fmt.dur(s.end - s.start)} · ${s.count} zdarzeń`, s.id));
  }
  if (prev && [...select.options].some(o => o.value === prev)) select.value = prev;
  return select.value;
}

function scheduleRender(panel, now) {
  if (panel.root.closest('[hidden]')) return;
  if (now) { clearTimeout(panel.renderTimer); panel.renderTimer = null; render(panel); return; }
  if (!panel.renderTimer) panel.renderTimer = setTimeout(() => { panel.renderTimer = null; render(panel); }, 1500);
}

function render(panel) {
  const { view, q } = panel, evs = view.events, running = view.live && L2GL.ocr.state.running;
  const start = evs.length ? evs[0].ts : (view.session ? Date.parse(view.session) : 0);
  const end = running ? Date.now() : (evs.length ? evs[evs.length - 1].ts : start);
  const durMin = Math.max((end - start) / 60000, 1 / 60);
  let dmg = 0, hits = 0, crit = 0, dmgIn = 0, exp = 0, sp = 0, adena = 0, items = 0;
  const byTarget = new Map(), bySource = new Map(), loot = new Map(), kills = new Map();
  const samples = { dmg: [], dmgIn: [], exp: [], sp: [] }; // punkty {ts, v} do średnich kroczących
  let lastTarget = null, lastTargetTs = 0, killsTotal = 0;
  const shotsPerUse = Math.max(1, parseInt($('shotsPerUse').value, 10) || 1);
  for (const ev of evs) {
    const f = ev.fields || {};
    if (ev.type === 'dmg_dealt' && f.dmg) {
      dmg += f.dmg; hits++; samples.dmg.push({ ts: ev.ts, v: f.dmg });
      if (f.target) { byTarget.set(f.target, (byTarget.get(f.target) || 0) + f.dmg); lastTarget = f.target; lastTargetTs = ev.ts; }
    }
    if (ev.type === 'crit') crit++;
    if (ev.type === 'dmg_received' && f.dmg) { dmgIn += f.dmg; samples.dmgIn.push({ ts: ev.ts, v: f.dmg }); if (f.src) bySource.set(f.src, (bySource.get(f.src) || 0) + f.dmg); }
    if (ev.type === 'exp') {
      if (f.exp) {
        exp += f.exp; samples.exp.push({ ts: ev.ts, v: f.exp });
        // Gra nie ogłasza śmierci potwora, ale każdy zabity daje jeden komunikat o XP: zaliczamy go ostatnio bitemu celowi.
        if (lastTarget && ev.ts - lastTargetTs < 15000) { kills.set(lastTarget, (kills.get(lastTarget) || 0) + 1); killsTotal++; lastTarget = null; }
      }
      if (f.sp) { sp += f.sp; samples.sp.push({ ts: ev.ts, v: f.sp }); }
    }
    if (ev.type === 'item') {
      const qty = f.qty || 1;
      if ((f.item || '').toLowerCase() === 'adena') adena += qty; else items += qty;
      const l = loot.get(f.item || '?') || { qty: 0, n: 0 }; l.qty += qty; l.n++; loot.set(f.item || '?', l);
    }
    if (ev.type === 'shot' && f.item) {
      // zużyte shoty: ujemna ilość w łupach, tyle na użycie, ile ustawiono dla broni
      const l = loot.get(f.item) || { qty: 0, n: 0 }; l.qty -= shotsPerUse; l.n++; loot.set(f.item, l);
    }
  }
  q('tDur').textContent = view.session ? fmt.dur(end - start) : '–';
  q('tDmg').textContent = fmt.n(dmg); q('tDpm').textContent = fmt.n(dmg / durMin); q('tHits').textContent = fmt.n(hits);
  q('tCrit').textContent = hits ? Math.round(100 * crit / hits) + '%' : '0%';
  q('tDmgIn').textContent = fmt.n(dmgIn); q('tExp').textContent = fmt.n(exp); q('tExpH').textContent = fmt.n(exp / durMin * 60);
  q('tSp').textContent = fmt.n(sp); q('tAdena').textContent = fmt.n(adena); q('tItems').textContent = fmt.n(items); q('tEvents').textContent = fmt.n(evs.length);
  q('tKills').textContent = fmt.n(killsTotal);

  const tb = q('loot').querySelector('tbody'); tb.innerHTML = '';
  for (const [item, l] of [...loot.entries()].sort((a, b) => b[1].qty - a[1].qty)) {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td></td><td class="num">${fmt.n(l.qty)}</td><td class="num">${l.n}</td>`;
    tr.firstChild.textContent = item; tb.append(tr);
  }

  renderUnknown(panel);

  const s = L2GL.ocr.state.stats;
  q('ocrStats').textContent = view.live && s.frames
    ? `Klatek: ${s.frames}, dopasowanych do poprzedniej: ${s.aligned}, niedopasowanych: ${s.unaligned}. Linii przeczytanych OCR: ${s.ocr}` + (s.ocr ? `, średnio ${Math.round(s.ocrMsTotal / s.ocr)} ms na linię, powtórnych odczytów: ${s.retries || 0}.` : '.')
    : '';

  if (typeof Chart === 'undefined') return;
  // Oś czasu co 10 s (dla długich sesji rzadziej); wartość w punkcie t = suma z ostatnich 2 minut przed t
  // podzielona przez 2, czyli średnia na minutę z dwóch ostatnich minut.
  const WINDOW = 120000;
  const span = Math.max(end - start, 60000);
  const step = Math.max(10000, Math.ceil(span / 600000) * 1000);
  const points = [];
  for (let t = start; t < start + span; t += step) points.push(t);
  points.push(start + span);
  const labels = points.map(t => fmt.dur(t - start));
  const rolling = key => {
    const arr = samples[key].slice().sort((a, b) => a.ts - b.ts);
    let lo = 0, hi = 0, sum = 0;
    return points.map(t => {
      while (hi < arr.length && arr[hi].ts <= t) { sum += arr[hi].v; hi++; }
      while (lo < hi && arr[lo].ts <= t - WINDOW) { sum -= arr[lo].v; lo++; }
      return Math.round(sum / (WINDOW / 60000));
    });
  };
  const ink = cssVar('--axis'), grid = cssVar('--grid'), s1 = cssVar('--s1'), s2 = cssVar('--s2'), s3 = cssVar('--s3'), s4 = cssVar('--s4');
  const base = { responsive: true, maintainAspectRatio: false, animation: false, interaction: { mode: 'index', intersect: false },
    scales: { x: { ticks: { color: ink, maxTicksLimit: 12 }, grid: { color: grid } }, y: { beginAtZero: true, ticks: { color: ink }, grid: { color: grid } } },
    plugins: { legend: { labels: { color: ink, boxWidth: 12 } } } };
  const single = { ...base, plugins: { legend: { display: false } } };
  const line = color => ({ borderColor: color, backgroundColor: color, borderWidth: 2, pointRadius: 0, pointHoverRadius: 5, tension: .2 });
  upsert(panel, 'chDmg', 'line', labels, [{ label: 'zadane', data: rolling('dmg'), ...line(s1) }, { label: 'otrzymane', data: rolling('dmgIn'), ...line(s2) }], base);
  upsert(panel, 'chExp', 'line', labels, [{ label: 'XP', data: rolling('exp'), ...line(s3) }], single);
  upsert(panel, 'chSp', 'line', labels, [{ label: 'SP', data: rolling('sp'), ...line(s4) }], single);
  const top = m => [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
  const hbar = { ...base, indexAxis: 'y', plugins: { legend: { display: false } }, scales: { x: { beginAtZero: true, ticks: { color: ink }, grid: { color: grid } }, y: { ticks: { color: ink }, grid: { display: false } } } };
  const targetLabel = name => kills.get(name) ? `${name} x${kills.get(name)}` : name;
  upsert(panel, 'chTargets', 'bar', top(byTarget).map(e => targetLabel(e[0])), [{ label: 'obrażenia', data: top(byTarget).map(e => e[1]), backgroundColor: s1, borderRadius: 3, borderSkipped: 'left' }], hbar);
  upsert(panel, 'chSources', 'bar', top(bySource).map(e => e[0]), [{ label: 'obrażenia', data: top(bySource).map(e => e[1]), backgroundColor: s2, borderRadius: 3, borderSkipped: 'left' }], hbar);
}

function upsert(panel, id, type, labels, datasets, options) {
  const c = panel.charts[id];
  if (c && c.config.type === type) {
    c.data.labels = labels;
    datasets.forEach((d, i) => { if (c.data.datasets[i]) Object.assign(c.data.datasets[i], d); else c.data.datasets.push(d); });
    c.data.datasets.length = datasets.length; c.options = options; c.update('none');
  } else {
    if (c) c.destroy();
    panel.charts[id] = new Chart(panel.q(id), { type, data: { labels, datasets }, options });
  }
}

/** Panel nierozpoznanych: zdarzenia bez typu albo z zastrzeżeniem (powód w polach), od najnowszych, z miniaturą linii. */
function renderUnknown(panel) {
  const list = panel.view.events.filter(e => e.type === 'other' || (e.fields && e.fields.reason));
  panel.q('unknownCount').textContent = list.length;
  if (panel.unknownN === list.length) return;
  panel.unknownN = list.length;
  const tb = panel.q('unknown').querySelector('tbody'), labels = L2GL.ocr.REASON_LABEL;
  tb.innerHTML = '';
  for (const ev of list.slice(-100).reverse()) {
    const f = ev.fields || {}, tr = document.createElement('tr');
    const why = (labels[f.reason] || f.reason || '') + (f.wouldBe ? ` (byłoby: ${f.wouldBe})` : '') + (f.ocr !== undefined ? `, OCR ${f.ocr}` : '');
    tr.innerHTML = '<td class="t"></td><td></td><td></td><td class="txt"></td>';
    tr.children[0].textContent = new Date(ev.ts).toLocaleTimeString('pl-PL');
    if (ev.thumb) { const im = new Image(); im.src = ev.thumb; im.alt = ''; tr.children[1].append(im); }
    tr.children[2].textContent = why;
    tr.children[3].textContent = ev.text;
    tb.append(tr);
  }
}

/** Pola zdarzenia w dzienniku: bez id szablonu, identyfikatorów z bazy i pewności OCR; pewność szablonu tylko, gdy dopasowanie nie było dokładne. */
function fmtFields(f) {
  return Object.entries(f).filter(([k, v]) => !['id', 'ocr', 'color', 'wouldBe', 'badField'].includes(k) && !/Id$/.test(k) && (k !== 'conf' || v < 0.95)).map(([k, v]) => k === 'conf' ? `~${v}` : `${k}=${v}`).join(' ');
}
function renderEvent(panel, ev) {
  const filter = panel.q('logFilter').value;
  if (filter && ev.type !== filter) return;
  const el = document.createElement('div'); el.className = 'ev';
  const t = new Date(ev.ts);
  const idTag = ev.fields && ev.fields.id !== undefined ? ` <span class="t">#${ev.fields.id}</span>` : '';
  el.innerHTML = `<span class="t">${t.toLocaleTimeString('pl-PL')}.${String(t.getMilliseconds()).padStart(3, '0')}</span><span class="k ${ev.type}">${ev.type}${idTag}</span><span><span class="f"></span> <span class="txt"></span></span>`;
  el.querySelector('.f').textContent = fmtFields(ev.fields || {});
  el.querySelector('.txt').textContent = ev.text;
  const log = panel.q('log'); log.prepend(el);
  while (log.childElementCount > 500) log.lastChild.remove();
}
function redrawLog(panel) { panel.q('log').innerHTML = ''; for (const ev of panel.view.events.slice(-500)) renderEvent(panel, ev); }

L2GL.dashboard = { create, setView, addEvents, fillSessionList, scheduleRender, render, redrawLog };
})();
