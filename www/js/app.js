// Archivos — lógica principal. Todo es local: metadatos en IndexedDB, bytes en el sistema de archivos del celular.
import {
  MAX_SIZE, TRASH_MS, esc, norm, splitName, sanitizeName, uniqueName, validateRename, makeId, formatSize, formatDate, formatDateTime,
  daysLeftLabel, plural, guessMime, effectiveType, category, CATEGORY_LABEL, sortFiles,
} from './util.js';
import * as db from './db.js';
import { storage, isNative, plugin } from './fs.js';
import { icon, hydrateIcons } from './icons.js';
import { layers, confirmDialog, infoDialog, renameDialog, sheet, progressDialog, snack, toast, hideSnack } from './ui-kit.js';

const $ = (s, r = document) => r.querySelector(s);

// ---------------------------------------------------------------- estado
const store = new Map(); // id -> { id, name, size, type, at, trashedAt }
const state = { tab: 'all', sort: 'recent', query: '', searchOpen: false, selecting: false, selected: new Set() };
const pv = { layer: null, ids: [], idx: 0, url: null, tok: 0 };
let busy = false;
let suppressClick = false;

const all = () => Array.from(store.values());
const get = (id) => store.get(id);
const isActive = (f) => f.trashedAt == null;
const THUMB_MAX = 6 * 1024 * 1024;

const ACTIONS = {
  share: { label: 'Compartir', short: 'Compartir', icon: 'share' },
  download: { label: 'Guardar en Descargas', short: 'Descargas', icon: 'download' },
  rename: { label: 'Renombrar', short: 'Renombrar', icon: 'edit' },
  trash: { label: 'Mover al basurero', short: 'Basurero', icon: 'trash' },
  restore: { label: 'Restaurar', short: 'Restaurar', icon: 'restore' },
  delete: { label: 'Eliminar para siempre', short: 'Eliminar', icon: 'trash', danger: true },
};
const SHEET_ACTIVE = ['share', 'download', 'rename', 'trash'];
const SHEET_TRASH = ['restore', 'delete'];
const BAR_ACTIVE = ['share', 'download', 'trash'];
const BAR_TRASH = ['restore', 'delete'];

function prefGet(k, d) {
  try {
    return localStorage.getItem(k) || d;
  } catch (e) {
    return d;
  }
}
function prefSet(k, v) {
  try {
    localStorage.setItem(k, v);
  } catch (e) {
    /* sin almacenamiento de preferencias: no pasa nada */
  }
}

// ---------------------------------------------------------------- datos
async function commit(records) {
  await db.putMany(records);
  records.forEach((r) => store.set(r.id, r));
}

function activeNames(excludeIds) {
  const s = new Set();
  for (const f of store.values()) if (isActive(f) && !(excludeIds && excludeIds.has(f.id))) s.add(f.name.toLowerCase());
  return s;
}

async function removeForever(ids) {
  for (const id of ids) await storage.remove(id);
  await db.deleteMany(ids);
  ids.forEach((id) => {
    store.delete(id);
    state.selected.delete(id);
  });
  if (state.selecting && state.selected.size === 0) state.selecting = false;
  if (pv.layer && pv.ids[pv.idx] && ids.includes(pv.ids[pv.idx])) closePreview();
  render();
}

/** Borra del basurero lo que lleva 30 días o más. */
async function purgeExpired() {
  const now = Date.now();
  const expired = all().filter((f) => f.trashedAt != null && now - f.trashedAt >= TRASH_MS);
  if (!expired.length) return 0;
  await removeForever(expired.map((f) => f.id));
  const n = expired.length;
  toast(`Se ${plural(n, 'eliminó 1 archivo', `eliminaron ${n} archivos`)} del basurero (más de 30 días).`);
  return n;
}

/** Quita archivos huérfanos (subidas interrumpidas) y registros sin archivo. Solo al abrir la app. */
async function reconcile() {
  const names = await storage.listIds();
  if (!names) return;
  const present = new Set(names);
  const orphans = names.filter((n) => !store.has(n));
  for (const n of orphans) await storage.remove(n);
  const missing = all().filter((f) => !present.has(f.id));
  if (missing.length) {
    await db.deleteMany(missing.map((f) => f.id));
    missing.forEach((f) => store.delete(f.id));
    toast(`Se limpiaron ${missing.length} ${plural(missing.length, 'registro', 'registros')} sin archivo.`);
  }
}

