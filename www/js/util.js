// Utilidades puras (sin DOM): se prueban con `npm test`.

export const MAX_SIZE = 20 * 1024 * 1024; // 20 MB por archivo
export const TRASH_DAYS = 30;
export const DAY_MS = 86400000;
export const TRASH_MS = TRASH_DAYS * DAY_MS;
export const MAX_NAME = 150;

const FORBIDDEN_G = /[\\/:*?"<>|\u0000-\u001f\u007f]/g;
const FORBIDDEN = /[\\/:*?"<>|\u0000-\u001f\u007f]/;

export function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/** Minúsculas y sin acentos, para buscar. */
export function norm(s) {
  return String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

/** "foto.final.jpg" -> { base: "foto.final", ext: ".jpg" }. ".env" y "README" no tienen extensión. */
export function splitName(name) {
  const i = name.lastIndexOf('.');
  if (i <= 0 || i === name.length - 1) return { base: name, ext: '' };
  return { base: name.slice(0, i), ext: name.slice(i) };
}

/** Limpia un nombre que viene del selector del sistema. */
export function sanitizeName(raw) {
  let n = String(raw == null ? '' : raw).replace(FORBIDDEN_G, '_').replace(/\s+/g, ' ').trim();
  n = n.replace(/[. ]+$/, '');
  if (!n || n === '.' || n === '..') n = 'archivo';
  if (n.length > MAX_NAME) {
    const { base, ext } = splitName(n);
    const e = ext.slice(0, 20);
    n = base.slice(0, MAX_NAME - e.length) + e;
  }
  return n;
}

/**
 * Si `name` ya existe en `taken` (Set de nombres en minúscula) devuelve "nombre (2).ext",
 * "nombre (3).ext", etc. Si el nombre ya traía " (n)", sigue contando desde la base.
 */
export function uniqueName(name, taken) {
  if (!taken.has(name.toLowerCase())) return name;
  const { base, ext } = splitName(name);
  const m = base.match(/^(.*) \((\d+)\)$/);
  const stem = m ? m[1] : base;
  for (let n = 2; ; n++) {
    const candidate = `${stem} (${n})${ext}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
}

/** Valida el nombre (sin extensión) al renombrar. `taken` = nombres activos en minúscula, sin el propio. */
export function validateRename(base, ext, taken) {
  const b = String(base).trim();
  if (!b) return 'El nombre no puede estar vacío.';
  if (FORBIDDEN.test(b)) return 'No puede contener / \\ : * ? " < > |';
  if (/^\.+$/.test(b)) return 'Nombre no válido.';
  const full = b + ext;
  if (full.length > MAX_NAME) return `Máximo ${MAX_NAME} caracteres.`;
  if (taken.has(full.toLowerCase())) return 'Ya existe un archivo con ese nombre.';
  return '';
}

function rand() {
  if (globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function') return globalThis.crypto.randomUUID();
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 12);
}

/**
 * id único. Lleva la extensión original (saneada) al final: el archivo en disco se llama igual que el id,
 * así el WebView reconoce el tipo al previsualizar y renombrar nunca toca el archivo físico.
 */
export function makeId(name) {
  const e = splitName(name).ext.slice(1).toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 8);
  return rand() + (e ? '.' + e : '');
}

export function formatSize(n) {
  if (!Number.isFinite(n) || n < 0) n = 0;
  if (n < 1024) return `${n} B`;
  const units = ['B', 'KB', 'MB', 'GB'];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < 3) {
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

export function daysLeft(trashedAt, now = Date.now()) {
  return Math.ceil((trashedAt + TRASH_MS - now) / DAY_MS);
}
export function daysLeftLabel(trashedAt, now = Date.now()) {
  const n = daysLeft(trashedAt, now);
  if (n <= 1) return 'Se elimina en menos de 1 día';
  return `Se elimina en ${n} días`;
}

export function plural(n, one, many) {
  return n === 1 ? one : many;
}

const MIME = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp',
  svg: 'image/svg+xml', heic: 'image/heic', heif: 'image/heif', avif: 'image/avif',
  mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', mkv: 'video/x-matroska',
  '3gp': 'video/3gpp', avi: 'video/x-msvideo',
  mp3: 'audio/mpeg', m4a: 'audio/mp4', aac: 'audio/aac', wav: 'audio/wav', ogg: 'audio/ogg', oga: 'audio/ogg',
  opus: 'audio/ogg', flac: 'audio/flac',
  pdf: 'application/pdf', txt: 'text/plain', md: 'text/markdown', csv: 'text/csv', json: 'application/json',
  html: 'text/html', xml: 'application/xml',
  zip: 'application/zip', rar: 'application/vnd.rar', '7z': 'application/x-7z-compressed', apk: 'application/vnd.android.package-archive',
  doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};

export function guessMime(name) {
  const e = splitName(name).ext.slice(1).toLowerCase();
  return MIME[e] || 'application/octet-stream';
}

export function effectiveType(f) {
  const t = (f.type || '').toLowerCase();
  return t && t !== 'application/octet-stream' ? t : guessMime(f.name);
}

/** image | video | audio | pdf | doc | archive | file */
export function category(f) {
  const t = effectiveType(f);
  if (t.startsWith('image/')) return 'image';
  if (t.startsWith('video/')) return 'video';
  if (t.startsWith('audio/')) return 'audio';
  if (t === 'application/pdf') return 'pdf';
  if (/zip|rar|7z|tar|gzip|compressed/.test(t)) return 'archive';
  if (t.startsWith('text/') || /word|sheet|excel|presentation|powerpoint|json|xml|opendocument/.test(t)) return 'doc';
  return 'file';
}

export const CATEGORY_LABEL = {
  image: 'Imagen', video: 'Video', audio: 'Audio', pdf: 'Documento PDF', doc: 'Documento', archive: 'Archivo comprimido', file: 'Archivo',
};

export function sortFiles(list, mode, trashView) {
  const arr = list.slice();
  if (mode === 'name') arr.sort((a, b) => a.name.localeCompare(b.name, 'es', { numeric: true, sensitivity: 'base' }));
  else if (mode === 'size') arr.sort((a, b) => b.size - a.size || a.name.localeCompare(b.name, 'es'));
  else arr.sort((a, b) => (trashView ? b.trashedAt - a.trashedAt : b.at - a.at));
  return arr;
}
