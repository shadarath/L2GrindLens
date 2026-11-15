// Obraz: maska tekstu czatu (jasny piksel przy ciemnej obwódce glifu, bez względu na barwę), segmentacja na linie,
// odciski linii i ich porównywanie, obraz pojedynczej linii dla silnika OCR. Parametry pochodzą z analizy próbek
// (tools/ocr_fingerprint.py i pomiary w przeglądarce opisane w docs/plan-ocr.md).
(() => {
/**
 * Maska tekstu bez barwy. Tekst czatu ma dowolny kolor (paleta klienta, własne kolory komunikatów), ale zawsze
 * ciemną obwódkę glifów, więc piksel jest tekstem, gdy jest jasny (lightness powyżej V_TEXT) i leży
 * przy obwódce w układzie typowym dla glifu: ciemne co najmniej 3 z 8 sąsiadów albo ciemny sąsiad w obu osiach.
 * Jasność to luminancja, a dla nasyconych barw najjaśniejszy kanał z wagą (czerwień 0.9, zieleń 0.8, błękit 0.6):
 * sam najjaśniejszy kanał mylił tekst z podkładką czatu nad niebem (niebieska podkładka rgb ok. 40,70,170 ma
 * najjaśniejszy kanał 0.67 jak beżowy tekst, luminancję 0.28), przez co na niebie pewność OCR spadała do 30-40
 * (sesja `samples/debug/2026-11-15_20-46-33`, eksport `nierozpoznane-2026-11-15T19-42-41.json`); z luminancją 90.
 * Sama luminancja gubiłaby czerwień palety (255,12,12: 0.33), stąd wagi kanałów; turkus (12,197,189) ma 0.55,
 * z wagą zieleni 0.62.
 * Sam warunek "ciemny piksel w pobliżu" nie wystarcza: na jasnym tle (trawa) zlewa sąsiednie linie.
 * "Ciemny" jest względny: sąsiad jest obwódką, gdy jest ciemniejszy niż V_DARK albo niż 60% jasności piksela
 * (do V_DARK2), bo przy półprzezroczystej podkładce nad jasną sceną obwódka rozjaśnia się do 0.34-0.45 i przy
 * progu stałym połowa glifu znikała (sesja 2026-11-14_15-32-36, klatka 15-33-56: 9.5 tys. zamiast 13.9 tys. pikseli,
 * klatka niedopasowana). Z progiem względnym wszystkie pary klatek trzech sesji debug pasują (średnia odległość
 * do 0.19, drugie najlepsze przesunięcie od 0.22).
 * Pomiary 2026-11-15 (samples/colors-chat.png, samples/debug/debug/2026-11-15_18-48-41): bez podkładki tekst
 * ma jasność 0.60-0.93 i przejmuje odcień tła, wszystkie 13 kolorów palety klienta jest jasnych w tym sensie;
 * dawna maska po barwie (beż/turkus/czerwień w HSV) gubiła litery nad trawą i całe linie pomarańczowe i fioletowe.
 */
const V_TEXT = 0.5;    // minimalna jasność piksela tekstu
const lightness = (r, g, b) => Math.max(0.299 * r + 0.587 * g + 0.114 * b, 0.9 * r, 0.8 * g, 0.6 * b);
const V_SOFT = 0.34;   // luźniejszy próg do obrazu dla OCR: kropki nad i oraz ogonki g/p/q/y są przyciemnione wygładzaniem
const V_DARK = 0.33;   // obwódka glifu: próg bezwzględny
const V_DARK2 = 0.45;  // górna granica progu względnego obwódki (0.6 jasności piksela)
const DARK_REL = 0.6;

/** Klasa barwy piksela tekstu: tylko etykieta do analizy (fields.color), nie bramkuje rozpoznawania. */
const COLOR_NAME = ['', 'beige', 'yellow', 'orange', 'red', 'green', 'cyan', 'blue', 'purple', 'white'];
function colorClass(r, g, b) {
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), s = mx ? (mx - mn) / mx : 0;
  if (s < 0.15) return 9;
  const dd = Math.max(mx - mn, 1), h = mx === r ? (60 * ((g - b) / dd) + 360) % 360 : mx === g ? 60 * ((b - r) / dd) + 120 : 60 * ((r - g) / dd) + 240;
  if (h < 15 || h > 345) return 4;
  if (h < 75) return s <= 0.6 ? 1 : h < 40 ? 3 : 2;
  if (h < 165) return 5;
  if (h < 210) return 6;
  if (h < 260) return 7;
  return 8;
}

/**
 * Maska tekstu dla wycinka. Zwraca { mask, soft, gray, cls, w, h }: mask (0/1) służy odciskom linii, soft to piksele
 * jaśniejsze niż V_SOFT otoczone obwódką jak cienki fragment glifu (ciemne co najmniej 5 z 8 sąsiadów albo ciemny
 * sąsiad w obu osiach; tylko do obrazu dla OCR), gray to jasność (lightness) piksela 0..255, cls to klasa barwy piksela maski
 * (indeks w COLOR_NAME). Luźna maska z samym "ciemny sąsiad obok" dawała halo: przy podkładce nad jasną sceną tło tuż
 * za obwódką (jasność 0.35-0.5) wchodziło do obrazu OCR jako szary pierścień wokół każdej litery i pewność odczytu
 * spadała do 35-76 (eksport nierozpoznanych 2026-11-15T19-33-16); z regułą obwódki 24 zamiast 14 dobrych linii na 37.
 */
function textMask(img) {
  const { width: w, height: h, data: d } = img;
  const gray = new Uint8Array(w * h), bright = new Uint8Array(w * h), loose = new Uint8Array(w * h);
  for (let i = 0, p = 0; i < w * h; i++, p += 4) {
    const v = Math.min(255, Math.round(lightness(d[p], d[p + 1], d[p + 2])));
    gray[i] = v;
    if (v > V_SOFT * 255) loose[i] = 1;
    if (v > V_TEXT * 255) bright[i] = 1;
  }
  const out = new Uint8Array(w * h), soft = new Uint8Array(w * h), cls = new Uint8Array(w * h);
  let lim = 0;   // próg obwódki dla bieżącego piksela
  const dk = (x, y) => (x >= 0 && x < w && y >= 0 && y < h && gray[y * w + x] < lim) ? 1 : 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x;
    if (!loose[i]) continue;
    lim = Math.max(V_DARK * 255, Math.min(V_DARK2 * 255, DARK_REL * gray[i]));
    const l = dk(x - 1, y), r = dk(x + 1, y), u = dk(x, y - 1), dn = dk(x, y + 1);
    const n = l + r + u + dn + dk(x - 1, y - 1) + dk(x + 1, y - 1) + dk(x - 1, y + 1) + dk(x + 1, y + 1);
    const both = (l || r) && (u || dn);
    if (n >= 5 || both) soft[i] = 1;
    if (bright[i] && (n >= 3 || both)) { out[i] = 1; cls[i] = colorClass(d[i * 4], d[i * 4 + 1], d[i * 4 + 2]); }
  }
  return { mask: out, soft, gray, cls, w, h };
}

