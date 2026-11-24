// Utilidades puras (sin DOM ni Android): se prueban con `npm test`.

export const DAY_MS = 86400000;
export const MAX_NAME = 255;
export const FORBIDDEN = /[\\/\u0000-\u001f\u007f]/;

export function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/** Minúsculas y sin acentos, para buscar. */
export function norm(s) {
  return String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

export function plural(n, one, many) {
  return n === 1 ? one : many;
}

// ---------------------------------------------------------------- rutas

export function baseName(p) {
  const s = String(p).replace(/\/+$/, '');
  return s.slice(s.lastIndexOf('/') + 1);
}

export function parentPath(p) {
  const s = String(p).replace(/\/+$/, '');
  const i = s.lastIndexOf('/');
  return i <= 0 ? '/' : s.slice(0, i);
}

export function joinPath(dir, name) {
  return `${String(dir).replace(/\/+$/, '')}/${name}`;
}

export function isUnder(path, root) {
  const r = String(root).replace(/\/+$/, '');
  return path === r || path.startsWith(`${r}/`);
}

/** Volumen al que pertenece una ruta (el más específico). */
export function volumeOf(path, volumes) {
  let best = null;
  for (const v of volumes) {
    if (isUnder(path, v.path) && (!best || v.path.length > best.path.length)) best = v;
  }
  return best;
}

/** "/storage/emulated/0/DCIM/Camera" -> [{label:'Almacenamiento interno',path:'/storage/emulated/0'},{label:'DCIM',...},{label:'Camera',...}] */
export function breadcrumbs(path, volumes) {
  const vol = volumeOf(path, volumes);
  if (!vol) return [{ label: path || '/', path }];
  const out = [{ label: vol.label, path: vol.path }];
  const rest = path.slice(vol.path.length).split('/').filter(Boolean);
  let cur = vol.path;
  for (const seg of rest) {
    cur = joinPath(cur, seg);
    out.push({ label: seg, path: cur });
  }
  return out;
}

/** Ruta legible: la raíz del volumen se cambia por su nombre. */
export function displayPath(path, volumes) {
  const vol = volumeOf(path, volumes);
  if (!vol) return path;
  const rest = path.slice(vol.path.length);
  return vol.label + rest;
}

// ---------------------------------------------------------------- nombres

/** "foto.final.jpg" -> { base: "foto.final", ext: ".jpg" }. ".env" y "README" no tienen extensión. */
export function splitName(name) {
  const i = name.lastIndexOf('.');
  if (i <= 0 || i === name.length - 1) return { base: name, ext: '' };
  return { base: name.slice(0, i), ext: name.slice(i) };
}

export function extOf(name) {
  return splitName(name).ext.slice(1).toLowerCase();
}

/**
 * Si `name` ya existe en `taken` (Set en minúscula) devuelve "nombre (2).ext", "nombre (3).ext"…
 * Las carpetas no tienen extensión.
 */
export function uniqueName(name, taken, isDir = false) {
  if (!taken.has(name.toLowerCase())) return name;
  const { base, ext } = isDir ? { base: name, ext: '' } : splitName(name);
  const m = base.match(/^(.*) \((\d+)\)$/);
  const stem = m ? m[1] : base;
  for (let n = 2; ; n++) {
    const candidate = `${stem} (${n})${ext}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
}

/** Valida un nombre de archivo o carpeta. `taken` = nombres existentes en minúscula, sin el propio. '' = correcto. */
export function validateName(name, taken = new Set()) {
  const n = String(name).trim();
  if (!n) return 'El nombre no puede estar vacío.';
  if (FORBIDDEN.test(n)) return 'No puede contener / \\ ni caracteres de control.';
  if (n === '.' || n === '..') return 'Nombre no válido.';
  if (new TextEncoder().encode(n).length > MAX_NAME) return `Máximo ${MAX_NAME} caracteres.`;
  if (taken.has(n.toLowerCase())) return 'Ya existe algo con ese nombre.';
  return '';
}

// ---------------------------------------------------------------- formato

export function formatSize(n) {
  if (!Number.isFinite(n) || n < 0) n = 0;
  if (n < 1024) return `${n} B`;
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < 4) {
    v /= 1024;
    i++;
  }
  return `${v.toLocaleString('es-CO', { maximumFractionDigits: v >= 100 ? 0 : 1 })} ${units[i]}`;
}

let dFmt;
let dtFmt;
export function formatDate(ts) {
  dFmt = dFmt || new Intl.DateTimeFormat('es-CO', { day: 'numeric', month: 'short', year: 'numeric' });
  return dFmt.format(ts);
}
export function formatDateTime(ts) {
  dtFmt = dtFmt || new Intl.DateTimeFormat('es-CO', { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' });
  return dtFmt.format(ts);
}

export function percent(used, total) {
  if (!total) return 0;
  return Math.max(0, Math.min(100, Math.round((used / total) * 100)));
}

// ---------------------------------------------------------------- papelera

export function daysLeft(deletedAt, retention, now = Date.now()) {
  return Math.ceil((deletedAt + retention * DAY_MS - now) / DAY_MS);
}
/** retention = días (0 = nunca se borra solo). */
export function trashLabel(deletedAt, retention, now = Date.now()) {
  if (!retention) return 'Se queda hasta que la vacíes';
  const n = daysLeft(deletedAt, retention, now);
  if (n <= 1) return 'Se elimina en menos de 1 día';
  return `Se elimina en ${n} días`;
}

// ---------------------------------------------------------------- tipos

const MIME = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp', svg: 'image/svg+xml',
  heic: 'image/heic', heif: 'image/heif', avif: 'image/avif',
  mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', mkv: 'video/x-matroska', '3gp': 'video/3gpp', avi: 'video/x-msvideo',
  mp3: 'audio/mpeg', m4a: 'audio/mp4', aac: 'audio/aac', wav: 'audio/wav', ogg: 'audio/ogg', oga: 'audio/ogg', opus: 'audio/ogg', flac: 'audio/flac',
  pdf: 'application/pdf', txt: 'text/plain', md: 'text/markdown', csv: 'text/csv', json: 'application/json', html: 'text/html', xml: 'application/xml',
  zip: 'application/zip', rar: 'application/vnd.rar', '7z': 'application/x-7z-compressed', apk: 'application/vnd.android.package-archive',
  doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};

export function guessMime(name) {
  return MIME[extOf(name)] || 'application/octet-stream';
}

const TEXT_EXT = new Set([
  'txt', 'md', 'csv', 'json', 'xml', 'html', 'htm', 'css', 'js', 'mjs', 'ts', 'log', 'ini', 'cfg', 'conf', 'yml', 'yaml', 'toml', 'properties',
  'java', 'kt', 'py', 'c', 'h', 'cpp', 'cs', 'sh', 'bat', 'ps1', 'sql', 'gradle', 'srt', 'vtt', 'env', 'gitignore', 'tsv',
]);
const DOC_EXT = new Set(['doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'odt', 'ods', 'odp', 'rtf', 'epub']);
const ARC_EXT = new Set(['zip', 'rar', '7z', 'tar', 'gz', 'tgz', 'bz2', 'xz']);

/** folder | image | video | audio | pdf | text | doc | archive | apk | file */
export function kind(e) {
  if (e.dir) return 'folder';
  const x = extOf(e.name);
  if (x === 'apk') return 'apk';
  const m = MIME[x] || '';
  if (m.startsWith('image/')) return 'image';
  if (m.startsWith('video/')) return 'video';
  if (m.startsWith('audio/')) return 'audio';
  if (x === 'pdf') return 'pdf';
  if (ARC_EXT.has(x)) return 'archive';
  if (TEXT_EXT.has(x) || (!x && /^(readme|license|makefile|dockerfile)$/i.test(e.name))) return 'text';
  if (DOC_EXT.has(x)) return 'doc';
  return 'file';
}

export const KIND_LABEL = {
  folder: 'Carpeta', image: 'Imagen', video: 'Video', audio: 'Audio', pdf: 'Documento PDF', text: 'Texto', doc: 'Documento',
  archive: 'Archivo comprimido', apk: 'App Android (APK)', file: 'Archivo',
};

export const isZip = (e) => !e.dir && extOf(e.name) === 'zip';
export const isEditable = (e) => !e.dir && kind(e) === 'text';

// ---------------------------------------------------------------- orden

/** key: name | date | size | type · dir: asc | desc · foldersFirst: carpetas antes que archivos */
export function sortEntries(list, { key = 'name', dir = 'asc' } = {}, foldersFirst = true) {
  const sign = dir === 'desc' ? -1 : 1;
  const byName = (a, b) => a.name.localeCompare(b.name, 'es', { numeric: true, sensitivity: 'base' });
  const cmp = (a, b) => {
    if (foldersFirst && a.dir !== b.dir) return a.dir ? -1 : 1;
    let r;
    if (key === 'date') r = a.mtime - b.mtime;
    else if (key === 'size') r = (a.dir ? (a.count || 0) : a.size) - (b.dir ? (b.count || 0) : b.size);
    else if (key === 'type') r = extOf(a.name).localeCompare(extOf(b.name)) || byName(a, b);
    else r = byName(a, b);
    return r * sign || byName(a, b);
  };
  return list.slice().sort(cmp);
}

/** Rutas de copias sobrantes de un grupo de duplicados: se conserva la más antigua. */
export function extraCopies(group) {
  const sorted = group.slice().sort((a, b) => a.mtime - b.mtime || a.path.length - b.path.length);
  return sorted.slice(1).map((e) => e.path);
}
