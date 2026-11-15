// Tryb debug: co kilka sekund zapisuje do folderu danych komplet materiału do analizy potoku OCR:
// kolorowy wycinek czatu w oryginalnej skali, maskę tekstu, co minutę pełną klatkę okna gry i serię kolejnych
// klatek wycinka w tempie potoku (do odtworzenia dopasowania klatek, obserwacji linii i poprawek wstecz),
// oraz dziennik JSONL z ustawieniami, surowym wynikiem OCR, liniami, oczekującymi, obserwowanymi, poprawkami
// wstecz, odrzuconymi powtórkami i zdarzeniami od poprzedniej próbki.
(() => {
const { $, settings, fmt } = L2GL;
const INTERVAL_MS = 10000;    // co ile sekund próbka (wycinek, maska, wpis w dzienniku)
const FULL_EVERY = 6;         // co która próbka ma też pełną klatkę okna (co minutę)
const BURST_EVERY = 6;        // co która próbka ma serię kolejnych klatek wycinka (co minutę)
const BURST_FRAMES = 8;       // tyle klatek w serii, w odstępie potoku (1000 / FPS ms)
const WATCH_MAX = 40;         // tyle obserwowanych linii najwyżej we wpisie
const REC_CHUNK = 60;         // tyle klatek w jednej paczce rec-*.bin (ok. 25 MB przy wycinku 327x422)

const state = { running: false, timer: null, dir: null, count: 0, lastEventIdx: 0, session: null, busy: false, rec: null };
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
    // 4. co minutę seria kolejnych klatek wycinka w tempie potoku: materiał do odtworzenia dynamiki
    // (dopasowanie klatek, przewijanie, powtórne odczyty w obserwacji), czego pojedyncze próbki nie dają
    const burst = [];
    if (state.count % BURST_EVERY === 0) {
      // najpierw same zrzuty (drawImage to ułamek ms), kodowanie PNG (ok. 1 s na klatkę) i zapis dopiero po serii
      const gap = 1000 / L2GL.ocr.FPS, shots = [];
      for (let i = 0; i < BURST_FRAMES; i++) {
        const t = new Date(), c = document.createElement('canvas'); c.width = crop.width; c.height = crop.height;
        c.getContext('2d').drawImage(cap.source, r.x, r.y, r.w, r.h, 0, 0, c.width, c.height);
        shots.push({ t, c });
        await new Promise(res => setTimeout(res, gap));
      }
      for (let i = 0; i < shots.length; i++) {
        const name = `${fmt.stamp(shots[i].t)}-b${i}-crop.png`;
        await L2GL.files.writeTo(state.dir, name, await blob(shots[i].c, 'image/png'));
        burst.push({ time: shots[i].t.toISOString(), file: name });
      }
    }
    // 5. wpis w dzienniku: ustawienia, ostatni OCR, oczekujące i obserwowane linie, poprawki wstecz i odrzucone
    // powtórki od poprzedniej próbki, zdarzenia od poprzedniej próbki
    const events = L2GL.dashboard.current ? L2GL.dashboard.current.view.events : [];
    const fresh = events.slice(state.lastEventIdx); state.lastEventIdx = events.length;
    const read = r => ({ text: r.text, conf: Math.round(r.conf), minWord: Math.round(r.minWord), min: r.min ? 1 : 0 });
    const entry = {
      time: now.toISOString(), files: { crop: `${stamp}-crop.png`, bin: `${stamp}-bin.png`, full: fullName }, burst,
      source: { kind: cap.kind, width: sw, height: sh }, region: r,
      settings: { scale: L2GL.ocr.SCALE, fps: L2GL.ocr.FPS, playerName: $('playerName').value, shotsPerUse: +$('shotsPerUse').value, threshold: L2GL.ocr.THRESHOLD, limits: { ...L2GL.ocr.limits } },
      session: ocr.session, running: ocr.running, stats: { ...ocr.stats },
      sync: { unstable: ocr.unstable ? ocr.unstable.n : 0, scrolled: ocr.scrolled, held: ocr.held.length, recent: ocr.recent.length, watch: ocr.watch.length },
      lastOcr: ocr.last ? { time: ocr.last.time, ms: ocr.last.ms, raw: ocr.last.raw, lines: ocr.last.lines } : null,
      lines: (ocr.lastLines || []).map(l => ({ y0: l.y0, y1: l.y1, ink: l.ink, color: l.color })),
      pending: ocr.pending.map(p => ({ y0: p.line.y0, idx: p.idx, miss: p.miss || 0, time: p.time, batch: p.batch || 0, reads: p.reads.map(read) })), openTail: ocr.openTail && ocr.openTail.text,
      watch: ocr.watch.slice(0, WATCH_MAX).map(w => ({ y0: w.line.y0, idx: w.idx, rank: w.rank, accN: w.accN, reads: w.reads.map(read), ev: { time: w.ev.time, type: w.ev.type, text: w.ev.text, rev: w.ev.fields.rev || 0, reason: w.ev.fields.reason || null } })),
      revisionsSinceLast: ocr.revLog.splice(0), droppedSinceLast: ocr.dropLog.splice(0),
      eventsSinceLast: fresh.map(e => ({ time: e.time, type: e.type, fields: e.fields, text: e.text })),
    };
    await L2GL.files.appendTo(state.dir, 'debug.jsonl', JSON.stringify(entry) + '\n');
    state.count++;
    $('debugState').textContent = `debug: ${state.count} próbek`;
  } catch (e) {
    L2GL.status('Debug: błąd zapisu próbki: ' + e.message, 'bad');
  } finally { state.busy = false; }
}

