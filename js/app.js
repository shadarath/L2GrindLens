// Spięcie całości: zakładki, bramki między krokami, przyciski, ustawienia, inicjalizacja.
(() => {
const { $, status, settings } = L2GL;
const cap = L2GL.capture, ocr = L2GL.ocr, dash = L2GL.dashboard, files = L2GL.files, msgs = L2GL.messages;
const TABS = [1, 2, 3, 4, 5];   // 1 źródło, 2 podgląd OCR, 3 ustawienia, 4 aktualna sesja, 5 historia

// ---------- dwie instancje dashboardu ----------
function mountDashboard(containerId) {
  const root = $(containerId);
  root.append($('dashTpl').content.cloneNode(true));
  const panel = dash.create(root);
  const run = (fn, errPrefix) => async () => { try { status(await fn(), 'ok'); } catch (e) { status(errPrefix + e.message, 'bad'); } };
  panel.q('btnJsonl').addEventListener('click', run(() => files.exportJsonl(panel.view), 'Eksport nie powiódł się: '));
  panel.q('btnCsv').addEventListener('click', run(() => files.exportCsv(panel.view), 'Eksport nie powiódł się: '));
  panel.q('btnUnknown').addEventListener('click', run(() => files.exportUnknown(panel.view), 'Eksport nie powiódł się: '));
  panel.q('btnSqlite').addEventListener('click', run(() => files.saveSqlite(false), 'Zapis SQLite nie powiódł się: '));
  panel.q('btnFolder').addEventListener('click', run(async () => { const m = await files.pickFolder(); showFolder(); return m; }, 'Nie udało się wybrać folderu: '));
  return panel;
}
const current = mountDashboard('dashCurrent');
const history = mountDashboard('dashHistory');
dash.current = current; dash.history = history;
function showFolder() {
  const t = files.folderName() ? `folder: ${files.folderName()}` : 'folder nie wybrany, pliki trafiają do Pobranych';
  current.q('folderInfo').textContent = t; history.q('folderInfo').textContent = t;
}

// ---------- stan kroków ----------
const sourceReady = () => !!cap.state.source && !!cap.state.region;
const canRun = () => sourceReady() && cap.state.kind === 'video';
const hasSession = () => !!ocr.state.session;
const hasName = () => !!(msgs.opts.playerName || '').trim();
/** Krok po źródle obrazu: ustawienia, a gdy imię postaci jest już ustawione, od razu aktualna sesja. */
const nextAfterSource = () => hasName() ? 4 : 3;

// ---------- zakładki i bramki ----------
function showTab(n) {
  for (const i of TABS) { $('tab' + i).hidden = i !== n; $('nav' + i).classList.toggle('current', i === n); }
  updateGates();
  if (n === 2 && sourceReady()) ocr.startLive($('ocrView')); else ocr.stopLive();
  if (n === 4) dash.scheduleRender(current, true);
  if (n === 5) refreshHistory();
  cap.drawPreview();
}
/** Podgląd (2) wymaga źródła i obszaru; sesja (4) wymaga okna gry albo już istniejącej sesji. */
function updateGates() {
  const g2 = !sourceReady();
  $('gate2').hidden = !g2; $('body2').hidden = g2;

  let g4 = null;
  if (!hasSession() && !canRun()) {
    g4 = sourceReady()
      ? { title: 'Potrzebne okno gry', text: 'Nasłuch działa tylko na obrazie z okna gry. Zrzut ekranu służy wyłącznie do sprawdzenia podglądu. Wróć do kroku 1 i wybierz okno gry.' }
      : { title: 'Najpierw źródło obrazu', text: 'Sesję można zacząć dopiero, gdy jest obraz z gry i zaznaczony obszar czatu. Wróć do kroku 1.' };
  }
  $('gate4').hidden = !g4; $('body4').hidden = !!g4;
  if (g4) { $('gate4Title').textContent = g4.title; $('gate4Text').textContent = g4.text; }
}
for (const i of TABS) $('nav' + i).addEventListener('click', () => showTab(i));
$('btnNext1').addEventListener('click', () => showTab(nextAfterSource()));
$('btnBack2').addEventListener('click', () => showTab(1));
$('btnNext2').addEventListener('click', () => showTab(3));
$('btnBack3').addEventListener('click', () => showTab(sourceReady() ? 2 : 1));
$('btnNext3').addEventListener('click', () => showTab(4));
for (const b of document.querySelectorAll('button[data-goto]')) b.addEventListener('click', () => showTab(+b.dataset.goto));

// ---------- stan przycisków ----------
function updateButtons() {
  const running = ocr.state.running;
  $('btnNext1').disabled = !sourceReady();
  $('btnStart4').disabled = !canRun() || running;
  $('btnStop').disabled = !running;
  $('btnDebug').disabled = !canRun() && !L2GL.debug.state.running;
  $('btnDebug').textContent = L2GL.debug.state.running ? 'Debug: zatrzymaj' : 'Debug: zbieraj próbki';
  $('liveState').textContent = running ? 'nasłuch trwa' : 'zatrzymany';
  $('liveState').className = 'pill' + (running ? ' on' : '');
  $('currentInfo').textContent = ocr.state.session
    ? (running ? `sesja od ${new Date(ocr.state.session).toLocaleTimeString('pl-PL')}` : `ostatnia sesja od ${new Date(ocr.state.session).toLocaleTimeString('pl-PL')}, zakończona`)
    : 'brak sesji, kliknij Start';
  updateGates();
}
cap.onChange(() => { if (!cap.state.source && ocr.state.running) ocr.stop(); updateButtons(); if (!$('tab2').hidden && sourceReady()) ocr.startLive($('ocrView')); });

// ---------- źródło ----------
cap.bind($('preview'));
$('btnShare').addEventListener('click', async () => {
  try {
    const restored = await cap.shareWindow();
    if (restored) { status('Obszar czatu przywrócony.', 'ok'); showTab(nextAfterSource()); }
    else status('Zaznacz myszą tekst czatu systemowego na podglądzie, potem "Dalej".');
  } catch (e) { status('Nie udało się przechwycić okna: ' + e.message, 'bad'); }
});
$('fileShot').addEventListener('change', async e => {
  const f = e.target.files[0]; if (!f) return;
  try { await cap.loadImage(f); status('Zaznacz obszar czatu. Ze zrzutu można tylko sprawdzić podgląd, nasłuch wymaga okna gry.'); }
  catch (err) { status(err.message, 'bad'); }
});
$('btnRegionReset').addEventListener('click', () => cap.setRegion(null, false));
{ const q = new URLSearchParams(location.search).get('img');
  if (q) cap.loadImage(q).then(() => { const [w, h] = cap.srcSize(); cap.setRegion({ x: 0, y: 0, w, h }, false); }).catch(() => {}); }

// ---------- OCR: zdarzenia i sesje ----------
ocr.hooks.onEvents = events => { dash.addEvents(current, events); updateButtons(); };
ocr.hooks.onFrame = s => { $('rawOcr').textContent = s.last ? s.last.raw : ''; };
ocr.hooks.onSessionStart = async id => { await dash.setView(current, id, true); updateButtons(); showTab(4); status('Nasłuch trwa.', 'ok'); };
ocr.hooks.onSessionStop = () => { current.view.live = false; updateButtons(); dash.scheduleRender(current, true); status('Zatrzymano. Sesja jest w historii.'); };
const start = () => ocr.start().catch(e => status(e.message, 'bad'));
$('btnStart4').addEventListener('click', start);
$('btnStop').addEventListener('click', () => ocr.stop());
$('btnDebug').addEventListener('click', async () => {
  try { status(L2GL.debug.state.running ? L2GL.debug.stop() : await L2GL.debug.start(), 'ok'); showFolder(); }
  catch (e) { status('Debug: ' + e.message, 'bad'); }
  updateButtons();
});

// ---------- historia ----------
async function refreshHistory() {
  const running = ocr.state.running ? ocr.state.session : null;
  const sel = await dash.fillSessionList($('sessionSel'), running);
  if (sel !== history.view.session) await dash.setView(history, sel || null, false);
  else dash.scheduleRender(history, true);
}
$('sessionSel').addEventListener('change', () => dash.setView(history, $('sessionSel').value || null, false));

function confirmBox(text, onYes) {
  const box = $('confirmBox'); box.hidden = false; box.innerHTML = '';
  box.append(text + ' ');
  const yes = document.createElement('button'); yes.textContent = 'Tak, usuń'; yes.className = 'danger';
  const no = document.createElement('button'); no.textContent = 'Anuluj'; no.style.marginLeft = '6px';
  yes.onclick = async () => { box.hidden = true; await onYes(); }; no.onclick = () => { box.hidden = true; };
  box.append(yes, no);
}
$('btnClearSession').addEventListener('click', () => {
  const id = history.view.session;
  if (!id) return;
  confirmBox('Usunąć wszystkie zdarzenia tej sesji z magazynu? Tego nie da się cofnąć.', async () => {
    await L2GL.db.clearSession(id);
    if (id === ocr.state.session) { ocr.state.session = null; ocr.state.sessionCount = 0; await dash.setView(current, null, false); updateButtons(); }
    history.view.session = null; await refreshHistory(); status('Sesja usunięta.');
  });
});
$('btnClearAll').addEventListener('click', () => {
  if (ocr.state.running) { status('Najpierw zatrzymaj nasłuch.', 'bad'); return; }
  confirmBox('Usunąć wszystkie sesje i zdarzenia z magazynu przeglądarki? Tego nie da się cofnąć.', async () => {
    await L2GL.db.clearAll(); ocr.state.session = null; ocr.state.sessionCount = 0;
    await dash.setView(current, null, false); history.view.session = null; await refreshHistory(); updateButtons(); status('Magazyn wyczyszczony.');
  });
});

// ---------- ustawienia ----------
$('playerName').addEventListener('change', () => { msgs.opts.playerName = $('playerName').value.trim(); settings.set('playerName', msgs.opts.playerName); updateButtons(); });
/** Pola cen shotów: wszystkie soul- i spiritshoty z bazy gry, domyślnie cena sklepowa, nadpisanie w ustawieniach. */
function buildShotPrices() {
  const box = $('shotPrices'), gd = window.L2_GAMEDATA;
  box.innerHTML = '';
  if (!gd) { box.textContent = 'brak bazy gry'; return; }
  const saved = settings.get('shotPrices', {});
  const shots = Object.entries(gd.items).filter(([, v]) => /^(Blessed )?(Soulshot|Spiritshot)\b/.test(v[0])).sort((a, b) => a[1][0].localeCompare(b[1][0]));
  for (const [id, v] of shots) {
    const lab = document.createElement('label');
    const inp = document.createElement('input'); inp.type = 'number'; inp.min = '0'; inp.step = '1';
    inp.value = saved[id] !== undefined && saved[id] !== '' ? saved[id] : (v[3] || 0);
    inp.title = `cena sklepowa: ${v[3] || 0}`;
    inp.addEventListener('change', () => {
      const cur = settings.get('shotPrices', {});
      if (inp.value === '' || +inp.value === (v[3] || 0)) delete cur[id]; else cur[id] = +inp.value;
      settings.set('shotPrices', cur); dash.scheduleRender(current, true); dash.scheduleRender(history, true);
    });
    lab.append(v[0], inp); box.append(lab);
  }
}
$('shotsPerUse').addEventListener('change', () => { settings.set('shotsPerUse', +$('shotsPerUse').value || 1); dash.scheduleRender(current, true); dash.scheduleRender(history, true); });

function loadSettings() {
  buildShotPrices();
  $('playerName').value = settings.get('playerName', ''); msgs.opts.playerName = $('playerName').value;
  $('shotsPerUse').value = settings.get('shotsPerUse', 1);
  const r = settings.get('region', null);
  if (r) $('regionInfo').textContent = `${r.w}×${r.h} przy (${r.x}, ${r.y}), zapamiętany, zostanie przywrócony po wyborze okna`;
}

// ---------- start ----------
(async () => {
  loadSettings();
  if (window.L2_SYSTEMMSG) msgs.build(window.L2_SYSTEMMSG);
  else status('Brak pliku systemmsg.js obok strony: bez bazy komunikatów żadna linia nie zostanie rozpoznana.', 'bad');
  if (window.L2_GAMEDATA) msgs.buildDicts(window.L2_GAMEDATA);
  else status('Brak pliku gamedata.js obok strony: nazwy przedmiotów i potworów zostaną takie, jak odczytał OCR.', 'bad');
  try { await L2GL.db.open(); $('storeState').textContent = 'magazyn: IndexedDB'; $('storeState').className = 'pill on'; }
  catch (e) { $('storeState').textContent = 'magazyn: niedostępny, dane tylko w pamięci'; }
  await files.restoreFolder();
  showFolder();
  updateButtons();
  showTab(1);
  window.addEventListener('resize', () => { dash.scheduleRender(current); dash.scheduleRender(history); });
  window.l2gl = { cleanLines: L2GL.lines.clean, classify: msgs.classify, matchTemplate: msgs.match, db: L2GL.db, current, history, state: ocr.state, showTab }; // do testów z konsoli
})();
})();
