/** Couche IndexedDB partagée par le service worker et le dashboard. */
const NAME = 'vtl-analytics';
const VERSION = 1;
let dbPromise;

export function openDb() {
  return (dbPromise ||= new Promise((resolve, reject) => {
    const req = indexedDB.open(NAME, VERSION);
    req.onupgradeneeded = () => {
      const d = req.result;
      d.createObjectStore('sessions', { keyPath: 'sid' });
      d.createObjectStore('items', { keyPath: 'k' }).createIndex('s', 's');
      d.createObjectStore('profiles', { keyPath: 'o' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  }));
}

const wrap = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });

async function run(stores, mode, fn) {
  const d = await openDb();
  return new Promise((resolve, reject) => {
    const t = d.transaction(stores, mode);
    let out;
    Promise.resolve(fn(t)).then((v) => { out = v; }, reject);
    t.oncomplete = () => resolve(out);
    t.onerror = t.onabort = () => reject(t.error);
  });
}

export const createSession = (s) => run('sessions', 'readwrite', (t) => wrap(t.objectStore('sessions').put(s)));

export const updateSession = (sid, patch) =>
  run('sessions', 'readwrite', async (t) => {
    const st = t.objectStore('sessions');
    const cur = await wrap(st.get(sid));
    if (cur) await wrap(st.put({ ...cur, ...patch }));
  });

export const getSession = (sid) => run('sessions', 'readonly', (t) => wrap(t.objectStore('sessions').get(sid)));

export const listSessions = () =>
  run('sessions', 'readonly', (t) => wrap(t.objectStore('sessions').getAll())).then((a) =>
    a.sort((x, y) => y.startedAt - x.startedAt));

/** Écrit un lot d'annonces dans une seule transaction (le plus rapide avec IndexedDB). */
export const putItems = (sid, items) =>
  run('items', 'readwrite', (t) => {
    const st = t.objectStore('items');
    for (const it of items) st.put({ ...it, k: sid + ':' + it.id, s: sid });
  });

export const countItems = (sid) => run('items', 'readonly', (t) => wrap(t.objectStore('items').index('s').count(sid)));

export const getItems = (sid) =>
  run('items', 'readonly', (t) => wrap(t.objectStore('items').index('s').getAll(sid)));

export const deleteSession = (sid) =>
  run(['sessions', 'items'], 'readwrite', (t) => {
    t.objectStore('sessions').delete(sid);
    t.objectStore('items').delete(IDBKeyRange.bound(sid + ':', sid + ':￿'));
  });

export const getProfiles = () => run('profiles', 'readonly', (t) => wrap(t.objectStore('profiles').getAll()));
export const putProfile = (p) => run('profiles', 'readwrite', (t) => wrap(t.objectStore('profiles').put(p)));
