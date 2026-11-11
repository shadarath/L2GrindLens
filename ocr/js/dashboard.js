// Dashboard: wybór sesji, kafelki, wykresy (Chart.js), tabela łupów, dziennik.
(() => {
const { $, fmt, cssVar } = L2GL;
const view = { session: null, events: [], live: false };
let renderTimer = null;
const charts = {};

async function setView(sessionId, liveSession) {
  view.session = sessionId;
  view.live = !!sessionId && sessionId === liveSession;
  view.events = sessionId ? await L2GL.db.eventsOf(sessionId) : [];
  redrawLog();
  scheduleRender(true);
}

async function refreshSessionList(liveSession) {
  const sel = $('sessionSel'), list = (await L2GL.db.sessions()).sort((a, b) => b.start - a.start);
  sel.innerHTML = '';
  if (!list.length) sel.append(new Option('brak zapisanych sesji', ''));
  for (const s of list) {
    const d = new Date(s.start);
    const lab = `${d.toLocaleDateString('pl-PL')} ${d.toLocaleTimeString('pl-PL', { hour: '2-digit', minute: '2-digit' })} · ${s.count} zdarzeń${s.id === liveSession ? ' (bieżąca)' : ''}`;
    sel.append(new Option(lab, s.id));
  }
  if (view.session) sel.value = view.session;
}

/** Zdarzenia z bieżącej klatki; do widoku trafiają, gdy oglądamy żywą sesję albo gdy to podgląd bez zapisu. */
function addEvents(events, persist) {
  if (persist && !view.live) return;
  for (const ev of events) { view.events.push(ev); renderEvent(ev); }
  scheduleRender();
}

function scheduleRender(now) {
  if ($('tab3').hidden) return;
  if (now) { clearTimeout(renderTimer); renderTimer = null; render(); return; }
  if (!renderTimer) renderTimer = setTimeout(() => { renderTimer = null; render(); }, 1500);
}

function render() {
  const evs = view.events, running = L2GL.ocr.state.running;
  const start = evs.length ? evs[0].ts : (view.live && view.session ? Date.parse(view.session) : 0);
  const end = view.live && running ? Date.now() : (evs.length ? evs[evs.length - 1].ts : start);
  const durMin = Math.max((end - start) / 60000, 1 / 60);
  let dmg = 0, hits = 0, crit = 0, dmgIn = 0, exp = 0, sp = 0, adena = 0, items = 0;
  const byTarget = new Map(), bySource = new Map(), loot = new Map(), bins = new Map();
  const binOf = ev => Math.floor((ev.ts - start) / 60000);
  for (const ev of evs) {
    const f = ev.fields || {}, b = bins.get(binOf(ev)) || { dmg: 0, dmgIn: 0, exp: 0 };
    if (ev.type === 'dmg_dealt' && f.dmg) { dmg += f.dmg; hits++; b.dmg += f.dmg; if (f.target) byTarget.set(f.target, (byTarget.get(f.target) || 0) + f.dmg); }
    if (ev.type === 'crit') crit++;
    if (ev.type === 'dmg_received' && f.dmg) { dmgIn += f.dmg; b.dmgIn += f.dmg; if (f.src) bySource.set(f.src, (bySource.get(f.src) || 0) + f.dmg); }
    if (ev.type === 'exp') { if (f.exp) { exp += f.exp; b.exp += f.exp; } if (f.sp) sp += f.sp; }
    if (ev.type === 'item') {
      const q = f.qty || 1;
      if ((f.item || '').toLowerCase() === 'adena') adena += q; else items += q;
      const l = loot.get(f.item || '?') || { qty: 0, n: 0 }; l.qty += q; l.n++; loot.set(f.item || '?', l);
    }
    bins.set(binOf(ev), b);
  }
  $('tDur').textContent = fmt.dur(end - start);
  $('tDmg').textContent = fmt.n(dmg); $('tDpm').textContent = fmt.n(dmg / durMin); $('tHits').textContent = fmt.n(hits);
  $('tCrit').textContent = hits ? Math.round(100 * crit / hits) + '%' : '0%';
  $('tDmgIn').textContent = fmt.n(dmgIn); $('tExp').textContent = fmt.n(exp); $('tExpH').textContent = fmt.n(exp / durMin * 60);
  $('tSp').textContent = fmt.n(sp); $('tAdena').textContent = fmt.n(adena); $('tItems').textContent = fmt.n(items); $('tEvents').textContent = fmt.n(evs.length);

  const tb = $('loot').querySelector('tbody'); tb.innerHTML = '';
  for (const [item, l] of [...loot.entries()].sort((a, b) => b[1].qty - a[1].qty)) {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td></td><td class="num">${fmt.n(l.qty)}</td><td class="num">${l.n}</td>`;
    tr.firstChild.textContent = item; tb.append(tr);
  }

  const s = L2GL.ocr.state.stats;
  $('ocrStats').textContent = s.ocr ? `OCR: ${s.frames} klatek pobranych, ${s.ocr} rozpoznanych, średnio ${Math.round(s.ocrMsTotal / s.ocr)} ms na klatkę.` : '';

  if (typeof Chart === 'undefined') return;
  const nBins = Math.max(1, Math.min(240, Math.ceil(durMin)));
  const labels = Array.from({ length: nBins }, (_, i) => `${i}'`);
  const series = key => labels.map((_, i) => (bins.get(i) || {})[key] || 0);
  const ink = cssVar('--axis'), grid = cssVar('--grid'), s1 = cssVar('--s1'), s2 = cssVar('--s2'), s3 = cssVar('--s3');
  const base = { responsive: true, maintainAspectRatio: false, animation: false, interaction: { mode: 'index', intersect: false },
    scales: { x: { ticks: { color: ink, maxTicksLimit: 12 }, grid: { color: grid } }, y: { beginAtZero: true, ticks: { color: ink }, grid: { color: grid } } },
    plugins: { legend: { labels: { color: ink, boxWidth: 12 } } } };
  const line = color => ({ borderColor: color, backgroundColor: color, borderWidth: 2, pointRadius: 0, pointHoverRadius: 5, tension: .2 });
  upsert('chDmg', 'line', labels, [{ label: 'zadane', data: series('dmg'), ...line(s1) }, { label: 'otrzymane', data: series('dmgIn'), ...line(s2) }], base);
  upsert('chExp', 'bar', labels, [{ label: 'XP', data: series('exp'), backgroundColor: s3, borderRadius: 3, borderSkipped: 'bottom' }], { ...base, plugins: { legend: { display: false } } });
  const top = m => [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
  const hbar = { ...base, indexAxis: 'y', plugins: { legend: { display: false } }, scales: { x: { beginAtZero: true, ticks: { color: ink }, grid: { color: grid } }, y: { ticks: { color: ink }, grid: { display: false } } } };
  upsert('chTargets', 'bar', top(byTarget).map(e => e[0]), [{ label: 'obrażenia', data: top(byTarget).map(e => e[1]), backgroundColor: s1, borderRadius: 3, borderSkipped: 'left' }], hbar);
  upsert('chSources', 'bar', top(bySource).map(e => e[0]), [{ label: 'obrażenia', data: top(bySource).map(e => e[1]), backgroundColor: s2, borderRadius: 3, borderSkipped: 'left' }], hbar);
}

function upsert(id, type, labels, datasets, options) {
  const c = charts[id];
  if (c && c.config.type === type) {
    c.data.labels = labels;
    datasets.forEach((d, i) => { if (c.data.datasets[i]) Object.assign(c.data.datasets[i], d); else c.data.datasets.push(d); });
    c.data.datasets.length = datasets.length; c.options = options; c.update('none');
  } else {
    if (c) c.destroy();
    charts[id] = new Chart($(id), { type, data: { labels, datasets }, options });
  }
}

function fmtFields(f) { return Object.entries(f).filter(([k]) => k !== 'id').map(([k, v]) => `${k}=${v}`).join(' '); }
function renderEvent(ev) {
  const filter = $('logFilter').value;
  if (filter && ev.type !== filter) return;
  const el = document.createElement('div'); el.className = 'ev';
  const t = new Date(ev.ts);
  const idTag = ev.fields && ev.fields.id !== undefined ? ` <span class="t">#${ev.fields.id}</span>` : '';
  el.innerHTML = `<span class="t">${t.toLocaleTimeString('pl-PL')}.${String(t.getMilliseconds()).padStart(3, '0')}</span><span class="k ${ev.type}">${ev.type}${idTag}</span><span></span>`;
  el.lastChild.textContent = (fmtFields(ev.fields || {}) ? fmtFields(ev.fields) + '  ' : '') + ev.text;
  const log = $('log'); log.prepend(el);
  while (log.childElementCount > 500) log.lastChild.remove();
}
function redrawLog() { $('log').innerHTML = ''; for (const ev of view.events.slice(-500)) renderEvent(ev); }

L2GL.dashboard = { view, setView, refreshSessionList, addEvents, scheduleRender, render, redrawLog };
})();
