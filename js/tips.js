// Porady na start: okno z kilkoma stronami (nagłówek "Ważna porada x/y", poprzednia/następna). Przy pierwszym
// uruchomieniu trzeba przejść wszystkie strony, zanim okno da się zamknąć; później przycisk "Porady" w nagłówku
// otwiera je z możliwością zamknięcia w każdej chwili.
(() => {
const { $, settings } = L2GL;
const TIPS = [
  {
    text: 'Upewnij się, że okienko komunikatów jest włączone i ma aktywne tło: w ustawieniach czatu (Chat Common) włącz opcję "Use System Message Window" i wyłącz "Sheer Chat Window".',
    images: ['chat-common.png', 'system-message-window.png', 'sheer-chat.png'],
  },
  {
    text: 'Im wyższe okno komunikatów, tym łatwiej o stabilny odczyt: chwytając róg panelu, możesz go rozciągnąć.',
    images: ['resize.png'],
  },
  {
    text: 'Włączając logowanie consumables (Chat Common, opcja "Consumable"), pozwalasz aplikacji śledzić zużycie shotów i przedmiotów i uwzględniać je w szacowaniu zysku.',
    images: ['chat-common.png', 'consumable.png'],
  },
  {
    text: 'Zaznaczając prostokąt z panelem komunikatów, obejmij całą ramkę, ale bez suwaka przewijania.',
    images: ['region.png'],
  },
  {
    text: 'Przykrywanie okna komunikatów innymi oknami gry oraz przewijanie go może namieszać w wynikach. Lepiej tego unikać w trakcie nasłuchu.',
    images: ['overlap.png'],
  },
];
const state = { page: 0, seen: new Set(), mustFinish: false };

function render() {
  const t = TIPS[state.page];
  state.seen.add(state.page);
  $('tipsTitle').textContent = `Ważna porada ${state.page + 1}/${TIPS.length}`;
  $('tipsText').textContent = t.text;
  const box = $('tipsImages'); box.innerHTML = '';
  for (const f of t.images) { const im = new Image(); im.src = 'img/tips/' + f; im.alt = ''; box.append(im); }
  $('tipsPrev').disabled = state.page === 0;
  const last = state.page === TIPS.length - 1;
  $('tipsNext').textContent = last ? 'Zamknij' : 'Następna porada';
  const allSeen = state.seen.size === TIPS.length;
  $('tipsNext').disabled = last && state.mustFinish && !allSeen;
  $('tipsClose').hidden = state.mustFinish && !allSeen;
}

function open(mustFinish) {
  state.page = 0; state.seen = new Set(); state.mustFinish = !!mustFinish;
  $('tipsOverlay').hidden = false;
  render();
  $('tipsNext').focus();
}
function close() {
  if (state.mustFinish && state.seen.size < TIPS.length) return;
  $('tipsOverlay').hidden = true;
  settings.set('tipsSeen', true);
}

function init() {
  $('tipsPrev').addEventListener('click', () => { if (state.page > 0) { state.page--; render(); } });
  $('tipsNext').addEventListener('click', () => { if (state.page < TIPS.length - 1) { state.page++; render(); } else close(); });
  $('tipsClose').addEventListener('click', close);
  $('btnTips').addEventListener('click', () => open(false));
  document.addEventListener('keydown', e => {
    if ($('tipsOverlay').hidden) return;
    if (e.key === 'ArrowRight') $('tipsNext').click(); else if (e.key === 'ArrowLeft') $('tipsPrev').click(); else if (e.key === 'Escape') close();
  });
  if (!settings.get('tipsSeen', false)) open(true);
}

L2GL.tips = { TIPS, open, close, init, state };
})();
