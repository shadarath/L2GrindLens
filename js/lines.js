// Czyszczenie surowego tekstu OCR i wykrywanie nowych linii między klatkami.
(() => {
// 1. usuwa śmieci z ikon przy lewej krawędzi, 2. odrzuca linie bez sensownej treści,
// 3. skleja linie zawinięte w oknie czatu (komunikat kończy się kropką, wykrzyknikiem lub pytajnikiem).
function clean(text) {
  const raw = text.split('\n').map(s => s.trim()).filter(Boolean), out = [];
  const terminated = t => /[.!?,]$/.test(t);
  for (let s of raw) {
    s = s.replace(/^[^A-Za-z0-9]+/, '').replace(/\s{2,}/g, ' ').trim();   // ikony, myślniki, cudzysłowy
    // krótki śmieć z ikony przed komunikatem ("77 You have...", "br) You...", "T You..."), ale nie prawdziwe słowo ("Use Soulshot")
    const m = /^(\S{1,3})\s+(?=[A-Z])/.exec(s);
    if (m && isJunkToken(m[1])) s = s.slice(m[0].length);
    for (const [re, rep] of L2GL.messages.OCR_FIXES) s = s.replace(re, rep);
    // śmieci za końcem zdania (krawędź okna, ikony): "...and 8 SP. 55 t" -> "...and 8 SP."
    const end = s.search(/[.!?](?=\s)/);
    if (end > 0 && !/[A-Za-z]{3,}/.test(s.slice(end + 1))) s = s.slice(0, end + 1);
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

const SHORT_WORDS = new Set(['use', 'you', 'the', 'not', 'no', 'an', 'it', 'due', 'as', 'at', 'if', 'in', 'on', 'to', 'by', 'of', 'is', 'be', 'do', 'go', 'up', 'we', 'he', 'hp', 'mp', 'xp', 'sp']);
/** Token przed komunikatem jest śmieciem, gdy ma znak spoza liter albo jest literą/zbitką, która nie jest słowem. */
function isJunkToken(t) {
  if (SHORT_WORDS.has(t.toLowerCase())) return false;
  return /[^A-Za-z]/.test(t) || t.length <= 2 || !/^[A-Z][a-z]{2}$/.test(t);
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

L2GL.lines = { clean, sim };
})();
