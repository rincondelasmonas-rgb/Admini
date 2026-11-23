// Capa de almacenamiento de bytes.
// - En el celular (Capacitor): Filesystem (Directory.Data/archivos/<id>) + plugin nativo "Downloads" + Share.
//   No se usan imports de npm: los plugins se obtienen con Capacitor.registerPlugin (sin bundler).
// - En un navegador (solo para probar en la PC): los blobs se guardan en IndexedDB.
import * as db from './db.js';

const DIR = 'archivos';
const SHARE_DIR = 'share';
const CHUNK = 3 * 512 * 1024; // 1,5 MB por tramo: evita pasar 20 MB de base64 de una sola vez por el puente

const cap = window.Capacitor;
export const isNative = !!(cap && typeof cap.isNativePlatform === 'function' && cap.isNativePlatform());

export function plugin(name) {
  if (!cap) return null;
  if (cap.Plugins && cap.Plugins[name]) return cap.Plugins[name];
  return cap.registerPlugin(name);
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => {
      const s = String(r.result);
      resolve(s.slice(s.indexOf(',') + 1));
    };
    r.onerror = () => reject(r.error || new Error('No se pudo leer el archivo'));
    r.readAsDataURL(blob);
  });
}

// ---------------------------------------------------------------- nativo
let FS;
let SHARE;
let DOWNLOADS;
let baseUri = '';

const fileUri = (id) => `${baseUri}/${id}`;

const native = {
  async init() {
    FS = plugin('Filesystem');
    SHARE = plugin('Share');
    DOWNLOADS = plugin('Downloads');
    try {
      await FS.mkdir({ path: DIR, directory: 'DATA', recursive: true });
    } catch (e) {
      /* ya existe */
    }
    const { uri } = await FS.getUri({ path: DIR, directory: 'DATA' });
    baseUri = uri.replace(/\/+$/, '');
    await this.cleanupShare();
  },

  async write(id, file, onProgress) {
    const path = `${DIR}/${id}`;
    let offset = 0;
    let first = true;
    while (offset < file.size) {
      const chunk = file.slice(offset, offset + CHUNK);
      const data = await blobToBase64(chunk);
      if (first) {
        await FS.writeFile({ path, directory: 'DATA', data, recursive: true });
        first = false;
      } else {
        await FS.appendFile({ path, directory: 'DATA', data });
      }
      offset += chunk.size;
      if (onProgress) onProgress(Math.min(1, offset / file.size));
    }
  },

  async remove(id) {
    try {
      await FS.deleteFile({ path: `${DIR}/${id}`, directory: 'DATA' });
    } catch (e) {
      /* si ya no existe, da igual */
    }
  },

  async listIds() {
    try {
      const res = await FS.readdir({ path: DIR, directory: 'DATA' });
      return (res.files || []).map((f) => (typeof f === 'string' ? f : f.name));
    } catch (e) {
      return null;
    }
  },

  thumbUrl(f) {
    return cap.convertFileSrc(fileUri(f.id));
  },
  async mediaUrl(f) {
    return cap.convertFileSrc(fileUri(f.id));
  },
  release() {},

  // La hoja de compartir de Android solo lee archivos de la caché: se copia ahí con el nombre real.
  async share(items) {
    await this.cleanupShare();
    const uris = [];
    for (const it of items) {
      const dir = `${SHARE_DIR}/${it.id}`;
      try {
        await FS.mkdir({ path: dir, directory: 'CACHE', recursive: true });
      } catch (e) {
        /* ya existe */
      }
      const r = await FS.copy({ from: `${DIR}/${it.id}`, directory: 'DATA', to: `${dir}/${it.name}`, toDirectory: 'CACHE' });
      uris.push(r.uri);
    }
    await SHARE.share({ files: uris, dialogTitle: 'Compartir' });
  },

  async cleanupShare() {
    try {
      await FS.rmdir({ path: SHARE_DIR, directory: 'CACHE', recursive: true });
    } catch (e) {
      /* no había nada */
    }
  },

  async saveToDownloads(f) {
    return DOWNLOADS.saveToDownloads({ uri: fileUri(f.id), name: f.name, mime: f.type });
  },
};

// ---------------------------------------------------------------- web (pruebas en PC)
const urls = new Set();

function download(blob, name) {
  const u = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = u;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(u), 10000);
}

const web = {
  async init() {},
  async write(id, file, onProgress) {
    await db.putBlob(id, file);
    if (onProgress) onProgress(1);
  },
  async remove(id) {
    await db.delBlob(id);
  },
  async listIds() {
    return (await db.blobKeys()).map(String);
  },
  thumbUrl() {
    return null;
  },
  async mediaUrl(f) {
    const b = await db.getBlob(f.id);
    if (!b) throw new Error('El archivo no existe');
    const u = URL.createObjectURL(new Blob([b], { type: f.type }));
    urls.add(u);
    return u;
  },
  release(u) {
    if (u && urls.has(u)) {
      URL.revokeObjectURL(u);
      urls.delete(u);
    }
  },
  async share(items) {
    const files = [];
    for (const it of items) {
      const b = await db.getBlob(it.id);
      if (b) files.push(new File([b], it.name, { type: it.type }));
    }
    if (navigator.canShare && navigator.canShare({ files })) {
      await navigator.share({ files });
    } else {
      files.forEach((f) => download(f, f.name));
    }
  },
  async saveToDownloads(f) {
    const b = await db.getBlob(f.id);
    if (!b) throw new Error('El archivo no existe');
    download(b, f.name);
    return { name: f.name };
  },
  async cleanupShare() {},
};

export const storage = isNative ? native : web;
