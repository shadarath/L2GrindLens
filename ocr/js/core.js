// Wspólne drobiazgi: przestrzeń nazw, skróty DOM, ustawienia w localStorage, pasek statusu.
window.L2GL = window.L2GL || {};

L2GL.$ = id => document.getElementById(id);

L2GL.status = (msg, cls) => {
  const el = L2GL.$('status');
  el.textContent = msg;
  el.className = cls || '';
};

L2GL.cssVar = name => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

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
