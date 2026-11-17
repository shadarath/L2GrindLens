// Dashboard jako komponent: ten sam układ (kafelki, wykresy, łupy, dziennik) w dwóch instancjach,
// "Aktualna sesja" (żywa, dopisywane zdarzenia) i "Historia sesji" (tylko odczyt zapisanych sesji).
(() => {
const { $, fmt, cssVar, settings } = L2GL;
const WINDOWS = [[60000, '1 min'], [120000, '2 min'], [300000, '5 min'], [900000, '15 min'], [3600000, '1 h']];   // okna średniej kroczącej do wyboru przy wykresie
const PERIODS = [['łącznie', Infinity], ['ostatnia godzina', 3600000], ['ostatnie 10 min', 600000]];
const TL_BUCKETS = 300;   // punkty paska linii czasu
const TL_WINDOW = 60000;  // okno średniej kroczącej na pasku (jak wykresy: suma z ostatniej minuty przeliczona na godzinę)
const HOUR = 3600000;
const MARK_MULT = 3;      // znacznik Adeny: kwota co najmniej tyle razy mediana kwot Adeny w sesji
const MARK_MAX = 60;      // najwyżej tyle znaczników na pasku (przy nadmiarze zostają najcenniejsze)
const DEFAULT_WINDOW = 120000;

/** Tworzy instancję dashboardu w kontenerze `root`, który zawiera sklonowany szablon #dashTpl. */
function create(root) {
  const panel = { root, charts: {}, view: { session: null, events: [], live: false }, renderTimer: null, windows: settings.get('chartWindows', {}) };
  panel.q = id => root.querySelector(`[data-id="${id}"]`);
  panel.q('logFilter').addEventListener('change', () => redrawLog(panel));
  // przyciski w prawym górnym rogu każdego wykresu: rozszerzanie (tylko jeden naraz) i okno wygładzania
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
    const id = sec.querySelector('canvas').dataset.id;
    if (sec.dataset.rolling !== undefined) {
      const sel = document.createElement('select');
      sel.className = 'chart-window'; sel.title = 'Okno średniej kroczącej';
      for (const [ms, label] of WINDOWS) sel.append(new Option(label, ms));
      sel.value = panel.windows[id] || DEFAULT_WINDOW;
      sel.addEventListener('change', () => { panel.windows[id] = +sel.value; settings.set('chartWindows', panel.windows); scheduleRender(panel, true); });
      sec.prepend(sel);
    }
  }
  // pasek linii czasu z ramką zakresu: przeciąganie odświeża widok od razu (z ograniczeniem), puszczenie pełnym renderem
  const tlc = root.querySelector('[data-id=tl]');
  if (tlc && L2GL.timeline) {
    panel.tl = L2GL.timeline.create(tlc, { onChange: final => {
      if (final) { clearTimeout(panel.tlTimer); panel.tlTimer = null; scheduleRender(panel, true); }
      else if (!panel.tlTimer) panel.tlTimer = setTimeout(() => { panel.tlTimer = null; render(panel); }, 80);
    } });
    root.querySelector('[data-id=tlReset]').addEventListener('click', () => panel.tl.reset());
  }
  return panel;
}

async function setView(panel, sessionId, live) {
  panel.view.session = sessionId;
  panel.view.live = !!live;
  panel.view.events = sessionId ? await L2GL.db.eventsOf(sessionId) : [];
  panel.unknownN = -1;
  if (panel.tl) { panel.tl.mode = 'all'; panel.tl.drag = null; }   // nowa sesja w widoku: ramka na całość
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

/**
 * Nicki z OCR sprowadzone do najczęstszej pisowni: "Siu", "Sifu" i "Silu" to jeden gracz. Wejście: Map nick -> liczba
 * wystąpień; wyjście: Map nick -> reprezentant. Reprezentantem zostaje najczęstsza pisownia, kolejne dołączają,
 * gdy podobieństwo (Levenshtein) wynosi co najmniej 0.7.
 */
function canonNames(counts) {
  const reps = [], map = new Map();
  for (const [name] of [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))) {
    const rep = reps.find(r => L2GL.lines.sim(r, name) >= 0.7);
    if (rep) map.set(name, rep); else { reps.push(name); map.set(name, name); }
  }
  return map;
}

/** Adres przedmiotu na lineage2wiki.org (kronika C1): identyfikator decyduje, nazwa w adresie jest tylko dla czytelności. */
function wikiUrl(id, name) {
  const slug = (name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return `https://lineage2wiki.org/c1/item/${id}/${slug ? slug + '/' : ''}`;
}

/** Cena przedmiotu w Adenie: cena shota z ustawień, inaczej cena z bazy gry, inaczej 0 (przedmiot spoza bazy). */
function priceOf(f) {
  if (!f.itemId) return 0;
  const custom = settings.get('shotPrices', {})[f.itemId];
  if (custom !== undefined && custom !== '') return +custom || 0;
  const gd = window.L2_GAMEDATA, it = gd && gd.items[f.itemId];
  return it && it[3] ? +it[3] : 0;
}

function render(panel) {
  const { view, q } = panel, evs = view.events, running = view.live && L2GL.ocr.state.running;
  const start = evs.length ? evs[0].ts : (view.session ? Date.parse(view.session) : 0);
  const end = running ? Date.now() : (evs.length ? evs[evs.length - 1].ts : start);
  const durMin = Math.max((end - start) / 60000, 1 / 60);
  let dmg = 0, hits = 0, crit = 0, dmgIn = 0, exp = 0, sp = 0, adena = 0, items = 0, profit = 0;
  const byTarget = new Map(), bySource = new Map(), kills = new Map();
  const samples = { dmg: [], dmgIn: [], exp: [], sp: [], profit: [], profitTeam: [], adena: [] }; // punkty {ts, v} do średnich kroczących
  // zysk: mój (łupy minus shoty) i całej drużyny (mój plus łupy pozostałych; ich kosztów shotów nie widać w czacie)
  const addProfit = (ts, v, mine) => { if (!v) return; if (mine) { profit += v; samples.profit.push({ ts, v }); } samples.profitTeam.push({ ts, v }); };
  let lastTarget = null, lastTargetTs = 0, killsTotal = 0;
  const hitTs = [], critTs = [], killTs = [];   // znaczniki czasu do statystyk okresów
  const shotsPerUse = Math.max(1, parseInt($('shotsPerUse').value, 10) || 1);
  // łupy: właściciel ('' = ja, potem członkowie drużyny w kolejności pojawienia się) -> przedmiot -> {qty, n, value, itemId}
  const whoCounts = new Map();
  for (const ev of evs) if (ev.type === 'item_party' && ev.fields && ev.fields.who) whoCounts.set(ev.fields.who, (whoCounts.get(ev.fields.who) || 0) + 1);
  const nick = canonNames(whoCounts);
  const lootBy = new Map([['', new Map()]]);
  const lootEvents = [];   // własne łupy do znaczników na pasku: {ts, item, qty, value}
  const addLoot = (owner, f, qty) => {
    if (!lootBy.has(owner)) lootBy.set(owner, new Map());
    const m = lootBy.get(owner), key = f.item || '?';
    const l = m.get(key) || { qty: 0, n: 0, value: 0, itemId: f.itemId };
    l.qty += qty; l.n++; l.value += qty * priceOf(f); m.set(key, l);
    return l;
  };
  for (const ev of evs) {
    const f = ev.fields || {};
    if (ev.type === 'dmg_dealt' && f.dmg) {
      dmg += f.dmg; hits++; samples.dmg.push({ ts: ev.ts, v: f.dmg }); hitTs.push(ev.ts);
      if (f.target) { byTarget.set(f.target, (byTarget.get(f.target) || 0) + f.dmg); lastTarget = f.target; lastTargetTs = ev.ts; }
    }
    if (ev.type === 'crit') { crit++; critTs.push(ev.ts); }
    if (ev.type === 'dmg_received' && f.dmg) { dmgIn += f.dmg; samples.dmgIn.push({ ts: ev.ts, v: f.dmg }); if (f.src) bySource.set(f.src, (bySource.get(f.src) || 0) + f.dmg); }
    if (ev.type === 'exp') {
      if (f.exp) {
        exp += f.exp; samples.exp.push({ ts: ev.ts, v: f.exp });
        // Gra nie ogłasza śmierci potwora, ale każdy zabity daje jeden komunikat o XP: zaliczamy go ostatnio bitemu celowi.
        if (lastTarget && ev.ts - lastTargetTs < 15000) { kills.set(lastTarget, (kills.get(lastTarget) || 0) + 1); killsTotal++; killTs.push(ev.ts); lastTarget = null; }
      }
      if (f.sp) { sp += f.sp; samples.sp.push({ ts: ev.ts, v: f.sp }); }
    }
    if (ev.type === 'item') {
      const qty = f.qty || 1;
      if ((f.item || '').toLowerCase() === 'adena') { adena += qty; samples.adena.push({ ts: ev.ts, v: qty }); } else items += qty;
      addLoot('', f, qty);
      addProfit(ev.ts, qty * priceOf(f), true);
      lootEvents.push({ ts: ev.ts, item: f.item || '?', itemId: f.itemId, qty, value: qty * priceOf(f) });
    }
    if (ev.type === 'item_party' && f.who) {
      const qty = f.qty || 1; addLoot(nick.get(f.who) || f.who, f, qty);
      addProfit(ev.ts, qty * priceOf(f), false);
    }
    if (ev.type === 'shot' && f.item) {
      // zużyte shoty: ujemna ilość w łupach, tyle na użycie, ile ustawiono dla broni; koszt obniża zysk
      addLoot('', f, -shotsPerUse);
      addProfit(ev.ts, -shotsPerUse * priceOf(f), true);
    }
  }
  if (panel === L2GL.dashboard.current && $('sessionDur')) $('sessionDur').textContent = view.session ? fmt.dur(end - start) : '–';   // czas sesji w górnym pasku

  // pasek linii czasu: XP i zysk na godzinę z całej sesji, znaczniki drogich łupów, ramka zakresu
  const span0 = Math.max(end - start, 60000);
  let range = { from: start, to: end };
  if (panel.tl) {
    // średnia krocząca z minuty w TL_BUCKETS punktach, tak jak wykresy niżej (suma z okna przed punktem na godzinę)
    const bucket = (arr) => {
      const s = arr.slice().sort((a, b) => a.ts - b.ts), out = new Array(TL_BUCKETS);
      let lo = 0, hi = 0, sum = 0;
      for (let i = 0; i < TL_BUCKETS; i++) {
        const t = start + (i + 1) / TL_BUCKETS * span0;
        while (hi < s.length && s[hi].ts <= t) { sum += s[hi].v; hi++; }
        while (lo < hi && s[lo].ts <= t - TL_WINDOW) { sum -= s[lo].v; lo++; }
        out[i] = sum / (TL_WINDOW / HOUR);
      }
      return out;
    };
    // znaczniki: każdy przedmiot o wartości sprzedaży (bez questowych) i wyjątkowo duża Adena (kilkukrotność mediany
    // jej kwot); przy nadmiarze zostaje MARK_MAX najcenniejszych
    const isAdena = l => l.item.toLowerCase() === 'adena';
    const values = lootEvents.filter(isAdena).map(l => l.value).filter(v => v > 0).sort((a, b) => a - b);
    const median = values.length ? values[values.length >> 1] : 0, thr = median * MARK_MULT;
    const gd = window.L2_GAMEDATA;
    let marked = lootEvents.filter(l => l.value > 0 && (!isAdena(l) || (values.length > 2 && l.value >= thr)));
    if (marked.length > MARK_MAX) marked = marked.slice().sort((a, b) => b.value - a.value).slice(0, MARK_MAX);
    const markers = marked.map(l => ({ ts: l.ts, icon: l.itemId && gd && gd.items[l.itemId] ? gd.items[l.itemId][4] : null, label: `${new Date(l.ts).toLocaleTimeString('pl-PL')}: ${l.qty > 1 ? l.qty + ' × ' : ''}${l.item} (${fmt.n(l.value)} Adena)` }));
    panel.tl.setData({ start, end: start + span0, xp: bucket(samples.exp), profit: bucket(samples.profit), markers });
    range = panel.tl.advance();
    panel.tl.draw();
    const all = panel.tl.isAll();
    q('tlReset').hidden = all; q('pSel').hidden = all;
    q('tlInfo').textContent = all ? 'Zakres: cała sesja' : `Zakres: ${fmt.dur(range.from - start)} – ${fmt.dur(range.to - start)} (${fmt.dur(range.to - range.from)})`;
  }

  // panele okresów: zaznaczenie (gdy ramka nie obejmuje całości), cała sesja, ostatnia godzina, ostatnie 10 minut (od `end`);
  // średnie z faktycznie objętego czasu; w każdym dwie kolumny: średnie (XP/h, zysk/h, % krytyków) i ilości (XP, zysk, zabite potwory)
  const periodCells = (from, to) => {
    const hours = Math.max(to - from, 60000) / 3600000;
    const sum = arr => arr.reduce((s, x) => s + (x.ts >= from && x.ts <= to ? x.v : 0), 0), cnt = arr => arr.reduce((s, t) => s + (t >= from && t <= to ? 1 : 0), 0);
    const e = sum(samples.exp), p = sum(samples.profit), h = cnt(hitTs), c = cnt(critTs);
    return [[fmt.n(e / hours), 'XP / h'], [fmt.n(p / hours), 'zysk / h'], [(h ? Math.round(100 * c / h) : 0) + '%', 'krytyków'], [fmt.n(e), 'XP'], [fmt.n(p), 'zysk (Adena)'], [fmt.n(cnt(killTs)), 'zabitych potworów']];
  };
  const fillPeriod = (id, cells) => { const box = q(id); if (!box) return; box.innerHTML = ''; for (const [v, label] of cells) { const d = document.createElement('div'); d.className = 'stat'; d.innerHTML = '<b></b><span></span>'; d.children[0].textContent = v; d.children[1].textContent = label; box.append(d); } };
  PERIODS.forEach(([, win], i) => {
    fillPeriod('p' + i, periodCells(win === Infinity ? start : Math.max(start, end - win), end));
    // okres dłuższy niż sesja: wartości pokrywają się z całą sesją, panel wyszarzony
    const box = q('p' + i), sec = box && box.closest('.period'); if (sec) sec.classList.toggle('short', win !== Infinity && end - start < win);
  });
  if (panel.tl && !panel.tl.isAll()) fillPeriod('p3', periodCells(range.from, range.to));

  const tb = q('loot').querySelector('tbody'); tb.innerHTML = '';
  for (const [owner, m] of lootBy) {
    if (lootBy.size > 1) {   // nagłówki właścicieli tylko, gdy jest łup drużyny
      const total = [...m.values()].reduce((s, l) => s + l.value, 0);
      const tr = document.createElement('tr'); tr.className = 'owner';
      tr.innerHTML = '<th colspan="3"></th><th class="num"></th>';
      tr.children[0].textContent = owner ? owner : 'Ty'; tr.children[1].textContent = fmt.n(total);
      tb.append(tr);
    }
    // najpierw przedmioty z bazy (wg ilości), na końcu te spoza bazy (bez identyfikatora i ceny)
    for (const [item, l] of [...m.entries()].sort((a, b) => (!!b[1].itemId - !!a[1].itemId) || b[1].qty - a[1].qty)) {
      const tr = document.createElement('tr');
      tr.innerHTML = `<td></td><td class="num">${fmt.n(l.qty)}</td><td class="num">${l.n}</td><td class="num">${fmt.n(l.value)}</td>`;
      const icon = l.itemId && window.L2_GAMEDATA && window.L2_GAMEDATA.items[l.itemId] && window.L2_GAMEDATA.items[l.itemId][4];
      if (icon) { const im = new Image(); im.className = 'icon'; im.src = `img/items/${icon}.png`; im.alt = ''; im.onerror = () => im.remove(); tr.firstChild.append(im); }
      if (l.itemId) { const a = document.createElement('a'); a.href = wikiUrl(l.itemId, item); a.target = '_blank'; a.rel = 'noopener'; a.textContent = item; tr.firstChild.append(a); }
      else tr.firstChild.append(item);
      // miejsce w kategorii: plakietka klasy i rząd diamencików (po jednym na przedmiot w kategorii, od najlepszego), własny podświetlony;
      // receptura albo kluczowy składnik pokazuje kategorię swojego produktu
      const gd = window.L2_GAMEDATA, target = l.itemId && gd && gd.made && gd.made[l.itemId] || l.itemId;
      const rk = target && gd && gd.items[target] && gd.items[target][5], members = rk && gd.cats && gd.cats[rk[2]];
      if (members) {
        const grade = gd.items[target][2] || 'NG', weapon = members[0].length === 3;
        const via = target !== l.itemId ? `${/^Recipe/.test(item) ? 'receptura na' : 'składnik na'}: ${gd.items[target][0]}; ` : '';
        const tag = document.createElement('span'); tag.className = `grade g-${grade}`; tag.textContent = grade;
        tag.title = `${via}${rk[0]}. miejsce wśród ${rk[1]} w kategorii: ${rk[2]} (${weapon ? 'według P.Atk' : 'według ceny sklepowej; wiki nie podaje obrony'})`;
        const dots = document.createElement('span'); dots.className = 'dots';
        // diamenciki od najtańszego do najdroższego (przy tej samej cenie od słabszego)
        const price = m => (gd.items[m[0]] && gd.items[m[0]][3]) || 0;
        for (const m of [...members].sort((a, b) => price(a) - price(b) || (a[1] || 0) - (b[1] || 0))) {
          const d = document.createElement('i'); d.className = 'dot' + (m[0] === target ? ' me' : '');
          const it = gd.items[m[0]];
          d.title = it ? `${it[0]}: ${weapon ? `P.Atk ${m[1]}, M.Atk ${m[2]}, cena ${fmt.n(it[3])}` : `cena ${fmt.n(m[1])}`}` : '';
          dots.append(d);
        }
        tr.firstChild.append(' ', tag, ' ', dots);
      }
      tb.append(tr);
    }
  }

  renderUnknown(panel);

  const s = L2GL.ocr.state.stats;
  q('ocrStats').textContent = view.live && s.frames
    ? `Klatek: ${s.frames}, dopasowanych do poprzedniej: ${s.aligned}, niedopasowanych: ${s.unaligned}. Linii przeczytanych OCR: ${s.ocr}` + (s.ocr ? `, średnio ${Math.round(s.ocrMsTotal / s.ocr)} ms na linię, powtórnych odczytów: ${s.retries || 0}, w obserwacji: ${s.rereads || 0} (z obrazu minimum: ${s.minReads || 0}), poprawek wstecz: ${s.revisions || 0}, linii straconych bez odczytu: ${s.lost || 0}.` : '.')
    : '';

  if (typeof Chart === 'undefined') return;
  // Oś czasu co 10 s (dla długich sesji rzadziej); wartość w punkcie t = suma z okna przed t podzielona przez
  // długość okna w godzinach, czyli tempo na godzinę z ostatniej minuty, 2, 5, 15 minut albo godziny (wybór przy wykresie).
  // zakres osi czasu z ramki paska (domyślnie cała sesja); podpisy liczone od początku sesji
  const cFrom = range.from, span = Math.max(range.to - cFrom, 60000);
  const step = Math.max(10000, Math.ceil(span / 600000) * 1000);
  const points = [];
  for (let t = cFrom; t < cFrom + span; t += step) points.push(t);
  points.push(cFrom + span);
  const labels = points.map(t => fmt.dur(t - start));
  const windowOf = id => panel.windows[id] || DEFAULT_WINDOW;
  const rolling = (key, win) => {
    const arr = samples[key].slice().sort((a, b) => a.ts - b.ts);
    let lo = 0, hi = 0, sum = 0;
    return points.map(t => {
      while (hi < arr.length && arr[hi].ts <= t) { sum += arr[hi].v; hi++; }
      while (lo < hi && arr[lo].ts <= t - win) { sum -= arr[lo].v; lo++; }
      return Math.round(sum / (win / HOUR));
    });
  };
  const ink = cssVar('--axis'), grid = cssVar('--grid'), s1 = cssVar('--s1'), s2 = cssVar('--s2'), s3 = cssVar('--s3'), s4 = cssVar('--s4'), ok = cssVar('--ok'), xp = cssVar('--xp');   // XP zawsze fioletowe (wykres i pasek)
  const axis = extra => ({ ticks: { color: ink }, grid: { color: grid }, ...extra });
  const base = { responsive: true, maintainAspectRatio: false, animation: false, interaction: { mode: 'index', intersect: false },
    scales: { x: { ticks: { color: ink, maxTicksLimit: 12 }, grid: { color: grid } }, y: axis({ beginAtZero: true }) },
    plugins: { legend: { labels: { color: ink, boxWidth: 12 } } } };
  const line = color => ({ borderColor: color, backgroundColor: color, borderWidth: 2, pointRadius: 0, pointHoverRadius: 5, tension: .2 });
  // XP i SP na jednym wykresie: skala XP po lewej, SP po prawej
  const dual = { ...base, scales: { x: base.scales.x, y: axis({ beginAtZero: true, position: 'left', title: { display: true, text: 'XP', color: ink } }), y1: axis({ beginAtZero: true, position: 'right', title: { display: true, text: 'SP', color: ink }, grid: { drawOnChartArea: false } }) } };
  const wXp = windowOf('chExpSp');
  upsert(panel, 'chExpSp', 'line', labels, [{ label: 'XP', data: rolling('exp', wXp), yAxisID: 'y', ...line(xp) }, { label: 'SP', data: rolling('sp', wXp), yAxisID: 'y1', ...line(s4) }], dual);
  const wDmg = windowOf('chDmg');
  upsert(panel, 'chDmg', 'line', labels, [{ label: 'zadane', data: rolling('dmg', wDmg), ...line(s1) }, { label: 'otrzymane', data: rolling('dmgIn', wDmg), ...line(s2) }], base);
  // zysk może być ujemny (koszt shotów), więc oś bez przymusu zera, ale z zerem w zasięgu
  const profitOpts = { ...base, scales: { x: base.scales.x, y: axis({ beginAtZero: false, suggestedMin: 0, suggestedMax: 0 }) } };
  const wProfit = windowOf('chProfit');
  upsert(panel, 'chProfit', 'line', labels, [{ label: 'mój zysk', data: rolling('profit', wProfit), ...line(ok) }, { label: 'sama Adena', data: rolling('adena', wProfit), ...line(s4) }, { label: 'cała drużyna', data: rolling('profitTeam', wProfit), ...line(s2) }], profitOpts);
  // Obrażenia wg potwora na jednym wykresie: od środka w prawo zadane, w lewo otrzymane (wartości ujemne, podpisy bez znaku).
  const names = [...new Set([...byTarget.keys(), ...bySource.keys()])]
    .sort((a, b) => ((byTarget.get(b) || 0) + (bySource.get(b) || 0)) - ((byTarget.get(a) || 0) + (bySource.get(a) || 0))).slice(0, 8);
  const dealt = names.map(n => byTarget.get(n) || 0), received = names.map(n => -(bySource.get(n) || 0));
  const extent = Math.max(1, ...dealt, ...received.map(v => -v));
  const abs = v => fmt.n(Math.abs(v));
  const butterfly = { ...base, indexAxis: 'y',
    scales: { x: axis({ stacked: true, min: -extent, max: extent, ticks: { color: ink, precision: 0, callback: v => abs(v) } }), y: { stacked: true, ticks: { color: ink }, grid: { display: false } } },
    plugins: { legend: { labels: { color: ink, boxWidth: 12 } }, tooltip: { callbacks: { label: c => `${c.dataset.label}: ${abs(c.raw)}` } } } };
  const targetLabel = name => kills.get(name) ? `${name} x${kills.get(name)}` : name;
  upsert(panel, 'chMonsters', 'bar', names.map(targetLabel), [
    { label: 'zadane', data: dealt, backgroundColor: s1, borderRadius: 3, borderSkipped: 'left' },
    { label: 'otrzymane', data: received, backgroundColor: s2, borderRadius: 3, borderSkipped: 'right' },
  ], butterfly);
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
  const list = panel.view.events.filter(L2GL.isUnknown);
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
  return Object.entries(f).filter(([k, v]) => !['id', 'ocr', 'color', 'wouldBe', 'badField', 'rev', 'reads'].includes(k) && !/Id$/.test(k) && (k !== 'conf' || v < 0.95)).map(([k, v]) => k === 'conf' ? `~${v}` : `${k}=${v}`).join(' ');
}
const rows = new WeakMap();   // zdarzenie -> jego wiersz dziennika (do poprawek wstecz)
function fillRow(el, ev) {
  const t = new Date(ev.ts), f = ev.fields || {};
  const idTag = f.id !== undefined ? ` <span class="t">#${f.id}</span>` : '';
  const rev = f.rev ? ` <span class="t rev" title="poprawione wstecz (${f.rev}. poprawka, ${f.reads} odczytów linii)">↻${f.rev}</span>` : '';
  el.innerHTML = `<span class="t">${t.toLocaleTimeString('pl-PL')}.${String(t.getMilliseconds()).padStart(3, '0')}</span><span class="k ${ev.type}">${ev.type}${idTag}${rev}</span><span><span class="f"></span> <span class="txt"></span></span>`;
  el.querySelector('.f').textContent = fmtFields(f);
  el.querySelector('.txt').textContent = ev.text;
}
function renderEvent(panel, ev) {
  const filter = panel.q('logFilter').value;
  if (filter && ev.type !== filter) return;
  const el = document.createElement('div'); el.className = 'ev';
  fillRow(el, ev); rows.set(ev, el);
  const log = panel.q('log'); log.prepend(el);
  while (log.childElementCount > 500) log.lastChild.remove();
}
/** Zdarzenia poprawione wstecz (te same obiekty, zmieniona treść): odświeżenie wierszy dziennika i przeliczenie widoku. */
function updateEvents(panel, events) {
  if (!panel.view.live) return;
  for (const ev of events) { const el = rows.get(ev); if (el) fillRow(el, ev); }
  panel.unknownN = -1;   // panel nierozpoznanych odświeża się także, gdy liczba pozycji się nie zmieniła
  scheduleRender(panel);
}
function redrawLog(panel) { panel.q('log').innerHTML = ''; for (const ev of panel.view.events.slice(-500)) renderEvent(panel, ev); }

L2GL.dashboard = { create, setView, addEvents, updateEvents, fillSessionList, scheduleRender, render, redrawLog, priceOf, canonNames, wikiUrl };
})();
