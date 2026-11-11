// Czyszczenie surowego tekstu OCR i wykrywanie nowych linii między klatkami.
(() => {
// 1. usuwa śmieci z ikon przy lewej krawędzi, 2. odrzuca linie bez sensownej treści,
// 3. skleja linie zawinięte w oknie czatu (komunikat kończy się kropką, wykrzyknikiem lub pytajnikiem).
function clean(text) {
  const raw = text.split('\n').map(s => s.trim()).filter(Boolean), out = [];
  const terminated = t => /[.!?,]$/.test(t);
  for (let s of raw) {
    s = s.replace(/^[^A-Za-z0-9]+/, '')               // ikony, myślniki, cudzysłowy
         .replace(/^\S{1,3}\s+(?=[A-Z])/, '')         // krótki śmieć z ikony przed komunikatem ("77 You have...")
         .replace(/\s{2,}/g, ' ').trim();
    for (const [re, rep] of L2GL.messages.OCR_FIXES) s = s.replace(re, rep);
    const realWords = s.split(' ').filter(w => w.replace(/[^A-Za-z0-9]/g, '').length >= 3).length;
    const prev = out[out.length - 1];
    if (realWords < 2) {
      // fragment typu "time," albo "Lieutenant." to końcówka zawiniętej linii; samotne śmieci odpadają
      if (prev !== undefined && !terminated(prev)) out[out.length - 1] = prev + ' ' + s;
      continue;
    }
    if (prev !== undefined && !terminated(prev) && (/^[a-z]/.test(s) || s.split(' ').length <= 3)) out[out.length - 1] = prev + ' ' + s;
    else out.push(s);
  }
  return out;
}

function norm(s) { return s.toLowerCase().replace(/[^a-z0-9ąćęłńóśźż ]+/g, ' ').replace(/\s+/g, ' ').trim(); }

/** Podobieństwo 0..1 na bazie odległości Levenshteina. */
function sim(a, b) {
  a = norm(a); b = norm(b);
  if (a === b) return 1;
  const m = a.length, n = b.length;
  if (!m || !n) return 0;
  let prev = new Array(n + 1), cur = new Array(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    cur[0] = i;
    for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    [prev, cur] = [cur, prev];
  }
  return 1 - prev[n] / Math.max(m, n);
}

/** Linie z bieżącej klatki, których nie było w poprzedniej (z tolerancją na pomyłki OCR). */
function newLines(prev, cur) {
  const T = 0.8;
  for (let k = Math.min(prev.length, cur.length); k >= 1; k--) {
    let ok = true;
    for (let i = 0; i < k && ok; i++) if (sim(prev[prev.length - k + i], cur[i]) < T) ok = false;
    if (ok) return cur.slice(k);
  }
  return cur.filter(c => !prev.some(p => sim(p, c) >= T));
}

L2GL.lines = { clean, sim, newLines };
})();
