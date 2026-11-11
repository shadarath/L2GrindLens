// Źródło obrazu (okno gry, zrzut, próbka), podgląd i zaznaczanie obszaru czatu.
(() => {
const { $, settings } = L2GL;
const state = { source: null, kind: null, stream: null, region: null };
const video = document.createElement('video'); video.muted = true; video.playsInline = true;
let preview, pctx, drag = null, previewTimer = null;
const listeners = [];

function onChange(fn) { listeners.push(fn); }
function emit() { for (const fn of listeners) fn(state); }

function srcSize() {
  const s = state.source;
  if (!s) return [0, 0];
  if (s === video) return [video.videoWidth, video.videoHeight];
  if (s instanceof HTMLImageElement) return [s.naturalWidth, s.naturalHeight];
  return [s.width, s.height];
}

function drawPreview() {
  const [sw, sh] = srcSize();
  if (!sw || !sh || !preview || preview.closest('[hidden]')) return;
  const pw = Math.max(200, preview.clientWidth || 640), ph = Math.round(pw * sh / sw);
  if (preview.width !== pw || preview.height !== ph) { preview.width = pw; preview.height = ph; }
  pctx.drawImage(state.source, 0, 0, pw, ph);
  const r = drag || state.region;
  if (r) {
    const k = pw / sw;
    pctx.fillStyle = L2GL.cssVar('--sel'); pctx.fillRect(r.x * k, r.y * k, r.w * k, r.h * k);
    pctx.strokeStyle = L2GL.cssVar('--accent'); pctx.lineWidth = 2; pctx.strokeRect(r.x * k, r.y * k, r.w * k, r.h * k);
  }
}

function toSrc(e) {
  const b = preview.getBoundingClientRect(), [sw] = srcSize(), k = sw / b.width;
  return { x: Math.max(0, (e.clientX - b.left) * k), y: Math.max(0, (e.clientY - b.top) * k) };
}

function setRegion(r, remember) {
  state.region = r;
  $('regionInfo').textContent = r ? `${r.w}×${r.h} przy (${r.x}, ${r.y})` : 'nie zaznaczony';
  if (remember && r && state.kind !== 'sample') settings.set('region', r);
  drawPreview(); emit();
}

/** Przywraca zapamiętany obszar, jeśli mieści się w bieżącym źródle. */
function restoreRegion() {
  const saved = settings.get('region', null), [sw, sh] = srcSize();
  if (saved && saved.x + saved.w <= sw && saved.y + saved.h <= sh) { setRegion(saved, false); return true; }
  return false;
}

function setSource(src, kind, label) {
  state.source = src; state.kind = kind;
  const el = $('capState'); el.textContent = label; el.className = 'pill on';
  clearInterval(previewTimer); previewTimer = setInterval(drawPreview, kind === 'video' ? 100 : 500);
  drawPreview(); emit();
}

async function shareWindow() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) throw new Error('Ta przeglądarka nie udostępnia przechwytywania ekranu. Użyj Chrome lub Edge.');
  const stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { ideal: 10 } }, audio: false });
  if (state.stream) state.stream.getTracks().forEach(t => t.stop());
  state.stream = stream; video.srcObject = stream; await video.play();
  stream.getVideoTracks()[0].addEventListener('ended', () => {
    state.source = null; state.stream = null;
    const el = $('capState'); el.textContent = 'udostępnianie zakończone'; el.className = 'pill';
    emit();
  });
  setSource(video, 'video', `okno ${video.videoWidth}×${video.videoHeight}`);
  return restoreRegion();
}

function loadImage(file) {
  return new Promise((res, rej) => {
    const img = new Image();
    img.onload = () => { setSource(img, 'image', `zrzut ${img.naturalWidth}×${img.naturalHeight}`); res(restoreRegion()); };
    img.onerror = () => rej(new Error('nie udało się wczytać obrazu'));
    img.src = typeof file === 'string' ? file : URL.createObjectURL(file);
  });
}

function bind(canvas) {
  preview = canvas; pctx = canvas.getContext('2d');
  canvas.addEventListener('pointerdown', e => { if (!state.source) return; canvas.setPointerCapture(e.pointerId); const p = toSrc(e); drag = { x0: p.x, y0: p.y, x: p.x, y: p.y, w: 0, h: 0 }; });
  canvas.addEventListener('pointermove', e => { if (!drag) return; const p = toSrc(e); drag.x = Math.min(drag.x0, p.x); drag.y = Math.min(drag.y0, p.y); drag.w = Math.abs(p.x - drag.x0); drag.h = Math.abs(p.y - drag.y0); drawPreview(); });
  canvas.addEventListener('pointerup', () => { if (!drag) return; const d = drag; drag = null; if (d.w > 10 && d.h > 6) setRegion({ x: Math.round(d.x), y: Math.round(d.y), w: Math.round(d.w), h: Math.round(d.h) }, true); else drawPreview(); });
}

L2GL.capture = { state, srcSize, bind, drawPreview, setSource, setRegion, restoreRegion, shareWindow, loadImage, onChange };
})();
