// Obraz: maska tekstu czatu (barwa + ciemna obwódka glifów), segmentacja na linie, odciski linii i ich
// porównywanie, obraz pojedynczej linii dla silnika OCR. Parametry pochodzą z analizy próbek (tools/ocr_fingerprint.py).
(() => {
/**
 * Barwy tekstu czatu w HSV: "biały" systemowy jest przez podkładkę beżowy, żółty dropów, turkusowy, czerwony.
 * `slack` obniża progi jasności i nasycenia: cienkie fragmenty glifów (kropka nad i, ogonek g) są przez
 * wygładzanie przyciemnione i wyblakłe (kropka nad i: v 0.71, s 0.10).
 */
function isTextColor(h, s, v, slack = 0) {
  if (v > 0.64 - slack && s > 0.10 - slack / 4 && s < 0.72 && h > 25 && h < 75) return 1;   // beżowy / żółty
  if (v > 0.55 - slack && s > 0.30 && h > 165 && h < 210) return 2;             // turkusowy
  if (v > 0.55 - slack && s > 0.45 && (h < 15 || h > 345)) return 3;            // czerwony
  return 0;
}
const COLOR_NAME = ['', 'beige', 'cyan', 'red'];

/**
 * Maska tekstu dla wycinka: piksel jest tekstem, gdy ma barwę tekstu i w promieniu 2 px leży ciemny piksel
 * (obwódka glifu). Zwraca { mask, soft, gray, cls, w, h }: mask (0/1) służy odciskom linii, soft to ta sama reguła
 * z luźniejszym progiem jasności (tylko do obrazu dla OCR), gray to jasność piksela 0..255, cls to klasa barwy
 * piksela maski (1 beżowy/żółty, 2 turkusowy, 3 czerwony).
 */
function textMask(img) {
  const { width: w, height: h, data: d } = img;
  const color = new Uint8Array(w * h), loose = new Uint8Array(w * h), dark = new Uint8Array(w * h), gray = new Uint8Array(w * h);
  for (let i = 0, p = 0; i < w * h; i++, p += 4) {
    const r = d[p] / 255, g = d[p + 1] / 255, b = d[p + 2] / 255;
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b), v = mx, s = mx > 0 ? (mx - mn) / mx : 0;
    gray[i] = Math.round(mx * 255);
    if (v < 0.33) { dark[i] = 1; continue; }
    const dd = Math.max(mx - mn, 1e-6);
    let hue = mx === r ? (60 * ((g - b) / dd) + 360) % 360 : mx === g ? 60 * ((b - r) / dd) + 120 : 60 * ((r - g) / dd) + 240;
    color[i] = isTextColor(hue, s, v);
    if (isTextColor(hue, s, v, 0.16)) loose[i] = 1;
  }
  const out = new Uint8Array(w * h), soft = new Uint8Array(w * h), cls = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x;
    if (!loose[i]) continue;
    let near = 0;
    for (let dy = -2; dy <= 2 && !near; dy++) {
      const yy = y + dy; if (yy < 0 || yy >= h) continue;
      for (let dx = -2; dx <= 2; dx++) { const xx = x + dx; if (xx >= 0 && xx < w && dark[yy * w + xx]) { near = 1; break; } }
    }
    soft[i] = near; out[i] = near && color[i] ? 1 : 0; cls[i] = out[i] ? color[i] : 0;
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
    // dominująca barwa linii: do analizy, które barwy odpowiadają którym typom komunikatów
    let color = null;
    if (cls) {
      const cnt = [0, 0, 0, 0]; for (let k = y0 * w; k < y1 * w; k++) cnt[cls[k]]++;
      const top = cnt.indexOf(Math.max(cnt[1], cnt[2], cnt[3]));
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
 * Obraz linii dla silnika OCR: ciemny tekst na białym tle, powiększony, z marginesem. Rysowane są piksele
 * maski poszerzonej o 1 px oraz piksele luźnej maski (soft) do 2 px od maski: tak wracają przyciemnione
 * kropki nad i oraz ogonki g/p/q/y. Zachowana jest jasność oryginału, więc krawędzie są wygładzone jak w grze.
 */
function renderLine(line, scale, canvas) {
  const pad = 4, W = line.w, H = line.h;
  canvas.width = Math.round((W + pad * 2) * scale); canvas.height = Math.round((H + pad * 2) * scale);
  const ctx = canvas.getContext('2d');
  const small = document.createElement('canvas'); small.width = W + pad * 2; small.height = H + pad * 2;
  const sctx = small.getContext('2d'), img = sctx.createImageData(small.width, small.height), d = img.data;
  d.fill(255);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const r = line.soft && line.soft[y * W + x] ? 2 : 1;
    let on = 0;
    for (let dy = -r; dy <= r && !on; dy++) for (let dx = -r; dx <= r; dx++) {
      const yy = y + dy, xx = x + dx;
      if (yy >= 0 && yy < H && xx >= 0 && xx < W && line.mask[yy * W + xx]) { on = 1; break; }
    }
    if (!on) continue;
    const v = line.gray ? 255 - line.gray[y * W + x] : (line.mask[y * W + x] ? 0 : 255);   // jasny tekst -> ciemny
    const p = ((y + pad) * small.width + (x + pad)) * 4; d[p] = d[p + 1] = d[p + 2] = Math.min(v, 255);
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
