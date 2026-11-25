// Almacenamiento simulado en memoria: tiene la misma interfaz que el plugin nativo "Files" (FilesPlugin.java).
// Sirve para probar la interfaz en el navegador de la PC y para las pruebas automáticas (`npm test`). No usa DOM.
import { baseName, parentPath, joinPath, isUnder, splitName, extOf, uniqueName, kind, norm, validateName } from './util.js';

export const INTERNAL = '/storage/emulated/0';
export const SDCARD = '/storage/1234-ABCD';
const TRASH = '.ArchivosPapelera';
const DAY = 86400000;
const DOC = new Set(['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'txt', 'rtf', 'odt', 'ods', 'odp', 'csv', 'epub', 'md']);

class CancelledError extends Error {
  constructor() {
    super('Cancelado');
    this.code = 'CANCELLED';
  }
}

export function createMock({ granted = true, seed = true } = {}) {
  /** ruta -> { dir, size, mtime, text?, hash?, zip? } */
  const nodes = new Map();
  const metas = new Map(); // ruta de datos en la papelera -> metadatos
  const listeners = [];
  const cancelled = new Set();
  const calls = []; // open / share, para las pruebas
  let access = granted;
  let nextId = 1;

  const emit = (o) => listeners.forEach((f) => f(o));
  const fail = (m) => {
    throw new Error(m);
  };
  const volumes = [
    { path: INTERNAL, label: 'Almacenamiento interno', total: 64 * 2 ** 30, free: 21 * 2 ** 30, primary: true },
    { path: SDCARD, label: 'Tarjeta SD / USB', total: 32 * 2 ** 30, free: 30 * 2 ** 30, primary: false },
  ];
  const rootOf = (p) => (volumes.find((v) => isUnder(p, v.path)) || volumes[0]).path;

  function put(path, node) {
    nodes.set(path, { dir: false, size: 0, mtime: Date.now(), ...node });
  }
  function mkdirp(path) {
    const root = rootOf(path);
    let cur = root;
    if (!nodes.has(root)) put(root, { dir: true });
    for (const seg of path.slice(root.length).split('/').filter(Boolean)) {
      cur = joinPath(cur, seg);
      if (!nodes.has(cur)) put(cur, { dir: true });
    }
  }
  const children = (dir) => [...nodes.keys()].filter((k) => parentPath(k) === dir && k !== dir);
  const subtree = (p) => [...nodes.keys()].filter((k) => k === p || k.startsWith(`${p}/`));
  function treeSize(p) {
    let size = 0;
    let files = 0;
    let folders = 0;
    for (const k of subtree(p)) {
      const n = nodes.get(k);
      if (n.dir) {
        if (k !== p) folders++;
      } else {
        size += n.size;
        files++;
      }
    }
    return { size, files, folders };
  }
  function moveSub(from, to) {
    const keys = subtree(from);
    const moved = keys.map((k) => [to + k.slice(from.length), nodes.get(k)]);
    keys.forEach((k) => nodes.delete(k));
    moved.forEach(([k, n]) => nodes.set(k, n));
  }
  function copySub(from, to) {
    for (const k of subtree(from)) nodes.set(to + k.slice(from.length), { ...nodes.get(k), mtime: nodes.get(k).mtime });
  }
  const removeSub = (p) => subtree(p).forEach((k) => nodes.delete(k));
  function unique(dir, name, isDir) {
    const taken = new Set(children(dir).map((k) => baseName(k).toLowerCase()));
    return joinPath(dir, uniqueName(name, taken, isDir));
  }
  const entry = (p) => {
    const n = nodes.get(p);
    const e = { name: baseName(p), path: p, dir: n.dir, size: n.dir ? 0 : n.size, mtime: n.mtime };
    if (n.dir) e.count = children(p).length;
    return e;
  };
  const hiddenPath = (p) => p.split('/').some((s) => s.startsWith('.'));
  const checkCancel = (opId) => {
    if (opId && cancelled.has(opId)) {
      cancelled.delete(opId);
      throw new CancelledError();
    }
  };

  // ---------------------------------------------------------------- datos de ejemplo
  if (seed) {
    const mb = 1024 * 1024;
    const day = (n) => Date.now() - n * DAY;
    [`${INTERNAL}/Download`, `${INTERNAL}/DCIM/Camera`, `${INTERNAL}/Pictures`, `${INTERNAL}/Documents/Trabajo`, `${INTERNAL}/Music`, `${INTERNAL}/Movies`,
      `${INTERNAL}/WhatsApp/Media`, `${SDCARD}/Fotos viejas`].forEach(mkdirp);
    const files = [
      ['DCIM/Camera/IMG_0001.jpg', 3.1 * mb, 1], ['DCIM/Camera/IMG_0002.jpg', 2.8 * mb, 2], ['DCIM/Camera/IMG_0003.jpg', 3.4 * mb, 3],
      ['DCIM/Camera/VID_0004.mp4', 84 * mb, 2], ['Pictures/captura #1.png', 0.4 * mb, 5],
      ['Download/Factura noviembre.pdf', 0.2 * mb, 1, 'f1'], ['Download/Factura noviembre (copia).pdf', 0.2 * mb, 6, 'f1'], ['Download/app-release.apk', 18 * mb, 4],
      ['Download/Proyecto.zip', 12 * mb, 8], ['Documents/notas.txt', 1200, 0, null, 'Compras:\n- Leche\n- Pan\n'], ['Documents/Trabajo/Informe.docx', 0.6 * mb, 7],
      ['Documents/Trabajo/presupuesto.xlsx', 0.3 * mb, 9], ['Music/Canción ñandú.mp3', 5.2 * mb, 10], ['Movies/Película.mkv', 740 * mb, 20],
      ['WhatsApp/Media/foto1.jpg', 0.9 * mb, 1, 'w1'], ['.oculto.txt', 10, 3, null, 'secreto'],
    ];
    for (const [rel, size, d, hash, text] of files) {
      const p = joinPath(INTERNAL, rel);
      mkdirp(parentPath(p));
      put(p, { size: Math.round(size), mtime: day(d), hash: hash || `h:${rel}`, text });
    }
    put(`${SDCARD}/Fotos viejas/playa.jpg`, { size: Math.round(2 * mb), mtime: day(400), hash: 'h:playa' });
    put(`${INTERNAL}/DCIM/Camera/IMG_0001 copia.jpg`, { size: Math.round(3.1 * mb), mtime: day(0), hash: 'h:DCIM/Camera/IMG_0001.jpg' });
  } else {
    volumes.forEach((v) => put(v.path, { dir: true }));
  }

  // ---------------------------------------------------------------- API
  const api = {
    // utilidades de prueba
    _nodes: nodes,
    _calls: calls,
    _metas: metas,
    _put: put,
    _mkdirp: mkdirp,
    _setAccess(v) {
      access = v;
    },

    async addListener(name, cb) {
      if (name === 'progress') listeners.push(cb);
      return { remove: async () => listeners.splice(listeners.indexOf(cb), 1) };
    },
    async cancel({ opId }) {
      if (opId) cancelled.add(opId);
    },

    async hasAccess() {
      return { granted: access, sdk: 34 };
    },
    async requestAccess() {
      calls.push(['requestAccess']);
    },
    async openAppSettings() {
      calls.push(['openAppSettings']);
    },
    async getVolumes() {
      return { volumes: volumes.map((v) => ({ ...v })) };
    },
    async existsMany({ paths }) {
      return { existing: paths.filter((p) => nodes.get(p)?.dir) };
    },

    async list({ path, showHidden = false }) {
      const n = nodes.get(path);
      if (!n || !n.dir) fail('La carpeta ya no existe.');
      return { path, entries: children(path).filter((k) => showHidden || !baseName(k).startsWith('.')).map(entry) };
    },
    async stat({ path }) {
      if (!nodes.has(path)) fail('El archivo ya no existe.');
      return { ...entry(path), canRead: true, canWrite: true, hidden: baseName(path).startsWith('.'), parent: parentPath(path) };
    },
    async dirSize({ path }) {
      return treeSize(path);
    },

    async createFolder({ parent, name }) {
      const bad = validateName(name);
      if (bad) fail('Nombre no válido.');
      const p = joinPath(parent, name.trim());
      if (nodes.has(p)) fail('Ya existe algo con ese nombre.');
      put(p, { dir: true });
      return { path: p };
    },
    async createFile({ parent, name, text = '' }) {
      if (validateName(name)) fail('Nombre no válido.');
      const p = joinPath(parent, name.trim());
      if (nodes.has(p)) fail('Ya existe algo con ese nombre.');
      put(p, { size: new TextEncoder().encode(text).length, text, hash: `n:${nextId++}` });
      return { path: p };
    },
    async rename({ path, name }) {
      if (validateName(name)) fail('Nombre no válido.');
      const target = joinPath(parentPath(path), name.trim());
      if (nodes.has(target) && baseName(path).toLowerCase() !== name.trim().toLowerCase()) fail('Ya existe algo con ese nombre.');
      moveSub(path, target);
      return { path: target };
    },
    async readText({ path, max = 1024 * 1024 }) {
      const n = nodes.get(path);
      if (!n || n.dir) fail('El archivo ya no existe.');
      if (n.size > max) return { size: n.size, mtime: n.mtime, tooLarge: true };
      if (n.text == null) return { size: n.size, mtime: n.mtime, binary: true };
      return { size: n.size, mtime: n.mtime, text: n.text };
    },
    async writeText({ path, text }) {
      const n = nodes.get(path);
      if (!n) fail('El archivo ya no existe.');
      n.text = text;
      n.size = new TextEncoder().encode(text).length;
      n.mtime = Date.now();
      return { size: n.size, mtime: n.mtime };
    },

    async conflicts({ items, dest }) {
      return { names: items.filter((p) => nodes.has(joinPath(dest, baseName(p))) && parentPath(p) !== dest).map(baseName) };
    },
    async copy(a) {
      return transfer(a, false);
    },
    async move(a) {
      return transfer(a, true);
    },
    async delete({ items, opId }) {
      const failed = [];
      let ok = 0;
      items.forEach((p, i) => {
        checkCancel(opId);
        emit({ opId, done: i, total: items.length, name: baseName(p) });
        removeSub(p);
        ok++;
      });
      return { ok, failed };
    },

    // papelera
    async trash({ items, opId }) {
      const failed = [];
      const trashed = [];
      const at = Date.now();
      for (const [i, p] of items.entries()) {
        checkCancel(opId);
        emit({ opId, done: i, total: items.length, name: baseName(p) });
        if (!nodes.has(p)) {
          failed.push({ name: baseName(p), reason: 'Ya no existe.' });
          continue;
        }
        const n = nodes.get(p);
        const id = `t${nextId++}`;
        const dataName = id + (n.dir ? '' : splitName(baseName(p)).ext);
        const root = rootOf(p);
        const data = `${root}/${TRASH}/data/${dataName}`;
        mkdirp(`${root}/${TRASH}/data`);
        const size = n.dir ? treeSize(p).size : n.size;
        moveSub(p, data);
        metas.set(data, { name: baseName(p), orig: p, deletedAt: at, dir: n.dir, size });
        trashed.push(data);
      }
      return { ok: trashed.length, failed, trashed };
    },
    async trashList() {
      return {
        entries: [...metas.entries()].map(([path, m]) => ({ name: m.name, orig: m.orig, deletedAt: m.deletedAt, dir: m.dir, size: m.size, path })),
      };
    },
    async trashRestore({ paths }) {
      const failed = [];
      const restored = [];
      for (const data of paths) {
        const m = metas.get(data);
        if (!m) {
          failed.push({ name: baseName(data), reason: 'Faltan los datos de este elemento.' });
          continue;
        }
        mkdirp(parentPath(m.orig));
        const target = unique(parentPath(m.orig), baseName(m.orig), m.dir);
        moveSub(data, target);
        metas.delete(data);
        restored.push(target);
      }
      return { ok: restored.length, failed, restored };
    },
    async trashDelete({ paths }) {
      paths.forEach((p) => {
        removeSub(p);
        metas.delete(p);
      });
      return { ok: paths.length };
    },
    async trashEmpty() {
      const n = metas.size;
      [...metas.keys()].forEach((p) => removeSub(p));
      metas.clear();
      return { ok: n };
    },
    async trashPurge({ days }) {
      let n = 0;
      if (days > 0) {
        for (const [p, m] of [...metas.entries()]) {
          if (m.deletedAt <= Date.now() - days * DAY) {
            removeSub(p);
            metas.delete(p);
            n++;
          }
        }
      }
      return { ok: n };
    },

    // ZIP simulado: guarda una copia del contenido dentro del nodo
    async zip({ items, dest, opId }) {
      if (nodes.has(dest)) fail('Ya existe un archivo con ese nombre.');
      const snapshot = [];
      let total = 0;
      const used = new Set();
      for (const p of items) {
        if (!nodes.has(p)) continue;
        let name = baseName(p);
        for (let n = 2; used.has(name.toLowerCase()); n++) name = `${baseName(p)} (${n})`;
        used.add(name.toLowerCase());
        for (const k of subtree(p)) {
          snapshot.push([name + k.slice(p.length), { ...nodes.get(k) }]);
          total += nodes.get(k).size || 0;
        }
      }
      if (!snapshot.length) fail('No hay nada que comprimir.');
      checkCancel(opId);
      emit({ opId, done: total, total, name: baseName(dest) });
      put(dest, { size: Math.round(total * 0.6) + 22, zip: snapshot, hash: `z:${nextId++}` });
      return { path: dest, size: nodes.get(dest).size };
    },
    async unzip({ path, dest, opId }) {
      const z = nodes.get(path);
      if (!z || !z.zip) fail('El ZIP está dañado o no es un ZIP.');
      const existed = nodes.has(dest);
      mkdirp(dest);
      let files = 0;
      for (const [rel, n] of z.zip) {
        const target = joinPath(dest, rel);
        if (rel.split('/').includes('..')) {
          if (!existed) removeSub(dest);
          fail('El ZIP contiene rutas no válidas y no se extrajo.');
        }
        mkdirp(n.dir ? target : parentPath(target));
        if (n.dir) continue;
        const out = nodes.has(target) ? unique(parentPath(target), baseName(target), false) : target;
        nodes.set(out, { ...n });
        files++;
      }
      checkCancel(opId);
      return { path: dest, files };
    },

    async search({ root, query, showHidden = false, limit = 300, opId }) {
      const q = norm(query.trim());
      if (!q) fail('Escribe algo para buscar.');
      const out = [];
      let truncated = false;
      for (const k of [...nodes.keys()].filter((x) => isUnder(x, root) && x !== root)) {
        checkCancel(opId);
        if (!showHidden && k.slice(root.length).split('/').some((s) => s.startsWith('.'))) continue;
        if (norm(baseName(k)).includes(q)) {
          out.push(entry(k));
          if (out.length >= limit) {
            truncated = true;
            break;
          }
        }
      }
      return { entries: out, truncated };
    },

    // categorías (lo que en el celular sale de MediaStore)
    async category({ type, limit = 500, offset = 0 }) {
      const all = filesBy((p) => {
        const e = { name: baseName(p) };
        const k = kind(e);
        const x = extOf(e.name);
        if (type === 'images') return k === 'image';
        if (type === 'videos') return k === 'video';
        if (type === 'audio') return k === 'audio';
        if (type === 'docs') return DOC.has(x);
        if (type === 'archives') return k === 'archive';
        if (type === 'apks') return x === 'apk';
        return false;
      }).sort((a, b) => b.mtime - a.mtime);
      const page = all.slice(offset, offset + limit);
      return { entries: page, more: offset + limit < all.length };
    },
    async categoryCounts() {
      const out = {};
      for (const t of ['images', 'videos', 'audio', 'docs', 'archives', 'apks']) out[t] = (await api.category({ type: t, limit: 1e9 })).entries.length;
      return out;
    },
    async categorySizes() {
      const out = {};
      for (const t of ['images', 'videos', 'audio', 'docs', 'archives', 'apks']) out[t] = (await api.category({ type: t, limit: 1e9 })).entries.reduce((n, e) => n + (e.size || 0), 0);
      return out;
    },
    async recent({ limit = 80 }) {
      return { entries: filesBy(() => true).sort((a, b) => b.mtime - a.mtime).slice(0, limit) };
    },
    async largest({ minSize = 50 * 1024 * 1024, limit = 150 }) {
      return { entries: filesBy(() => true).filter((e) => e.size >= minSize).sort((a, b) => b.size - a.size).slice(0, limit) };
    },
    async duplicates({ minSize = 1024, opId }) {
      const bySize = new Map();
      for (const e of filesBy(() => true)) {
        if (e.size < minSize) continue;
        bySize.set(e.size, [...(bySize.get(e.size) || []), e]);
      }
      const groups = [];
      for (const [size, list] of bySize) {
        checkCancel(opId);
        if (list.length < 2) continue;
        const byHash = new Map();
        for (const e of list) byHash.set(nodes.get(e.path).hash, [...(byHash.get(nodes.get(e.path).hash) || []), e]);
        for (const g of byHash.values()) if (g.length > 1) groups.push({ size, items: g });
      }
      groups.sort((a, b) => b.size * (b.items.length - 1) - a.size * (a.items.length - 1));
      return { groups };
    },

    async open({ path, chooser = false }) {
      calls.push(['open', path, chooser]);
      return {};
    },
    async share({ paths }) {
      const files = paths.filter((p) => nodes.has(p) && !nodes.get(p).dir);
      if (!files.length) fail('Solo se pueden compartir archivos, no carpetas.');
      calls.push(['share', files]);
    },
    async scan() {},

    async importLegacy({ items }) {
      return { okIds: items.map((i) => i.id), failed: [] };
    },
  };

  function filesBy(pred) {
    return [...nodes.keys()]
      .filter((p) => !nodes.get(p).dir && !hiddenPath(p) && pred(p))
      .map(entry);
  }

  async function transfer({ items, dest, policy = 'rename', opId }, move) {
    if (!nodes.get(dest)?.dir) fail('La carpeta de destino no existe.');
    const failed = [];
    const results = [];
    let ok = 0;
    let skipped = 0;
    for (const [i, src] of items.entries()) {
      checkCancel(opId);
      emit({ opId, done: i, total: items.length, name: baseName(src) });
      const n = nodes.get(src);
      if (!n) {
        failed.push({ name: baseName(src), reason: 'Ya no existe.' });
        continue;
      }
      if (n.dir && isUnder(dest, src)) {
        failed.push({ name: baseName(src), reason: `No se puede ${move ? 'mover' : 'copiar'} una carpeta dentro de sí misma.` });
        continue;
      }
      let target = joinPath(dest, baseName(src));
      const same = target === src;
      if (move && same) {
        skipped++;
        continue;
      }
      if (same || nodes.has(target)) {
        if (same || policy === 'rename') target = unique(dest, baseName(src), n.dir);
        else if (policy === 'skip') {
          skipped++;
          continue;
        } else removeSub(target);
      }
      if (move) moveSub(src, target);
      else copySub(src, target);
      results.push(target);
      ok++;
    }
    return { ok, skipped, failed, results };
  }

  return api;
}