// ---------------------------------------------------------------- vista
function visibleList() {
  const trashView = state.tab === 'trash';
  const q = norm(state.query.trim());
  let arr = all().filter((f) => (trashView ? !isActive(f) : isActive(f)));
  if (q) arr = arr.filter((f) => norm(f.name).includes(q));
  return sortFiles(arr, state.sort, trashView);
}

function thumbHtml(f) {
  const cat = category(f);
  let img = '';
  if (cat === 'image' && f.size <= THUMB_MAX) {
    const u = storage.thumbUrl(f);
    if (u) img = `<img src="${esc(u)}" alt="" loading="lazy" decoding="async">`;
  }
  return `<div class="thumb c-${cat}">${icon(cat)}${img}</div>`;
}

function itemHtml(f, now) {
  const trashView = state.tab === 'trash';
  const sel = state.selected.has(f.id);
  const meta = trashView
    ? `${formatSize(f.size)} · ${daysLeftLabel(f.trashedAt, now)}`
    : `${formatSize(f.size)} · ${formatDate(f.at)}`;
  const trail = state.selecting
    ? `<span class="check"><i>${icon('check')}</i></span>`
    : `<button type="button" class="icon-btn" data-more aria-label="Más opciones de ${esc(f.name)}">${icon('more')}</button>`;
  return `<li class="item ${sel ? 'selected' : ''}" data-id="${esc(f.id)}" role="listitem" ${state.selecting ? `aria-selected="${sel}"` : ''}>
    ${thumbHtml(f)}
    <div class="meta"><div class="name">${esc(f.name)}</div><div class="sub">${esc(meta)}</div></div>${trail}</li>`;
}

function emptyHtml() {
  const trashView = state.tab === 'trash';
  const q = state.query.trim();
  if (q) {
    return `<div class="badge">${icon('search')}</div><h2>Sin resultados</h2><p>No hay archivos que coincidan con “${esc(q)}”.</p>`;
  }
  if (trashView) {
    return `<div class="badge">${icon('trash')}</div><h2>El basurero está vacío</h2><p>Los archivos que muevas aquí se borran solos a los 30 días.</p>`;
  }
  return `<div class="badge">${icon('empty')}</div><h2>Aún no hay archivos</h2><p>Sube archivos desde tu teléfono (máx. 20 MB cada uno).</p>
    <button type="button" class="btn primary" data-upload>${icon('plus')}Subir archivos</button>`;
}

function render() {
  const files = all();
  const act = files.filter(isActive);
  const tr = files.filter((f) => !isActive(f));
  const total = files.reduce((s, f) => s + f.size, 0);
  const trSize = tr.reduce((s, f) => s + f.size, 0);
  const trashView = state.tab === 'trash';

  $('#cntAll').textContent = String(act.length);
  $('#cntTrash').textContent = String(tr.length);
  $('#storageText').textContent = files.length
    ? `${formatSize(total)} usados${tr.length ? ` · ${formatSize(trSize)} en el basurero` : ''}`
    : 'Sin archivos todavía';

  document.querySelectorAll('.tab').forEach((t) => t.setAttribute('aria-selected', String(t.dataset.tab === state.tab)));
  document.querySelectorAll('.seg-btn').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.sort === state.sort)));

  const list = visibleList();
  const now = Date.now();
  $('#list').innerHTML = list.map((f) => itemHtml(f, now)).join('');
  const empty = $('#empty');
  empty.classList.toggle('hidden', list.length > 0);
  if (!list.length) empty.innerHTML = emptyHtml();

  $('#trashBanner').classList.toggle('hidden', !(trashView && tr.length > 0));

  // cabecera según modo
  $('#tbNormal').classList.toggle('hidden', state.selecting);
  $('#tbSelect').classList.toggle('hidden', !state.selecting);
  $('#searchRow').classList.toggle('hidden', !state.searchOpen || state.selecting);
  $('#btnSearch').classList.toggle('hidden', false);
  if (state.selecting) {
    const n = state.selected.size;
    $('#selCount').textContent = `${n} ${plural(n, 'seleccionado', 'seleccionados')}`;
  }

  // acciones inferiores
  const bar = $('#selbar');
  bar.classList.toggle('hidden', !state.selecting);
  if (state.selecting) {
    const keys = trashView ? BAR_TRASH : BAR_ACTIVE;
    bar.innerHTML = keys
      .map((k) => `<button type="button" class="act ${ACTIONS[k].danger ? 'danger' : ''}" data-act="${k}">${icon(ACTIONS[k].icon)}<span>${ACTIONS[k].short}</span></button>`)
      .join('');
  }
  const fabOn = !trashView && !state.selecting;
  $('#fab').classList.toggle('hidden', !fabOn);
  document.body.classList.toggle('fab-on', fabOn);
  document.body.classList.toggle('selecting', state.selecting);
}

