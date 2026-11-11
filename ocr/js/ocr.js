// Silnik OCR (Tesseract.js), pętla nasłuchu, podgląd na żywo, sesje i test na próbce.
(() => {
const { $, status, settings } = L2GL;
const cap = L2GL.capture.state;

const state = {
  worker: null, workerReady: false,
  running: false, busy: false, timer: null, autosaveTimer: null, liveTimer: null,
  session: null, sessionCount: 0,
  prevLines: null, prevSig: null, firstFrame: true,
  last: null,
  stats: { frames: 0, ocr: 0, ocrMsTotal: 0 },
};
const hooks = { onEvents: () => {}, onSessionStart: async () => {}, onSessionStop: () => {}, onFrame: () => {} };

const work = document.createElement('canvas');      // klatka dla silnika
const liveWork = document.createElement('canvas');  // klatka dla podglądu na żywo
const lastSrc = document.createElement('canvas'), lastOcr = document.createElement('canvas');
const sample = document.createElement('canvas');

function imageOpts() { return { scale: +$('scale').value, thr: +$('thr').value, bright: $('bright').checked }; }
function resetFrameState() { state.prevLines = null; state.prevSig = null; state.firstFrame = true; }

async function ensureWorker() {
  if (state.workerReady) return;
  if (typeof Tesseract === 'undefined') throw new Error('Biblioteka OCR nie została wczytana. Sprawdź połączenie z internetem.');
  status('Wczytuję silnik OCR (za pierwszym razem kilkanaście MB)...');
  state.worker = await Tesseract.createWorker('eng', 1, { logger: m => { if (m.status && m.progress !== undefined) status(`OCR: ${m.status} ${Math.round(m.progress * 100)}%`); } });
  await state.worker.setParameters({ tessedit_pageseg_mode: '6', preserve_interword_spaces: '1' });
  state.workerReady = true;
  status('Silnik OCR gotowy.', 'ok');
}

/** Jedna klatka: obróbka, OCR (gdy obraz się zmienił), nowe linie -> zdarzenia. */
async function processFrame(frameTime, persist) {
  if (state.busy || !cap.source || !cap.region) return [];
  state.busy = true;
  try {
    state.stats.frames++;
    const img = L2GL.image.preprocess(cap.source, cap.region, imageOpts(), work);
    L2GL.image.cropColor(cap.source, cap.region, lastSrc);
    const sig = L2GL.image.signature(img);
    if (!L2GL.image.changed(sig, state.prevSig)) return [];
    state.prevSig = sig;

    const t0 = performance.now();
    const { data } = await state.worker.recognize(work);
    const ms = performance.now() - t0;
    state.stats.ocr++; state.stats.ocrMsTotal += ms;

    const lines = L2GL.lines.clean(data.text);
    lastOcr.width = work.width; lastOcr.height = work.height; lastOcr.getContext('2d').drawImage(work, 0, 0);
    state.last = { time: (frameTime || new Date()).toISOString(), raw: data.text, lines, ms: Math.round(ms), events: [] };

    let fresh;
    if (state.prevLines === null) fresh = (state.firstFrame && $('baseline').checked) ? [] : lines;
    else fresh = L2GL.lines.newLines(state.prevLines, lines);
    state.firstFrame = false; state.prevLines = lines;

    const out = [];
    for (const text of fresh) {
      const c = L2GL.messages.classify(text), t = frameTime || new Date();
      const ev = { session: persist ? state.session : null, ts: t.getTime(), time: t.toISOString(), text, type: c.type, fields: c.fields };
      state.last.events.push(ev); out.push(ev);
      if (persist) { state.sessionCount++; L2GL.db.add(ev).catch(e => status('Błąd zapisu zdarzenia: ' + e.message, 'bad')); }
    }
    if (persist && out.length) L2GL.db.putSession({ id: state.session, start: Date.parse(state.session), end: Date.now(), count: state.sessionCount }).catch(() => {});
    hooks.onFrame(state);
    if (out.length) hooks.onEvents(out, persist);
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
  resetFrameState();
  await L2GL.db.putSession({ id: state.session, start: Date.now(), end: Date.now(), count: 0 }).catch(() => {});
  await hooks.onSessionStart(state.session);
  state.timer = setInterval(() => { processFrame(new Date(), true).catch(e => status('Błąd OCR: ' + e.message, 'bad')); }, 1000 / +$('fps').value);
  state.autosaveTimer = setInterval(() => L2GL.files.autosave(), 60000);
}
function stop() {
  if (!state.running) return;
  state.running = false;
  clearInterval(state.timer); clearInterval(state.autosaveTimer); state.timer = state.autosaveTimer = null;
  L2GL.db.putSession({ id: state.session, start: Date.parse(state.session), end: Date.now(), count: state.sessionCount }).catch(() => {});
  L2GL.files.autosave();
  hooks.onSessionStop(state.session);
}

// ---------- test na próbce ----------
function drawSample(lines) {
  const rows = 8; sample.width = 560; sample.height = 14 + rows * 19;
  const c = sample.getContext('2d');
  c.fillStyle = '#0d0f1a'; c.fillRect(0, 0, sample.width, sample.height);
  c.font = '15px Arial, sans-serif'; c.textBaseline = 'top';
  const shown = lines.slice(-rows);
  shown.forEach((l, i) => { c.fillStyle = /XP/.test(l) ? '#e8d26a' : /obtained/.test(l) ? '#7fd38a' : /hit you/.test(l) ? '#e58a7a' : '#f0f0f0'; c.fillText(l, 8, 8 + (rows - shown.length + i) * 19); });
}
/** Sztuczny czat o stałej wysokości: klatka bazowa, dwie nowe linie, przewinięcie o trzy. Zwraca [a, b, c]. */
async function sampleTest() {
  await ensureWorker();
  const base = ['You hit for 128 damage.', 'Critical hit!', 'You hit for 341 damage.', 'Gremlin hit you for 23 damage.', 'You have acquired 1250 XP and 86 SP.', 'You have obtained 540 Adena.'];
  drawSample(base);
  L2GL.capture.setSource(sample, 'sample', 'próbka');
  L2GL.capture.setRegion({ x: 0, y: 0, w: sample.width, h: sample.height }, false);
  resetFrameState();
  const a = (await processFrame(new Date(), false)).length;
  drawSample(base.concat(['You hit for 97 damage.', 'You have obtained 5 Wooden Arrow.']));
  const b = (await processFrame(new Date(), false)).length;
  drawSample(base.slice(3).concat(['You hit for 97 damage.', 'You have obtained 5 Wooden Arrow.', 'Gremlin hit you for 31 damage.', 'You have acquired 980 XP and 71 SP.', 'You hit for 215 damage.']));
  const c = (await processFrame(new Date(), false)).length;
  return [a, b, c];
}

L2GL.ocr = { state, hooks, ensureWorker, processFrame, start, stop, startLive, stopLive, resetFrameState, sampleTest, lastSrc, lastOcr };
})();
