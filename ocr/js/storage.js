// Magazyn zdarzeń i sesji w IndexedDB przeglądarki (+ drobne klucz-wartość, np. uchwyt folderu danych).
(() => {
const db = {
  h: null, ok: false,

  async open() {
    if (!window.indexedDB) throw new Error('brak IndexedDB');
    this.h = await new Promise((res, rej) => {
      const r = indexedDB.open('l2grindlens', 1);
      r.onupgradeneeded = () => {
        const d = r.result;
        const ev = d.createObjectStore('events', { keyPath: 'id', autoIncrement: true });
        ev.createIndex('session', 'session');
        d.createObjectStore('sessions', { keyPath: 'id' });
        d.createObjectStore('kv', { keyPath: 'key' });
      };
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error || new Error('open failed'));
      r.onblocked = () => rej(new Error('zablokowana przez inną kartę'));
    });
    this.ok = true;
  },

  req(r) { return new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }); },
  st(name, mode) { return this.h.transaction(name, mode || 'readonly').objectStore(name); },

  add(ev) { return this.ok ? this.req(this.st('events', 'readwrite').add(ev)) : Promise.resolve(); },
  eventsOf(session) { return this.ok ? this.req(this.st('events').index('session').getAll(session)) : Promise.resolve([]); },
  allEvents() { return this.ok ? this.req(this.st('events').getAll()) : Promise.resolve([]); },
  sessions() { return this.ok ? this.req(this.st('sessions').getAll()) : Promise.resolve([]); },
  putSession(s) { return this.ok ? this.req(this.st('sessions', 'readwrite').put(s)) : Promise.resolve(); },

  async clearSession(id) {
    if (!this.ok) return;
    const tx = this.h.transaction(['events', 'sessions'], 'readwrite');
    tx.objectStore('sessions').delete(id);
    const idx = tx.objectStore('events').index('session');
    await new Promise((res, rej) => {
      const c = idx.openKeyCursor(IDBKeyRange.only(id));
      c.onsuccess = () => { const cur = c.result; if (!cur) return res(); tx.objectStore('events').delete(cur.primaryKey); cur.continue(); };
      c.onerror = () => rej(c.error);
    });
  },
  async clearAll() {
    if (!this.ok) return;
    await this.req(this.st('events', 'readwrite').clear());
    await this.req(this.st('sessions', 'readwrite').clear());
  },

  kvGet(key) { return this.ok ? this.req(this.st('kv').get(key)).then(r => r && r.value) : Promise.resolve(undefined); },
  kvSet(key, value) { return this.ok ? this.req(this.st('kv', 'readwrite').put({ key, value })) : Promise.resolve(); },
};

L2GL.db = db;
})();