/**
 * Zapis każdej klatki wycinka (opcja "każda klatka"): surowe RGB bez kompresji, bo kodowanie PNG trwa ok. 1 s na
 * klatkę i nie nadąża za 4 klatkami na sekundę. Format paczki rec-<stamp>-<nr>.bin: kolejno klatki, każda to
 * nagłówek 16 bajtów (uint32 LE: czas w ms modulo 2^32, szerokość, wysokość, 0) i w*h*3 bajtów RGB; spis paczek
 * i czasów klatek w rec.jsonl. Kopiowanie klatki to ułamek ms, zapis paczki idzie w tle.
 */
function recordFrame(img, time) {
  if (!state.running || !$('debugRec').checked || !state.dir) return;
  const w = img.width, h = img.height, d = img.data, buf = new Uint8Array(16 + w * h * 3);
  new DataView(buf.buffer).setUint32(0, time.getTime() >>> 0, true);
  new DataView(buf.buffer).setUint32(4, w, true); new DataView(buf.buffer).setUint32(8, h, true);
  for (let i = 0, p = 0, q = 16; i < w * h; i++, p += 4, q += 3) { buf[q] = d[p]; buf[q + 1] = d[p + 1]; buf[q + 2] = d[p + 2]; }
  if (!state.rec) state.rec = { parts: [], times: [], seq: 0, frames: 0, w, h };
  state.rec.parts.push(buf); state.rec.times.push(time.toISOString()); state.rec.frames++;
  if (state.rec.parts.length >= REC_CHUNK) flushRec();
}
function flushRec() {
  const rec = state.rec;
  if (!rec || !rec.parts.length) return Promise.resolve();
  const parts = rec.parts, times = rec.times, name = `rec-${fmt.stamp(new Date(Date.parse(times[0])))}-${String(rec.seq++).padStart(3, '0')}.bin`;
  rec.parts = []; rec.times = [];
  const dir = state.dir;
  return L2GL.files.writeTo(dir, name, new Blob(parts, { type: 'application/octet-stream' }))
    .then(() => L2GL.files.appendTo(dir, 'rec.jsonl', JSON.stringify({ file: name, w: rec.w, h: rec.h, frames: times.length, first: times[0], last: times[times.length - 1], times }) + '\n'))
    .catch(e => L2GL.status('Debug: błąd zapisu paczki klatek: ' + e.message, 'bad'));
}

/** Włącza zbieranie; przy pierwszym użyciu prosi o folder danych. Zwraca komunikat statusu. */
async function start() {
  if (state.running) return 'Debug już działa.';
  const sessionTag = fmt.stamp(new Date()).slice(0, 19);
  state.dir = await L2GL.files.ensureDir(['debug', sessionTag], true);
  if (!state.dir) throw new Error('bez folderu danych nie ma gdzie zapisywać próbek');
  state.running = true; state.count = 0; state.session = sessionTag; state.rec = null;
  state.lastEventIdx = L2GL.dashboard.current ? L2GL.dashboard.current.view.events.length : 0;
  await tick();
  state.timer = setInterval(tick, INTERVAL_MS);
  $('debugState').className = 'pill on';
  return `Debug włączony: co ${INTERVAL_MS / 1000} s próbka, co ${INTERVAL_MS * BURST_EVERY / 1000} s seria ${BURST_FRAMES} klatek, do folderu debug/${sessionTag}.`;
}

function stop() {
  if (!state.running) return 'Debug nie działa.';
  clearInterval(state.timer); state.timer = null; state.running = false;
  const rec = state.rec ? `, ${state.rec.frames} klatek w paczkach rec-*.bin` : '';
  flushRec();
  $('debugState').className = 'pill';
  return `Debug wyłączony, zapisano ${state.count} próbek${rec} w debug/${state.session}.`;
}

L2GL.debug = { state, start, stop, tick, recordFrame, flushRec };
})();
