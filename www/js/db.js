// IndexedDB de la versión 1 (la "bóveda": archivos subidos a la app). Solo se lee para pasarlos a carpetas reales.
// Registros: { id, name, size, type, at, trashedAt }

const NAME = 'archivos-db';
const VERSION = 1;
let dbPromise = null;

function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(NAME, VERSION);
    req.onupgradeneeded = () => {
      const d = req.result;
      if (!d.objectStoreNames.contains('files')) d.createObjectStore('files', { keyPath: 'id' });
      if (!d.objectStoreNames.contains('blobs')) d.createObjectStore('blobs');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx(stores, mode, fn) {
  return open().then(
    (d) =>
      new Promise((resolve, reject) => {
        const t = d.transaction(stores, mode);
        let out;
        t.oncomplete = () => resolve(out instanceof IDBRequest ? out.result : out);
        t.onerror = () => reject(t.error);
        t.onabort = () => reject(t.error || new Error('Transacción cancelada'));
        out = fn(t);
      })
  );
}

export const getAll = () => tx('files', 'readonly', (t) => t.objectStore('files').getAll());

export const deleteMany = (ids) =>
  tx('files', 'readwrite', (t) => {
    const s = t.objectStore('files');
    ids.forEach((id) => s.delete(id));
  });