/** Pasy wierszy z atramentem: linie czatu. Każda ma y0, y1, własną maskę (pełna szerokość) i liczbę pikseli tekstu. */
function segmentLines({ mask, soft, gray, cls, w, h }, minRows = 6, minInk = 4) {
  const rowInk = new Int32Array(h);
  for (let y = 0; y < h; y++) { let k = 0; for (let x = 0; x < w; x++) k += mask[y * w + x]; rowInk[y] = k; }
  const bands = [];
  let y = 0;
  while (y < h) {
    if (rowInk[y] < minInk) { y++; continue; }
    const y0 = y;
    while (y < h && rowInk[y] >= minInk) y++;
    if (y - y0 >= minRows) bands.push([y0, y]);
  }
  // Ogonki liter (g, p, q, y) są pod linią bazową cienkie i przyciemnione: w masce zostaje z nich kilka pikseli,
  // a wiersz pomiędzy bywa pusty, więc pas rozszerzamy zawsze o 1 wiersz w górę i 3 w dół (nie wchodząc na sąsiada);
  // obraz dla OCR (renderLine) dobiera brakujące piksele ogonka po jasności w otoczeniu maski.
  const lines = [];
  for (let i = 0; i < bands.length; i++) {
    const prevEnd = i > 0 ? bands[i - 1][1] : 0, nextStart = i + 1 < bands.length ? bands[i + 1][0] : h;
    let [y0, y1] = bands[i];
    y0 = Math.max(prevEnd, y0 - 1);
    y1 = Math.min(y1 + 3, nextStart, h);
    const m = mask.slice(y0 * w, y1 * w);
    let total = 0; for (let k = 0; k < m.length; k++) total += m[k];
    // dominująca barwa linii: etykieta do analizy (które barwy odpowiadają którym typom komunikatów)
    let color = null;
    if (cls) {
      const cnt = new Array(COLOR_NAME.length).fill(0); for (let k = y0 * w; k < y1 * w; k++) cnt[cls[k]]++;
      let top = 1; for (let c = 2; c < cnt.length; c++) if (cnt[c] > cnt[top]) top = c;
      color = total && cnt[top] / total >= 0.7 ? COLOR_NAME[top] : 'mixed';
    }
    lines.push({ y0, y1, w, h: y1 - y0, mask: m, soft: soft ? soft.slice(y0 * w, y1 * w) : null, gray: gray ? gray.slice(y0 * w, y1 * w) : null, ink: total, color });
  }
  return lines;
}

