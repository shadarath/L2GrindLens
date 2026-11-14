// Tryb debug: co kilkanaście sekund zapisuje do folderu danych komplet materiału do analizy potoku OCR:
// kolorowy wycinek czatu w oryginalnej skali, obraz po obróbce, co jakiś czas całą klatkę okna gry,
// oraz dziennik JSONL z ustawieniami, surowym wynikiem OCR, liniami, linią oczekującą i zdarzeniami.
(() => {
const { $, settings, fmt } = L2GL;
const INTERVAL_MS = 15000;    // co ile sekund próbka
const FULL_EVERY = 4;         // co która próbka ma też pełną klatkę okna

const state = { running: false, timer: null, dir: null, count: 0, lastEventIdx: 0, session: null, busy: false };
const crop = document.createElement('canvas'), bin = document.createElement('canvas'), full = document.createElement('canvas');

function blob(canvas, type, q) { return new Promise(res => canvas.toBlob(res, type, q)); }

async function tick() {
  if (state.busy) return;
  const cap = L2GL.capture.state, ocr = L2GL.ocr.state;
  if (!cap.source || !cap.region || !state.dir) return;
  state.busy = true;
  try {
    const now = new Date(), stamp = fmt.stamp(now), r = cap.region, [sw, sh] = L2GL.capture.srcSize();
    // 1. kolorowy wycinek czatu 1:1
    crop.width = Math.round(r.w); crop.height = Math.round(r.h);
    crop.getContext('2d').drawImage(cap.source, r.x, r.y, r.w, r.h, 0, 0, crop.width, crop.height);
    await L2GL.files.writeTo(state.dir, `${stamp}-crop.png`, await blob(crop, 'image/png'));
    // 2. maska tekstu tego wycinka (biały tekst na czarnym), z której powstają odciski linii
    const tm = L2GL.image.textMask(crop.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, crop.width, crop.height));
    bin.width = tm.w; bin.height = tm.h;
    const bimg = bin.getContext('2d').createImageData(tm.w, tm.h);
    for (let i = 0; i < tm.w * tm.h; i++) { const v = tm.mask[i] ? 255 : 0; bimg.data[i * 4] = bimg.data[i * 4 + 1] = bimg.data[i * 4 + 2] = v; bimg.data[i * 4 + 3] = 255; }
    bin.getContext('2d').putImageData(bimg, 0, 0);
    await L2GL.files.writeTo(state.dir, `${stamp}-bin.png`, await blob(bin, 'image/png'));
    // 3. co kilka próbek pełna klatka okna (JPEG, do kalibracji kolorów i kontekstu)
    let fullName = null;
    if (state.count % FULL_EVERY === 0 && sw && sh) {
      full.width = sw; full.height = sh;
      full.getContext('2d').drawImage(cap.source, 0, 0, sw, sh);
      fullName = `${stamp}-full.jpg`;
      await L2GL.files.writeTo(state.dir, fullName, await blob(full, 'image/jpeg', 0.85));
    }
    // 4. wpis w dzienniku: ustawienia, ostatni OCR, zdarzenia od poprzedniej próbki
    const events = L2GL.dashboard.current ? L2GL.dashboard.current.view.events : [];
    const fresh = events.slice(state.lastEventIdx); state.lastEventIdx = events.length;
    const entry = {
      time: now.toISOString(), files: { crop: `${stamp}-crop.png`, bin: `${stamp}-bin.png`, full: fullName },
      source: { kind: cap.kind, width: sw, height: sh }, region: r,
      settings: { scale: L2GL.ocr.SCALE, fps: L2GL.ocr.FPS, playerName: $('playerName').value, shotsPerUse: +$('shotsPerUse').value, threshold: L2GL.ocr.THRESHOLD },
      session: ocr.session, running: ocr.running, stats: { ...ocr.stats },
      lastOcr: ocr.last ? { time: ocr.last.time, ms: ocr.last.ms, raw: ocr.last.raw, lines: ocr.last.lines } : null,
      lines: (ocr.lastLines || []).map(l => ({ y0: l.y0, y1: l.y1, ink: l.ink, color: l.color })),
      pending: ocr.pending.map(p => ({ y0: p.line.y0, time: p.time, reads: p.reads.map(r => ({ text: r.text, conf: Math.round(r.conf), minWord: Math.round(r.minWord) })) })), openTail: ocr.openTail && ocr.openTail.text,
      eventsSinceLast: fresh.map(e => ({ time: e.time, type: e.type, fields: e.fields, text: e.text })),
    };
    await L2GL.files.appendTo(state.dir, 'debug.jsonl', JSON.stringify(entry) + '\n');
    state.count++;
    $('debugState').textContent = `debug: ${state.count} próbek`;
  } catch (e) {
    L2GL.status('Debug: błąd zapisu próbki: ' + e.message, 'bad');
  } finally { state.busy = false; }
}

/** Włącza zbieranie; przy pierwszym użyciu prosi o folder danych. Zwraca komunikat statusu. */
async function start() {
  if (state.running) return 'Debug już działa.';
  const sessionTag = fmt.stamp(new Date()).slice(0, 19);
  state.dir = await L2GL.files.ensureDir(['debug', sessionTag], true);
  if (!state.dir) throw new Error('bez folderu danych nie ma gdzie zapisywać próbek');
  state.running = true; state.count = 0; state.session = sessionTag;
  state.lastEventIdx = L2GL.dashboard.current ? L2GL.dashboard.current.view.events.length : 0;
  await tick();
  state.timer = setInterval(tick, INTERVAL_MS);
  $('debugState').className = 'pill on';
  return `Debug włączony: co ${INTERVAL_MS / 1000} s próbka do folderu debug/${sessionTag}.`;
}

function stop() {
  if (!state.running) return 'Debug nie działa.';
  clearInterval(state.timer); state.timer = null; state.running = false;
  $('debugState').className = 'pill';
  return `Debug wyłączony, zapisano ${state.count} próbek w debug/${state.session}.`;
}

L2GL.debug = { state, start, stop, tick };
})();
