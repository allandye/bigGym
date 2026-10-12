// Storage: IndexedDB is the primary store, with every change written immediately.
// A JSON snapshot is also mirrored to localStorage as a second copy on the device.
(function (root) {
  'use strict';

  const DB_NAME = 'workout-log';
  const DB_VERSION = 1;
  const STORES = ['exercises', 'types', 'sessions', 'meta'];
  const MIRROR_KEY = 'workout-log-mirror';

  const state = {
    exercises: new Map(),
    types: new Map(),
    sessions: new Map(),
    meta: new Map(),
  };
  let db = null;
  let volatile = false; // true when nothing can be saved (shown as a warning)
  let lastWrite = Promise.resolve();
  let mirrorTimer = null;

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
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
      r.onblocked = () => reject(new Error('IndexedDB blocked'));
    });
  }

  async function load() {
    try {
      db = await openDb();
      const tx = db.transaction(STORES, 'readonly');
      for (const name of STORES) {
        const all = await req(tx.objectStore(name).getAll());
        state[name] = new Map(all.map(x => [x.id, x]));
      }
      // If the database came back empty but the mirror has data, restore from the mirror.
      if (!state.sessions.size && !state.types.size && !state.exercises.size) {
        const m = readMirror();
        if (m && ((m.sessions || []).length || (m.types || []).length)) {
          await importData(m, { replace: true });
        }
      }
    } catch (e) {
      console.warn('Storage unavailable', e);
      volatile = true;
      const m = readMirror();
      if (m) loadPlain(m);
    }
    return state;
  }

  function loadPlain(data) {
    for (const name of STORES) {
      state[name] = new Map((data[name] || []).map(x => [x.id, x]));
    }
  }

  function readMirror() {
    try {
      const t = localStorage.getItem(MIRROR_KEY);
      return t ? JSON.parse(t) : null;
    } catch (e) { return null; }
  }

  function scheduleMirror() {
    clearTimeout(mirrorTimer);
    mirrorTimer = setTimeout(() => {
      try { localStorage.setItem(MIRROR_KEY, JSON.stringify(exportData())); } catch (e) { /* full or blocked */ }
    }, 300);
  }

  function write(storeName, fn) {
    scheduleMirror();
    if (!db) return Promise.resolve(!volatile);
    const p = lastWrite.then(() => new Promise((resolve) => {
      try {
        const tx = db.transaction(storeName, 'readwrite');
        fn(tx.objectStore(storeName));
        tx.oncomplete = () => resolve(true);
        tx.onerror = tx.onabort = () => { console.warn('write failed', tx.error); resolve(false); };
      } catch (e) {
        console.warn('write failed', e);
        resolve(false);
      }
    }));
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
  // With replace:true the backup is loaded as-is (used to restore from the local mirror).
  async function importData(data, opts) {
    validate(data);
    const replace = opts && opts.replace;
    const counts = { added: 0, updated: 0 };
    for (const name of ['exercises', 'types', 'sessions']) {
      for (const rec of data[name]) {
        const cur = state[name].get(rec.id);
        if (!cur) counts.added++;
        else if (replace || (rec.updatedAt || 0) > (cur.updatedAt || 0)) counts.updated++;
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
    flush: () => lastWrite,
    get volatile() { return volatile; },
  };
})(this);