// ---------------------------------------------------------------- selección
function enterSelection(id) {
  state.selecting = true;
  state.selected = new Set([id]);
  hideSnack();
  render();
}
function exitSelection() {
  if (!state.selecting) return;
  state.selecting = false;
  state.selected.clear();
  render();
}
function toggleSelect(id) {
  if (state.selected.has(id)) state.selected.delete(id);
  else state.selected.add(id);
  if (state.selected.size === 0) state.selecting = false;
  render();
}
function selectAll() {
  const ids = visibleList().map((f) => f.id);
  const allOn = ids.length > 0 && ids.every((id) => state.selected.has(id));
  state.selected = allOn ? new Set() : new Set(ids);
  if (state.selected.size === 0) state.selecting = false;
  render();
}

// ---------------------------------------------------------------- acciones
async function guarded(fn) {
  if (busy) return;
  busy = true;
  try {
    await fn();
  } catch (e) {
    console.error(e);
    toast('Algo salió mal. Inténtalo de nuevo.');
  } finally {
    busy = false;
  }
}

const isCancel = (e) => /cancel|abort/i.test((e && (e.message || e.name)) || String(e));

function trunc(s, n = 28) {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

async function restoreSnapshots(snaps) {
  const ids = new Set(snaps.map((s) => s.id));
  const taken = activeNames(ids);
  const out = [];
  for (const s of snaps) {
    if (!store.has(s.id)) continue; // ya se eliminó definitivamente
    const rec = { ...s };
    if (rec.trashedAt == null) {
      rec.name = uniqueName(rec.name, taken);
      taken.add(rec.name.toLowerCase());
    }
    out.push(rec);
  }
  if (out.length) await commit(out);
  render();
}

async function doTrash(ids) {
  const items = ids.map(get).filter((f) => f && isActive(f));
  if (!items.length) return;
  const snaps = items.map((f) => ({ ...f }));
  const now = Date.now();
  await commit(items.map((f) => ({ ...f, trashedAt: now })));
  state.selecting = false;
  state.selected.clear();
  if (pv.layer) closePreview();
  render();
  const msg = items.length === 1 ? `“${trunc(items[0].name)}” movido al basurero` : `${items.length} archivos movidos al basurero`;
  snack(msg, { action: 'Deshacer', onAction: () => guarded(() => restoreSnapshots(snaps)) });
}

async function doRestore(ids) {
  const items = ids.map(get).filter((f) => f && !isActive(f));
  if (!items.length) return;
  const snaps = items.map((f) => ({ ...f }));
  const taken = activeNames(new Set(items.map((f) => f.id)));
  let renamed = 0;
  const out = items.map((f) => {
    const name = uniqueName(f.name, taken);
    taken.add(name.toLowerCase());
    if (name !== f.name) renamed++;
    return { ...f, name, trashedAt: null };
  });
  await commit(out);
  state.selecting = false;
  state.selected.clear();
  if (pv.layer) closePreview();
  render();
  let msg = items.length === 1 ? `“${trunc(out[0].name)}” restaurado` : `${items.length} archivos restaurados`;
  if (renamed) msg += ` (${renamed} ${plural(renamed, 'renombrado', 'renombrados')} por duplicado)`;
  snack(msg, { action: 'Deshacer', onAction: () => guarded(() => restoreSnapshots(snaps)) });
}

async function doDelete(ids) {
  const items = ids.map(get).filter((f) => f && !isActive(f));
  if (!items.length) return;
  const size = items.reduce((s, f) => s + f.size, 0);
  const ok = await confirmDialog({
    title: '¿Eliminar para siempre?',
    message:
      items.length === 1
        ? `“${items[0].name}” (${formatSize(size)}) se eliminará definitivamente. No se puede deshacer.`
        : `${items.length} archivos (${formatSize(size)}) se eliminarán definitivamente. No se puede deshacer.`,
    confirmText: 'Eliminar',
    danger: true,
  });
  if (!ok) return;
  await removeForever(items.map((f) => f.id));
  toast(items.length === 1 ? 'Archivo eliminado' : `${items.length} archivos eliminados`);
}

async function doEmptyTrash() {
  const items = all().filter((f) => !isActive(f));
  if (!items.length) return;
  const size = items.reduce((s, f) => s + f.size, 0);
  const ok = await confirmDialog({
    title: '¿Vaciar el basurero?',
    message: `Se eliminarán para siempre ${items.length} ${plural(items.length, 'archivo', 'archivos')} (${formatSize(size)}). No se puede deshacer.`,
    confirmText: 'Vaciar',
    danger: true,
  });
  if (!ok) return;
  await removeForever(items.map((f) => f.id));
  toast('Basurero vacío');
}

async function doRename(id) {
  const f = get(id);
  if (!f || !isActive(f)) return;
  const { base, ext } = splitName(f.name);
  const taken = activeNames(new Set([f.id]));
  const res = await renameDialog({ title: 'Renombrar', base, ext, validate: (b) => validateRename(b, ext, taken) });
  if (res == null) return;
  const name = res + ext;
  if (name === f.name) return;
  await commit([{ ...f, name }]);
  render();
  if (pv.layer) showPreviewItem();
  toast('Archivo renombrado');
}

async function doShare(ids) {
  const items = ids.map(get).filter(Boolean);
  if (!items.length) return;
  if (items.length > 2) toast('Preparando archivos…');
  try {
    await storage.share(items);
  } catch (e) {
    if (isCancel(e)) return;
    console.error(e);
    toast('No se pudo abrir la hoja de compartir.');
  }
  exitSelection();
}

async function doDownload(ids) {
  const items = ids.map(get).filter(Boolean);
  if (!items.length) return;
  const saved = [];
  const failed = [];
  for (const f of items) {
    try {
      const r = await storage.saveToDownloads(f);
      saved.push((r && r.name) || f.name);
    } catch (e) {
      console.error(e);
      failed.push(f.name);
    }
  }
  if (failed.length) {
    await infoDialog({
      title: 'No se pudieron guardar algunos archivos',
      message: saved.length ? `${saved.length} ${plural(saved.length, 'archivo se guardó', 'archivos se guardaron')} en Descargas.` : '',
      lines: failed,
    });
  } else {
    toast(saved.length === 1 ? `Guardado en Descargas: ${trunc(saved[0], 34)}` : `${saved.length} archivos guardados en Descargas`);
  }
  exitSelection();
}

function runAction(act, ids) {
  guarded(async () => {
    switch (act) {
      case 'share': return doShare(ids);
      case 'download': return doDownload(ids);
      case 'rename': return doRename(ids[0]);
      case 'trash': return doTrash(ids);
      case 'restore': return doRestore(ids);
      case 'delete': return doDelete(ids);
      default: return undefined;
    }
  });
}

async function openItemMenu(id) {
  const f = get(id);
  if (!f) return;
  const keys = isActive(f) ? SHEET_ACTIVE : SHEET_TRASH;
  const choice = await sheet({
    title: f.name,
    subtitle: `${formatSize(f.size)} · ${CATEGORY_LABEL[category(f)]}`,
    items: keys.map((k) => ({ id: k, label: ACTIONS[k].label, icon: ACTIONS[k].icon, danger: !!ACTIONS[k].danger })),
  });
  if (choice) runAction(choice, [id]);
}

// ---------------------------------------------------------------- subida
async function handleFiles(fileList) {
  const files = Array.from(fileList || []);
  if (!files.length) return;
  const problems = [];
  let ok = 0;
  let renamed = 0;
  let cancelled = false;
  const dlg = progressDialog({ title: 'Subiendo archivos', onCancel: () => (cancelled = true) });
  try {
    for (let i = 0; i < files.length; i++) {
      if (cancelled) break;
      const file = files[i];
      const shown = file.name || 'archivo';
      dlg.update({ index: i, total: files.length, name: shown, fraction: 0 });
      if (file.size > MAX_SIZE) {
        problems.push(`${shown}: pesa ${formatSize(file.size)} y el máximo es 20 MB.`);
        continue;
      }
      if (file.size === 0) {
        problems.push(`${shown}: está vacío.`);
        continue;
      }
      const clean = sanitizeName(file.name);
      const name = uniqueName(clean, activeNames());
      const id = makeId(name);
      try {
        await storage.write(id, file, (fraction) => dlg.update({ index: i, total: files.length, name: shown, fraction }));
      } catch (e) {
        console.error(e);
        await storage.remove(id);
        problems.push(`${shown}: no se pudo guardar.`);
        continue;
      }
      const rec = { id, name, size: file.size, type: file.type || guessMime(name), at: Date.now(), trashedAt: null };
      try {
        await db.put(rec);
      } catch (e) {
        console.error(e);
        await storage.remove(id);
        problems.push(`${shown}: no se pudo registrar.`);
        continue;
      }
      store.set(id, rec);
      if (name !== clean) renamed++;
      ok++;
      render();
    }
  } finally {
    dlg.close();
    $('#picker').value = '';
  }
  if (ok) {
    let msg = `${ok} ${plural(ok, 'archivo subido', 'archivos subidos')}`;
    if (renamed) msg += ` · ${renamed} ${plural(renamed, 'renombrado', 'renombrados')} por duplicado`;
    toast(msg);
  }
  if (cancelled && !problems.length) toast(ok ? `Subida cancelada. ${ok} ${plural(ok, 'archivo subido', 'archivos subidos')}.` : 'Subida cancelada');
  if (problems.length) {
    await infoDialog({
      title: ok ? 'Algunos archivos no se subieron' : 'No se pudo subir',
      message: 'Los demás se subieron con normalidad.',
      lines: problems,
    });
  }
}

// ---------------------------------------------------------------- vista previa
function releasePreviewUrl() {
  if (pv.url) storage.release(pv.url);
  pv.url = null;
}

function cardHtml(f, note) {
  const cat = category(f);
  const rows = [
    ['Tamaño', formatSize(f.size)],
    ['Tipo', `${CATEGORY_LABEL[cat]} (${effectiveType(f)})`],
    ['Subido', formatDateTime(f.at)],
  ];
  if (!isActive(f)) rows.push(['En el basurero desde', formatDateTime(f.trashedAt)], ['Estado', daysLeftLabel(f.trashedAt)]);
  return `<div class="pv-card"><div class="pv-fileicon c-${cat}">${icon(cat)}</div><h2>${esc(f.name)}</h2>
    ${note ? `<p class="note">${esc(note)}</p>` : ''}
    <dl>${rows.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join('')}</dl></div>`;
}

function renderPreviewActions(f) {
  const keys = isActive(f) ? SHEET_ACTIVE : SHEET_TRASH;
  $('#pvActions').innerHTML = keys
    .map((k) => `<button type="button" class="act ${ACTIONS[k].danger ? 'danger' : ''}" data-act="${k}">${icon(ACTIONS[k].icon)}<span>${ACTIONS[k].short}</span></button>`)
    .join('');
}

async function showPreviewItem() {
  const tok = ++pv.tok;
  const f = get(pv.ids[pv.idx]);
  if (!f) return closePreview();
  const body = $('#pvBody');
  body.classList.remove('zoom');
  releasePreviewUrl();
  body.innerHTML = '';
  $('#pvName').textContent = f.name;
  $('#pvInfo').textContent = `${formatSize(f.size)} · ${CATEGORY_LABEL[category(f)]} · ${formatDate(f.at)}`;
  $('#pvPrev').classList.toggle('hidden', pv.ids.length < 2);
  $('#pvNext').classList.toggle('hidden', pv.ids.length < 2);
  renderPreviewActions(f);

  const cat = category(f);
  if (cat !== 'image' && cat !== 'video' && cat !== 'audio') {
    body.innerHTML = cardHtml(f);
    return;
  }
  let url;
  try {
    url = await storage.mediaUrl(f);
  } catch (e) {
    if (tok === pv.tok) body.innerHTML = cardHtml(f, 'No se pudo abrir el archivo.');
    return;
  }
  if (tok !== pv.tok) {
    storage.release(url);
    return;
  }
  pv.url = url;
  const fail = () => {
    if (tok !== pv.tok) return;
    body.innerHTML = cardHtml(f, 'No se pudo mostrar la vista previa en este teléfono.');
  };
  let el;
  if (cat === 'image') {
    el = document.createElement('img');
    el.className = 'pv-img';
    el.alt = f.name;
    el.addEventListener('click', () => body.classList.toggle('zoom'));
  } else if (cat === 'video') {
    el = document.createElement('video');
    el.controls = true;
    el.playsInline = true;
    el.preload = 'metadata';
  } else {
    const wrap = document.createElement('div');
    wrap.className = 'pv-audio';
    wrap.innerHTML = `<div class="pv-fileicon c-audio">${icon('audio')}</div>`;
    el = document.createElement('audio');
    el.controls = true;
    el.preload = 'metadata';
    wrap.appendChild(el);
    el.addEventListener('error', fail);
    el.src = url;
    body.appendChild(wrap);
    return;
  }
  el.addEventListener('error', fail);
  el.src = url;
  body.appendChild(el);
}

function openPreview(id) {
  const ids = visibleList().map((f) => f.id);
  const idx = ids.indexOf(id);
  if (idx < 0) return;
  pv.ids = ids;
  pv.idx = idx;
  if (!pv.layer) {
    pv.layer = layers.push(closePreview);
    $('#preview').classList.remove('hidden');
  }
  showPreviewItem();
}

function stepPreview(d) {
  if (pv.ids.length < 2) return;
  pv.idx = (pv.idx + d + pv.ids.length) % pv.ids.length;
  showPreviewItem();
}

function closePreview() {
  if (!pv.layer) return;
  layers.remove(pv.layer);
  pv.layer = null;
  pv.tok++;
  const body = $('#pvBody');
  body.querySelectorAll('video,audio').forEach((m) => {
    m.pause();
    m.removeAttribute('src');
    m.load();
  });
  body.innerHTML = '';
  releasePreviewUrl();
  $('#preview').classList.add('hidden');
}

// ---------------------------------------------------------------- navegación y búsqueda
function setTab(tab) {
  if (state.tab === tab) return;
  state.tab = tab;
  state.selecting = false;
  state.selected.clear();
  hideSnack();
  $('#content').scrollTop = 0;
  render();
}

function setSort(sort) {
  state.sort = sort;
  prefSet('archivos.sort', sort);
  render();
}

function openSearch() {
  state.searchOpen = true;
  render();
  $('#searchInput').focus();
}
function closeSearch() {
  state.searchOpen = false;
  state.query = '';
  $('#searchInput').value = '';
  render();
}

/** Botón Atrás de Android: de lo más superficial a lo más profundo; al final, salir. */
function onBack() {
  if (layers.closeTop()) return;
  if (state.selecting) return exitSelection();
  if (state.searchOpen || state.query) return closeSearch();
  if (state.tab === 'trash') return setTab('all');
  const App = plugin('App');
  if (App && App.exitApp) App.exitApp();
}

// ---------------------------------------------------------------- eventos
function wire() {
  const list = $('#list');
  let press = null;

  list.addEventListener('pointerdown', (e) => {
    const li = e.target.closest('.item');
    if (!li || e.target.closest('[data-more]') || e.button > 0) return;
    const id = li.dataset.id;
    press = { x: e.clientX, y: e.clientY, id, timer: setTimeout(() => {
      press = null;
      suppressClick = true;
      if (navigator.vibrate) {
        try { navigator.vibrate(12); } catch (err) { /* sin vibración */ }
      }
      if (state.selecting) toggleSelect(id);
      else enterSelection(id);
    }, 450) };
  });
  const cancelPress = () => {
    if (press) clearTimeout(press.timer);
    press = null;
  };
  list.addEventListener('pointermove', (e) => {
    if (press && Math.hypot(e.clientX - press.x, e.clientY - press.y) > 10) cancelPress();
  });
  list.addEventListener('pointerup', cancelPress);
  list.addEventListener('pointercancel', cancelPress);
  list.addEventListener('contextmenu', (e) => e.preventDefault());
  list.addEventListener('scroll', cancelPress, true);

  list.addEventListener('click', (e) => {
    if (suppressClick) {
      suppressClick = false;
      return;
    }
    const li = e.target.closest('.item');
    if (!li) return;
    const id = li.dataset.id;
    if (e.target.closest('[data-more]')) return void openItemMenu(id);
    if (state.selecting) toggleSelect(id);
    else openPreview(id);
  });
  // Si la miniatura falla, se queda el ícono del tipo.
  list.addEventListener('error', (e) => {
    if (e.target && e.target.tagName === 'IMG') e.target.remove();
  }, true);

  $('#empty').addEventListener('click', (e) => {
    if (e.target.closest('[data-upload]')) $('#picker').click();
  });
  document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => setTab(t.dataset.tab)));
  document.querySelectorAll('.seg-btn').forEach((b) => b.addEventListener('click', () => setSort(b.dataset.sort)));
  $('#btnSearch').addEventListener('click', () => (state.searchOpen ? closeSearch() : openSearch()));
  $('#btnSearchClear').addEventListener('click', () => {
    if (state.query) {
      state.query = '';
      $('#searchInput').value = '';
      render();
      $('#searchInput').focus();
    } else {
      closeSearch();
    }
  });
  $('#searchInput').addEventListener('input', (e) => {
    state.query = e.target.value;
    render();
  });
  $('#btnSelClose').addEventListener('click', exitSelection);
  $('#btnSelAll').addEventListener('click', selectAll);
  $('#btnEmptyTrash').addEventListener('click', () => guarded(doEmptyTrash));
  $('#fab').addEventListener('click', () => $('#picker').click());
  $('#picker').addEventListener('change', (e) => {
    const files = Array.from(e.target.files || []);
    if (files.length) guarded(() => handleFiles(files));
  });
  $('#selbar').addEventListener('click', (e) => {
    const b = e.target.closest('[data-act]');
    if (b) runAction(b.dataset.act, Array.from(state.selected));
  });

  // vista previa
  $('#pvBack').addEventListener('click', closePreview);
  $('#pvPrev').addEventListener('click', () => stepPreview(-1));
  $('#pvNext').addEventListener('click', () => stepPreview(1));
  $('#pvActions').addEventListener('click', (e) => {
    const b = e.target.closest('[data-act]');
    if (b && pv.ids[pv.idx]) runAction(b.dataset.act, [pv.ids[pv.idx]]);
  });

  // botón Atrás
  const App = plugin('App');
  if (isNative && App) {
    App.addListener('backButton', onBack);
    App.addListener('appStateChange', ({ isActive: active }) => {
      if (active) purgeExpired().catch(() => {});
    });
  } else {
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') onBack();
    });
  }
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) purgeExpired().catch(() => {});
  });
  window.addEventListener('unhandledrejection', (e) => console.error(e.reason));
}

// ---------------------------------------------------------------- arranque
async function boot() {
  hydrateIcons();
  state.sort = ['recent', 'name', 'size'].includes(prefGet('archivos.sort', 'recent')) ? prefGet('archivos.sort', 'recent') : 'recent';
  wire();
  try {
    await storage.init();
    (await db.getAll()).forEach((f) => store.set(f.id, f));
    await reconcile();
  } catch (e) {
    console.error(e);
    $('#empty').classList.remove('hidden');
    $('#empty').innerHTML = `<div class="badge">${icon('x')}</div><h2>No se pudo abrir el almacenamiento</h2><p>Cierra la app y vuelve a abrirla. Si sigue igual, reinstálala.</p>`;
    return;
  }
  render();
  await purgeExpired().catch(() => {});
  setInterval(() => purgeExpired().catch(() => {}), 60 * 1000); // también mientras la app está abierta
}

boot();