/** 1 - pokrycie pikseli tekstu dwóch linii, najlepsze z przesunięć ±2 px w pionie i ±1 w poziomie. */
function lineDistance(a, b) {
  if (a.ink === 0 || b.ink === 0) return 1;
  if (Math.abs(a.ink - b.ink) / Math.max(a.ink, b.ink) > 0.6) return 1;   // tani test wstępny
  let best = 1;
  for (let dy = -2; dy <= 2; dy++) for (let dx = -1; dx <= 1; dx++) {
    const hh = Math.min(a.h, b.h) - Math.abs(dy), ww = Math.min(a.w, b.w) - Math.abs(dx);
    if (hh <= 0 || ww <= 0) continue;
    const ay = dy >= 0 ? dy : 0, by = dy >= 0 ? 0 : -dy, ax = dx >= 0 ? dx : 0, bx = dx >= 0 ? 0 : -dx;
    let inter = 0, union = 0;
    for (let y = 0; y < hh; y++) {
      const ra = (ay + y) * a.w + ax, rb = (by + y) * b.w + bx;
      for (let x = 0; x < ww; x++) { const p = a.mask[ra + x], q = b.mask[rb + x]; if (p & q) inter++; if (p | q) union++; }
    }
    const d = 1 - inter / Math.max(union, 1);
    if (d < best) best = d;
    if (best === 0) return 0;
  }
  return best;
}

/**
 * Dopasowanie poprzedniej klatki do bieżącej: szuka najmniejszego co do wartości przesunięcia k, przy którym
 * nałożone linie mają średnią odległość poniżej progu. k >= 0: cur[i] ~ prev[i+k], czyli k nowych linii u dołu;
 * k < 0: cur[i-k] ~ prev[i], czyli czat przewinięty w górę i u góry widać |k| starszych wpisów. Zwraca
 * { k, overlap, mean } albo null, gdy żadne przesunięcie nie pasuje.
 */
function alignFrames(prev, cur, threshold = 0.25) {
  const test = k => {
    const po = Math.max(k, 0), co = Math.max(-k, 0);
    const overlap = Math.min(prev.length - po, cur.length - co);
    if (overlap < 3) return null;
    let sum = 0, bad = 0;
    for (let i = 0; i < overlap; i++) {
      const d = lineDistance(prev[i + po], cur[i + co]);
      sum += d; if (d > 0.5) bad++;
      if (bad > Math.max(1, overlap * 0.2)) return null;
    }
    const mean = sum / overlap;
    return mean < threshold ? { k, overlap, mean } : null;
  };
  const maxShift = Math.max(prev.length, cur.length) - 3;
  for (let s = 0; s <= maxShift; s++) {
    const a = test(s) || (s > 0 && test(-s));
    if (a) return a;
  }
  return null;
}

/** Czy linia występuje w klatce (dowolna pozycja). */
function presentIn(line, lines, threshold = 0.25) {
  return lines.some(l => lineDistance(line, l) < threshold);
}
/** Najbliższa linia w klatce (poniżej progu) albo null. */
function findIn(line, lines, threshold = 0.25) {
  let best = null, bd = threshold;
  for (const l of lines) { const d = lineDistance(line, l); if (d < bd) { bd = d; best = l; } }
  return best;
}

/**
 * Obraz linii dla silnika OCR: ciemny tekst na białym tle, powiększony, z marginesem. Jasność jest normalizowana
 * do linii: mediana jasności pikseli maski (tekst) daje czerń, mediana jasności obwódki daje biel, więc tekst
 * półprzezroczysty albo przyciemniony tłem wychodzi tak samo czarno jak jasny (na niebie 23/23 dobrych linii zamiast
 * 14/23, przy podkładce nad jasną sceną 30/37 zamiast 24/37, na trawie 16/25 zamiast 9/25). Rysowane są piksele
 * maski poszerzonej o 1 px oraz piksele luźnej maski (soft) do 2 px od maski (przyciemnione kropki nad i oraz ogonki
 * g/p/q/y); piksel spoza maski trafia do obrazu tylko, gdy dotyka obwódki albo sam jest ciemny, bo inaczej jasne tło
 * przy glifie (piasek, podkładka) stawało się szarą otoczką.
 */
