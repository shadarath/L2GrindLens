// Potok: klatka -> maska tekstu -> linie z odciskami -> dopasowanie do poprzedniej klatki -> nowe linie
// (tylko sufiks) -> potwierdzenie w następnej klatce -> OCR każdej nowej linii (przy niskiej pewności
// powtórny odczyt w kolejnej klatce) -> klasyfikacja -> zdarzenia; co nie przeszło, zostaje jako "nierozpoznane".
(() => {
const { $, status } = L2GL;
const cap = L2GL.capture.state;
const THRESHOLD = 0.25;   // z analizy próbek: ta sama linia < 0.26, inne linie > 0.30
const CONF_OK = 85, WORD_OK = 70, MAX_READS = 3;   // pewność OCR: linia i najsłabsze słowo (0-100); liczba prób odczytu
// Powiększenie obrazu linii dla silnika: czcionka czatu ma 9 px, silnik chce liter ok. 20 px. Zmierzone na 37 liniach:
// x1 daje 5 odczytów innych niż x2 (fałszywe apostrofy, "9" jako "©"), x1.5 i x3 po 2, x2 zero; czas 24-37 ms na linię.
const SCALE = 2;
const FPS = 4;   // klatek na sekundę: maska i odciski kosztują kilka ms, OCR tylko nowych linii

const state = {
  worker: null, workerReady: false,
  running: false, busy: false, timer: null, autosaveTimer: null, liveTimer: null,
  session: null, sessionCount: 0,
  prevLines: null,    // linie z poprzedniej klatki (odciski), null = następna klatka jest punktem odniesienia
  pending: [],        // nowe linie czekające na potwierdzenie lub kolejny odczyt: {line, time, reads: [{text, conf, minWord}]}
  openTail: null,     // niedokończony komunikat (zawinięty), czeka na kontynuację
  last: null,
  stats: { frames: 0, ocr: 0, ocrMsTotal: 0, aligned: 0, unaligned: 0, retries: 0 },
};
const hooks = { onEvents: () => {}, onSessionStart: async () => {}, onSessionStop: () => {}, onFrame: () => {} };

const grab = document.createElement('canvas');      // wycinek 1:1
const lineCanvas = document.createElement('canvas'); // obraz linii dla silnika
const thumbCanvas = document.createElement('canvas'); // miniatura linii do panelu nierozpoznanych

function ensureWorker() {
  if (state.workerReady) return Promise.resolve();
  if (state.workerPromise) return state.workerPromise;   // trwające ładowanie: jedna instancja silnika, nie dwie
  if (typeof Tesseract === 'undefined') return Promise.reject(new Error('Biblioteka OCR nie została wczytana. Sprawdź połączenie z internetem.'));
  status('Wczytuję silnik OCR (za pierwszym razem kilkanaście MB)...');
  state.workerPromise = (async () => {
    try {
      state.worker = await Tesseract.createWorker('eng', 1, { logger: m => { if (m.status && m.progress !== undefined) status(`OCR: ${m.status} ${Math.round(m.progress * 100)}%`); } });
      await state.worker.setParameters({ tessedit_pageseg_mode: '7', preserve_interword_spaces: '1' });   // 7 = jedna linia tekstu
      state.workerReady = true;
      status('Silnik OCR gotowy.', 'ok');
    } finally { state.workerPromise = null; }
  })();
  return state.workerPromise;
}

const REASON_LABEL = {
  no_template: 'brak szablonu', bad_fields: 'pola nie pasują do szablonu', unknown_item: 'przedmiot spoza bazy',
  unknown_skill: 'umiejętność spoza bazy', bad_number: 'nieczytelna liczba w polu pobocznym', low_confidence: 'niska pewność OCR', fragment: 'fragment lub śmieć', empty: 'pusty odczyt',
};

/** Zamienia gotowe teksty linii na zdarzenia, zapisuje je i zgłasza do dashboardu. */
function emit(items) {
  const out = [];
  for (const it of items) {
    const c = it.reason ? { type: 'other', fields: {}, reason: it.reason } : L2GL.messages.classify(it.text);
    const fields = { ...c.fields, ocr: Math.round(it.conf) };
    let type = c.type;
    if (type === 'other') fields.reason = c.reason || 'no_template';
    // niska pewność OCR bez zgodnego drugiego odczytu: zdarzenie tylko, gdy szablon i pola pasują niemal dokładnie
    else if (it.low && !((fields.conf || 0) >= 0.9 && !fields.reason)) { fields.wouldBe = type; type = 'other'; fields.reason = 'low_confidence'; }
    if (it.line && it.line.color) fields.color = it.line.color;
    const ev = { session: state.session, ts: it.time.getTime(), time: it.time.toISOString(), text: it.text, type, fields };
    if (fields.reason && it.line) ev.thumb = L2GL.image.renderLine(it.line, 1, thumbCanvas).toDataURL('image/png');
    out.push(ev);
    state.sessionCount++;
    L2GL.db.add(ev).catch(e => status('Błąd zapisu zdarzenia: ' + e.message, 'bad'));
  }
  if (out.length) {
    L2GL.db.putSession({ id: state.session, start: Date.parse(state.session), end: Date.now(), count: state.sessionCount }).catch(() => {});
    hooks.onEvents(out);
  }
  return out;
}

/** OCR jednej linii z jej maski: { text, conf, minWord } (pewność linii i najsłabszego słowa, 0-100). */
async function readLine(line) {
  L2GL.image.renderLine(line, SCALE, lineCanvas);
  const t0 = performance.now();
  // Obraz przekazujemy jako data URL: podanie canvasu (toBlob w środku) kosztuje w Chrome ok. 1 s opóźnienia
  // na ponownie używanym canvasie, a samo rozpoznanie linii trwa 20-50 ms.
  const { data } = await state.worker.recognize(lineCanvas.toDataURL('image/png'));
  state.stats.ocr++; state.stats.ocrMsTotal += performance.now() - t0;
  const words = (data.words || []).filter(w => w.text.replace(/[^A-Za-z0-9]/g, '').length >= 2);
  return { text: data.text.replace(/\s+/g, ' ').trim(), conf: data.confidence || 0, minWord: words.length ? Math.min(...words.map(w => w.confidence)) : (data.confidence || 0) };
}

const isGood = r => r.conf >= CONF_OK && r.minWord >= WORD_OK;

/** Czy odczyty linii wystarczają: dobry odczyt, dwa zgodne albo wyczerpane próby. */
function settled(p) {
  const n = p.reads.length, last = p.reads[n - 1];
  return isGood(last) || (n >= 2 && p.reads[n - 2].text === last.text) || n >= MAX_READS;
}
/** Najlepszy odczyt oczekującej linii jako rekord do sklejania i klasyfikacji. */
function finalize(p) {
  const best = p.reads.reduce((a, b) => b.conf > a.conf ? b : a);
  const n = p.reads.length, agree = n >= 2 && p.reads[n - 2].text === p.reads[n - 1].text;
  return { text: best.text, conf: best.conf, minWord: best.minWord, reads: n, low: !isGood(best) && !agree, time: p.time, line: p.line };
}

/**
 * Odczyty nowych linii -> komunikaty. Zawinięty komunikat to linia bez kropki na końcu i kontynuacja w następnej;
 * kontynuacja może przyjść dopiero w kolejnej klatce, więc niedokończony ogon czeka w state.openTail.
 * Fragment bez poprzednika (śmieć z ikony, obcięta linia) wychodzi jako rekord z powodem.
 */
function assemble(records) {
  const out = [];
  const terminated = t => /[.!?,]$/.test(t);
  for (const r of records) {
    const c = L2GL.lines.cleanOne(r.text);
    if (!c) { out.push({ ...r, reason: 'empty' }); continue; }
    let item = { ...r, text: c.text };
    const fragment = c.words < 2 || /^[a-z]/.test(c.text) || c.text.split(' ').length <= 3;
    if (state.openTail) {
      const tail = state.openTail; state.openTail = null;
      if (fragment) item = { ...tail, text: tail.text + ' ' + c.text, conf: Math.min(tail.conf, r.conf), low: tail.low || r.low };
      else out.push(tail);
    } else if (c.words < 2) { out.push({ ...item, reason: 'fragment' }); continue; }
    if (!terminated(item.text)) state.openTail = item;
    else out.push(item);
  }
  return out;
}

/** Jedna klatka: linie z odciskami, dopasowanie do poprzedniej klatki, odczyt oczekujących, nowe do kolejki. */
async function processFrame(frameTime) {
  if (state.busy || !cap.source || !cap.region) return [];
  state.busy = true;
  try {
    state.stats.frames++;
    const img = L2GL.image.grabRegion(cap.source, cap.region, grab);
    const tm = L2GL.image.textMask(img);
    const lines = L2GL.image.segmentLines(tm);
    state.lastMask = tm; state.lastLines = lines;

    // 1. linie nowe w poprzednich klatkach, nadal widoczne -> OCR (z bieżącej klatki) -> gotowe albo kolejna próba
    const records = [], keep = [];
    for (const p of state.pending) {
      const cur = L2GL.image.findIn(p.line, lines, THRESHOLD);
      if (!cur) continue;                                   // zniknęła: szum albo klatka w trakcie przewijania
      if (p.reads.length) state.stats.retries++;
      p.reads.push(await readLine(cur)); p.line = cur;
      if (settled(p)) records.push(finalize(p)); else keep.push(p);
    }
    const items = assemble(records);
    if (records.length) state.last = { time: frameTime.toISOString(), raw: records.map(r => `${r.text}  [${Math.round(r.conf)}]`).join('\n'), lines: items.map(i => i.text) };
    const out = emit(items);

    // 2. nowe linie względem poprzedniej klatki: wyłącznie sufiks po nałożeniu odcisków
    let fresh = [];
    if (state.prevLines === null) {
      state.prevLines = lines;                                   // punkt odniesienia po Starcie: zastane wpisy są nieaktualne
    } else {
      const a = L2GL.image.alignFrames(state.prevLines, lines, THRESHOLD);
      if (a) { state.stats.aligned++; fresh = lines.slice(a.overlap); }
      else { state.stats.unaligned++; fresh = lines.filter(l => !L2GL.image.presentIn(l, state.prevLines, THRESHOLD)); }
      state.prevLines = lines;
    }
    state.pending = keep.concat(fresh.map(line => ({ line, time: frameTime, reads: [] })));
    hooks.onFrame(state);
    return out;
  } finally { state.busy = false; }
}

// ---------- podgląd na żywo: obraz dla silnika OCR albo ścisła maska (diagnostyka) ----------
const PREVIEW_EVERY_MS = 1000;
function startLive(view) {
  stopLive();
  state.liveTimer = setInterval(() => {
    if (!cap.source || !cap.region) return;
    const tm = L2GL.image.textMask(L2GL.image.grabRegion(cap.source, cap.region, grab));
    if ($('maskView').checked) L2GL.image.showMask(tm, view); else L2GL.image.showOcrInput(tm, view);
  }, 250);
  // Bez nasłuchu "surowy wynik OCR" pokazuje odczyt całego widocznego okna czatu: za pierwszym razem wszystkie
  // linie, potem tylko nowe (odciski linii i nałożenie klatek jak w potoku, teksty niezmienionych linii zostają).
  // W trakcie nasłuchu pole wypełnia potok.
  state.preview = null;   // { lines, texts } z poprzedniego odczytu podglądu
  state.previewTimer = setInterval(async () => {
    if (state.running || state.previewBusy || !cap.source || !cap.region) return;
    state.previewBusy = true;
    try {
      await ensureWorker();
      const lines = L2GL.image.segmentLines(L2GL.image.textMask(L2GL.image.grabRegion(cap.source, cap.region, grab)));
      const prev = state.preview, a = prev ? L2GL.image.alignFrames(prev.lines, lines, THRESHOLD) : null;
      const texts = a ? prev.texts.slice(a.k, a.k + a.overlap) : [];
      for (const l of a ? lines.slice(a.overlap) : lines) {
        if (!state.previewTimer) return;
        const r = await readLine(l); texts.push(`${r.text}  [${Math.round(r.conf)}]`);
      }
      state.preview = { lines, texts };
      state.last = { time: new Date().toISOString(), raw: texts.join('\n'), lines: [] };
      hooks.onFrame(state);
    } catch (e) { status('Podgląd OCR: ' + e.message, 'bad'); }
    finally { state.previewBusy = false; }
  }, PREVIEW_EVERY_MS);
}
function stopLive() { clearInterval(state.liveTimer); clearInterval(state.previewTimer); state.liveTimer = state.previewTimer = null; state.preview = null; }

// ---------- pętla nasłuchu ----------
async function start() {
  if (state.running) return;
  await ensureWorker();
  state.running = true;
  state.session = new Date().toISOString(); state.sessionCount = 0;
  state.prevLines = null; state.pending = []; state.openTail = null; state.last = null;
  state.stats = { frames: 0, ocr: 0, ocrMsTotal: 0, aligned: 0, unaligned: 0, retries: 0 };
  await L2GL.db.putSession({ id: state.session, start: Date.now(), end: Date.now(), count: 0 }).catch(() => {});
  await hooks.onSessionStart(state.session);
  state.timer = setInterval(() => { processFrame(new Date()).catch(e => status('Błąd OCR: ' + e.message, 'bad')); }, 1000 / FPS);
  state.autosaveTimer = setInterval(() => L2GL.files.autosave(), 60000);
}
async function flush() {
  // koniec sesji: oczekujące linie bez potwierdzenia też czytamy, żeby nic nie przepadło
  const records = [];
  for (const p of state.pending) {
    if (!p.reads.length) p.reads.push(await readLine(p.line));
    records.push(finalize(p));
  }
  state.pending = [];
  const items = assemble(records);
  if (state.openTail) { items.push(state.openTail); state.openTail = null; }
  emit(items);
}
async function stop() {
  if (!state.running) return;
  clearInterval(state.timer); clearInterval(state.autosaveTimer); state.timer = state.autosaveTimer = null;
  while (state.busy) await new Promise(r => setTimeout(r, 50));
  try { await flush(); } catch (e) { status('Błąd OCR przy zatrzymaniu: ' + e.message, 'bad'); }
  state.running = false;
  L2GL.db.putSession({ id: state.session, start: Date.parse(state.session), end: Date.now(), count: state.sessionCount }).catch(() => {});
  L2GL.files.autosave();
  hooks.onSessionStop(state.session);
}

L2GL.ocr = { state, hooks, ensureWorker, processFrame, start, stop, flush, startLive, stopLive, readLine, THRESHOLD, SCALE, FPS, REASON_LABEL };
})();
