// Wspólne drobiazgi: przestrzeń nazw, skróty DOM, ustawienia w localStorage, pasek statusu.
window.L2GL = window.L2GL || {};

L2GL.$ = id => document.getElementById(id);

L2GL.status = (msg, cls) => {
  const el = L2GL.$('status');
  el.textContent = msg;
  el.className = cls || '';
};

L2GL.cssVar = name => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

/** Czy zdarzenie należy do "nierozpoznanych": bez szablonu albo z zastrzeżeniem. Przedmiot spoza bazy (np. questowy) jest poprawnym odczytem. */
L2GL.isUnknown = e => e.type === 'other' || !!(e.fields && e.fields.reason && e.fields.reason !== 'unknown_item');

// Podpowiedzi (.help[data-tip]): jeden dymek w stałej pozycji, dosuwany do krawędzi okna, więc nie rozpycha strony.
(() => {
  let tip = null, cur = null;
  const show = el => {
    if (!tip) { tip = document.createElement('div'); tip.className = 'tip'; document.body.append(tip); }
    cur = el; tip.textContent = el.dataset.tip; tip.style.left = tip.style.top = '0px'; tip.classList.add('on');
    const r = el.getBoundingClientRect(), w = tip.offsetWidth, h = tip.offsetHeight;
    const vw = document.documentElement.clientWidth, vh = document.documentElement.clientHeight;
    const above = r.bottom + 6 + h > vh - 8 && r.top - 6 - h >= 8;   // pod znakiem zapytania, a gdy się nie mieści: nad nim
    tip.style.left = Math.max(8, Math.min(r.left, vw - w - 8)) + 'px';
    tip.style.top = (above ? r.top - 6 - h : r.bottom + 6) + 'px';
  };
  const hide = () => { cur = null; if (tip) tip.classList.remove('on'); };
  const helpOf = e => e.target instanceof Element ? e.target.closest('.help[data-tip]') : null;
  document.addEventListener('mouseover', e => { const el = helpOf(e); if (el && el !== cur) show(el); });
  document.addEventListener('mouseout', e => { const el = helpOf(e); if (el && !el.contains(e.relatedTarget)) hide(); });
  document.addEventListener('focusin', e => { const el = helpOf(e); if (el && el.matches(':focus-visible')) show(el); });
  document.addEventListener('focusout', e => { if (helpOf(e)) hide(); });
  window.addEventListener('scroll', hide, true);
})();

L2GL.settings = {
  get(key, fallback) {
    try {
      const v = localStorage.getItem('l2gl.' + key);
      return v === null ? fallback : JSON.parse(v);
    } catch (e) { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem('l2gl.' + key, JSON.stringify(value)); } catch (e) {}
  },
};

L2GL.fmt = {
  dur(ms) { const s = Math.max(0, Math.round(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; },
  n(x) { return Math.round(x).toLocaleString('pl-PL'); },
  stamp(date) {
    const p = n => String(n).padStart(2, '0');
    return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}_${p(date.getHours())}-${p(date.getMinutes())}-${p(date.getSeconds())}-${String(date.getMilliseconds()).padStart(3, '0')}`;
  },
};
