// Storage: IndexedDB is the primary store, with every change written immediately.
// Two more copies live on the device: a snapshot in localStorage (written on every change)
// and one in Cache Storage (written a moment later). Every copy carries a revision number,
// so on launch the app loads whichever copy is newest. This covers the iOS bug where a
// Home Screen app loses its IndexedDB connection after being in the background and later
// writes silently fail.
(function (root) {
  'use strict';

  const DB_NAME = 'workout-log';
  const DB_VERSION = 1;
  const STORES = ['exercises', 'types', 'sessions', 'meta'];
  const MIRROR_KEY = 'workout-log-mirror';
  const CACHE_NAME = 'workout-data';
  const CACHE_URL = 'data-backup.json';
  const REV_KEY = '_rev';
  const TX_TIMEOUT = 4000;

  const state = {
    exercises: new Map(),
    types: new Map(),
    sessions: new Map(),
    meta: new Map(),
  };
  let db = null;
  let volatile = false; // true when the database can't be opened at all
  let trouble = false;  // true after a write failed even after reconnecting
  let rev = 0;          // revision of the in-memory data; bumped on every change
  let lastWrite = Promise.resolve();
  let mirrorQueued = false;
  let cacheTimer = null;
  let onTrouble = null;

  function req(r) {
    return new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  }

  function openDb() {
    return new Promise((resolve, reject) => {
      if (!root.indexedDB) return reject(new Error('IndexedDB unavailable'));
      const r = indexedDB.open(DB_NAME, DB_VERSION);
      r.onupgradeneeded = () => {
        const d = r.result;
        for (const name of STORES) {
          if (!d.objectStoreNames.contains(name)) d.createObjectStore(name, { keyPath: 'id' });
        }
      };
      r.onsuccess = () => {
        const d = r.result;
        d.onclose = () => { if (db === d) db = null; }; // connection lost; the next write reopens
        d.onversionchange = () => { d.close(); if (db === d) db = null; };
        resolve(d);
      };
      r.onerror = () => reject(r.error);
      r.onblocked = () => reject(new Error('IndexedDB blocked'));
    });
  }

  async function readDb() {
    const out = {};
    const tx = db.transaction(STORES, 'readonly');
    for (const name of STORES) out[name] = await req(tx.objectStore(name).getAll());
    const r = out.meta.find(m => m.id === REV_KEY);
    out.meta = out.meta.filter(m => m.id !== REV_KEY);
    out.rev = r ? r.value : 0;
    return out;
  }

  function hasData(d) {
    return !!d && ['sessions', 'types', 'exercises'].some(n => (d[n] || []).length);
  }

  async function load() {
    const mirror = readMirror();
    const cached = await readCache();
    let fromDb = null;
    try {
      db = await openDb();
      fromDb = await readDb();
    } catch (e) {
      console.warn('Storage unavailable', e);
      volatile = true;
    }

    // Pick the newest copy. Ties go to the database.
    let best = fromDb;
    for (const c of [mirror, cached]) {
      if (c && hasData(c) && (!best || (c.rev || 0) > (best.rev || 0) || (!hasData(best) && !best.rev))) best = c;
    }
    if (best) loadPlain(best);
    rev = Math.max(rev, best ? best.rev || 0 : 0);

    // Data saved before revision numbers existed: merge record by record, newest copy wins.
    let merged = false;
    for (const c of [fromDb, mirror, cached]) {
      if (c && c !== best && hasData(c) && !c.rev && !(best && best.rev)) { mergeInto(c); merged = true; }
    }

    // If the database wasn't the newest copy, bring it (and the other copies) up to date.
    const fresh = best !== fromDb || merged;
    if (fresh) rev = Math.max(Date.now(), rev + 1);
    if (db && fresh) await replaceDb();
    if (fresh || best !== mirror) writeMirror();
    if (fresh || best !== cached) scheduleCache(0);
    return state;
  }

  function loadPlain(data) {
    for (const name of STORES) {
      state[name] = new Map((data[name] || []).filter(x => x && x.id !== REV_KEY).map(x => [x.id, x]));
    }
  }

  function mergeInto(data) {
    for (const name of ['exercises', 'types', 'sessions']) {
      for (const recd of data[name] || []) {
        const cur = state[name].get(recd.id);
        if (!cur || (recd.updatedAt || 0) > (cur.updatedAt || 0)) state[name].set(recd.id, recd);
      }
    }
  }

  // ---------- the two backup copies on the device ----------

  function snapshot() {
    const out = { app: 'workout-log', version: 1, rev, savedAt: Date.now() };
    for (const name of STORES) out[name] = all(name);
    return out;
  }

  function readMirror() {
    try {
      const t = localStorage.getItem(MIRROR_KEY);
      return t ? JSON.parse(t) : null;
    } catch (e) { return null; }
  }

  function writeMirror() {
    mirrorQueued = false;
    try { localStorage.setItem(MIRROR_KEY, JSON.stringify(snapshot())); return true; }
    catch (e) { console.warn('mirror write failed', e); return false; }
  }

  // Several changes in one tap are written to the mirror once, before the app can be suspended.
  function queueMirror() {
    if (mirrorQueued) return;
    mirrorQueued = true;
    Promise.resolve().then(writeMirror);
  }

  async function readCache() {
    try {
      if (!root.caches) return null;
      const c = await caches.open(CACHE_NAME);
      const r = await c.match(CACHE_URL);
      return r ? await r.json() : null;
    } catch (e) { return null; }
  }

  function scheduleCache(delay) {
    clearTimeout(cacheTimer);
    cacheTimer = setTimeout(writeCache, delay == null ? 1500 : delay);
  }

  async function writeCache() {
    clearTimeout(cacheTimer);
    cacheTimer = null;
    try {
      if (!root.caches) return;
      const c = await caches.open(CACHE_NAME);
      await c.put(CACHE_URL, new Response(JSON.stringify(snapshot()), { headers: { 'Content-Type': 'application/json' } }));
    } catch (e) { console.warn('cache write failed', e); }
  }

  // Write everything out when the app goes to the background.
  function flushCopies() {
    if (mirrorQueued) writeMirror();
    if (cacheTimer) writeCache();
  }
  if (root.addEventListener) {
    root.addEventListener('pagehide', flushCopies);
    root.document && document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flushCopies(); });
  }

  // ---------- database writes ----------

  // One transaction; resolves true on commit, false on error, abort or a hang.
  function runTx(storeNames, fn) {
    return new Promise((resolve) => {
      let done = false;
      const finish = ok => { if (!done) { done = true; clearTimeout(t); resolve(ok); } };
      const t = setTimeout(() => finish(false), TX_TIMEOUT);
      try {
        const tx = db.transaction(storeNames, 'readwrite');
        fn(tx);
        tx.oncomplete = () => finish(true);
        tx.onerror = tx.onabort = () => { console.warn('write failed', tx.error); finish(false); };
      } catch (e) {
        console.warn('write failed', e);
        finish(false);
      }
    });
  }

  // Run a write; if it fails, reconnect to the database and try once more.
  async function txWithRetry(storeNames, fn) {
    if (db && await runTx(storeNames, fn)) return true;
    try { if (db) db.close(); } catch (e) { /* already closed */ }
    db = null;
    try { db = await openDb(); } catch (e) { console.warn('reopen failed', e); }
    return !!db && runTx(storeNames, fn);
  }

  function setTrouble(v) {
    if (trouble === v) return;
    trouble = v;
    try { if (onTrouble) onTrouble(v); } catch (e) { console.warn(e); }
  }

  function write(storeName, fn) {
    rev = Math.max(Date.now(), rev + 1);
    const myRev = rev;
    queueMirror();
    scheduleCache();
    if (volatile) return Promise.resolve(false);
    const names = storeName === 'meta' ? ['meta'] : [storeName, 'meta'];
    const p = lastWrite.catch(() => {}).then(async () => {
      const ok = await txWithRetry(names, tx => {
        fn(tx.objectStore(storeName));
        tx.objectStore('meta').put({ id: REV_KEY, value: myRev });
      });
      setTrouble(!ok);
      return ok;
    });
    lastWrite = p;
    return p;
  }

  // Replace the database contents with the in-memory data (after loading a newer copy).
  function replaceDb() {
    const data = snapshot();
    const p = lastWrite.catch(() => {}).then(async () => {
      const ok = await txWithRetry(STORES, tx => {
        for (const name of STORES) {
          const s = tx.objectStore(name);
          s.clear();
          for (const x of data[name]) s.put(x);
        }
        tx.objectStore('meta').put({ id: REV_KEY, value: data.rev });
      });
      setTrouble(!ok);
      return ok;
    });
    lastWrite = p;
    return p;
  }

  function put(storeName, obj) {
    obj.updatedAt = Date.now();
    return putRaw(storeName, obj);
  }

  function putRaw(storeName, obj) {
    state[storeName].set(obj.id, obj);
    const copy = JSON.parse(JSON.stringify(obj));
    return write(storeName, s => s.put(copy));
  }

  function del(storeName, id) {
    state[storeName].delete(id);
    return write(storeName, s => s.delete(id));
  }

  function all(storeName) {
    return [...state[storeName].values()];
  }

  function get(storeName, id) {
    return state[storeName].get(id) || null;
  }

  function getMeta(key, fallback) {
    const m = state.meta.get(key);
    return m ? m.value : fallback;
  }

  function setMeta(key, value) {
    return put('meta', { id: key, value });
  }

  function exportData() {
    return {
      app: 'workout-log',
      version: 1,
      exportedAt: Date.now(),
      exercises: all('exercises'),
      types: all('types'),
      sessions: all('sessions'),
      meta: all('meta').filter(m => m.id === 'settings'),
    };
  }

  function validate(data) {
    if (!data || data.app !== 'workout-log' || !Array.isArray(data.sessions) ||
        !Array.isArray(data.exercises) || !Array.isArray(data.types)) {
      throw new Error('This file is not a workout backup.');
    }
    for (const list of [data.sessions, data.exercises, data.types]) {
      for (const x of list) if (!x || typeof x.id !== 'string') throw new Error('Backup has a damaged record.');
    }
  }

  // Merge a backup into current data. For the same record id, the newer copy wins.
  async function importData(data) {
    validate(data);
    const counts = { added: 0, updated: 0 };
    for (const name of ['exercises', 'types', 'sessions']) {
      for (const rec of data[name]) {
        const cur = state[name].get(rec.id);
        if (!cur) counts.added++;
        else if ((rec.updatedAt || 0) > (cur.updatedAt || 0)) counts.updated++;
        else continue;
        await putRaw(name, rec);
      }
    }
    return counts;
  }

  async function requestPersistence() {
    try {
      if (navigator.storage && navigator.storage.persist) {
        if (await navigator.storage.persisted()) return true;
        return await navigator.storage.persist();
      }
    } catch (e) { /* not supported */ }
    return false;
  }

  async function isPersisted() {
    try { return navigator.storage && navigator.storage.persisted ? await navigator.storage.persisted() : false; }
    catch (e) { return false; }
  }

  root.Store = {
    load, put, del, all, get, getMeta, setMeta, exportData, importData, validate,
    requestPersistence, isPersisted,
    flush: () => { flushCopies(); return lastWrite; },
    set onTrouble(fn) { onTrouble = fn; },
    get volatile() { return volatile; },
    get trouble() { return trouble; },
    get rev() { return rev; },
  };
})(this);
