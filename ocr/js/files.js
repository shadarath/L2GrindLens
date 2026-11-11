// Folder danych (File System Access API), zapis próbek, eksport JSONL/CSV i bazy SQLite (sql.js).
(() => {
const { $, status, fmt } = L2GL;
let dirHandle = null, SQL = null;

async function restoreFolder() {
  try { dirHandle = (await L2GL.db.kvGet('dirHandle')) || null; } catch (e) { dirHandle = null; }
}

/** Zwraca true, gdy mamy zapisywalny folder. `interactive` pozwala poprosić o uprawnienie lub otworzyć wybór folderu. */
async function ensureFolder(interactive) {
  if (dirHandle) {
    if (await dirHandle.queryPermission({ mode: 'readwrite' }) === 'granted') return true;
    if (interactive && await dirHandle.requestPermission({ mode: 'readwrite' }) === 'granted') return true;
    return false;
  }
  if (!interactive || !window.showDirectoryPicker) return false;
  try { dirHandle = await window.showDirectoryPicker({ mode: 'readwrite', id: 'l2grindlens-data' }); }
  catch (e) { if (e.name === 'AbortError') return false; throw e; }
  await L2GL.db.kvSet('dirHandle', dirHandle).catch(() => {});
  return true;
}

/** Zapisuje do folderu danych albo (gdy interaktywnie i bez folderu) pobiera plik. Zwraca 'folder' lub 'download'. */
async function writeFile(name, blob, interactive) {
  if (await ensureFolder(interactive)) {
    const fh = await dirHandle.getFileHandle(name, { create: true });
    const w = await fh.createWritable(); await w.write(blob); await w.close();
    return 'folder';
  }
  if (!interactive) throw new Error('brak dostępu do folderu');
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  return 'download';
}

async function ensureSql() {
  if (SQL) return SQL;
  const base = 'https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.10.3/';
  if (typeof initSqlJs === 'undefined') await new Promise((res, rej) => { const s = document.createElement('script'); s.src = base + 'sql-wasm.js'; s.onload = res; s.onerror = () => rej(new Error('nie udało się wczytać sql.js')); document.head.append(s); });
  SQL = await initSqlJs({ locateFile: f => base + f });
  return SQL;
}

/** Buduje plik SQLite ze wszystkich sesji i zdarzeń w magazynie. */
async function saveSqlite(quiet) {
  const sql = await ensureSql();
  const sessions = await L2GL.db.sessions(), events = await L2GL.db.allEvents();
  const d = new sql.Database();
  d.run(`CREATE TABLE sessions (id TEXT PRIMARY KEY, start TEXT, end TEXT, events INTEGER);
         CREATE TABLE events (id INTEGER PRIMARY KEY, session TEXT, time TEXT, ts INTEGER, type TEXT, msg_id INTEGER,
           dmg INTEGER, exp INTEGER, sp INTEGER, qty INTEGER, item TEXT, src TEXT, target TEXT, skill TEXT, text TEXT, fields TEXT);
         CREATE INDEX ix_events_session ON events(session); CREATE INDEX ix_events_ts ON events(ts);`);
  const ps = d.prepare('INSERT INTO sessions VALUES (?,?,?,?)');
  for (const s of sessions) ps.run([s.id, new Date(s.start).toISOString(), new Date(s.end).toISOString(), s.count]);
  ps.free();
  const pe = d.prepare('INSERT INTO events VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
  for (const e of events) {
    const f = e.fields || {};
    pe.run([e.id, e.session, e.time, e.ts, e.type, f.id ?? null, f.dmg ?? null, f.exp ?? null, f.sp ?? null, f.qty ?? null, f.item ?? null, f.src ?? null, f.target ?? null, f.skill ?? null, e.text, JSON.stringify(f)]);
  }
  pe.free();
  const bytes = d.export(); d.close();
  const where = await writeFile('l2grindlens.sqlite', new Blob([bytes], { type: 'application/x-sqlite3' }), !quiet);
  return where === 'folder' ? `Zapisano l2grindlens.sqlite w folderze ${dirHandle.name} (${events.length} zdarzeń, ${sessions.length} sesji).` : `Pobrano l2grindlens.sqlite (${events.length} zdarzeń, ${sessions.length} sesji).`;
}

/** Cichy zapis bazy do folderu danych, jeśli jest wybrany (co minutę w trakcie sesji i przy zatrzymaniu). */
function autosave() { if (dirHandle) saveSqlite(true).catch(() => {}); }

function sessionTag(view) { return view.session ? view.session.replace(/[:.]/g, '-').slice(0, 19) : 'sesja'; }
function jsonl(view) { return view.events.map(e => JSON.stringify(e)).join('\n') + '\n'; }
function csv(view) {
  const q = v => '"' + String(v ?? '').replace(/"/g, '""') + '"';
  return 'time,type,msg_id,dmg,exp,sp,qty,item,src,target,text\n' + view.events.map(e => { const f = e.fields || {}; return [e.time, e.type, f.id, f.dmg, f.exp, f.sp, f.qty, f.item, f.src, f.target, e.text].map(q).join(','); }).join('\n') + '\n';
}
/** Eksport zdarzeń widoku (sesji) dashboardu. */
async function exportJsonl(view) { const w = await writeFile(`events-${sessionTag(view)}.jsonl`, new Blob([jsonl(view)], { type: 'text/plain' }), true); return w === 'folder' ? 'Zapisano JSONL w folderze danych.' : 'Pobrano JSONL.'; }
async function exportCsv(view) { const w = await writeFile(`events-${sessionTag(view)}.csv`, new Blob([csv(view)], { type: 'text/csv' }), true); return w === 'folder' ? 'Zapisano CSV w folderze danych.' : 'Pobrano CSV.'; }

async function pickFolder() { if (await ensureFolder(true)) return `Folder danych: ${dirHandle.name}.`; return 'Nie wybrano folderu.'; }

L2GL.files = { restoreFolder, pickFolder, saveSqlite, autosave, exportJsonl, exportCsv, folderName: () => dirHandle && dirHandle.name };
})();
