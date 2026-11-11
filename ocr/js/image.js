// Obróbka obrazu: wycięcie obszaru, powiększenie, binaryzacja, wykrywanie zmian między klatkami.
(() => {
/**
 * Rysuje wycinek źródła do canvasu w skali `scale` i zamienia na czarny tekst na białym tle.
 * Zwraca ImageData wyniku.
 */
function preprocess(source, region, { scale, thr, bright }, canvas) {
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  canvas.width = Math.max(8, Math.round(region.w * scale));
  canvas.height = Math.max(8, Math.round(region.h * scale));
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(source, region.x, region.y, region.w, region.h, 0, 0, canvas.width, canvas.height);
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height), d = img.data;
  let sum = 0;
  for (let i = 0; i < d.length; i += 4) sum += (d[i] * 299 + d[i + 1] * 587 + d[i + 2] * 114) / 1000;
  const darkBg = sum / (d.length / 4) < 128;
  for (let i = 0; i < d.length; i += 4) {
    let text;
    if (bright) text = Math.max(d[i], d[i + 1], d[i + 2]) > thr;
    else { let l = (d[i] * 299 + d[i + 1] * 587 + d[i + 2] * 114) / 1000; if (darkBg) l = 255 - l; text = l < thr; }
    const v = text ? 0 : 255;
    d[i] = d[i + 1] = d[i + 2] = v; d[i + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return img;
}

/** Kopia wycinka w kolorze i oryginalnej skali (do zapisu próbki). */
function cropColor(source, region, canvas) {
  canvas.width = Math.max(1, Math.round(region.w));
  canvas.height = Math.max(1, Math.round(region.h));
  canvas.getContext('2d').drawImage(source, region.x, region.y, region.w, region.h, 0, 0, canvas.width, canvas.height);
}

/** Sygnatura rozkładu czarnych pikseli w siatce 64x24, do taniego porównania klatek. */
function signature(img) {
  const cols = 64, rows = 24, sig = new Float32Array(cols * rows), cw = img.width / cols, ch = img.height / rows, d = img.data;
  for (let y = 0; y < img.height; y++) for (let x = 0; x < img.width; x++)
    if (d[(y * img.width + x) * 4] === 0) sig[Math.min(rows - 1, (y / ch) | 0) * cols + Math.min(cols - 1, (x / cw) | 0)]++;
  const cell = cw * ch;
  for (let i = 0; i < sig.length; i++) sig[i] /= cell;
  return sig;
}

/** Zmiana globalna (przewinięcie) albo lokalna (choćby jedna cyfra w komórce siatki) liczy się jako nowa klatka. */
function changed(sig, prevSig) {
  if (!prevSig) return true;
  let sum = 0, max = 0;
  for (let i = 0; i < sig.length; i++) { const d = Math.abs(sig[i] - prevSig[i]); sum += d; if (d > max) max = d; }
  return max > 0.05 || sum / sig.length > 0.003;
}

/** Rysuje canvas źródłowy do canvasu podglądu, dopasowując szerokość do kontenera. */
function showIn(src, view) {
  const avail = (view.parentElement.clientWidth || 0) - 24;
  if (avail < 50 || !src.width) return; // kontener niewidoczny lub bez szerokości: nie zerujemy canvasu
  const vw = Math.min(src.width, avail), vh = Math.round(src.height * vw / src.width);
  if (view.width !== vw || view.height !== vh) { view.width = vw; view.height = vh; }
  view.getContext('2d').drawImage(src, 0, 0, vw, vh);
}

L2GL.image = { preprocess, cropColor, signature, changed, showIn };
})();
