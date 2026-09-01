// IndexedDB layer. Stores: foods, log, settings (kv), scanCache (barcode lookups).

const DB_NAME = 'calorie-tracker';
const DB_VER = 1;
let _db = null;

export function openDB() {
  return new Promise((res, rej) => {
    const req = indexedDB.open(DB_NAME, DB_VER);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('foods')) {
        const s = db.createObjectStore('foods', { keyPath: 'id' });
        s.createIndex('barcode', 'barcode', { unique: false });
        s.createIndex('lastUsed', 'lastUsed', { unique: false });
      }
      if (!db.objectStoreNames.contains('log')) {
        const s = db.createObjectStore('log', { keyPath: 'id' });
        s.createIndex('date', 'date', { unique: false });
      }
      if (!db.objectStoreNames.contains('settings')) {
        db.createObjectStore('settings', { keyPath: 'key' });
      }
      if (!db.objectStoreNames.contains('scanCache')) {
        db.createObjectStore('scanCache', { keyPath: 'barcode' });
      }
    };
    req.onsuccess = () => { _db = req.result; res(_db); };
    req.onerror = () => rej(req.error);
  });
}

function reqP(req) {
  return new Promise((res, rej) => {
    req.onsuccess = () => res(req.result);
    req.onerror = () => rej(req.error);
  });
}

function store(name, mode = 'readonly') {
  return _db.transaction(name, mode).objectStore(name);
}

export const put = (name, val) => reqP(store(name, 'readwrite').put(val));
export const get = (name, key) => reqP(store(name).get(key));
export const del = (name, key) => reqP(store(name, 'readwrite').delete(key));
export const all = (name) => reqP(store(name).getAll());
export const byIndex = (name, index, value) => reqP(store(name).index(index).getAll(value));
export const clearStore = (name) => reqP(store(name, 'readwrite').clear());

export async function setSetting(key, value) { await put('settings', { key, value }); }
export async function getSetting(key, dflt = null) {
  const row = await get('settings', key);
  return row ? row.value : dflt;
}

// ---- Export / import (non-negotiable: iOS can evict site storage) ----

export async function exportAll() {
  return {
    app: 'calorie-tracker',
    schema: 1,
    exportedAt: new Date().toISOString(),
    foods: await all('foods'),
    log: await all('log'),
    settings: await all('settings'),
    scanCache: await all('scanCache'),
  };
}

export async function importAll(data, { replace = false } = {}) {
  if (!data || data.app !== 'calorie-tracker') throw new Error('Not a calorie-tracker backup file');
  const stores = ['foods', 'log', 'settings', 'scanCache'];
  if (replace) for (const s of stores) await clearStore(s);
  let count = 0;
  for (const s of stores) {
    for (const row of (data[s] || [])) { await put(s, row); count++; }
  }
  return count;
}
