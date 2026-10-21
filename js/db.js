// IndexedDB layer. Stores: foods, log, settings (kv), scanCache (barcode lookups).
//
// Writes resolve only when the TRANSACTION commits, not when the request
// reports success: on iOS a request can succeed and the transaction still
// abort afterwards (Oct 2026: a diary row silently vanished this way), and
// the old request-only promise could not tell. Every call also survives a
// dropped connection — Safari closes IndexedDB connections on a backgrounded
// home-screen app — by reopening the database and retrying once.

const DB_NAME = 'calorie-tracker';
const DB_VER = 1;
let _db = null;
let _opening = null;

export function openDB() {
  if (_opening) return _opening;
  _opening = new Promise((res, rej) => {
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
    req.onsuccess = () => {
      _db = req.result;
      // the browser dropped the connection (or another tab upgraded the
      // schema): forget the handle so the next call reopens instead of
      // throwing "connection is closing" forever
      _db.onclose = () => { if (_db === req.result) _db = null; };
      _db.onversionchange = () => { req.result.close(); if (_db === req.result) _db = null; };
      res(_db);
    };
    req.onerror = () => rej(req.error);
    req.onblocked = () => rej(new Error('database open blocked'));
  }).finally(() => { _opening = null; });
  return _opening;
}

// A closed or dropped connection shows up as one of these; anything else is a
// real failure that a retry would only repeat.
function connectionLost(e) {
  const name = e && e.name;
  const msg = String((e && e.message) || e || '');
  return name === 'InvalidStateError' || name === 'UnknownError' || name === 'TransactionInactiveError'
    || /connection|closing|closed/i.test(msg);
}

// run(fn) gives fn a live database handle; a lost connection reopens and
// retries exactly once, every other error propagates untouched.
async function run(fn) {
  if (!_db) await openDB();
  try {
    return await fn(_db);
  } catch (e) {
    if (!connectionLost(e)) throw e;
    try { _db && _db.close(); } catch (_) { /* already closed */ }
    _db = null;
    await openDB();
    return await fn(_db);
  }
}

// Read: resolves with the request result (reads can't partially commit).
function read(name, op) {
  return run(db => new Promise((res, rej) => {
    const tx = db.transaction(name, 'readonly');
    const req = op(tx.objectStore(name));
    req.onsuccess = () => res(req.result);
    req.onerror = () => rej(req.error || new Error('read failed'));
    tx.onabort = () => rej(tx.error || new Error('read transaction aborted'));
  }));
}

// Write: resolves with the request result only once the transaction has
// COMMITTED; an abort (quota, lost connection, constraint) rejects with the
// real error so the caller can show it.
function write(name, op) {
  return run(db => new Promise((res, rej) => {
    const tx = db.transaction(name, 'readwrite');
    let result;
    let failed = null;
    const req = op(tx.objectStore(name));
    req.onsuccess = () => { result = req.result; };
    req.onerror = () => { failed = req.error; };
    tx.oncomplete = () => res(result);
    tx.onabort = () => rej(tx.error || failed || new Error('write transaction aborted'));
    tx.onerror = () => { failed = failed || tx.error; };
  }));
}

export const put = (name, val) => write(name, s => s.put(val));
export const get = (name, key) => read(name, s => s.get(key));
export const del = (name, key) => write(name, s => s.delete(key));
export const all = (name) => read(name, s => s.getAll());
export const byIndex = (name, index, value) => read(name, s => s.index(index).getAll(value));
export const clearStore = (name) => write(name, s => s.clear());

// several rows into one store in ONE transaction (import)
export function putMany(name, rows) {
  if (!rows.length) return Promise.resolve(0);
  return run(db => new Promise((res, rej) => {
    const tx = db.transaction(name, 'readwrite');
    const st = tx.objectStore(name);
    for (const row of rows) st.put(row);
    tx.oncomplete = () => res(rows.length);
    tx.onabort = () => rej(tx.error || new Error('import transaction aborted'));
  }));
}

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
  for (const s of stores) count += await putMany(s, data[s] || []);
  return count;
}
