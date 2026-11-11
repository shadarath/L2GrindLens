// Spięcie całości: zakładki, przyciski, ustawienia, inicjalizacja.
(() => {
const { $, status, settings } = L2GL;
const cap = L2GL.capture, ocr = L2GL.ocr, dash = L2GL.dashboard, files = L2GL.files, msgs = L2GL.messages;
const PATTERNS_KEY = 'patterns.v3';

// ---------- zakładki ----------
function showTab(n) {
  for (const i of [1, 2, 3]) { $('tab' + i).hidden = i !== n; $('nav' + i).classList.toggle('current', i === n); }
  settings.set('tab', n);
  if (n === 2) ocr.startLive($('ocrView')); else ocr.stopLive();
  if (n === 3) dash.scheduleRender(true);
  cap.drawPreview();
}
for (const i of [1, 2, 3]) $('nav' + i).addEventListener('click', () => showTab(i));
$('btnNext1').addEventListener('click', () => showTab(2));
$('btnBack2').addEventListener('click', () => showTab(1));

// ---------- stan przycisków ----------
function updateButtons() {
  const ready = !!cap.state.source && !!cap.state.region;
  const canRun = ready && cap.state.kind === 'video', running = ocr.state.running;
  $('btnNext1').disabled = !ready;
  $('btnStart').disabled = !canRun || running;
  $('btnStart3').disabled = !canRun || running;
  $('btnStop').disabled = !running;
  $('btnSaveSample').disabled = !ocr.state.last;
  $('liveState').textContent = running ? 'nasłuch trwa' : 'zatrzymany';
  $('liveState').className = 'pill' + (running ? ' on' : '');
  $('nav1').classList.toggle('done', ready);
  $('nav2').classList.toggle('done', running || ocr.state.sessionCount > 0);
}
cap.onChange(() => { if (!cap.state.source && ocr.state.running) ocr.stop(); updateButtons(); });

// ---------- źródło ----------
cap.bind($('preview'));
$('btnShare').addEventListener('click', async () => {
  try {
    const restored = await cap.shareWindow();
    status(restored ? 'Przywrócono zapamiętany obszar czatu. Sprawdź go na podglądzie i przejdź dalej.' : 'Zaznacz myszą obszar czatu systemowego na podglądzie, potem "Dalej".', restored ? 'ok' : '');
  } catch (e) { status('Nie udało się przechwycić okna: ' + e.message, 'bad'); }
});
$('fileShot').addEventListener('change', async e => {
  const f = e.target.files[0]; if (!f) return;
  try { await cap.loadImage(f); status('Zaznacz obszar czatu i przejdź dalej, podgląd obróbki jest na żywo.'); }
  catch (err) { status(err.message, 'bad'); }
});
$('btnRegionReset').addEventListener('click', () => cap.setRegion(null, false));
$('btnRegionAll').addEventListener('click', () => { const [w, h] = cap.srcSize(); if (w && h) cap.setRegion({ x: 0, y: 0, w, h }, true); });
$('btnSample').addEventListener('click', async () => {
  try {
    const [a, b, c] = await ocr.sampleTest();
    const ok = a === 0 && b === 2 && c === 3;
    status(`Test próbki: klatka 1: ${a} (oczekiwano 0), klatka 2: ${b} (oczekiwano 2), klatka 3: ${c} (oczekiwano 3). ${ok ? 'OK' : 'Rozbieżność, sprawdź dziennik.'}`, ok ? 'ok' : 'bad');
  } catch (e) { status('Test nie powiódł się: ' + e.message, 'bad'); }
});
{ const q = new URLSearchParams(location.search).get('img');
  if (q) cap.loadImage(q).then(() => { const [w, h] = cap.srcSize(); cap.setRegion({ x: 0, y: 0, w, h }, false); }).catch(() => {}); }

// ---------- OCR: zdarzenia i sesje ----------
ocr.hooks.onEvents = (events, persist) => { dash.addEvents(events, persist); updateButtons(); };
ocr.hooks.onFrame = s => { $('rawOcr').textContent = s.last ? s.last.raw : ''; };
ocr.hooks.onSessionStart = async id => { await dash.setView(id, id); await dash.refreshSessionList(id); updateButtons(); showTab(3); status('Nasłuch trwa. Zdarzenia pojawiają się w dzienniku i zapisują w magazynie.', 'ok'); };
ocr.hooks.onSessionStop = () => { updateButtons(); dash.scheduleRender(true); status('Zatrzymano. Sesja zapisana.'); };
const start = () => ocr.start().catch(e => status(e.message, 'bad'));
$('btnStart').addEventListener('click', start);
$('btnStart3').addEventListener('click', start);
$('btnStop').addEventListener('click', () => ocr.stop());
$('sessionSel').addEventListener('change', () => { if ($('sessionSel').value) dash.setView($('sessionSel').value, ocr.state.session); });
$('logFilter').addEventListener('change', () => dash.redrawLog());

// ---------- pliki ----------
const run = (fn, errPrefix) => async () => { try { status(await fn(), 'ok'); } catch (e) { status(errPrefix + e.message, 'bad'); } };
$('btnSaveSample').addEventListener('click', run(files.saveSample, 'Zapis próbki nie powiódł się: '));
$('btnSqlite').addEventListener('click', run(() => files.saveSqlite(false), 'Zapis SQLite nie powiódł się: '));
$('btnFolder').addEventListener('click', run(files.pickFolder, 'Nie udało się wybrać folderu: '));
$('btnJsonl').addEventListener('click', run(files.exportJsonl, 'Eksport nie powiódł się: '));
$('btnCsv').addEventListener('click', run(files.exportCsv, 'Eksport nie powiódł się: '));

// ---------- czyszczenie ----------
function confirmBox(text, onYes) {
  const box = $('confirmBox'); box.hidden = false; box.innerHTML = '';
  box.append(text + ' ');
  const yes = document.createElement('button'); yes.textContent = 'Tak, usuń'; yes.className = 'danger';
  const no = document.createElement('button'); no.textContent = 'Anuluj'; no.style.marginLeft = '6px';
  yes.onclick = async () => { box.hidden = true; await onYes(); }; no.onclick = () => { box.hidden = true; };
  box.append(yes, no);
}
$('btnClearSession').addEventListener('click', () => {
  const v = dash.view;
  if (!v.session) return;
  if (v.session === ocr.state.session && ocr.state.running) { status('Najpierw zatrzymaj nasłuch.', 'bad'); return; }
  confirmBox('Usunąć wszystkie zdarzenia tej sesji z magazynu? Tego nie da się cofnąć.', async () => {
    await L2GL.db.clearSession(v.session);
    if (v.session === ocr.state.session) { ocr.state.session = null; ocr.state.sessionCount = 0; }
    await dash.refreshSessionList(ocr.state.session); await dash.setView($('sessionSel').value || null, ocr.state.session); status('Sesja usunięta.');
  });
});
$('btnClearAll').addEventListener('click', () => {
  if (ocr.state.running) { status('Najpierw zatrzymaj nasłuch.', 'bad'); return; }
  confirmBox('Usunąć wszystkie sesje i zdarzenia z magazynu przeglądarki? Tego nie da się cofnąć.', async () => {
    await L2GL.db.clearAll(); ocr.state.session = null; ocr.state.sessionCount = 0;
    await dash.refreshSessionList(null); await dash.setView(null, null); status('Magazyn wyczyszczony.');
  });
});

// ---------- ustawienia ----------
function applyPatterns() { const err = msgs.compilePatterns($('patterns').value); $('patternsErr').textContent = err ? 'Błąd we wzorcach: ' + err : ''; if (!err) settings.set(PATTERNS_KEY, $('patterns').value); }
$('thr').addEventListener('input', () => { $('thrVal').textContent = $('thr').value; settings.set('thr', +$('thr').value); });
for (const id of ['fps', 'scale']) $(id).addEventListener('change', () => settings.set(id, $(id).value));
for (const id of ['bright', 'baseline']) $(id).addEventListener('change', () => settings.set(id, $(id).checked));
$('useDb').addEventListener('change', () => { msgs.opts.useDb = $('useDb').checked; settings.set('useDb', msgs.opts.useDb); });
$('playerName').addEventListener('change', () => { msgs.opts.playerName = $('playerName').value.trim(); settings.set('playerName', msgs.opts.playerName); });
$('patterns').addEventListener('change', applyPatterns);
$('btnPatternsReset').addEventListener('click', () => { $('patterns').value = JSON.stringify(msgs.DEFAULT_PATTERNS, null, 2); applyPatterns(); });

function loadSettings() {
  $('thr').value = settings.get('thr', 140); $('thrVal').textContent = $('thr').value;
  $('fps').value = settings.get('fps', '4'); $('scale').value = settings.get('scale', '2');
  $('bright').checked = settings.get('bright', true); $('baseline').checked = settings.get('baseline', true);
  $('useDb').checked = settings.get('useDb', true); msgs.opts.useDb = $('useDb').checked;
  $('playerName').value = settings.get('playerName', ''); msgs.opts.playerName = $('playerName').value;
  $('patterns').value = settings.get(PATTERNS_KEY, JSON.stringify(msgs.DEFAULT_PATTERNS, null, 2)); applyPatterns();
  const r = settings.get('region', null);
  if (r) $('regionInfo').textContent = `${r.w}×${r.h} przy (${r.x}, ${r.y}), zapamiętany, zostanie przywrócony po wyborze okna`;
}

// ---------- start ----------
(async () => {
  loadSettings();
  if (window.L2_SYSTEMMSG) { const n = msgs.build(window.L2_SYSTEMMSG); $('dbState').textContent = `baza: ${n} szablonów`; $('dbState').className = 'pill on'; }
  else $('dbState').textContent = 'baza: brak pliku systemmsg.js';
  try { await L2GL.db.open(); $('storeState').textContent = 'magazyn: IndexedDB'; $('storeState').className = 'pill on'; }
  catch (e) { $('storeState').textContent = 'magazyn: niedostępny, dane tylko w pamięci'; }
  await files.restoreFolder();
  await dash.refreshSessionList(null);
  if ($('sessionSel').value) await dash.setView($('sessionSel').value, null);
  updateButtons();
  showTab(1);
  window.addEventListener('resize', () => { if (!$('tab3').hidden) dash.scheduleRender(); });
  window.l2gl = { cleanLines: L2GL.lines.clean, classify: msgs.classify, matchTemplate: msgs.match, db: L2GL.db, view: dash.view, state: ocr.state }; // do testów z konsoli
})();
})();