const RENDER_DARK = 0.45 * 255;   // piksel ciemniejszy niż to liczy się jako obwódka przy normalizacji i poszerzaniu
function renderLine(line, scale, canvas) {
  const pad = 4, W = line.w, H = line.h, M = line.mask, G = line.gray, S = line.soft;
  const at = (x, y) => (x >= 0 && x < W && y >= 0 && y < H) ? y * W + x : -1;
  const isDark = i => G && G[i] < RENDER_DARK;
  // mediany jasności tekstu i obwódki
  let tMed = 200, oMed = 40;
  if (G) {
    const tv = [], ov = [];
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const i = y * W + x; if (!M[i]) continue;
      tv.push(G[i]);
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const j = at(x + dx, y + dy); if (j >= 0 && isDark(j)) ov.push(G[j]); }
    }
    tv.sort((a, b) => a - b); ov.sort((a, b) => a - b);
    if (tv.length) tMed = tv[tv.length >> 1];
    if (ov.length) oMed = ov[ov.length >> 1];
  }
  const span = Math.max(tMed - oMed, 30);
  canvas.width = Math.round((W + pad * 2) * scale); canvas.height = Math.round((H + pad * 2) * scale);
  const ctx = canvas.getContext('2d');
  const small = document.createElement('canvas'); small.width = W + pad * 2; small.height = H + pad * 2;
  const sctx = small.getContext('2d'), img = sctx.createImageData(small.width, small.height), d = img.data;
  d.fill(255);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x;
    const r = S && S[i] ? 2 : 1;
    let on = 0;
    for (let dy = -r; dy <= r && !on; dy++) for (let dx = -r; dx <= r; dx++) { const j = at(x + dx, y + dy); if (j >= 0 && M[j]) { on = 1; break; } }
    if (!on) continue;
    if (!M[i] && G) {
      let touch = isDark(i);
      for (let dy = -1; dy <= 1 && !touch; dy++) for (let dx = -1; dx <= 1; dx++) { const j = at(x + dx, y + dy); if (j >= 0 && isDark(j)) { touch = true; break; } }
      if (!touch) continue;
    }
    const v = G ? Math.round(255 * (1 - Math.max(0, Math.min(1, (G[i] - oMed) / span)))) : (M[i] ? 0 : 255);   // jasny tekst -> ciemny
    const p = ((y + pad) * small.width + (x + pad)) * 4; d[p] = d[p + 1] = d[p + 2] = v;
  }
  sctx.putImageData(img, 0, 0);
  ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(small, 0, 0, canvas.width, canvas.height);
  return canvas;
}

/** Rysuje canvas `tmp` (w x h) w `view` dopasowanym do szerokości kontenera. */
function fitInto(tmp, view) {
  // szerokość liczona z sekcji, nie z ramki podglądu: ramka jest inline-block i sama dopasowuje się do obrazu,
  // dzięki czemu pasek przewijania leży tuż przy jego krawędzi; 44 = wcięcia sekcji i miejsce na pasek
  const host = view.closest('section') || view.parentElement;
  const w = tmp.width, h = tmp.height, avail = (host.clientWidth || 0) - 44;
  if (avail < 50 || !w) return;
  const vw = Math.min(w, avail), vh = Math.round(h * vw / w);
  if (view.width !== vw || view.height !== vh) { view.width = vw; view.height = vh; }
  const ctx = view.getContext('2d'); ctx.imageSmoothingEnabled = vw !== w; ctx.drawImage(tmp, 0, 0, vw, vh);
}

/** Podgląd ścisłej maski całego wycinka (biały tekst na czarnym): to, z czego powstają odciski linii. */
function showMask({ mask, w, h }, view) {
  const tmp = document.createElement('canvas'); tmp.width = w; tmp.height = h;
  const img = tmp.getContext('2d').createImageData(w, h), d = img.data;
  for (let i = 0; i < w * h; i++) { const v = mask[i] ? 255 : 0; d[i * 4] = d[i * 4 + 1] = d[i * 4 + 2] = v; d[i * 4 + 3] = 255; }
  tmp.getContext('2d').putImageData(img, 0, 0);
  fitInto(tmp, view);
}

/** Podgląd tego, co dostaje silnik OCR: obrazy kolejnych linii (ciemny tekst na białym) na swoich miejscach w wycinku. */
function showOcrInput(tm, view) {
  const tmp = document.createElement('canvas'); tmp.width = tm.w; tmp.height = tm.h;
  const ctx = tmp.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, tm.w, tm.h);
  const lc = document.createElement('canvas');
  for (const line of segmentLines(tm)) {
    renderLine(line, 1, lc);                                  // obraz linii ma margines 4 px z każdej strony
    ctx.drawImage(lc, 4, 4, line.w, line.h, 0, line.y0, line.w, line.h);
  }
  fitInto(tmp, view);
}

/** Wycinek obszaru ze źródła w skali 1:1 jako ImageData. */
function grabRegion(source, region, canvas) {
  canvas.width = Math.max(1, Math.round(region.w)); canvas.height = Math.max(1, Math.round(region.h));
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(source, region.x, region.y, region.w, region.h, 0, 0, canvas.width, canvas.height);
  return ctx.getImageData(0, 0, canvas.width, canvas.height);
}

L2GL.image = { textMask, segmentLines, lineDistance, alignFrames, presentIn, findIn, renderLine, showMask, showOcrInput, grabRegion };
})();
