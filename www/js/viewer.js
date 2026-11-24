// Visor de imágenes, video y audio (con flechas para pasar al siguiente) y editor de texto.
import { icon } from './icons.js';
import { esc, kind, KIND_LABEL, formatSize, formatDate } from './util.js';
import { fileUrl } from './api.js';
import { layers, confirmDialog } from './ui-kit.js';

const $ = (s) => document.querySelector(s);

const VIEW_ACTIONS = [
  { id: 'share', label: 'Compartir', icon: 'share' },
  { id: 'openWith', label: 'Abrir con', icon: 'open' },
  { id: 'details', label: 'Detalles', icon: 'info' },
  { id: 'delete', label: 'Eliminar', icon: 'trash', danger: true },
];

const pv = { layer: null, list: [], idx: 0, tok: 0, onAction: null };

function card(e, note) {
  const k = kind(e);
  return `<div class="pv-card"><div class="pv-fileicon c-${k}">${icon(k)}</div><h2>${esc(e.name)}</h2>
    ${note ? `<p class="note">${esc(note)}</p>` : ''}
    <button type="button" class="btn tonal pv-open" data-open>${icon('open')}Abrir con otra app</button></div>`;
}

function show() {
  const tok = ++pv.tok;
  const e = pv.list[pv.idx];
  if (!e) return closeViewer();
  const body = $('#pvBody');
  body.classList.remove('zoom');
  body.querySelectorAll('video,audio').forEach((m) => {
    m.pause();
    m.removeAttribute('src');
    m.load();
  });
  body.innerHTML = '';
  $('#pvName').textContent = e.name;
  $('#pvInfo').textContent = `${formatSize(e.size)} · ${KIND_LABEL[kind(e)]} · ${formatDate(e.mtime)}${pv.list.length > 1 ? ` · ${pv.idx + 1} de ${pv.list.length}` : ''}`;
  $('#pvPrev').classList.toggle('hidden', pv.list.length < 2);
  $('#pvNext').classList.toggle('hidden', pv.list.length < 2);

  const k = kind(e);
  const fail = () => {
    if (tok === pv.tok) body.innerHTML = card(e, 'No se pudo mostrar este archivo aquí.');
  };
  const url = fileUrl(e.path);
  let el;
  if (k === 'image') {
    el = document.createElement('img');
    el.className = 'pv-img';
    el.alt = e.name;
    el.addEventListener('click', () => body.classList.toggle('zoom'));
  } else if (k === 'video') {
    el = document.createElement('video');
    el.controls = true;
    el.playsInline = true;
    el.preload = 'metadata';
  } else if (k === 'audio') {
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
  } else {
    body.innerHTML = card(e);
    return;
  }
  el.addEventListener('error', fail);
  el.src = url;
  body.appendChild(el);
}

export function initViewer(onAction) {
  pv.onAction = onAction;
  $('#pvActions').innerHTML = VIEW_ACTIONS
    .map((a) => `<button type="button" class="act ${a.danger ? 'danger' : ''}" data-act="${a.id}">${icon(a.icon)}<span>${a.label}</span></button>`)
    .join('');
  $('#pvBack').addEventListener('click', closeViewer);
  $('#pvPrev').addEventListener('click', () => step(-1));
  $('#pvNext').addEventListener('click', () => step(1));
  $('#pvActions').addEventListener('click', (ev) => {
    const b = ev.target.closest('[data-act]');
    if (b && pv.list[pv.idx]) pv.onAction(b.dataset.act, pv.list[pv.idx]);
  });
  $('#pvBody').addEventListener('click', (ev) => {
    if (ev.target.closest('[data-open]') && pv.list[pv.idx]) pv.onAction('openWith', pv.list[pv.idx]);
  });
}

function step(d) {
  if (pv.list.length < 2) return;
  pv.idx = (pv.idx + d + pv.list.length) % pv.list.length;
  show();
}

export function openViewer(list, idx) {
  if (idx < 0 || !list[idx]) return;
  pv.list = list;
  pv.idx = idx;
  if (!pv.layer) {
    pv.layer = layers.push(closeViewer);
    $('#viewer').classList.remove('hidden');
  }
  show();
}

export function viewerEntry() {
  return pv.layer ? pv.list[pv.idx] : null;
}

/** Cambia el nombre/ruta del elemento abierto (tras renombrar). */
export function viewerReplace(entry) {
  if (pv.layer) {
    pv.list[pv.idx] = entry;
    show();
  }
}

export function closeViewer() {
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
  $('#viewer').classList.add('hidden');
}

// ---------------------------------------------------------------- editor de texto
const ed = { layer: null, dirty: false, entry: null, save: null };

/** save(texto) -> Promise: guarda el archivo. Si falla, lanza el error (se muestra y se sigue editando). */
export function openEditor(entry, text, { save, onError }) {
  if (ed.layer) return;
  ed.entry = entry;
  ed.dirty = false;
  ed.save = save;
  const area = $('#edText');
  area.value = text;
  $('#edName').textContent = entry.name;
  $('#edSave').disabled = true;
  $('#editor').classList.remove('hidden');
  ed.layer = layers.push(requestClose);

  area.oninput = () => {
    ed.dirty = true;
    $('#edSave').disabled = false;
    $('#edName').textContent = `${entry.name} •`;
  };
  $('#edSave').onclick = async () => {
    $('#edSave').disabled = true;
    try {
      await ed.save(area.value);
      ed.dirty = false;
      $('#edName').textContent = entry.name;
    } catch (e) {
      $('#edSave').disabled = false;
      if (onError) onError(e);
    }
  };
  $('#edBack').onclick = requestClose;
  setTimeout(() => area.focus(), 80);
}

async function requestClose() {
  if (!ed.layer) return;
  if (ed.dirty) {
    // la capa sigue en la pila mientras se pregunta; el diálogo queda por encima
    const discard = await confirmDialog({ title: '¿Descartar los cambios?', message: 'Hay cambios sin guardar en este archivo.', confirmText: 'Descartar', danger: true });
    if (!discard) return;
  }
  layers.remove(ed.layer);
  ed.layer = null;
  ed.dirty = false;
  $('#editor').classList.add('hidden');
  $('#edText').value = '';
}

export const editorOpen = () => !!ed.layer;
