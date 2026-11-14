// Potok: klatka -> maska tekstu -> linie z odciskami -> dopasowanie do poprzedniej klatki -> nowe linie
// (tylko sufiks) -> potwierdzenie w następnej klatce -> OCR każdej nowej linii -> zdarzenia.
(() => {
const { $, status } = L2GL;
const cap = L2GL.capture.state;
const THRESHOLD = 0.25;   // z analizy próbek: ta sama linia < 0.26, inne linie > 0.30

const state = {
  worker: null, workerReady: false,
  running: false, busy: false, timer: null, autosaveTimer: null, liveTimer: null,
  session: null, sessionCount: 0,
  prevLines: null,    // linie z poprzedniej klatki (odciski), null = następna klatka jest punktem odniesienia
  pending: [],        // nowe linie czekające na potwierdzenie w kolejnej klatce: {line, time}
  openTail: null,     // niedokończony komunikat (zawinięty), czeka na kontynuację: {text, time}
  last: null,
  stats: { frames: 0, ocr: 0, ocrMsTotal: 0, aligned: 0, unaligned: 0 },
};
const hooks = { onEvents: () => {}, onSessionStart: async () => {}, onSessionStop: () => {}, onFrame: () => {} };

const grab = document.createElement('canvas');      // wycinek 1:1
const lineCanvas = document.createElement('canvas'); // obraz linii dla silnika

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

/** Zamienia gotowe teksty linii na zdarzenia, zapisuje je i zgłasza do dashboardu. */
function emit(items) {
  const out = [];
  for (const { text, time } of items) {
    const c = L2GL.messages.classify(text);
    const ev = { session: state.session, ts: time.getTime(), time: time.toISOString(), text, type: c.type, fields: c.fields };
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

/** OCR jednej linii z jej maski. */
async function readLine(line) {
  L2GL.image.renderLine(line, +$('scale').value, lineCanvas);
  const t0 = performance.now();
  // Obraz przekazujemy jako data URL: podanie canvasu (toBlob w środku) kosztuje w Chrome ok. 1 s opóźnienia
  // na ponownie używanym canvasie, a samo rozpoznanie linii trwa 20-50 ms.
  const { data } = await state.worker.recognize(lineCanvas.toDataURL('image/png'));
  state.stats.ocr++; state.stats.ocrMsTotal += performance.now() - t0;
  return data.text.replace(/\s+/g, ' ').trim();
}

/**
 * Teksty nowych linii -> komunikaty. Zawinięty komunikat to linia bez kropki na końcu i kontynuacja w następnej;
 * kontynuacja może przyjść dopiero w kolejnej klatce, więc niedokończony ogon czeka w state.openTail.
 */
function assemble(texts) {
  const out = [];
  const terminated = t => /[.!?,]$/.test(t);
  for (const { text, time } of texts) {
    const cleaned = L2GL.lines.clean(text);
    if (!cleaned.length) continue;
    let t = cleaned.join(' ');
    if (state.openTail) {
      const realWords = t.split(' ').filter(w => w.replace(/[^A-Za-z0-9]/g, '').length >= 3).length;
      if (/^[a-z]/.test(t) || realWords < 2 || t.split(' ').length <= 3) { t = state.openTail.text + ' ' + t; }
      else out.push(state.openTail);
      state.openTail = null;
    }
    if (!terminated(t)) state.openTail = { text: t, time };
    else out.push({ text: t, time });
  }
  return out;
}

/** Jedna klatka: linie z odciskami, dopasowanie do poprzedniej klatki, potwierdzenie i OCR oczekujących, nowe do kolejki. */
async function processFrame(frameTime) {
  if (state.busy || !cap.source || !cap.region) return [];
  state.busy = true;
  try {
    state.stats.frames++;
    const img = L2GL.image.grabRegion(cap.source, cap.region, grab);
    const tm = L2GL.image.textMask(img);
    const lines = L2GL.image.segmentLines(tm);
    state.lastMask = tm; state.lastLines = lines;

    // 1. potwierdzenie: linie nowe w poprzedniej klatce, które nadal są widoczne -> OCR -> zdarzenia
    const confirmed = state.pending.filter(p => L2GL.image.presentIn(p.line, lines, THRESHOLD));
    state.pending = [];
    const texts = [];
    for (const p of confirmed) texts.push({ text: await readLine(p.line), time: p.time });
    const items = assemble(texts);
    state.last = { time: frameTime.toISOString(), raw: texts.map(t => t.text).join('\n'), lines: items.map(i => i.text), events: [] };
    const out = emit(items);

    // 2. nowe linie względem poprzedniej klatki: wyłącznie sufiks po nałożeniu odcisków
    if (state.prevLines === null) {
      state.prevLines = lines;                                   // punkt odniesienia po Starcie: zastane wpisy są nieaktualne
    } else {
      const a = L2GL.image.alignFrames(state.prevLines, lines, THRESHOLD);
      let fresh;
      if (a) { state.stats.aligned++; fresh = lines.slice(a.overlap); }
      else { state.stats.unaligned++; fresh = lines.filter(l => !L2GL.image.presentIn(l, state.prevLines, THRESHOLD)); }
      state.pending = fresh.map(line => ({ line, time: frameTime }));
      state.prevLines = lines;
    }
    hooks.onFrame(state);
    return out;
  } finally { state.busy = false; }
}

// ---------- podgląd na żywo: maska tekstu ----------
function startLive(view) {
  stopLive();
  state.liveTimer = setInterval(() => {
    if (!cap.source || !cap.region) return;
    L2GL.image.showMask(L2GL.image.textMask(L2GL.image.grabRegion(cap.source, cap.region, grab)), view);
  }, 250);
}
function stopLive() { clearInterval(state.liveTimer); state.liveTimer = null; }

// ---------- pętla nasłuchu ----------
async function start() {
  if (state.running) return;
  await ensureWorker();
  state.running = true;
  state.session = new Date().toISOString(); state.sessionCount = 0;
  state.prevLines = null; state.pending = []; state.openTail = null;
  await L2GL.db.putSession({ id: state.session, start: Date.now(), end: Date.now(), count: 0 }).catch(() => {});
  await hooks.onSessionStart(state.session);
  state.timer = setInterval(() => { processFrame(new Date()).catch(e => status('Błąd OCR: ' + e.message, 'bad')); }, 1000 / +$('fps').value);
  state.autosaveTimer = setInterval(() => L2GL.files.autosave(), 60000);
}
async function flush() {
  // koniec sesji: oczekujące linie bez potwierdzenia też czytamy, żeby nic nie przepadło
  const texts = [];
  for (const p of state.pending) texts.push({ text: await readLine(p.line), time: p.time });
  state.pending = [];
  const items = assemble(texts);
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

L2GL.ocr = { state, hooks, ensureWorker, processFrame, start, stop, flush, startLive, stopLive, readLine, THRESHOLD };
})();
