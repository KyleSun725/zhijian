/* IndexedDB persistence for per-document annotations and chat history. */

const DB_NAME = 'zhijian';
const DB_VERSION = 1;
const STORE = 'docs';
let dbPromise = null;

function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function run(mode, fn) {
  return openDB().then(
    (db) =>
      new Promise((resolve, reject) => {
        const t = db.transaction(STORE, mode);
        let request;
        try {
          request = fn(t.objectStore(STORE));
        } catch (err) {
          reject(err);
          return;
        }
        t.onerror = () => reject(t.error);
        if (request) {
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        } else {
          t.oncomplete = () => resolve(undefined);
        }
      }),
  );
}

export async function loadDoc(key) {
  if (!key) return null;
  try {
    return (await run('readonly', (s) => s.get(key))) || null;
  } catch {
    return null;
  }
}

export async function saveDoc(key, value) {
  if (!key) return;
  try {
    await run('readwrite', (s) => s.put(value, key));
  } catch (err) {
    console.warn('保存失败', err);
  }
}

export async function deleteDoc(key) {
  if (!key) return;
  try {
    await run('readwrite', (s) => s.delete(key));
  } catch {
    /* ignore */
  }
}

export function fingerprint(name, size, mtime) {
  return `${name}::${size}::${mtime || 0}`;
}
