// Potok: klatka -> maska tekstu -> linie z odciskami -> dopasowanie do poprzedniej klatki -> nowe linie
// (tylko sufiks) -> potwierdzenie w następnej klatce -> OCR każdej nowej linii (przy niskiej pewności
// powtórny odczyt w kolejnej klatce) -> klasyfikacja -> zdarzenia; co nie przeszło, zostaje jako "nierozpoznane".
// Wyemitowana linia jest obserwowana, dopóki jest na ekranie: gdy tło pod nią się zmieni, jest czytana ponownie,
// a lepszy odczyt poprawia zdarzenie wstecz (w miejscu, ten sam identyfikator i czas).
(() => {
const { $, status } = L2GL;
const cap = L2GL.capture.state;
const THRESHOLD = 0.25;   // z analizy próbek: ta sama linia < 0.26, inne linie > 0.30
const CONF_OK = 85, WORD_OK = 70;   // pewność OCR: linia i najsłabsze słowo (0-100); liczba prób odczytu w limits.maxReads
// Powiększenie obrazu linii dla silnika: czcionka czatu ma 9 px, silnik chce liter ok. 20 px. Zmierzone na 37 liniach:
// x1 daje 5 odczytów innych niż x2 (fałszywe apostrofy, "9" jako "©"), x1.5 i x3 po 2, x2 zero; czas 24-37 ms na linię.
const SCALE = 2;
const FPS = 4;   // klatek na sekundę: maska i odciski kosztują kilka ms, OCR tylko nowych linii
const RESYNC_FRAMES = 3;   // tyle kolejnych, zgodnych ze sobą klatek niepasujących do odniesienia zmienia odniesienie
const BIG_SHIFT = 8;       // skok o tyle linii w jednej klatce jest podejrzany: teksty porównane z ostatnio wyemitowanymi
const RECENT_MAX = 150;    // tyle ostatnich tekstów linii pamiętamy do wykrywania powtórek
const WATCH_READS = 5;     // łącznie tyle odczytów jednej linii (pierwsze plus powtórne w obserwacji)
const REREAD_DIST = 0.1;   // odległość odcisku od maski z ostatniego odczytu, od której tło pod linią uznajemy za zmienione
// budżet OCR na klatkę: łącznie tyle odczytów, nowe linie mają pierwszeństwo, obserwacja dostaje resztę (do watchPerFrame);
// minFrames: od tylu zaakumulowanych klatek o różnym tle powtórny odczyt idzie z obrazu minimum linii (999 = wyłączone)
const limits = { frameReads: 4, watchPerFrame: 2, minFrames: 3, maxReads: 3 };
const LOOSE = 0.4;        // próg "ta sama linia" na oczekiwanej pozycji: pozycja jest mocnym dowodem, maska bywa chwilowo gorsza
const MISS_FRAMES = 2;    // tyle kolejnych klatek linia może być nie do poznania, zanim uznamy, że zniknęła
const ACC_DIST = 0.08;   // odległość odcisku od ostatnio zaakumulowanej klatki, od której tło liczy się jako nowe
const ACC_PAD = 2;       // margines pasa linii w obrazie minimum (góra i dół)

const state = {
  worker: null, workerReady: false,
  running: false, busy: false, timer: null, autosaveTimer: null, liveTimer: null,
  session: null, sessionCount: 0,
  prevLines: null,    // klatka odniesienia (odciski linii ostatniej dopasowanej klatki), null = następna klatka nią zostanie
  unstable: null,     // { lines, n }: ostatnia klatka niepasująca do odniesienia i liczba kolejnych zgodnych z nią
  scrolled: false,    // czat przewinięty w górę przez gracza: linie, które "dojdą" u dołu, mogą być już wyemitowane
  pending: [],        // nowe linie czekające na potwierdzenie lub kolejny odczyt: {line, time, reads: [{text, conf, minWord}], batch}
  held: [],           // odczytane linie z podejrzanej partii (batch), czekają na resztę partii i sprawdzenie powtórek
  recent: [],         // teksty ostatnio przeczytanych linii w kolejności czatu (do wykrywania powtórek)
  watch: [],          // wyemitowane linie nadal na ekranie: {line, idx, readLine, reads, ev, saved, rank}; idx = pozycja w ostatniej klatce
  revLog: [],         // poprawki wstecz od ostatniego odczytu przez debug: {time, before, after}
  dropLog: [],        // partie odrzucone jako powtórki (dropRepeated): {time, texts}
  batchSeq: 0,
  openTail: null,     // niedokończony komunikat (zawinięty), czeka na kontynuację
  last: null,
  stats: { frames: 0, ocr: 0, ocrMsTotal: 0, frameMsTotal: 0, aligned: 0, unaligned: 0, resyncs: 0, dropped: 0, retries: 0, rereads: 0, minReads: 0, revisions: 0, lost: 0 },
};
const LOG_MAX = 300;   // tyle wpisów trzymają dzienniki revLog i dropLog, gdy debug ich nie opróżnia
const logPush = (log, item) => { log.push(item); if (log.length > LOG_MAX) log.splice(0, log.length - LOG_MAX); };
const hooks = { onEvents: () => {}, onEventsUpdated: () => {}, onSessionStart: async () => {}, onSessionStop: () => {}, onFrame: () => {} };

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

/** Treść zdarzenia dla gotowego tekstu linii: typ i pola z klasyfikacji, zastrzeżenia OCR. */
function toEvent(it) {
  const c = it.reason ? { type: 'other', fields: {}, reason: it.reason } : L2GL.messages.classify(it.text);
  const fields = { ...c.fields, ocr: Math.round(it.conf) };
  let type = c.type;
  if (type === 'other') fields.reason = c.reason || 'no_template';
  // niska pewność OCR bez zgodnego drugiego odczytu: zdarzenie tylko, gdy szablon i pola pasują niemal dokładnie
  else if (it.low && !((fields.conf || 0) >= 0.9 && !fields.reason)) { fields.wouldBe = type; type = 'other'; fields.reason = 'low_confidence'; }
  if (it.line && it.line.color) fields.color = it.line.color;
  return { text: it.text, type, fields };
}
const thumbOf = line => L2GL.image.renderLine(line, 1, thumbCanvas).toDataURL('image/png');
/** Jakość rozpoznania zdarzenia: 4 szablon bez zastrzeżeń, 3 z nazwą spoza bazy, 2 niska pewność, 1 złe pola lub fragment, 0 brak szablonu. */
const RANK = { low_confidence: 2, bad_fields: 1, fragment: 1 };
const rankOf = e => e.type === 'other' ? (RANK[e.fields.reason] || 0) : e.fields.reason ? 3 : 4;

/** Zamienia gotowe teksty linii na zdarzenia, zapisuje je i zgłasza do dashboardu; linie jednowierszowe idą pod obserwację. */
function emit(items, lines) {
  const out = [];
  for (const it of items) {
    const { text, type, fields } = toEvent(it);
    const ev = { session: state.session, ts: it.time.getTime(), time: it.time.toISOString(), text, type, fields };
    if (fields.reason && it.line) ev.thumb = thumbOf(it.line);
    out.push(ev);
    state.sessionCount++;
    const saved = L2GL.db.add(ev).then(id => { if (id !== undefined) ev.id = id; }).catch(e => status('Błąd zapisu zdarzenia: ' + e.message, 'bad'));
    // komunikat z jednej linii zostaje pod obserwacją, dopóki jest na ekranie (zawinięte dwuliniowe są zamykane przy emisji)
    if (it.src) state.watch.push({ line: it.src.line, idx: lines ? lines.indexOf(it.src.line) : -1, readLine: it.src.line, reads: it.src.reads, ev, saved, rank: rankOf(ev), first: it.src.line, acc: null, accN: 0, min: null });
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
  return isGood(last) || (n >= 2 && p.reads[n - 2].text === last.text) || n >= limits.maxReads;
}
/** Najlepszy odczyt oczekującej linii jako rekord do sklejania i klasyfikacji. */
function finalize(p) {
  const best = p.reads.reduce((a, b) => b.conf > a.conf ? b : a);
  const n = p.reads.length, agree = n >= 2 && p.reads[n - 2].text === p.reads[n - 1].text;
  return { text: best.text, conf: best.conf, minWord: best.minWord, reads: n, low: !isGood(best) && !agree, time: p.time, line: p.line, batch: p.batch || 0, src: p };
}

/**
 * Najlepszy z odczytów obserwowanej linii jako treść zdarzenia: najpierw jakość rozpoznania (rankOf), potem zgodność
 * odczytów (ten sam tekst po oczyszczeniu), na końcu pewność OCR. Zgodne odczyty znoszą zastrzeżenie niskiej pewności.
 */
function bestRead(w) {
  const votes = new Map();
  const cands = w.reads.map(r => { const c = L2GL.lines.cleanOne(r.text); const text = c ? c.text : ''; votes.set(text, (votes.get(text) || 0) + 1); return { r, text, words: c ? c.words : 0 }; });
  let best = null;
  const scores = new Map();   // tekst -> najlepszy wynik; poprawka wymaga lepszej jakości albo większej zgodności, nie samej pewności
  for (const c of cands) {
    const agree = votes.get(c.text) >= 2;
    const e = toEvent({ text: c.text, conf: c.r.conf, low: !isGood(c.r) && !agree, line: w.line, reason: !c.text ? 'empty' : c.words < 2 && !known(c.text) ? 'fragment' : null });
    const rank = rankOf(e), score = rank * 1000 + Math.min(votes.get(c.text), 3) * 100 + c.r.conf;
    if (!best || score > best.score) best = { e, rank, score };
    if (!(scores.get(c.text) > score)) scores.set(c.text, score);
  }
  best.scores = scores;
  return best;
}
const stripMeta = f => Object.fromEntries(Object.entries(f).filter(([k]) => !['ocr', 'color', 'rev', 'reads'].includes(k)));
const sameText = (a, b) => L2GL.lines.sim(a, b) === 1;   // bez interpunkcji i wielkości liter: sama kropka to nie poprawka

/**
 * Odnajduje śledzoną linię (oczekującą albo obserwowaną) w bieżącej klatce. Znana pozycja i przesunięcie czatu:
 * oczekiwany indeks minus przesunięcie, z tolerancją ±1 pasa i luźnym progiem, bo pozycja jest mocnym dowodem,
 * a maska bywa na chwilę gorsza (piasek, ruch kamery). Pozycja nieznana (po resynchronizacji, partia wstrzymana):
 * wyszukanie w całym oknie tylko, gdy jednoznaczne; bliźniacze linie (te same obrażenia od tego samego potwora)
 * różnią się paroma pikselami i śledzenie niewłaściwej podmieniałoby zdarzenie na sąsiada.
 */
function locate(entry, lines, shift) {
  if (entry.idx >= 0 && shift !== null) {
    for (const d of [0, -1, 1]) {
      const j = entry.idx - shift + d;
      if (j >= 0 && j < lines.length && L2GL.image.lineDistance(entry.line, lines[j]) < LOOSE) return { line: lines[j], idx: j };
    }
  }
  // pozycja nieznana albo zawiodła (dopasowanie klatek bywa błędne przy powtarzalnym czacie): wyszukanie w oknie, tylko jednoznaczne
  let b1 = THRESHOLD, b2 = THRESHOLD, bi = -1;
  for (let j = 0; j < lines.length; j++) { const d = L2GL.image.lineDistance(entry.line, lines[j]); if (d < b1) { b2 = b1; b1 = d; bi = j; } else if (d < b2) b2 = d; }
  return bi >= 0 && b2 >= THRESHOLD ? { line: lines[bi], idx: bi } : null;
}
/** Linia nie odnaleziona w tej klatce: aktualizuje pozycję i licznik chybień; true, gdy już jej nie ma (wyjechała albo za długo nie do poznania). */
function missed(entry, lines, shift) {
  const out = shift !== null && entry.idx >= 0 && entry.idx - shift < 0;
  if (shift === null) entry.idx = -1; else if (entry.idx >= 0) entry.idx -= shift;
  entry.miss = (entry.miss || 0) + 1;
  return out || entry.miss > MISS_FRAMES;
}

/**
 * Obraz minimum linii: per piksel najciemniejsza wartość RGB ze wszystkich zaakumulowanych klatek o różnym tle.
 * Tekst jest jasny w każdej klatce, więc zostaje, a tło przyjmuje najciemniejszą z widzianych wersji, co podnosi
 * kontrast (klasyka wideo OCR, Sato i in. 1998). Czat przewija się o całe wiersze, więc ta sama linia odwiedza wiele
 * pozycji i pod każdą ma inne tło nawet przy nieruchomej kamerze. Pomiar na 491 kolejnych klatkach
 * (`samples/debug/2026-11-15_22-07-20`, 143 linii, 3-59 klatek na linię): 125/143 dobrych linii z obrazu minimum
 * wobec 104/143 z najlepszego pojedynczego odczytu, pewność 92.7 wobec 90.0, 21 linii lepiej o 10+, 1 gorzej.
 * Nałożenie: przesunięcie w pionie ±2 px po pokryciu masek z pierwszą klatką linii (przewijanie jest o całe wiersze).
 */
function accumulate(w, cur, img) {
  const W = cur.w, h = w.first.h, hh = h + ACC_PAD * 2;
  if (!w.min) { w.min = new Uint8ClampedArray(W * hh * 4).fill(255); w.hh = hh; }
  let best = null;
  for (let dy = -2; dy <= 2; dy++) {
    let inter = 0;
    for (let y = 0; y < h; y++) { const yy = y + dy; if (yy < 0 || yy >= cur.h) continue; for (let x = 0; x < W; x++) if (w.first.mask[y * W + x] && cur.mask[yy * W + x]) inter++; }
    if (!best || inter > best.inter) best = { dy, inter };
  }
  const d = img.data, m = w.min;
  for (let y = 0; y < hh; y++) {
    const sy = cur.y0 - ACC_PAD + y + best.dy;
    if (sy < 0 || sy >= img.height) continue;
    for (let x = 0; x < W; x++) {
      const p = (sy * W + x) * 4, q = (y * W + x) * 4;
      if (d[p] < m[q]) m[q] = d[p]; if (d[p + 1] < m[q + 1]) m[q + 1] = d[p + 1]; if (d[p + 2] < m[q + 2]) m[q + 2] = d[p + 2];
    }
  }
  w.accN++; w.acc = cur;
}
/** Linia do OCR z obrazu minimum (maska i obraz liczone na nim jak na zwykłej klatce) albo null, gdy nic z niego nie wychodzi. */
function minLine(w, W) {
  const ls = L2GL.image.segmentLines(L2GL.image.textMask(new ImageData(w.min, W, w.hh)));
  const l = ls.length ? ls.reduce((a, b) => b.ink > a.ink ? b : a) : null;
  return l && l.ink > 20 ? l : null;
}

/**
 * Obserwacja wyemitowanych linii: dopóki linia jest na ekranie, przy zmianie tła pod nią (piksele inne niż przy
 * ostatnim odczycie) jest czytana ponownie (od limits.minFrames klatek o różnym tle: z obrazu minimum linii),
 * a gdy najlepszy z odczytów daje inne zdarzenie, zdarzenie jest poprawiane
 * w miejscu: ten sam identyfikator i czas, nowy tekst, typ i pola, licznik `rev`. Linia jest śledzona po pozycji
 * (indeks w poprzedniej klatce minus przesunięcie `shift`), nie szukana w całym oknie: w grindzie te same komunikaty
 * wracają co chwilę i stara linia "podstawiałaby się" pod nowe. Pozycja nieznana (shift null po resynchronizacji,
 * linia z partii wstrzymanej) jest ustalana raz przez wyszukanie w oknie. Zwraca poprawione zdarzenia.
 */
async function watchLines(lines, shift, budget, img) {
  const keep = [], cands = [], revised = [];
  for (const w of state.watch) {
    const loc = locate(w, lines, shift);
    if (!loc) { if (!missed(w, lines, shift)) keep.push(w); continue; }   // chwilowo nie do poznania: czekamy; zniknęła: koniec obserwacji
    const cur = loc.line;
    w.line = cur; w.idx = loc.idx; w.miss = 0; keep.push(w);
    // obraz minimum: pierwsza klatka zawsze, potem każda z innym tłem (niezależnie od budżetu odczytów)
    if (img && (w.accN === 0 || L2GL.image.lineDistance(cur, w.acc) > ACC_DIST)) accumulate(w, cur, img);
    if (w.reads.length < WATCH_READS && L2GL.image.lineDistance(cur, w.readLine) > REREAD_DIST) cands.push(w);
  }
  state.watch = keep;
  cands.sort((a, b) => a.rank - b.rank || a.ev.ts - b.ev.ts);   // najpierw najsłabiej rozpoznane, potem najstarsze
  for (const w of cands.slice(0, Math.max(0, budget))) {
    // obraz minimum tylko dla linii rozpoznanych z zastrzeżeniem: czystego odczytu nie ma czym poprawiać, a odczyty
    // z obrazu minimum nie są niezależne (ten sam obraz, coraz więcej klatek), więc w głosowaniu liczy się tylko
    // ostatni z nich (poprzedni jest zastępowany); w teście dwa takie odczyty przegłosowały poprawne "53 damage" (95).
    let src = w.line, fromMin = false;
    if (w.rank < 4 && w.accN >= limits.minFrames) { const ml = minLine(w, w.line.w); if (ml) { src = ml; fromMin = true; } }
    const r = await readLine(src); r.min = fromMin;
    if (fromMin) { const i = w.reads.findIndex(x => x.min); if (i >= 0) w.reads.splice(i, 1); }
    w.reads.push(r); w.readLine = w.line; state.stats.rereads++; if (fromMin) state.stats.minReads++;
    const b = bestRead(w), ev = w.ev;
    if (b.e.type === ev.type && sameText(b.e.text, ev.text) && JSON.stringify(stripMeta(b.e.fields)) === JSON.stringify(stripMeta(ev.fields))) continue;
    // dwa dobre odczyty różniące się cyfrą to nie powód do poprawki: wygrywa dopiero lepsza jakość albo przewaga głosów
    const curScore = b.scores.get(ev.text);
    if (curScore !== undefined && b.score < curScore + 100) continue;
    logPush(state.revLog, { time: new Date().toISOString(), before: { text: ev.text, type: ev.type, reason: ev.fields.reason || null, ocr: ev.fields.ocr }, after: { text: b.e.text, type: b.e.type, reason: b.e.fields.reason || null, ocr: b.e.fields.ocr }, reads: w.reads.map(r => ({ text: r.text, conf: Math.round(r.conf), minWord: Math.round(r.minWord) })) });
    ev.text = b.e.text; ev.type = b.e.type; ev.fields = { ...b.e.fields, rev: (ev.fields.rev || 0) + 1, reads: w.reads.length };
    if (ev.fields.reason) ev.thumb = thumbOf(w.line); else delete ev.thumb;
    w.rank = b.rank; state.stats.revisions++;
    w.saved = w.saved.then(() => L2GL.db.put(ev)).catch(e => status('Błąd zapisu poprawki: ' + e.message, 'bad'));
    revised.push(ev);
  }
  return revised;
}

/**
 * Partia linii z podejrzanego źródła (resynchronizacja klatki odniesienia, duży skok, powrót po przewinięciu)
 * kontra ostatnio przeczytane teksty: jeśli początek partii pokrywa się po kolei z jakimś fragmentem historii
 * (te same liczby, tekst podobny), to są stare wpisy o zmienionej masce, nie nowe. Zostaje tylko reszta partii.
 * Pojedyncze powtórzenie linii nie wystarczy, bo w grindzie te same komunikaty wracają co chwilę.
 */
const nums = t => (t.match(/\d+/g) || []).join(',');
function dropRepeated(batch) {
  const recent = state.recent, n = batch.length;
  let best = null;
  for (let k = 0; k < recent.length; k++) {
    const overlap = Math.min(n, recent.length - k);
    if (overlap < 2) break;
    let hits = 0;
    for (let i = 0; i < overlap; i++) {
      const a = batch[i].text, b = recent[k + i];
      if (nums(a) === nums(b) && L2GL.lines.sim(a, b) >= 0.85) hits++;
    }
    if (!best || hits > best.hits) best = { k, overlap, hits };
  }
  if (best && best.hits >= 2 && best.hits >= best.overlap * 0.6) {
    state.stats.dropped += best.overlap;
    logPush(state.dropLog, { time: new Date().toISOString(), hits: best.hits, texts: batch.slice(0, best.overlap).map(r => r.text), kept: batch.length - best.overlap });
    return batch.slice(best.overlap);
  }
  return batch;
}

/** Zwalnia partie z state.held, których żadna linia już nie czeka w kolejce, po odrzuceniu powtórek. */
function releaseHeld() {
  const out = [];
  while (state.held.length) {
    const id = state.held[0].batch;
    if (state.pending.some(p => p.batch === id)) break;
    const batch = [], rest = [];
    for (const r of state.held) (r.batch === id ? batch : rest).push(r);
    state.held = rest;
    const kept = dropRepeated(batch);
    if (kept.length) state.scrolled = false;   // coś naprawdę nowego: okno czatu jest znów na dole
    out.push(...kept);
  }
  return out;
}

/** Rekordy z klatki -> gotowe do sklejania: partie podejrzane czekają w state.held na komplet, teksty gotowych do state.recent. */
function collect(records) {
  const ready = [];
  for (const r of records) {
    if (r.batch) state.held.push(r); else { ready.push(...releaseHeld()); ready.push(r); }
  }
  ready.push(...releaseHeld());
  for (const r of ready) state.recent.push(r.text);
  if (state.recent.length > RECENT_MAX) state.recent.splice(0, state.recent.length - RECENT_MAX);
  return ready;
}

/**
 * Odczyty nowych linii -> komunikaty. Zawinięty komunikat to linia bez kropki na końcu i kontynuacja w następnej;
 * kontynuacja może przyjść dopiero w kolejnej klatce, więc niedokończony ogon czeka w state.openTail.
 * Fragment bez poprzednika (śmieć z ikony, obcięta linia) wychodzi jako rekord z powodem.
 */
/** Krótka linia, która sama jest komunikatem z bazy ("Over-hit!"): nie fragment i nie kontynuacja zawiniętego. */
const known = text => L2GL.messages.classify(text).type !== 'other';
function assemble(records) {
  const out = [];
  const terminated = t => /[.!?,]$/.test(t);
  for (const r of records) {
    const c = L2GL.lines.cleanOne(r.text);
    if (!c) { out.push({ ...r, reason: 'empty' }); continue; }
    let item = { ...r, text: c.text };
    const short = c.words < 2 || /^[a-z]/.test(c.text) || c.text.split(' ').length <= 3;
    const fragment = short && !known(c.text);
    if (state.openTail) {
      const tail = state.openTail; state.openTail = null;
      if (fragment) item = { ...tail, text: tail.text + ' ' + c.text, conf: Math.min(tail.conf, r.conf), low: tail.low || r.low, src: null };
      else out.push(tail);
    } else if (c.words < 2 && fragment) { out.push({ ...item, reason: 'fragment' }); continue; }
    if (!terminated(item.text)) state.openTail = item;
    else out.push(item);
  }
  return out;
}

/** Jedna klatka: linie z odciskami, dopasowanie do poprzedniej klatki, odczyt oczekujących, nowe do kolejki. */
async function processFrame(frameTime) {
  if (state.busy || !cap.source || !cap.region) return [];
  state.busy = true;
  const t0 = performance.now();
  try {
    state.stats.frames++;
    const img = L2GL.image.grabRegion(cap.source, cap.region, grab);
    if (L2GL.debug && L2GL.debug.state.running) L2GL.debug.recordFrame(img, frameTime);   // zapis każdej klatki (opcja debug)
    const tm = L2GL.image.textMask(img);
    const lines = L2GL.image.segmentLines(tm);
    state.lastMask = tm; state.lastLines = lines;

    // 1. dopasowanie do klatki odniesienia. Klatka, która nie pasuje, nie zmienia niczego i jest pomijana: ruch
    // kamery potrafi na chwilę zepsuć maskę tekstu (tło za czatem), a taka klatka wzięta za odniesienie sprawiała,
    // że następna dobra klatka wyglądała na całkiem nową i cały czat wchodził drugi raz do OCR i do zdarzeń.
    // Odniesienie zmienia się dopiero po RESYNC_FRAMES zgodnych ze sobą klatkach (czat wyczyszczony, przewinięty
    // o więcej niż okno, inne tło na stałe). Linie z resynchronizacji, z dużego skoku i po przewinięciu w górę
    // są podejrzane: przed emisją porównane tekstowo z ostatnio przeczytanymi (dropRepeated).
    let fresh = [], suspect = false, shift = null;   // shift: o ile linii przesunął się czat względem klatki odniesienia (null = nieznane)
    if (state.prevLines === null) {
      // punkt odniesienia po Starcie: zastane wpisy nie są zdarzeniami, ale ich teksty trafiają do historii,
      // żeby po zmianie tła nie wyszły jako nowe
      state.prevLines = lines;
      for (const l of lines) state.recent.push((await readLine(l)).text);
    } else {
      const a = L2GL.image.alignFrames(state.prevLines, lines, THRESHOLD);
      if (a) {
        state.stats.aligned++; state.unstable = null; state.prevLines = lines; shift = a.k;
        if (a.k < 0) state.scrolled = true;   // przewinięte w górę: u góry starsze wpisy, u dołu nic nowego
        else { fresh = lines.slice(a.overlap); suspect = state.scrolled || a.k >= BIG_SHIFT; }
      } else {
        state.stats.unaligned++;
        const u = state.unstable;
        state.unstable = u && L2GL.image.alignFrames(u.lines, lines, THRESHOLD) ? { lines, n: u.n + 1 } : { lines, n: 1 };
        if (state.unstable.n < RESYNC_FRAMES) { hooks.onFrame(state); return []; }   // klatka pominięta, oczekujące nietknięte
        state.stats.resyncs++; state.unstable = null;
        fresh = lines.filter(l => !L2GL.image.presentIn(l, state.prevLines, THRESHOLD)); suspect = true;
        state.prevLines = lines;
      }
    }

    // 2. linie nowe w poprzednich klatkach, nadal widoczne -> OCR (z bieżącej klatki) -> gotowe albo kolejna próba.
    // Kolejność z czatu jest zachowana: linia nie zostaje sfinalizowana, dopóki czeka jakaś wcześniejsza, bo
    // inaczej kontynuacja zawiniętego komunikatu ("time.") mogłaby trafić do sklejania po następnym wpisie
    // i zostać sierotą ("fragment lub śmieć"), a sam ogon wyszedłby bez końcówki.
    const records = [], keep = [];
    let blocked = false, reads = 0;
    for (const p of state.pending) {
      const loc = locate(p, lines, shift);
      if (loc) { p.line = loc.line; p.idx = loc.idx; p.miss = 0; }   // zawsze bieżąca linia: emit bierze z niej pozycję do obserwacji
      else if (!missed(p, lines, shift)) { keep.push(p); blocked = true; continue; }   // chwilowo nie do poznania: czekamy, kolejność zachowana
      else if (!p.reads.length) { state.stats.lost++; continue; }   // wyjechała bez żadnego odczytu: stracona
      else p.gone = true;                                            // wyjechała: zostaje z tym, co odczytano
      if (!p.gone && (!p.reads.length || !settled(p))) {
        if (p.reads.length) state.stats.retries++;
        p.reads.push(await readLine(p.line)); reads++;
      }
      if (!blocked && (p.gone || settled(p))) records.push(finalize(p));
      else { blocked = true; keep.push(p); }
    }
    state.pending = keep;
    const ready = collect(records);
    const items = assemble(ready);
    if (ready.length) state.last = { time: frameTime.toISOString(), raw: ready.map(r => `${r.text}  [${Math.round(r.conf)}]`).join('\n'), lines: items.map(i => i.text) };
    const out = emit(items, lines);

    // 2b. obserwacja linii już wyemitowanych: powtórne odczyty w ramach reszty budżetu klatki
    const revised = await watchLines(lines, shift, Math.min(limits.watchPerFrame, limits.frameReads - reads), img);
    if (revised.length) hooks.onEventsUpdated(revised);

    // 3. nowe linie do kolejki; podejrzane dostają numer partii
    const batch = suspect && fresh.length ? ++state.batchSeq : 0;
    state.pending = keep.concat(fresh.map(line => ({ line, idx: lines.indexOf(line), time: frameTime, reads: [], batch, miss: 0 })));
    hooks.onFrame(state);
    return out;
  } finally { state.busy = false; state.stats.frameMsTotal += performance.now() - t0; }
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
      const prev = state.preview, al = prev ? L2GL.image.alignFrames(prev.lines, lines, THRESHOLD) : null;
      const a = al && al.k >= 0 ? al : null;   // przewinięcie w górę: czytamy od nowa
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
  state.prevLines = null; state.unstable = null; state.scrolled = false; state.pending = []; state.held = []; state.recent = []; state.watch = []; state.batchSeq = 0;
  state.revLog = []; state.dropLog = [];
  state.openTail = null; state.last = null;
  state.stats = { frames: 0, ocr: 0, ocrMsTotal: 0, frameMsTotal: 0, aligned: 0, unaligned: 0, resyncs: 0, dropped: 0, retries: 0, rereads: 0, minReads: 0, revisions: 0, lost: 0 };
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
  const items = assemble(collect(records));
  if (state.openTail) { items.push(state.openTail); state.openTail = null; }
  emit(items);
  state.watch = [];
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

L2GL.ocr = { state, hooks, limits, ensureWorker, processFrame, start, stop, flush, startLive, stopLive, readLine, THRESHOLD, SCALE, FPS, REASON_LABEL };
})();
