// IndexedDB: metadatos de los archivos { id, name, size, type, at, trashedAt }.
// El almacén "blobs" solo se usa en el modo web (pruebas en la PC); en el celular los bytes van al sistema de archivos.

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

export const put = (rec) => tx('files', 'readwrite', (t) => t.objectStore('files').put(rec));

export const putMany = (recs) =>
  tx('files', 'readwrite', (t) => {
    const s = t.objectStore('files');
    recs.forEach((r) => s.put(r));
  });

export const deleteMany = (ids) =>
  tx('files', 'readwrite', (t) => {
    const s = t.objectStore('files');
    ids.forEach((id) => s.delete(id));
  });

export const putBlob = (id, blob) => tx('blobs', 'readwrite', (t) => t.objectStore('blobs').put(blob, id));
export const getBlob = (id) => tx('blobs', 'readonly', (t) => t.objectStore('blobs').get(id));
export const delBlob = (id) => tx('blobs', 'readwrite', (t) => t.objectStore('blobs').delete(id));
export const blobKeys = () => tx('blobs', 'readonly', (t) => t.objectStore('blobs').getAllKeys());
