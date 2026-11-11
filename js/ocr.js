// Silnik OCR (Tesseract.js), pętla nasłuchu, podgląd na żywo i sesje.
(() => {
const { $, status } = L2GL;
const cap = L2GL.capture.state;

const state = {
  worker: null, workerReady: false,
  running: false, busy: false, timer: null, autosaveTimer: null, liveTimer: null,
  session: null, sessionCount: 0,
  prevLines: null, prevSig: null, baselineNext: false,
  pending: [],   // linie nowe w ostatniej klatce, czekające na potwierdzenie w następnej
  last: null,
  stats: { frames: 0, ocr: 0, ocrMsTotal: 0 },
};
const hooks = { onEvents: () => {}, onSessionStart: async () => {}, onSessionStop: () => {}, onFrame: () => {} };

const work = document.createElement('canvas');      // klatka dla silnika
const liveWork = document.createElement('canvas');  // klatka dla podglądu na żywo

function imageOpts() { return { scale: +$('scale').value, thr: +$('thr').value, bright: $('bright').checked }; }

async function ensureWorker() {
  if (state.workerReady) return;
  if (typeof Tesseract === 'undefined') throw new Error('Biblioteka OCR nie została wczytana. Sprawdź połączenie z internetem.');
  status('Wczytuję silnik OCR (za pierwszym razem kilkanaście MB)...');
  state.worker = await Tesseract.createWorker('eng', 1, { logger: m => { if (m.status && m.progress !== undefined) status(`OCR: ${m.status} ${Math.round(m.progress * 100)}%`); } });
  await state.worker.setParameters({ tessedit_pageseg_mode: '6', preserve_interword_spaces: '1' });
  state.workerReady = true;
  status('Silnik OCR gotowy.', 'ok');
}

/** Zamienia linie na zdarzenia, zapisuje je i zgłasza do dashboardu. */
function emit(items) {
  const out = [];
  for (const { text, time } of items) {
    const c = L2GL.messages.classify(text);
    const ev = { session: state.session, ts: time.getTime(), time: time.toISOString(), text, type: c.type, fields: c.fields };
    if (state.last) state.last.events.push(ev);
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

/** Zgłasza linie czekające na potwierdzenie bez czekania (koniec sesji). */
function flushPending() {
  const items = state.pending; state.pending = [];
  return emit(items);
}

/** Jedna klatka: obróbka, OCR (gdy obraz się zmienił), nowe linie -> zdarzenia. */
async function processFrame(frameTime) {
  if (state.busy || !cap.source || !cap.region) return [];
  state.busy = true;
  try {
    state.stats.frames++;
    const img = L2GL.image.preprocess(cap.source, cap.region, imageOpts(), work);
    const sig = L2GL.image.signature(img);
    // Klatka bez zmian jest pomijana, chyba że czekają linie do potwierdzenia: wtedy OCR musi je zobaczyć drugi raz.
    if (!state.pending.length && !L2GL.image.changed(sig, state.prevSig)) return [];
    state.prevSig = sig;

    const t0 = performance.now();
    const { data } = await state.worker.recognize(work);
    const ms = performance.now() - t0;
    state.stats.ocr++; state.stats.ocrMsTotal += ms;

    const lines = L2GL.lines.clean(data.text);
    state.last = { time: frameTime.toISOString(), raw: data.text, lines, ms: Math.round(ms), events: [] };

    // Klatka tuż po Starcie: tylko punkt odniesienia. Dalej: tylko linie nowe względem poprzedniej klatki.
    let fresh;
    if (state.baselineNext || state.prevLines === null) { fresh = []; state.baselineNext = false; state.pending = []; }
    else fresh = L2GL.lines.newLines(state.prevLines, lines);
    state.prevLines = lines;

    // Nowa linia liczy się dopiero, gdy w następnej klatce nadal jest widoczna: pojedyncze przekłamanie OCR
    // (np. przy zmianie tła pod czatem) znika w kolejnej klatce i nie zostaje zdarzeniem.
    const confirmed = state.pending.filter(p => lines.some(l => L2GL.lines.same(l, p.text)));
    state.pending = fresh.map(text => ({ text, time: frameTime }));
    const out = emit(confirmed);
    hooks.onFrame(state);
    return out;
  } finally { state.busy = false; }
}

// ---------- podgląd na żywo (bez OCR) ----------
function startLive(view) {
  stopLive();
  state.liveTimer = setInterval(() => {
    if (!cap.source || !cap.region) return;
    L2GL.image.preprocess(cap.source, cap.region, imageOpts(), liveWork);
    L2GL.image.showIn(liveWork, view);
  }, 150);
}
function stopLive() { clearInterval(state.liveTimer); state.liveTimer = null; }

// ---------- pętla nasłuchu ----------
async function start() {
  if (state.running) return;
  await ensureWorker();
  state.running = true;
  state.session = new Date().toISOString(); state.sessionCount = 0;
  // Pierwsza klatka po Starcie jest tylko punktem odniesienia: zastane wpisy w czacie są nieaktualne,
  // do sesji trafiają wyłącznie linie, które pojawią się później.
  state.prevSig = null; state.pending = []; state.baselineNext = true;
  await L2GL.db.putSession({ id: state.session, start: Date.now(), end: Date.now(), count: 0 }).catch(() => {});
  await hooks.onSessionStart(state.session);
  state.timer = setInterval(() => { processFrame(new Date()).catch(e => status('Błąd OCR: ' + e.message, 'bad')); }, 1000 / +$('fps').value);
  state.autosaveTimer = setInterval(() => L2GL.files.autosave(), 60000);
}
function stop() {
  if (!state.running) return;
  clearInterval(state.timer); clearInterval(state.autosaveTimer); state.timer = state.autosaveTimer = null;
  flushPending();
  state.running = false;
  L2GL.db.putSession({ id: state.session, start: Date.parse(state.session), end: Date.now(), count: state.sessionCount }).catch(() => {});
  L2GL.files.autosave();
  hooks.onSessionStop(state.session);
}

L2GL.ocr = { state, hooks, ensureWorker, processFrame, flushPending, start, stop, startLive, stopLive };
})();
