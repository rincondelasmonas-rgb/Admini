// Archivos — administrador de archivos para Android (Capacitor). Todo es local: sin servidor ni cuentas.
import {
  esc, norm, plural, baseName, parentPath, joinPath, volumeOf, breadcrumbs, displayPath, uniqueName, validateName, formatSize, formatDate,
  formatDateTime, percent, trashLabel, kind, KIND_LABEL, isZip, isEditable, extOf, sortEntries, extraCopies, DAY_MS,
} from './util.js';
import * as db from './db.js';
import { Files, isNative, plugin, fileUrl, initProgress, newOpId, watch, isCancel } from './api.js';
import { icon, hydrateIcons } from './icons.js';
import { layers, confirmDialog, infoDialog, choiceDialog, promptDialog, detailsDialog, sheet, progressDialog, snack, toast, hideSnack } from './ui-kit.js';
import { initViewer, openViewer, closeViewer, viewerEntry, viewerReplace, openEditor } from './viewer.js';

const $ = (s, r = document) => r.querySelector(s);

const PAGE = 150; // elementos que se dibujan por tramo
const CAT_PAGE = 500; // elementos que se piden a la galería por tramo
const THUMB_MAX = 12 * 1024 * 1024; // miniaturas solo de imágenes de hasta 12 MB

const CATS = [
  { id: 'images', label: 'Imágenes', icon: 'image', cls: 'c-image' },
  { id: 'videos', label: 'Videos', icon: 'video', cls: 'c-video' },
  { id: 'audio', label: 'Audio', icon: 'audio', cls: 'c-audio' },
  { id: 'docs', label: 'Documentos', icon: 'doc', cls: 'c-doc' },
  { id: 'archives', label: 'Comprimidos', icon: 'archive', cls: 'c-archive' },
  { id: 'apks', label: 'Apps (APK)', icon: 'apk', cls: 'c-apk' },
];
const QUICK = [
  ['Download', 'Descargas', 'download'], ['DCIM', 'Cámara', 'image'], ['Pictures', 'Imágenes', 'image'], ['Documents', 'Documentos', 'doc'],
  ['Music', 'Música', 'audio'], ['Movies', 'Películas', 'video'], ['WhatsApp', 'WhatsApp', 'folder'],
  ['Android/media/com.whatsapp/WhatsApp', 'WhatsApp (media)', 'folder'], ['Telegram', 'Telegram', 'folder'],
];
const LIST_ROUTES = new Set(['folder', 'cat', 'recent', 'large', 'search', 'trash', 'dups']);
const GRID_ROUTES = new Set(['folder', 'cat', 'recent', 'large', 'search']);

// ---------------------------------------------------------------- ajustes y favoritos
const DEFAULTS = {
  showHidden: false, foldersFirst: true, view: 'list', sortKey: 'name', sortDir: 'asc', useTrash: true, trashDays: 30,
  theme: 'auto', textSize: 100, density: 'compact', thumbs: true, startIn: 'home', recentCount: 8,
};
const OPTIONS = {
  theme: ['auto', 'light', 'dark'], textSize: [90, 100, 115, 130], density: ['compact', 'cozy'], startIn: ['home', 'storage'],
  recentCount: [0, 4, 8, 12], view: ['list', 'grid'], sortKey: ['name', 'date', 'size', 'type'], sortDir: ['asc', 'desc'], trashDays: [0, 7, 30, 90],
};

