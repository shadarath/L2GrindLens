// Pasek linii czasu pod statystykami: uproszczony przebieg XP i zysku z całej sesji, znaczniki ważnych momentów
// i ramka wyboru zakresu (lewy uchwyt: początek, prawy: koniec, środek: przesunięcie, przeciągnięcie poza ramką:
// nowy zakres). Stan ramki należy wyłącznie do paska; dashboard czyta go przy każdym przeliczeniu i dosuwa
// ramkę do nowego końca sesji wg trybu (advance).
(() => {
const { cssVar } = L2GL;
const H = 56, SNAP = 4, GRIP = 7, MIN_SPAN = 60000;   // wysokość, zasięg przylegania do końca (px), zasięg uchwytu (px), minimalna szerokość ramki

/**
 * Tworzy pasek na `canvas`. `onChange(final)` wołane przy każdej zmianie ramki przez użytkownika (final = puszczenie).
 * Tryb ramki: all (obie krawędzie na końcach: rośnie z sesją), tail (prawa na końcu: stała szerokość, podąża
 * za najnowszymi), fixed (stoi w miejscu).
 */
function create(canvas, { onChange }) {
  const tl = { canvas, start: 0, end: 1, from: 0, to: 1, mode: 'all', xp: [], profit: [], markers: [], drag: null };
  const ctx = canvas.getContext('2d');
  const width = () => canvas.clientWidth || 600;
  const toX = t => (t - tl.start) / Math.max(tl.end - tl.start, 1) * width();
  const toT = x => tl.start + x / width() * (tl.end - tl.start);

  /** Dane z przeliczenia dashboardu: zakres sesji, punkty (wartości na godzinę) i znaczniki {ts, label}. */
  tl.setData = ({ start, end, xp, profit, markers }) => { tl.start = start; tl.end = Math.max(end, start + 1); tl.xp = xp; tl.profit = profit; tl.markers = markers; };
  /** Dosuwa ramkę do nowego końca sesji według trybu; zwraca zakres. Nie rusza ramki w trakcie przeciągania. */
  tl.advance = () => {
    if (!tl.drag) {
      if (tl.mode === 'all') { tl.from = tl.start; tl.to = tl.end; }
      else if (tl.mode === 'tail') { const w = tl.to - tl.from; tl.to = tl.end; tl.from = Math.max(tl.start, tl.end - w); }
      else { tl.from = Math.max(tl.start, Math.min(tl.from, tl.end)); tl.to = Math.max(tl.from, Math.min(tl.to, tl.end)); }
    }
    return { from: tl.from, to: tl.to };
  };
  tl.isAll = () => tl.mode === 'all';
  tl.reset = () => { tl.mode = 'all'; tl.from = tl.start; tl.to = tl.end; onChange(true); };

  tl.draw = () => {
    const w = width(), dpr = window.devicePixelRatio || 1;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(H * dpr)) { canvas.width = Math.round(w * dpr); canvas.height = Math.round(H * dpr); }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, H);
    const n = tl.xp.length, top = 10, bottom = H - 2, plotH = bottom - top;
    const series = (arr, color, alpha) => {
      if (!n) return;
      let mx = 0, mn = 0; for (const v of arr) { if (v > mx) mx = v; if (v < mn) mn = v; }
      const span = Math.max(mx - mn, 1e-9), y = v => bottom - (v - mn) / span * plotH, y0 = y(0);
      ctx.beginPath(); ctx.moveTo(0, y0);
      for (let i = 0; i < n; i++) ctx.lineTo((i + 0.5) / n * w, y(arr[i]));
      ctx.lineTo(w, y0); ctx.closePath();
      ctx.globalAlpha = alpha; ctx.fillStyle = color; ctx.fill(); ctx.globalAlpha = 1;
      ctx.beginPath(); for (let i = 0; i < n; i++) ctx[i ? 'lineTo' : 'moveTo']((i + 0.5) / n * w, y(arr[i]));
      ctx.strokeStyle = color; ctx.lineWidth = 1; ctx.stroke();
    };
    series(tl.xp, cssVar('--xp'), 0.18);      // XP fioletowe jak na wykresie XP, zysk zielony jak na wykresie zysku, znaczniki bursztynowe
    series(tl.profit, cssVar('--ok'), 0.18);
    // znaczniki: trójkąt u góry
    ctx.fillStyle = cssVar('--warn');
    for (const m of tl.markers) { const x = toX(m.ts); ctx.beginPath(); ctx.moveTo(x - 4, 1); ctx.lineTo(x + 4, 1); ctx.lineTo(x, 8); ctx.closePath(); ctx.fill(); }
    // ramka: przyciemnienie poza zakresem, krawędzie i uchwyty
    const x1 = toX(tl.from), x2 = toX(tl.to);
    ctx.fillStyle = 'rgba(0,0,0,0.5)'; ctx.fillRect(0, 0, x1, H); ctx.fillRect(x2, 0, w - x2, H);
    ctx.strokeStyle = cssVar('--accent'); ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(x1, 0); ctx.lineTo(x1, H); ctx.moveTo(x2, 0); ctx.lineTo(x2, H); ctx.stroke();
    ctx.fillStyle = cssVar('--accent');
    for (const x of [x1, x2]) { ctx.fillRect(x - 3, H / 2 - 9, 6, 18); }
    ctx.fillStyle = cssVar('--panel'); for (const x of [x1, x2]) { ctx.fillRect(x - 0.5, H / 2 - 5, 1, 10); }
  };

  const hit = x => {
    const x1 = toX(tl.from), x2 = toX(tl.to);
    if (Math.abs(x - x1) <= GRIP && Math.abs(x - x2) <= GRIP) return x < (x1 + x2) / 2 ? 'left' : 'right';
    if (Math.abs(x - x1) <= GRIP) return 'left';
    if (Math.abs(x - x2) <= GRIP) return 'right';
    if (x > x1 && x < x2) return 'move';
    return 'new';
  };
  const px = e => Math.max(0, Math.min(width(), e.clientX - canvas.getBoundingClientRect().left));
  canvas.addEventListener('pointerdown', e => {
    if (e.button !== 0) return;
    const x = px(e), kind = hit(x);
    canvas.setPointerCapture(e.pointerId);
    tl.drag = { kind, x0: x, from0: tl.from, to0: tl.to, t0: toT(x) };
    if (kind === 'new') { tl.from = tl.to = toT(x); }
    e.preventDefault();
  });
  canvas.addEventListener('pointermove', e => {
    const x = px(e);
    if (!tl.drag) {
      const kind = hit(x); canvas.style.cursor = kind === 'move' ? 'grab' : kind === 'new' ? 'crosshair' : 'ew-resize';
      const m = tl.markers.find(m => Math.abs(toX(m.ts) - x) <= 5); canvas.title = m ? m.label : '';
      return;
    }
    const d = tl.drag, dt = toT(x) - d.t0, span = tl.end - tl.start;
    if (d.kind === 'left') tl.from = Math.max(tl.start, Math.min(d.from0 + dt, tl.to - MIN_SPAN));
    else if (d.kind === 'right') tl.to = Math.min(tl.end, Math.max(d.to0 + dt, tl.from + MIN_SPAN));
    else if (d.kind === 'move') { const w = d.to0 - d.from0, f = Math.max(tl.start, Math.min(d.from0 + dt, tl.end - w)); tl.from = f; tl.to = f + w; }
    else { const t = toT(x); tl.from = Math.max(tl.start, Math.min(d.t0, t)); tl.to = Math.min(tl.end, Math.max(d.t0, t)); }
    if (span <= MIN_SPAN) { tl.from = tl.start; tl.to = tl.end; }
    tl.mode = 'fixed';
    tl.draw(); onChange(false);
  });
  const finish = e => {
    if (!tl.drag) return;
    const d = tl.drag; tl.drag = null;
    if (d.kind === 'new' && tl.to - tl.from < MIN_SPAN) { tl.from = d.from0; tl.to = d.to0; }   // kliknięcie bez przeciągnięcia: bez zmian
    // przyleganie do końców decyduje o trybie
    const snapT = SNAP / width() * (tl.end - tl.start);
    const atStart = tl.from - tl.start <= snapT, atEnd = tl.end - tl.to <= snapT;
    if (atStart) tl.from = tl.start; if (atEnd) tl.to = tl.end;
    tl.mode = atStart && atEnd ? 'all' : atEnd ? 'tail' : 'fixed';
    tl.draw(); onChange(true);
  };
  canvas.addEventListener('pointerup', finish); canvas.addEventListener('pointercancel', finish);
  return tl;
}

L2GL.timeline = { create, MIN_SPAN };
})();
