/*
 * Dünne Hülle um IndexedDB. Alle Daten bleiben lokal im Browser.
 * Stores: entities, positions, attachments (mit Datei-Blob), meta (Schlüssel/Wert).
 */
(function (root) {
  'use strict';

  const DB_NAME = 'steuer-belege';
  const DB_VERSION = 1;
  let dbPromise = null;

  function open() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        db.createObjectStore('entities', { keyPath: 'id' });
        const positions = db.createObjectStore('positions', { keyPath: 'id' });
        positions.createIndex('year', 'year');
        const attachments = db.createObjectStore('attachments', { keyPath: 'id' });
        attachments.createIndex('positionId', 'positionId');
        db.createObjectStore('meta', { keyPath: 'key' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return dbPromise;
  }

  function promisify(req) {
    return new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  function txDone(tx) {
    return new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  }

  async function getAll(store) {
    const db = await open();
    return promisify(db.transaction(store).objectStore(store).getAll());
  }

  async function get(store, key) {
    const db = await open();
    return promisify(db.transaction(store).objectStore(store).get(key));
  }

  async function put(store, value) {
    const db = await open();
    const tx = db.transaction(store, 'readwrite');
    tx.objectStore(store).put(value);
    return txDone(tx);
  }

  async function putMany(store, values) {
    const db = await open();
    const tx = db.transaction(store, 'readwrite');
    const os = tx.objectStore(store);
    for (const v of values) os.put(v);
    return txDone(tx);
  }

  async function remove(store, key) {
    const db = await open();
    const tx = db.transaction(store, 'readwrite');
    tx.objectStore(store).delete(key);
    return txDone(tx);
  }

  async function removeMany(store, keys) {
    const db = await open();
    const tx = db.transaction(store, 'readwrite');
    const os = tx.objectStore(store);
    for (const k of keys) os.delete(k);
    return txDone(tx);
  }

  async function clearAll() {
    const db = await open();
    const stores = ['entities', 'positions', 'attachments', 'meta'];
    const tx = db.transaction(stores, 'readwrite');
    for (const s of stores) tx.objectStore(s).clear();
    return txDone(tx);
  }

  async function getMeta(key, fallback) {
    const row = await get('meta', key);
    return row ? row.value : fallback;
  }

  function setMeta(key, value) {
    return put('meta', { key, value });
  }

  root.DB = { open, getAll, get, put, putMany, remove, removeMany, clearAll, getMeta, setMeta };
})(window);