// aplica tema, tamaño de texto y densidad al documento
function applyAppearance() {
  const st = S.settings;
  const root = document.documentElement;
  if (st.theme === 'light' || st.theme === 'dark') root.setAttribute('data-theme', st.theme);
  else root.removeAttribute('data-theme');
  root.style.fontSize = `${st.textSize}%`;
  document.body.classList.toggle('dense', st.density === 'compact');
  const dark = st.theme === 'dark' || (st.theme === 'auto' && window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
  document.querySelectorAll('meta[name="theme-color"]').forEach((m) => m.remove());
  const m = document.createElement('meta');
  m.name = 'theme-color';
  m.content = dark ? '#162127' : '#FFFFFF';
  document.head.appendChild(m);
}

function loadSettings() {
  try {
    const raw = JSON.parse(localStorage.getItem('archivos.settings') || '{}');
    const out = { ...DEFAULTS, ...raw };
    for (const k of Object.keys(OPTIONS)) if (!OPTIONS[k].includes(out[k])) out[k] = DEFAULTS[k];
    for (const k of ['showHidden', 'foldersFirst', 'useTrash', 'thumbs']) if (typeof out[k] !== 'boolean') out[k] = DEFAULTS[k];
    return out;
  } catch (e) {
    return { ...DEFAULTS };
  }
}
function loadFavs() {
  try {
    const a = JSON.parse(localStorage.getItem('archivos.favs') || '[]');
    return Array.isArray(a) ? a.filter((x) => typeof x === 'string') : [];
  } catch (e) {
    return [];
  }
}
function persist(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch (e) {
    /* sin almacenamiento de preferencias: no pasa nada */
  }
}

// ---------------------------------------------------------------- estado
const S = {
  access: null, // null = sin comprobar · true / false
  volumes: [], counts: null, quickExisting: [], homeRecent: [], trashInfo: null,
  route: { name: 'home' }, history: [],
  entries: [], more: false, loading: false, loadingMore: false, error: null, seq: 0, offset: 0,
  view: [], byPath: new Map(), rendered: 0,
  selecting: false, selected: new Set(),
  clip: null, // { mode: 'copy' | 'cut', items: [ruta], count }
  settings: loadSettings(), favs: loadFavs(),
  groups: [], query: '', truncated: false, searching: false, searchSeq: 0, searchOps: [], searchTimer: null,
  busy: false, version: '',
};
let suppressClick = false;
let observer = null;

const rname = () => S.route.name;
const isGrid = () => S.settings.view === 'grid' && GRID_ROUTES.has(rname());
const trashDays = () => S.settings.trashDays;
const countText = (n, one, many) => `${n} ${plural(n, one, many)}`;
const primaryRoot = () => (S.volumes[0] ? S.volumes[0].path : '/storage/emulated/0');

// ---------------------------------------------------------------- operaciones con progreso y cancelar
async function runOp(title, fn, { bytes = false } = {}) {
  const opId = newOpId();
  let dlg = null;
  const timer = setTimeout(() => {
    dlg = progressDialog({ title, onCancel: () => Files.cancel({ opId }).catch(() => {}) });
    dlg.update({ name: '', fraction: null, text: '' });
  }, 400); // si termina rápido, nunca se ve el diálogo
  const off = watch(opId, (e) => {
    if (!dlg) return;
    const frac = e.total > 0 ? e.done / e.total : null;
    dlg.update({ name: e.name || '', fraction: frac, text: e.total > 0 ? (bytes ? `${formatSize(e.done)} de ${formatSize(e.total)}` : `${Math.min(e.done, e.total)} de ${e.total}`) : '' });
  });
  try {
    return await fn(opId);
  } finally {
    clearTimeout(timer);
    off();
    if (dlg) dlg.close();
  }
}

async function guarded(fn) {
  if (S.busy) return;
  S.busy = true;
  try {
    await fn();
  } catch (e) {
    if (isCancel(e)) {
      toast('Operación cancelada');
      await reloadCurrent().catch(() => {});
    } else {
      console.error(e);
      await infoDialog({ title: 'No se pudo completar', message: (e && e.message) || 'Algo salió mal. Inténtalo de nuevo.' });
    }
  } finally {
    S.busy = false;
  }
}

function reportFailures(title, failed) {
  if (!failed || !failed.length) return Promise.resolve();
  return infoDialog({ title, lines: failed.map((f) => `${f.name}: ${f.reason}`) });
}

// ---------------------------------------------------------------- carga de datos por ruta
function toTrashEntry(t) {
  return { name: t.name, path: t.path, dir: t.dir, size: t.size, mtime: t.deletedAt, deletedAt: t.deletedAt, orig: t.orig, trash: true };
}

async function loadHome(seq) {
  const alive = () => seq === S.seq && rname() === 'home';
  const vols = await Files.getVolumes();
  S.volumes = vols.volumes;
  if (!alive()) return;
  renderAll();
  const paths = QUICK.map((q) => joinPath(primaryRoot(), q[0])).concat(S.favs);
  const jobs = [
    Files.existsMany({ paths }).then((r) => { S.quickExisting = r.existing; }),
    Files.categoryCounts().then((c) => { S.counts = c; }),
    Files.recent({ limit: Math.max(S.settings.recentCount, 1) }).then((r) => { S.homeRecent = r.entries; }),
    Files.trashList().then((r) => { S.trashInfo = { count: r.entries.length, size: r.entries.reduce((s, t) => s + (t.size || 0), 0) }; }),
  ];
  for (const j of jobs) {
    j.catch((e) => console.error(e)).finally(() => {
      if (alive()) renderView();
    });
  }
  await Promise.allSettled(jobs);
}

async function load() {
  const r = S.route;
  const seq = ++S.seq;
  S.loading = true;
  S.error = null;
  S.offset = 0;
  try {
    switch (r.name) {
      case 'home':
        await loadHome(seq);
        break;
      case 'folder': {
        const res = await Files.list({ path: r.path, showHidden: S.settings.showHidden });
        if (seq === S.seq) S.entries = res.entries;
        break;
      }
      case 'cat': {
        const res = await Files.category({ type: r.type, limit: CAT_PAGE, offset: 0 });
        if (seq === S.seq) {
          S.entries = res.entries;
          S.more = res.more;
          S.offset = CAT_PAGE;
        }
        break;
      }
      case 'recent': {
        const res = await Files.recent({ limit: 100 });
        if (seq === S.seq) S.entries = res.entries;
        break;
      }
      case 'large': {
        const res = await Files.largest({ minSize: 50 * 1024 * 1024, limit: 150 });
        if (seq === S.seq) S.entries = res.entries;
        break;
      }
      case 'trash': {
        const res = await Files.trashList();
        if (seq === S.seq) S.entries = res.entries.map(toTrashEntry).sort((a, b) => b.deletedAt - a.deletedAt);
        break;
      }
      case 'settings': {
        const tl = await Files.trashList().catch(() => null);
        if (tl && seq === S.seq) S.trashInfo = { count: tl.entries.length, size: tl.entries.reduce((t, x) => t + (x.size || 0), 0) };
        break;
      }
      case 'dups':
        if (seq === S.seq && !r.scanned) {
          r.scanned = true;
          await scanDuplicates(seq);
        }
        break;
      default:
        break;
    }
  } catch (e) {
    if (seq === S.seq && !isCancel(e)) {
      console.error(e);
      S.error = (e && e.message) || 'No se pudo cargar.';
    }
  } finally {
    if (seq === S.seq) S.loading = false;
  }
}

async function reloadCurrent() {
  const top = $('#content').scrollTop;
  if (rname() === 'search') await runSearch();
  else if (rname() === 'dups') {
    S.route.scanned = false;
    await load();
  } else await load();
  renderAll();
  $('#content').scrollTop = top;
}

// ---------------------------------------------------------------- navegación
function resetRouteState() {
  S.entries = [];
  S.more = false;
  S.error = null;
  S.groups = [];
  S.query = '';
  S.truncated = false;
  S.searching = false;
  S.selecting = false;
  S.selected.clear();
  S.rendered = 0;
}

async function go(route, { push = true } = {}) {
  hideSnack();
  if (push) S.history.push(S.route);
  S.route = route;
  resetRouteState();
  $('#content').scrollTop = 0;
  S.loading = !['search', 'settings', 'clean'].includes(route.name);
  renderAll();
  if (route.name === 'search') {
    setTimeout(() => {
      const i = $('#searchInput');
      if (i) i.focus();
    }, 60);
    return;
  }
  await load();
  renderAll();
}

function goBack() {
  if (S.history.length) return go(S.history.pop(), { push: false });
  if (rname() !== 'home') return go({ name: 'home' }, { push: false });
  return undefined;
}

function openFolder(path) {
  go({ name: 'folder', path });
}

/** Botón Atrás de Android: de lo más superficial a lo más profundo; al final, salir. */
function onBack() {
  if (layers.closeTop()) return;
  if (S.selecting) return exitSelection();
  if (S.access === false) return exitApp();
  if (S.history.length || rname() !== 'home') return goBack();
  return exitApp();
}

function exitApp() {
  const App = plugin('App');
  if (isNative && App && App.exitApp) App.exitApp();
}

// ---------------------------------------------------------------- vista calculada
function computeView() {
  const n = rname();
  let list = S.entries;
  if (n === 'folder' || n === 'search') list = sortEntries(list, { key: S.settings.sortKey, dir: S.settings.sortDir }, S.settings.foldersFirst);
  if (n === 'dups') list = S.groups.flatMap((g) => g.items);
  S.view = list;
  S.byPath = new Map(list.map((e) => [e.path, e]));
}

function pruneSelection() {
  for (const p of [...S.selected]) if (!S.byPath.has(p)) S.selected.delete(p);
  if (S.selecting && S.selected.size === 0) S.selecting = false;
}

// ---------------------------------------------------------------- dibujo
function renderAll() {
  computeView();
  renderTopbar();
  renderCrumbs();
  renderBanner();
  renderView();
  renderBars();
  document.body.classList.toggle('selecting', S.selecting);
}

const tbBtn = (a, ic, label, cls = '') => `<button type="button" class="icon-btn ${cls}" data-a="${a}" aria-label="${label}">${icon(ic)}</button>`;

function titleOf() {
  const r = S.route;
  switch (r.name) {
    case 'folder': {
      const crumbs = breadcrumbs(r.path, S.volumes);
      return crumbs[crumbs.length - 1].label;
    }
    case 'cat': return (CATS.find((c) => c.id === r.type) || {}).label || 'Categoría';
    case 'recent': return 'Recientes';
    case 'large': return 'Archivos grandes';
    case 'trash': return 'Papelera';
    case 'clean': return 'Limpieza';
    case 'dups': return 'Duplicados';
    case 'settings': return 'Ajustes';
    default: return 'Archivos';
  }
}

function renderTopbar() {
  const tb = $('#topbar');
  if (S.access === false) {
    tb.innerHTML = '<div class="tb-row"><div class="tb-title"><h1>Archivos</h1></div></div>';
    return;
  }
  if (S.selecting) {
    tb.innerHTML = `<div class="tb-row">${tbBtn('selclose', 'x', 'Salir de la selección')}<div class="tb-title sel-count" aria-live="polite">${countText(S.selected.size, 'seleccionado', 'seleccionados')}</div>${tbBtn('selall', 'checkall', 'Seleccionar todo')}</div>`;
    return;
  }
  const n = rname();
  if (n === 'home') {
    const v = S.volumes[0];
    const sub = v ? `${formatSize(v.total - v.free)} usados de ${formatSize(v.total)}` : '';
    tb.innerHTML = `<div class="tb-row"><div class="tb-title"><h1>Archivos</h1><p class="tb-sub">${esc(sub)}</p></div>${tbBtn('search', 'search', 'Buscar')}${tbBtn('settings', 'settings', 'Ajustes')}</div>`;
    return;
  }
  if (n === 'search') {
    tb.innerHTML = `<div class="tb-row">${tbBtn('back', 'back', 'Volver')}<div class="search-field"><span class="search-ic">${icon('search')}</span><input id="searchInput" type="search" inputmode="search" placeholder="${esc(S.route.root ? `Buscar en ${baseName(S.route.root)}` : 'Buscar en todo el almacenamiento')}" autocomplete="off" autocapitalize="none" spellcheck="false" aria-label="Buscar"><button type="button" class="icon-btn small" data-a="clearsearch" aria-label="Borrar búsqueda">${icon('x')}</button></div></div>`;
    $('#searchInput').value = S.query;
    return;
  }
  let sub = '';
  if (n === 'folder' && !S.loading) sub = countText(S.view.length, 'elemento', 'elementos');
  if (n === 'trash' && S.entries.length) sub = `${countText(S.entries.length, 'elemento', 'elementos')} · ${formatSize(S.entries.reduce((s, e) => s + e.size, 0))}`;
  let right = '';
  if (n === 'folder') right = tbBtn('search', 'search', 'Buscar aquí') + tbBtn('view', S.settings.view === 'grid' ? 'list' : 'grid', 'Cambiar vista') + tbBtn('more', 'more', 'Más opciones');
  else if (GRID_ROUTES.has(n)) right = tbBtn('view', S.settings.view === 'grid' ? 'list' : 'grid', 'Cambiar vista');
  else if (n === 'trash') right = tbBtn('more', 'more', 'Más opciones');
  tb.innerHTML = `<div class="tb-row">${tbBtn('back', 'back', 'Volver')}<div class="tb-title"><h1 class="sm">${esc(titleOf())}</h1>${sub ? `<p class="tb-sub">${esc(sub)}</p>` : ''}</div>${right}</div>`;
}

function renderCrumbs() {
  const el = $('#crumbs');
  const show = rname() === 'folder' && !S.selecting && S.access;
  el.classList.toggle('hidden', !show);
  if (!show) return;
  const parts = breadcrumbs(S.route.path, S.volumes);
  el.innerHTML = parts
    .map((c, i) => `${i ? `<span class="crumb-sep">${icon('chevron')}</span>` : ''}<button type="button" class="crumb ${i === parts.length - 1 ? 'on' : ''}" data-crumb="${esc(c.path)}">${esc(c.label)}</button>`)
    .join('');
  el.scrollLeft = el.scrollWidth;
}

function renderBanner() {
  const el = $('#banner');
  const n = rname();
  let html = '';
  if (n === 'trash' && S.entries.length) {
    html = `<span>${trashDays() ? `Se eliminan solos a los ${trashDays()} días.` : 'Se quedan aquí hasta que vacíes la papelera.'}</span><button type="button" class="btn text danger-text" data-b="empty">Vaciar</button>`;
  } else if (n === 'search') {
    if (S.searching) html = '<span>Buscando…</span>';
    else if (S.query.trim()) html = `<span>${countText(S.entries.length, 'resultado', 'resultados')}${S.truncated ? ' (hay más: escribe más letras para afinar)' : ''}</span>`;
    else html = '<span>Escribe el nombre de lo que buscas.</span>';
  } else if (n === 'dups' && S.groups.length) {
    const waste = S.groups.reduce((s, g) => s + g.size * (g.items.length - 1), 0);
    html = `<span>${countText(S.groups.length, 'grupo', 'grupos')} · puedes liberar ${formatSize(waste)}</span><button type="button" class="btn text" data-b="extras">Elegir copias</button>`;
  } else if (n === 'large') {
    html = '<span>Archivos de 50 MB o más, de mayor a menor.</span>';
  }
  el.classList.toggle('hidden', !html || S.selecting);
  el.innerHTML = html;
}

// --- vista principal
function thumbHtml(e) {
  const k = kind(e);
  const img = S.settings.thumbs && k === 'image' && e.size <= THUMB_MAX ? `<img src="${esc(fileUrl(e.path))}" alt="" loading="lazy" decoding="async">` : '';
  return `<div class="thumb c-${k}">${icon(k)}${img}</div>`;
}

function subText(e) {
  if (e.trash) return `${formatSize(e.size)} · ${trashLabel(e.deletedAt, trashDays())}`;
  if (e.dir) return `${countText(e.count || 0, 'elemento', 'elementos')} · ${formatDate(e.mtime)}`;
  return `${formatSize(e.size)} · ${formatDate(e.mtime)}`;
}

function pathLine(e) {
  const n = rname();
  if (n === 'folder' || isGrid()) return '';
  const where = e.trash ? e.orig && parentPath(e.orig) : parentPath(e.path);
  return where ? `<div class="path">${esc(displayPath(where, S.volumes))}</div>` : '';
}

function itemHtml(e) {
  const sel = S.selected.has(e.path);
  return `<li class="item${sel ? ' selected' : ''}" data-path="${esc(e.path)}" role="listitem">
    ${thumbHtml(e)}
    <div class="meta"><div class="name">${esc(e.name)}</div><div class="sub">${esc(subText(e))}</div>${pathLine(e)}</div>
    <span class="trail"><span class="check"><i>${icon('check')}</i></span><button type="button" class="icon-btn more-btn" data-more aria-label="Más opciones de ${esc(e.name)}">${icon('more')}</button></span></li>`;
}

function groupsHtml() {
  return S.groups
    .map(
      (g) => `<li class="group-head">${icon('dup')}<span>${countText(g.items.length, 'copia', 'copias')} · ${formatSize(g.size)} cada una</span></li>${g.items.map(itemHtml).join('')}`
    )
    .join('');
}

function emptyHtml() {
  const n = rname();
  let ic = 'empty';
  let title = 'Aquí no hay nada';
  let text = '';
  let extra = '';
  if (S.error) {
    ic = 'x';
    title = 'No se pudo abrir';
    text = S.error;
    extra = '<button type="button" class="btn primary" data-a="retry">Reintentar</button>';
  } else if (n === 'trash') {
    ic = 'trash';
    title = 'La papelera está vacía';
    text = trashDays() ? `Lo que elimines aparece aquí y se borra solo a los ${trashDays()} días.` : 'Lo que elimines aparece aquí hasta que la vacíes.';
  } else if (n === 'search') {
    ic = 'search';
    title = S.query.trim() ? 'Sin resultados' : 'Buscar';
    text = S.query.trim() ? `No hay nada que coincida con “${S.query.trim()}”.` : '';
  } else if (n === 'dups') {
    ic = 'dup';
    title = 'No hay duplicados';
    text = 'No se encontraron archivos repetidos.';
  } else if (n === 'folder') {
    ic = 'folder';
    title = 'Carpeta vacía';
    text = 'Toca ⋮ para crear una carpeta o un archivo de texto.';
  } else if (n === 'large') {
    title = 'Nada pesado';
    text = 'No hay archivos de 50 MB o más.';
  }
  return `<div class="empty"><div class="badge">${icon(ic)}</div><h2>${esc(title)}</h2>${text ? `<p>${esc(text)}</p>` : ''}${extra}</div>`;
}

function appendChunk() {
  const list = $('#list');
  if (!list || S.rendered >= S.view.length) return;
  const to = Math.min(S.view.length, S.rendered + PAGE);
  list.insertAdjacentHTML('beforeend', S.view.slice(S.rendered, to).map(itemHtml).join(''));
  S.rendered = to;
}

function armSentinel() {
  if (observer) observer.disconnect();
  const sentinel = $('#sentinel');
  if (!sentinel || !('IntersectionObserver' in window)) return;
  observer = new IntersectionObserver((entries) => {
    if (!entries.some((x) => x.isIntersecting)) return;
    if (S.rendered < S.view.length) {
      appendChunk();
      armSentinel();
    } else if (S.more && !S.loadingMore && rname() === 'cat') {
      loadMore();
    }
  }, { root: $('#content'), rootMargin: '400px' });
  observer.observe(sentinel);
}

async function loadMore() {
  S.loadingMore = true;
  const seq = S.seq;
  try {
    const res = await Files.category({ type: S.route.type, limit: CAT_PAGE, offset: S.offset });
    if (seq !== S.seq) return;
    S.offset += CAT_PAGE;
    S.entries = S.entries.concat(res.entries);
    S.more = res.more;
    computeView();
    appendChunk();
    armSentinel();
  } catch (e) {
    console.error(e);
  } finally {
    S.loadingMore = false;
  }
}

function renderView() {
  const root = $('#view');
  const n = rname();
  document.body.classList.toggle('gate', S.access === false);
  if (S.access === false) {
    root.innerHTML = gateHtml();
    return;
  }
  if (n === 'home') {
    root.innerHTML = homeHtml();
    return;
  }
  if (n === 'settings') {
    root.innerHTML = settingsHtml();
    return;
  }
  if (n === 'clean') {
    root.innerHTML = cleanHtml();
    return;
  }
  if (observer) observer.disconnect();
  computeView();
  pruneSelection();
  if (S.loading && !S.view.length) {
    root.innerHTML = `<div class="empty"><div class="spinner"></div><p>${n === 'dups' ? 'Buscando archivos repetidos…' : 'Cargando…'}</p></div>`;
    return;
  }
  if (S.error || !S.view.length) {
    root.innerHTML = emptyHtml();
    return;
  }
  S.rendered = 0;
  if (n === 'dups') {
    root.innerHTML = `<ul class="list" id="list">${groupsHtml()}</ul>`;
    S.rendered = S.view.length;
    return;
  }
  root.innerHTML = `<ul class="list ${isGrid() ? 'grid' : ''}" id="list"></ul>`;
  appendChunk();
  armSentinel();
}

// --- portada
function homeHtml() {
  const vols = S.volumes
    .map((v) => {
      const used = v.total - v.free;
      return `<button type="button" class="vol-card" data-vol="${esc(v.path)}"><span class="vol-ic">${icon(v.primary ? 'phone' : 'sd')}</span>
        <span class="vol-meta"><span class="vol-name">${esc(v.label)}</span><span class="vol-sub">${formatSize(used)} usados de ${formatSize(v.total)} · ${formatSize(v.free)} libres</span>
        <span class="vol-bar"><i style="width:${percent(used, v.total)}%"></i></span></span>${icon('chevron')}</button>`;
    })
    .join('');
  const cats = CATS.map(
    (c) => `<button type="button" class="cat" data-cat="${c.id}"><span class="cat-ic ${c.cls}">${icon(c.icon)}</span><span class="cat-name">${c.label}</span><span class="cat-n">${S.counts ? S.counts[c.id] : ''}</span></button>`
  ).join('');
  const have = new Set(S.quickExisting);
  const chips = QUICK.map((q) => ({ path: joinPath(primaryRoot(), q[0]), label: q[1], ic: q[2] }))
    .concat(S.favs.map((p) => ({ path: p, label: baseName(p), ic: 'star' })))
    .filter((c) => have.has(c.path))
    .map((c) => `<button type="button" class="chip" data-quick="${esc(c.path)}">${icon(c.ic)}<span>${esc(c.label)}</span></button>`)
    .join('');
  const recent = S.settings.recentCount > 0
    ? S.homeRecent.slice(0, S.settings.recentCount).map(
      (e) => `<button type="button" class="rc" data-recent="${esc(e.path)}">${thumbHtml(e)}<span class="rc-name">${esc(e.name)}</span><span class="rc-sub">${esc(formatSize(e.size))} · ${esc(formatDate(e.mtime))}</span></button>`
    ).join('')
    : '';
  const ti = S.trashInfo;
  return `<div class="home">
    <section class="vols">${vols}</section>
    ${S.settings.recentCount > 0 ? `<div class="section-head"><h2 class="section-title">Recientes</h2><button type="button" class="btn text" data-a="seerecent">Ver todo</button></div>${recent ? `<section class="rc-strip">${recent}</section>` : '<p class="rc-empty">Aún no hay archivos recientes.</p>'}` : ''}
    <h2 class="section-title">Categorías</h2><section class="cat-grid">${cats}</section>
    ${chips ? `<h2 class="section-title">Carpetas</h2><section class="chips">${chips}</section>` : ''}
    <h2 class="section-title">Herramientas</h2>
    <section class="tools">
      <button type="button" class="tool" data-tool="trash"><span class="tool-ic">${icon('trash')}</span><span class="tool-meta"><b>Papelera</b><small>${ti ? (ti.count ? `${countText(ti.count, 'elemento', 'elementos')} · ${formatSize(ti.size)}` : 'Vacía') : ''}</small></span>${icon('chevron')}</button>
      <button type="button" class="tool" data-tool="clean"><span class="tool-ic">${icon('clean')}</span><span class="tool-meta"><b>Limpieza</b><small>Archivos grandes y duplicados</small></span>${icon('chevron')}</button>
      <button type="button" class="tool" data-tool="settings"><span class="tool-ic">${icon('settings')}</span><span class="tool-meta"><b>Ajustes</b><small>Tema, texto, orden, papelera, permisos</small></span>${icon('chevron')}</button>
    </section></div>`;
}

function cleanHtml() {
  return `<div class="home"><section class="tools">
    <button type="button" class="tool" data-tool="large"><span class="tool-ic">${icon('big')}</span><span class="tool-meta"><b>Archivos grandes</b><small>Los de 50 MB o más, de mayor a menor</small></span>${icon('chevron')}</button>
    <button type="button" class="tool" data-tool="dups"><span class="tool-ic">${icon('dup')}</span><span class="tool-meta"><b>Duplicados</b><small>Archivos idénticos repetidos (compara el contenido)</small></span>${icon('chevron')}</button>
    <button type="button" class="tool" data-tool="trash"><span class="tool-ic">${icon('trash')}</span><span class="tool-meta"><b>Papelera</b><small>Revisa o vacía lo eliminado</small></span>${icon('chevron')}</button>
  </section></div>`;
}

function gateHtml() {
  const legacy = S.sdk && S.sdk < 30;
  return `<div class="gate-card"><div class="badge">${icon('lock')}</div><h2>Necesito acceso a tus archivos</h2>
    <p>Para ser un administrador de archivos de verdad (ver carpetas, copiar, mover y borrar) Android pide un permiso especial.</p>
    <ol><li>Toca <b>Dar permiso</b>.</li><li>${legacy ? 'Acepta el aviso de Android.' : 'Activa <b>Permitir acceso para gestionar todos los archivos</b> para “Archivos”.'}</li><li>Vuelve a esta app: se abre sola.</li></ol>
    <button type="button" class="btn primary" data-a="grant">Dar permiso</button>
    <button type="button" class="btn text" data-a="appsettings">Abrir ajustes de la app</button>
    <p class="fine">Todo se queda en tu teléfono. La app no usa internet.</p></div>`;
}

// --- ajustes
const sw = (key, on, label, sub) => `<button type="button" class="set-row" data-set="${key}" role="switch" aria-checked="${on}"><span class="set-meta"><b>${label}</b>${sub ? `<small>${sub}</small>` : ''}</span><span class="switch"><i></i></span></button>`;
const seg = (key, cur, opts) => `<div class="seg" role="radiogroup">${opts.map(([v, l]) => `<button type="button" role="radio" class="seg-btn" data-set="${key}" data-val="${v}" aria-checked="${String(cur) === String(v)}">${l}</button>`).join('')}</div>`;

function settingsHtml() {
  const s = S.settings;
  const ti = S.trashInfo;
  const trashTxt = ti ? (ti.count ? `${countText(ti.count, 'elemento', 'elementos')} · ${formatSize(ti.size)}` : 'La papelera está vacía') : '';
  return `<div class="settings">
    <h2 class="section-title">Apariencia</h2>
    <section class="card">
      <div class="set-row static"><span class="set-meta"><b>Tema</b><small>Automático sigue al del teléfono</small></span>${seg('theme', s.theme, [['auto', 'Automático'], ['light', 'Claro'], ['dark', 'Oscuro']])}</div>
      <div class="set-row static"><span class="set-meta"><b>Tamaño del texto</b></span>${seg('textSize', s.textSize, [[90, 'Pequeño'], [100, 'Normal'], [115, 'Grande'], [130, 'Muy grande']])}</div>
      <div class="set-row static"><span class="set-meta"><b>Filas de la lista</b><small>Compacta muestra más archivos sin espacio de sobra</small></span>${seg('density', s.density, [['compact', 'Compacta'], ['cozy', 'Cómoda']])}</div>
      ${sw('thumbs', s.thumbs, 'Miniaturas de imágenes', 'Si lo apagas se ve solo el icono (más ligero)')}
    </section>
    <h2 class="section-title">Carpetas y orden</h2>
    <section class="card">
      <div class="set-row static"><span class="set-meta"><b>Vista de carpetas</b></span>${seg('view', s.view, [['list', 'Lista'], ['grid', 'Cuadrícula']])}</div>
      <div class="set-row static"><span class="set-meta"><b>Ordenar por</b><small>En carpetas y en la búsqueda</small></span>${seg('sortKey', s.sortKey, [['name', 'Nombre'], ['date', 'Fecha'], ['size', 'Tamaño'], ['type', 'Tipo']])}</div>
      <div class="set-row static"><span class="set-meta"><b>Dirección</b></span>${seg('sortDir', s.sortDir, [['asc', 'Ascendente'], ['desc', 'Descendente']])}</div>
      ${sw('foldersFirst', s.foldersFirst, 'Carpetas primero', 'Antes que los archivos al ordenar')}
      ${sw('showHidden', s.showHidden, 'Mostrar archivos ocultos', 'Los que empiezan con punto')}
    </section>
    <h2 class="section-title">Inicio</h2>
    <section class="card">
      <div class="set-row static"><span class="set-meta"><b>Al abrir la app</b><small>Dónde empiezas</small></span>${seg('startIn', s.startIn, [['home', 'Portada'], ['storage', 'Almacenamiento']])}</div>
      <div class="set-row static"><span class="set-meta"><b>Recientes en la portada</b><small>Cuántos archivos se ven arriba</small></span>${seg('recentCount', s.recentCount, [[0, 'Ocultar'], [4, '4'], [8, '8'], [12, '12']])}</div>
    </section>
    <h2 class="section-title">Papelera</h2>
    <section class="card">
      ${sw('useTrash', s.useTrash, 'Usar la papelera', s.useTrash ? 'Eliminar mueve a la papelera y se puede deshacer' : 'Eliminar borra para siempre (pide confirmación)')}
      <div class="set-row static"><span class="set-meta"><b>Conservar</b><small>Tiempo antes de borrarse sola</small></span>${seg('trashDays', s.trashDays, [[7, '7 días'], [30, '30 días'], [90, '90 días'], [0, 'Siempre']])}</div>
      <div class="set-row static"><span class="set-meta"><b>Vaciar ahora</b><small>${esc(trashTxt)}</small></span><button type="button" class="btn tonal" data-a="emptytrash" ${ti && !ti.count ? 'disabled' : ''}>Vaciar</button></div>
    </section>
    <h2 class="section-title">Permisos</h2>
    <section class="card">
      <div class="set-row static"><span class="set-meta"><b>Acceso a todos los archivos</b><small>${S.access ? 'Activado' : 'Desactivado'}</small></span><button type="button" class="btn tonal" data-a="${S.access ? 'appsettings' : 'grant'}">${S.access ? 'Ajustes' : 'Dar permiso'}</button></div>
    </section>
    <h2 class="section-title">Acerca de</h2>
    <section class="card">
      <div class="set-row static"><span class="set-meta"><b>Archivos</b><small>${S.version ? `Versión ${esc(S.version)} · ` : ''}Todo es local: sin servidor ni cuentas.</small></span></div>
      <div class="set-row static"><span class="set-meta"><b>Restablecer ajustes</b><small>Vuelve a los valores originales (tus archivos no se tocan)</small></span><button type="button" class="btn tonal danger-text" data-a="resetsettings">Restablecer</button></div>
    </section></div>`;
}

// --- barras inferiores
const BAR_ITEMS = {
  copy: ['Copiar', 'copy'], cut: ['Cortar', 'cut'], share: ['Compartir', 'share'], trash: ['Eliminar', 'trash'], more: ['Más', 'more'],
  restore: ['Restaurar', 'restore'], delete: ['Eliminar', 'trash'],
};

function renderBars() {
  const n = rname();
  const bar = $('#selbar');
  bar.classList.toggle('hidden', !S.selecting);
  if (S.selecting) {
    const keys = n === 'trash' ? ['restore', 'delete'] : ['copy', 'cut', 'share', 'trash', 'more'];
    bar.innerHTML = keys.map((k) => `<button type="button" class="act ${k === 'delete' || (k === 'trash' && !S.settings.useTrash) ? 'danger' : ''}" data-act="${k}">${icon(BAR_ITEMS[k][1])}<span>${BAR_ITEMS[k][0]}</span></button>`).join('');
  }
  const clipOn = !!S.clip && n === 'folder' && !S.selecting;
  const cb = $('#clipbar');
  cb.classList.toggle('hidden', !clipOn);
  if (clipOn) {
    const label = `${S.clip.mode === 'copy' ? 'Copiando' : 'Moviendo'} ${countText(S.clip.count, 'elemento', 'elementos')}`;
    cb.innerHTML = `<span class="clip-ic">${icon(S.clip.mode === 'copy' ? 'copy' : 'cut')}</span><span class="clip-text">${esc(label)}</span><button type="button" class="btn primary" data-clip="paste">${icon('paste')}Pegar aquí</button><button type="button" class="icon-btn" data-clip="cancel" aria-label="Cancelar">${icon('x')}</button>`;
  }
  const fabOn = n === 'folder' && !S.selecting && !clipOn && !S.error;
  $('#fab').classList.toggle('hidden', !fabOn);
  document.body.classList.toggle('fab-on', fabOn);
  document.body.classList.toggle('bar-on', clipOn || S.selecting);
}

// ---------------------------------------------------------------- selección
function enterSelection(path) {
  if (!LIST_ROUTES.has(rname())) return;
  S.selecting = true;
  S.selected = new Set([path]);
  hideSnack();
  syncSelection();
}
function exitSelection() {
  if (!S.selecting) return;
  S.selecting = false;
  S.selected.clear();
  syncSelection();
  renderCrumbs();
  renderBanner();
}
function toggleSelect(path) {
  if (S.selected.has(path)) S.selected.delete(path);
  else S.selected.add(path);
  if (S.selected.size === 0) S.selecting = false;
  syncSelection();
  if (!S.selecting) {
    renderCrumbs();
    renderBanner();
  }
}
function selectAll() {
  const all = S.view.map((e) => e.path);
  const allOn = all.length > 0 && all.every((p) => S.selected.has(p));
  S.selected = allOn ? new Set() : new Set(all);
  if (!S.selected.size) S.selecting = false;
  // dibuja todo lo que falte para que se vea marcado
  while (S.rendered < S.view.length) appendChunk();
  syncSelection();
}
function syncSelection() {
  document.querySelectorAll('#view .item[data-path]').forEach((li) => li.classList.toggle('selected', S.selected.has(li.dataset.path)));
  renderTopbar();
  renderBars();
  $('#banner').classList.toggle('hidden', S.selecting || !$('#banner').innerHTML);
  $('#crumbs').classList.toggle('hidden', S.selecting || rname() !== 'folder');
  document.body.classList.toggle('selecting', S.selecting);
}
const selectedEntries = () => [...S.selected].map((p) => S.byPath.get(p)).filter(Boolean);

// ---------------------------------------------------------------- abrir
async function openExternal(e, chooser = false) {
  try {
    const r = await Files.open({ path: e.path, chooser });
    if (r && r.needsInstallPermission) {
      await infoDialog({ title: 'Permite instalar apps', message: 'Android pidió activar “Permitir de esta fuente” para Archivos. Actívalo, vuelve y toca el APK otra vez.' });
    }
  } catch (err) {
    await infoDialog({ title: 'No se pudo abrir', message: (err && err.message) || 'No hay ninguna app para abrir este archivo.' });
  }
}

async function editText(e) {
  const res = await Files.readText({ path: e.path, max: 1024 * 1024 });
  if (res.tooLarge || res.binary) {
    toast(res.tooLarge ? 'Es muy grande para editarlo aquí: se abre con otra app.' : 'No es un archivo de texto: se abre con otra app.');
    return openExternal(e, true);
  }
  return openEditor(e, res.text, {
    save: async (text) => {
      await Files.writeText({ path: e.path, text });
      toast('Guardado');
      reloadCurrent().catch(() => {});
    },
    onError: (err) => infoDialog({ title: 'No se pudo guardar', message: (err && err.message) || 'Inténtalo de nuevo.' }),
  });
}

function openEntry(e, list) {
  if (!e) return undefined;
  const k = kind(e);
  if (e.dir) return openFolder(e.path);
  if (k === 'image' || k === 'video' || k === 'audio') {
    const group = (list || [e]).filter((x) => kind(x) === k);
    return openViewer(group, Math.max(0, group.findIndex((x) => x.path === e.path)));
  }
  if (isEditable(e)) return guarded(() => editText(e));
  return openExternal(e);
}

// ---------------------------------------------------------------- acciones sobre archivos
const verbo = (mode, n) => (mode === 'copy' ? plural(n, 'copiado', 'copiados') : plural(n, 'movido', 'movidos'));

async function namesIn(dir) {
  const res = await Files.list({ path: dir, showHidden: true });
  return new Set(res.entries.map((x) => x.name.toLowerCase()));
}

function setClip(mode, entries) {
  S.clip = { mode, items: entries.map((e) => e.path), count: entries.length };
  exitSelection();
  renderBars();
  toast(`${countText(entries.length, 'elemento listo', 'elementos listos')} para ${mode === 'copy' ? 'copiar' : 'mover'}. Abre la carpeta de destino y toca “Pegar aquí”.`);
}

async function doPaste() {
  const clip = S.clip;
  if (!clip || rname() !== 'folder') return;
  const dest = S.route.path;
  if (clip.mode === 'cut' && clip.items.every((p) => parentPath(p) === dest)) {
    S.clip = null;
    renderBars();
    toast('Ya están en esta carpeta.');
    return;
  }
  let policy = 'rename';
  const { names } = await Files.conflicts({ items: clip.items, dest });
  if (names.length) {
    const choice = await choiceDialog({
      title: names.length === 1 ? 'Ya existe un elemento con ese nombre' : `Ya existen ${names.length} elementos con el mismo nombre`,
      message: names.length === 1 ? `“${names[0]}”` : names.slice(0, 3).join(', ') + (names.length > 3 ? '…' : ''),
      choices: [{ id: 'rename', label: 'Conservar ambos', primary: true }, { id: 'replace', label: 'Reemplazar', danger: true }, { id: 'skip', label: 'Omitir los repetidos' }],
    });
    if (!choice) return;
    policy = choice;
  }
  const fn = clip.mode === 'copy' ? Files.copy : Files.move;
  const res = await runOp(clip.mode === 'copy' ? 'Copiando' : 'Moviendo', (opId) => fn.call(Files, { items: clip.items, dest, policy, opId }), { bytes: true });
  if (clip.mode === 'cut' && !res.failed.length) S.clip = null;
  else if (clip.mode === 'cut') S.clip.items = S.clip.items.filter((p) => res.failed.some((f) => f.name === baseName(p)));
  await reloadCurrent();
  const parts = [];
  if (res.ok) parts.push(`${countText(res.ok, 'elemento', 'elementos')} ${verbo(clip.mode, res.ok)}`);
  if (res.skipped) parts.push(`${res.skipped} omitido${res.skipped === 1 ? '' : 's'}`);
  if (parts.length) toast(parts.join(' · '));
  await reportFailures('No se pudieron pasar algunos elementos', res.failed);
}

async function doTrash(entries) {
  const paths = entries.map((e) => e.path);
  const res = await runOp('Moviendo a la papelera', (opId) => Files.trash({ items: paths, opId }));
  const open = viewerEntry();
  if (open && paths.includes(open.path)) closeViewer();
  exitSelection();
  await reloadCurrent();
  if (res.ok) {
    const msg = res.ok === 1 ? `“${trunc(entries[0].name)}” movido a la papelera` : `${res.ok} elementos movidos a la papelera`;
    snack(msg, { action: 'Deshacer', onAction: () => guarded(() => undoTrash(res.trashed)) });
  }
  await reportFailures('No se pudieron eliminar algunos elementos', res.failed);
}

async function undoTrash(trashed) {
  await Files.trashRestore({ paths: trashed });
  await reloadCurrent();
  toast('Restaurado');
}

async function doDeleteForever(entries, { trashItems = false } = {}) {
  const total = entries.reduce((s, e) => s + (e.size || 0), 0);
  const ok = await confirmDialog({
    title: '¿Eliminar para siempre?',
    message: entries.length === 1
      ? `“${entries[0].name}”${total ? ` (${formatSize(total)})` : ''} se eliminará definitivamente. No se puede deshacer.`
      : `${entries.length} elementos${total ? ` (${formatSize(total)})` : ''} se eliminarán definitivamente. No se puede deshacer.`,
    confirmText: 'Eliminar',
    danger: true,
  });
  if (!ok) return;
  const paths = entries.map((e) => e.path);
  const res = trashItems
    ? await runOp('Eliminando', (opId) => Files.trashDelete({ paths, opId }))
    : await runOp('Eliminando', (opId) => Files.delete({ items: paths, opId }));
  const open = viewerEntry();
  if (open && paths.includes(open.path)) closeViewer();
  exitSelection();
  await reloadCurrent();
  toast(res.ok === 1 ? 'Eliminado' : `${res.ok} elementos eliminados`);
  await reportFailures('No se pudieron eliminar algunos elementos', res.failed);
}

/** "Eliminar": papelera si está activada; si no, borrado definitivo con confirmación. */
function doRemove(entries) {
  return S.settings.useTrash ? doTrash(entries) : doDeleteForever(entries);
}

async function doRestore(entries) {
  const res = await runOp('Restaurando', (opId) => Files.trashRestore({ paths: entries.map((e) => e.path), opId }));
  exitSelection();
  await reloadCurrent();
  if (res.ok) toast(res.ok === 1 ? 'Restaurado en su carpeta original' : `${res.ok} elementos restaurados`);
  await reportFailures('No se pudieron restaurar algunos elementos', res.failed);
}

async function doEmptyTrash() {
  if (!S.entries.length) return;
  const ok = await confirmDialog({
    title: '¿Vaciar la papelera?',
    message: `Se eliminarán para siempre ${countText(S.entries.length, 'elemento', 'elementos')} (${formatSize(S.entries.reduce((s, e) => s + e.size, 0))}). No se puede deshacer.`,
    confirmText: 'Vaciar',
    danger: true,
  });
  if (!ok) return;
  await Files.trashEmpty();
  await reloadCurrent();
  toast('Papelera vacía');
}

async function doRename(e) {
  const siblings = await namesIn(parentPath(e.path));
  siblings.delete(e.name.toLowerCase()); // permite cambiar solo mayúsculas
  const val = await promptDialog({
    title: e.dir ? 'Renombrar carpeta' : 'Renombrar',
    value: e.name,
    select: e.dir ? 'all' : 'base',
    validate: (v) => validateName(v, siblings),
  });
  if (val == null || val === e.name) return;
  const res = await Files.rename({ path: e.path, name: val });
  exitSelection();
  if (viewerEntry() && viewerEntry().path === e.path) viewerReplace({ ...e, name: val, path: res.path });
  await reloadCurrent();
  toast('Renombrado');
}

async function doNew(isFolder) {
  if (rname() !== 'folder') return;
  const dir = S.route.path;
  const taken = await namesIn(dir);
  const val = await promptDialog({
    title: isFolder ? 'Nueva carpeta' : 'Nuevo archivo de texto',
    value: isFolder ? '' : 'Nuevo.txt',
    select: isFolder ? 'all' : 'base',
    confirmText: 'Crear',
    validate: (v) => validateName(v, taken),
  });
  if (val == null) return;
  if (isFolder) await Files.createFolder({ parent: dir, name: val });
  else await Files.createFile({ parent: dir, name: val, text: '' });
  await reloadCurrent();
  toast(isFolder ? 'Carpeta creada' : 'Archivo creado');
}

async function doZip(entries) {
  const dir = parentPath(entries[0].path);
  const taken = await namesIn(dir);
  const stem = entries.length === 1 ? (entries[0].dir ? entries[0].name : entries[0].name.replace(/\.[^.]*$/, '') || entries[0].name) : 'Archivos';
  const name = await promptDialog({
    title: 'Comprimir en ZIP',
    value: uniqueName(`${stem}.zip`, taken),
    select: 'base',
    confirmText: 'Comprimir',
    validate: (v) => validateName(v, taken) || (/\.zip$/i.test(v.trim()) ? '' : 'Debe terminar en .zip'),
  });
  if (name == null) return;
  const dest = joinPath(dir, name);
  const res = await runOp('Comprimiendo', (opId) => Files.zip({ items: entries.map((e) => e.path), dest, opId }), { bytes: true });
  exitSelection();
  await reloadCurrent();
  toast(`Creado ${name} (${formatSize(res.size)})`);
}

async function doUnzip(e) {
  const dir = parentPath(e.path);
  const taken = await namesIn(dir);
  const folder = uniqueName(e.name.replace(/\.zip$/i, '') || 'Extraído', taken, true);
  const dest = joinPath(dir, folder);
  const res = await runOp('Extrayendo', (opId) => Files.unzip({ path: e.path, dest, opId }), { bytes: true });
  exitSelection();
  await reloadCurrent();
  snack(`Extraído en “${trunc(folder)}” (${countText(res.files, 'archivo', 'archivos')})`, { action: 'Abrir', onAction: () => openFolder(dest) });
}

async function doShare(entries) {
  const files = entries.filter((e) => !e.dir);
  if (!files.length) {
    toast('Las carpetas no se pueden compartir: comprímelas en ZIP primero.');
    return;
  }
  if (files.length < entries.length) toast('Las carpetas se omiten: solo se comparten archivos.');
  await Files.share({ paths: files.map((e) => e.path) });
  exitSelection();
}

function toggleFav(path) {
  const i = S.favs.indexOf(path);
  if (i >= 0) S.favs.splice(i, 1);
  else S.favs.push(path);
  persist('archivos.favs', S.favs);
  toast(i >= 0 ? 'Quitada de favoritos' : 'Añadida a favoritos (en la portada)');
  exitSelection();
}

async function doDetails(entries) {
  if (entries.length === 1) {
    const e = entries[0];
    if (e.trash) {
      await infoDialog({
        title: 'Detalles',
        lines: [`Nombre: ${e.name}`, `Estaba en: ${displayPath(parentPath(e.orig || ''), S.volumes)}`, `Eliminado: ${formatDateTime(e.deletedAt)}`, `Tamaño: ${formatSize(e.size)}`, trashLabel(e.deletedAt, trashDays())],
      });
      return;
    }
    const st = await Files.stat({ path: e.path });
    const perms = [st.canRead ? 'lectura' : '', st.canWrite ? 'escritura' : ''].filter(Boolean).join(' y ') || 'ninguno';
    const rows = [
      ['Nombre', st.name], ['Tipo', KIND_LABEL[kind(st)]], ['Ubicación', displayPath(st.parent, S.volumes)],
      ['Modificado', formatDateTime(st.mtime)], ['Permisos', perms],
      st.dir ? ['Tamaño', 'Calculando…'] : ['Tamaño', `${formatSize(st.size)} (${st.size.toLocaleString('es-CO')} bytes)`],
    ];
    const dlg = detailsDialog({ title: st.dir ? 'Detalles de la carpeta' : 'Detalles', rows });
    if (st.dir) {
      const opId = newOpId();
      Files.dirSize({ path: st.path, opId })
        .then((r) => dlg.update([...rows.slice(0, 5), ['Tamaño', formatSize(r.size)], ['Contenido', `${countText(r.files, 'archivo', 'archivos')}, ${countText(r.folders, 'carpeta', 'carpetas')}`]]))
        .catch(() => {});
      dlg.done.then(() => Files.cancel({ opId }).catch(() => {}));
    }
    await dlg.done;
    return;
  }
  const dirs = entries.filter((e) => e.dir).length;
  const rows = [['Elementos', `${countText(entries.length - dirs, 'archivo', 'archivos')}${dirs ? ` y ${countText(dirs, 'carpeta', 'carpetas')}` : ''}`], ['Tamaño total', 'Calculando…']];
  const dlg = detailsDialog({ title: 'Detalles', rows });
  const opIds = [];
  (async () => {
    let total = 0;
    for (const e of entries) {
      if (!e.dir) {
        total += e.size;
        continue;
      }
      const opId = newOpId();
      opIds.push(opId);
      total += (await Files.dirSize({ path: e.path, opId })).size;
    }
    dlg.update([rows[0], ['Tamaño total', formatSize(total)]]);
  })().catch(() => {});
  dlg.done.then(() => opIds.forEach((id) => Files.cancel({ opId: id }).catch(() => {})));
  await dlg.done;
}

const trunc = (s, n = 28) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

// ---------------------------------------------------------------- menús
function menuItemsFor(entries, { full }) {
  const one = entries.length === 1 ? entries[0] : null;
  const items = [];
  if (full) {
    items.push({ id: 'open', label: 'Abrir', icon: 'folderopen' });
    if (one && !one.dir) items.push({ id: 'openWith', label: 'Abrir con…', icon: 'open' }, { id: 'share', label: 'Compartir', icon: 'share' });
    items.push({ id: 'copy', label: 'Copiar', icon: 'copy' }, { id: 'cut', label: 'Cortar', icon: 'cut' });
  } else if (one && !one.dir) {
    items.push({ id: 'openWith', label: 'Abrir con…', icon: 'open' });
  }
  if (one) items.push({ id: 'rename', label: 'Renombrar', icon: 'edit' });
  items.push({ id: 'zip', label: 'Comprimir en ZIP', icon: 'zip' });
  if (one && isZip(one)) items.push({ id: 'unzip', label: 'Extraer aquí', icon: 'unzip' });
  if (one && one.dir) items.push({ id: 'fav', label: S.favs.includes(one.path) ? 'Quitar de favoritos' : 'Añadir a favoritos', icon: 'star' });
  if (one && rname() !== 'folder') items.push({ id: 'location', label: 'Abrir ubicación', icon: 'folder' });
  items.push({ id: 'details', label: 'Detalles', icon: 'info' }, { divider: true });
  if (full) items.push({ id: 'trash', label: S.settings.useTrash ? 'Mover a la papelera' : 'Eliminar', icon: 'trash', danger: !S.settings.useTrash });
  if (S.settings.useTrash || !full) items.push({ id: 'delete', label: 'Eliminar para siempre', icon: 'trash', danger: true });
  return items;
}

function runAction(id, entries) {
  if (!entries.length) return;
  const one = entries[0];
  guarded(async () => {
    switch (id) {
      case 'open': return openEntry(one, S.view);
      case 'openWith': return openExternal(one, true);
      case 'share': return doShare(entries);
      case 'copy': return setClip('copy', entries);
      case 'cut': return setClip('cut', entries);
      case 'rename': return doRename(one);
      case 'zip': return doZip(entries);
      case 'unzip': return doUnzip(one);
      case 'fav': return toggleFav(one.path);
      case 'location': return openFolder(parentPath(one.path));
      case 'details': return doDetails(entries);
      case 'trash': return doRemove(entries);
      case 'delete': return doDeleteForever(entries);
      case 'restore': return doRestore(entries);
      case 'purge': return doDeleteForever(entries, { trashItems: true });
      default: return undefined;
    }
  });
}

async function openItemMenu(e) {
  const choice = await sheet({
    title: e.name,
    subtitle: `${e.dir ? countText(e.count || 0, 'elemento', 'elementos') : formatSize(e.size)} · ${KIND_LABEL[kind(e)]}`,
    items: menuItemsFor([e], { full: true }),
  });
  if (choice) runAction(choice, [e]);
}

async function openTrashMenu(e) {
  const choice = await sheet({
    title: e.name,
    subtitle: `${formatSize(e.size)} · ${trashLabel(e.deletedAt, trashDays())}`,
    items: [{ id: 'restore', label: 'Restaurar', icon: 'restore' }, { id: 'details', label: 'Detalles', icon: 'info' }, { divider: true }, { id: 'purge', label: 'Eliminar para siempre', icon: 'trash', danger: true }],
  });
  if (choice) runAction(choice, [e]);
}

async function openMoreMenu() {
  const entries = selectedEntries();
  const choice = await sheet({ title: countText(entries.length, 'elemento seleccionado', 'elementos seleccionados'), items: menuItemsFor(entries, { full: false }) });
  if (choice) runAction(choice, entries);
}

async function openFolderMenu() {
  const s = S.settings;
  const here = S.route.path;
  const choice = await sheet({
    title: titleOf(),
    subtitle: displayPath(here, S.volumes),
    items: [
      { id: 'newfolder', label: 'Nueva carpeta', icon: 'folderplus' },
      { id: 'newfile', label: 'Nuevo archivo de texto', icon: 'fileplus' },
      { divider: true },
      { id: 'sort', label: 'Ordenar por…', icon: 'sort', sub: `${{ name: 'Nombre', date: 'Fecha', size: 'Tamaño', type: 'Tipo' }[s.sortKey]} · ${s.sortDir === 'asc' ? 'ascendente' : 'descendente'}` },
      { id: 'hidden', label: s.showHidden ? 'Ocultar archivos ocultos' : 'Mostrar archivos ocultos', icon: 'eye' },
      { id: 'selall', label: 'Seleccionar todo', icon: 'checkall' },
      { id: 'fav', label: S.favs.includes(here) ? 'Quitar de favoritos' : 'Añadir a favoritos', icon: 'star' },
      { id: 'refresh', label: 'Actualizar', icon: 'refresh' },
      { id: 'details', label: 'Detalles de la carpeta', icon: 'info' },
    ],
  });
  if (!choice) return;
  if (choice === 'newfolder') guarded(() => doNew(true));
  else if (choice === 'newfile') guarded(() => doNew(false));
  else if (choice === 'sort') openSortMenu();
  else if (choice === 'hidden') setSetting('showHidden', !s.showHidden);
  else if (choice === 'selall') {
    if (S.view.length) {
      S.selecting = true;
      selectAll();
    }
  } else if (choice === 'fav') toggleFav(here);
  else if (choice === 'refresh') guarded(() => reloadCurrent());
  else if (choice === 'details') runAction('details', [{ name: baseName(here), path: here, dir: true }]);
}

async function openSortMenu() {
  const s = S.settings;
  const k = (id, label) => ({ id: `k:${id}`, label, checked: s.sortKey === id });
  const choice = await sheet({
    title: 'Ordenar por',
    items: [k('name', 'Nombre'), k('date', 'Fecha de modificación'), k('size', 'Tamaño'), k('type', 'Tipo'), { divider: true },
      { id: 'd:asc', label: 'Ascendente (A-Z, antiguos, pequeños)', checked: s.sortDir === 'asc' }, { id: 'd:desc', label: 'Descendente (Z-A, recientes, grandes)', checked: s.sortDir === 'desc' }],
  });
  if (!choice) return;
  const [t, v] = choice.split(':');
  setSetting(t === 'k' ? 'sortKey' : 'sortDir', v);
}

async function openTrashMore() {
  const choice = await sheet({
    title: 'Papelera',
    items: [{ id: 'empty', label: 'Vaciar la papelera', icon: 'trash', danger: true }, { id: 'selall', label: 'Seleccionar todo', icon: 'checkall' }, { id: 'refresh', label: 'Actualizar', icon: 'refresh' }],
  });
  if (choice === 'empty') guarded(doEmptyTrash);
  else if (choice === 'selall' && S.view.length) {
    S.selecting = true;
    selectAll();
  } else if (choice === 'refresh') guarded(() => reloadCurrent());
}

// ---------------------------------------------------------------- ajustes
function setSetting(key, value) {
  S.settings[key] = value;
  persist('archivos.settings', S.settings);
  if (key === 'showHidden') {
    if (rname() === 'folder' || rname() === 'search') reloadCurrent().catch(() => {});
    else renderAll();
  } else if (key === 'trashDays') {
    purgeTrash().catch(() => {});
    renderAll();
  } else if (key === 'recentCount') {
    renderAll();
    if (value > 0) Files.recent({ limit: value }).then((r) => { S.homeRecent = r.entries; }).catch(() => {});
  } else if (key === 'theme' || key === 'textSize' || key === 'density') {
    applyAppearance();
    renderAll();
  } else renderAll();
}

async function purgeTrash() {
  if (S.access !== true || !(trashDays() > 0)) return;
  const res = await Files.trashPurge({ days: trashDays() });
  if (res.ok) {
    toast(`Se ${plural(res.ok, 'eliminó 1 elemento', `eliminaron ${res.ok} elementos`)} de la papelera (más de ${trashDays()} días).`);
    if (rname() === 'trash') reloadCurrent().catch(() => {});
  }
}

// ---------------------------------------------------------------- búsqueda
function scheduleSearch() {
  clearTimeout(S.searchTimer);
  S.searchTimer = setTimeout(() => runSearch().catch((e) => console.error(e)), 350);
}

async function runSearch() {
  const q = S.query.trim();
  const seq = ++S.searchSeq;
  S.searchOps.forEach((id) => Files.cancel({ opId: id }).catch(() => {}));
  S.searchOps = [];
  if (!q) {
    S.entries = [];
    S.searching = false;
    S.truncated = false;
    renderBanner();
    renderView();
    return;
  }
  S.searching = true;
  renderBanner();
  const roots = S.route.root ? [S.route.root] : S.volumes.map((v) => v.path);
  try {
    const results = await Promise.all(
      roots.map(async (root) => {
        const opId = newOpId();
        S.searchOps.push(opId);
        try {
          return await Files.search({ root, query: q, showHidden: S.settings.showHidden, limit: 300, opId });
        } catch (e) {
          if (isCancel(e)) return null;
          throw e;
        }
      })
    );
    if (seq !== S.searchSeq) return;
    S.entries = results.filter(Boolean).flatMap((r) => r.entries);
    S.truncated = results.some((r) => r && r.truncated);
    S.error = null;
  } catch (e) {
    if (seq !== S.searchSeq) return;
    S.entries = [];
    S.error = (e && e.message) || 'No se pudo buscar.';
  }
  S.searching = false;
  renderBanner();
  renderView();
}

// ---------------------------------------------------------------- duplicados
async function scanDuplicates(seq) {
  try {
    const res = await runOp('Buscando duplicados', (opId) => Files.duplicates({ minSize: 1024, opId }), { bytes: true });
    if (seq === S.seq) S.groups = res.groups;
  } catch (e) {
    if (isCancel(e)) {
      S.route.scanned = false;
      return;
    }
    throw e;
  }
}

function selectExtraCopies() {
  const extras = S.groups.flatMap((g) => extraCopies(g.items));
  if (!extras.length) return;
  S.selecting = true;
  S.selected = new Set(extras);
  syncSelection();
  toast(`${countText(extras.length, 'copia elegida', 'copias elegidas')}: se conserva la más antigua de cada grupo.`);
}

// ---------------------------------------------------------------- permiso
let pollTimer = null;

async function checkAccess() {
  try {
    const r = await Files.hasAccess();
    S.sdk = r.sdk;
    return !!r.granted;
  } catch (e) {
    console.error(e);
    return false;
  }
}

function startPoll() {
  stopPoll();
  pollTimer = setInterval(async () => {
    if (S.access === false && (await checkAccess())) await startApp();
  }, 1500);
}
function stopPoll() {
  clearInterval(pollTimer);
  pollTimer = null;
}

async function grantAccess() {
  try {
    await Files.requestAccess();
  } catch (e) {
    toast((e && e.message) || 'No se pudo abrir la pantalla de permisos.');
  }
}

// ---------------------------------------------------------------- bóveda de la versión 1
async function migrateVault() {
  if (!isNative) return;
  let recs;
  try {
    recs = await db.getAll();
  } catch (e) {
    return;
  }
  if (!recs.length) return;
  try {
    const FS = plugin('Filesystem');
    const { uri } = await FS.getUri({ path: 'archivos', directory: 'DATA' });
    const srcDir = decodeURIComponent(uri.replace(/^file:\/\//, '')).replace(/\/+$/, '');
    const res = await Files.importLegacy({
      srcDir,
      destDir: joinPath(joinPath(primaryRoot(), 'Documents'), 'Archivos'),
      items: recs.map((r) => ({ id: r.id, name: r.name, trashedAt: r.trashedAt == null ? null : r.trashedAt })),
    });
    if (res.okIds.length) await db.deleteMany(res.okIds);
    const moved = recs.filter((r) => res.okIds.includes(r.id) && r.trashedAt == null).length;
    const bin = recs.filter((r) => res.okIds.includes(r.id) && r.trashedAt != null).length;
    if (moved || bin) {
      setTimeout(() => toast(`Tus archivos de la versión anterior están en Documents/Archivos${bin ? ` (${bin} en la papelera)` : ''}.`), 800);
    }
    if (res.failed.length) await reportFailures('Algunos archivos de la versión anterior no se pudieron pasar', res.failed);
  } catch (e) {
    console.error(e);
  }
}

// ---------------------------------------------------------------- eventos
function wire() {
  const view = $('#view');
  let press = null;

  view.addEventListener('pointerdown', (e) => {
    const li = e.target.closest('.item[data-path]');
    if (!li || e.target.closest('[data-more]') || e.button > 0) return;
    const path = li.dataset.path;
    press = {
      x: e.clientX, y: e.clientY,
      timer: setTimeout(() => {
        press = null;
        suppressClick = true;
        if (navigator.vibrate) {
          try { navigator.vibrate(12); } catch (err) { /* sin vibración */ }
        }
        if (S.selecting) toggleSelect(path);
        else enterSelection(path);
      }, 450),
    };
  });
  const cancelPress = () => {
    if (press) clearTimeout(press.timer);
    press = null;
  };
  view.addEventListener('pointermove', (e) => {
    if (press && Math.hypot(e.clientX - press.x, e.clientY - press.y) > 10) cancelPress();
  });
  view.addEventListener('pointerup', cancelPress);
  view.addEventListener('pointercancel', cancelPress);
  view.addEventListener('contextmenu', (e) => e.preventDefault());
  $('#content').addEventListener('scroll', cancelPress, { passive: true });

  view.addEventListener('error', (e) => {
    if (e.target && e.target.tagName === 'IMG') e.target.remove(); // si la miniatura falla, queda el ícono
  }, true);

  view.addEventListener('click', (e) => {
    if (suppressClick) {
      suppressClick = false;
      return;
    }
    const t = e.target;
    const li = t.closest('.item[data-path]');
    if (li) {
      const ent = S.byPath.get(li.dataset.path);
      if (!ent) return;
      if (t.closest('[data-more]')) return void (rname() === 'trash' ? openTrashMenu(ent) : openItemMenu(ent));
      if (S.selecting) return toggleSelect(ent.path);
      if (rname() === 'trash') return void openTrashMenu(ent);
      return void openEntry(ent, S.view);
    }
    const rec = t.closest('[data-recent]');
    if (rec) return void openEntry(S.homeRecent.find((x) => x.path === rec.dataset.recent), S.homeRecent);
    const vol = t.closest('[data-vol]');
    if (vol) return openFolder(vol.dataset.vol);
    const cat = t.closest('[data-cat]');
    if (cat) return void go({ name: 'cat', type: cat.dataset.cat });
    const quick = t.closest('[data-quick]');
    if (quick) return openFolder(quick.dataset.quick);
    const tool = t.closest('[data-tool]');
    if (tool) return void go({ name: tool.dataset.tool });
    const set = t.closest('[data-set]');
    if (set) {
      const key = set.dataset.set;
      if (set.dataset.val !== undefined) return setSetting(key, ['trashDays', 'textSize', 'recentCount'].includes(key) ? Number(set.dataset.val) : set.dataset.val);
      return setSetting(key, !S.settings[key]);
    }
    const a = t.closest('[data-a]');
    if (a) return handleTopAction(a.dataset.a);
    return undefined;
  });

  $('#topbar').addEventListener('click', (e) => {
    const a = e.target.closest('[data-a]');
    if (a) handleTopAction(a.dataset.a);
  });
  $('#topbar').addEventListener('input', (e) => {
    if (e.target.id === 'searchInput') {
      S.query = e.target.value;
      scheduleSearch();
    }
  });
  $('#crumbs').addEventListener('click', (e) => {
    const c = e.target.closest('[data-crumb]');
    if (c && c.dataset.crumb !== S.route.path) openFolder(c.dataset.crumb);
  });
  $('#banner').addEventListener('click', (e) => {
    const b = e.target.closest('[data-b]');
    if (!b) return;
    if (b.dataset.b === 'empty') guarded(doEmptyTrash);
    else if (b.dataset.b === 'extras') selectExtraCopies();
  });
  $('#clipbar').addEventListener('click', (e) => {
    const b = e.target.closest('[data-clip]');
    if (!b) return;
    if (b.dataset.clip === 'paste') guarded(doPaste);
    else {
      S.clip = null;
      renderBars();
    }
  });
  $('#selbar').addEventListener('click', (e) => {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    const act = b.dataset.act;
    const entries = selectedEntries();
    if (act === 'more') return void openMoreMenu();
    if (act === 'delete') return runAction('purge', entries);
    return runAction(act, entries);
  });
  $('#fab').addEventListener('click', async () => {
    const choice = await sheet({ title: 'Crear', items: [{ id: 'f', label: 'Nueva carpeta', icon: 'folderplus' }, { id: 'n', label: 'Nuevo archivo de texto', icon: 'fileplus' }] });
    if (choice) guarded(() => doNew(choice === 'f'));
  });

  const App = plugin('App');
  if (isNative && App) {
    App.addListener('backButton', onBack);
    App.addListener('appStateChange', ({ isActive }) => {
      if (!isActive) return;
      if (S.access === false) {
        checkAccess().then((ok) => ok && startApp());
        return;
      }
      purgeTrash().catch(() => {});
      if (!S.busy && !layers.open && !S.selecting && rname() !== 'search') reloadCurrent().catch(() => {});
    });
    App.getInfo().then((i) => { S.version = i.version || ''; }).catch(() => {});
  } else {
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') onBack();
    });
  }
  window.addEventListener('unhandledrejection', (e) => console.error(e.reason));
}

function handleTopAction(a) {
  switch (a) {
    case 'back': return void goBack();
    case 'search': return void go({ name: 'search', root: rname() === 'folder' ? S.route.path : null });
    case 'settings': return void go({ name: 'settings' });
    case 'view': return setSetting('view', S.settings.view === 'grid' ? 'list' : 'grid');
    case 'more': return void (rname() === 'trash' ? openTrashMore() : openFolderMenu());
    case 'selclose': return exitSelection();
    case 'selall': return selectAll();
    case 'clearsearch': {
      S.query = '';
      const i = $('#searchInput');
      if (i) {
        i.value = '';
        i.focus();
      }
      return void runSearch();
    }
    case 'retry': return void guarded(reloadCurrent);
    case 'seerecent': return void go({ name: 'recent' });
    case 'emptytrash': return void guarded(async () => {
      const tl = await Files.trashList();
      if (!tl.entries.length) return;
      const ok = await confirmDialog({ title: '¿Vaciar la papelera?', message: `Se eliminarán para siempre ${countText(tl.entries.length, 'elemento', 'elementos')} (${formatSize(tl.entries.reduce((t, x) => t + (x.size || 0), 0))}). No se puede deshacer.`, confirmText: 'Vaciar', danger: true });
      if (!ok) return;
      await Files.trashEmpty();
      S.trashInfo = { count: 0, size: 0 };
      renderAll();
      toast('Papelera vacía');
    });
    case 'resetsettings': return void guarded(async () => {
      const ok = await confirmDialog({ title: '¿Restablecer ajustes?', message: 'Tema, texto, orden, papelera y demás vuelven a los valores originales. Tus archivos y favoritos no se tocan.', confirmText: 'Restablecer', danger: true });
      if (!ok) return;
      S.settings = { ...DEFAULTS };
      persist('archivos.settings', S.settings);
      applyAppearance();
      renderAll();
      toast('Ajustes restablecidos');
    });
    case 'grant': return void grantAccess();
    case 'appsettings': return void Files.openAppSettings().catch(() => {});
    default: return undefined;
  }
}

// ---------------------------------------------------------------- arranque
async function startApp() {
  stopPoll();
  S.access = true;
  document.body.classList.remove('gate');
  try {
    S.volumes = (await Files.getVolumes()).volumes;
    await migrateVault();
    await purgeTrash().catch(() => {});
  } catch (e) {
    console.error(e);
  }
  S.history = [];
  S.route = { name: 'home' };
  await go({ name: 'home' }, { push: false });
  if (S.settings.startIn === 'storage' && S.volumes[0]) await go({ name: 'folder', path: S.volumes[0].path }, { push: true });
}

async function boot() {
  applyAppearance();
  hydrateIcons();
  wire();
  initViewer((act, e) => {
    if (act === 'share') guarded(() => doShare([e]));
    else if (act === 'openWith') openExternal(e, true);
    else if (act === 'details') guarded(() => doDetails([e]));
    else if (act === 'delete') guarded(() => doRemove([e]));
  });
  await initProgress();
  S.access = await checkAccess();
  if (!S.access) {
    S.access = false;
    renderAll();
    startPoll();
    return;
  }
  await startApp();
  setInterval(() => purgeTrash().catch(() => {}), 10 * 60 * 1000);
}

window.__app = { S, go, onBack }; // para pruebas
boot();
