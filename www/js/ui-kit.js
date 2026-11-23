// Piezas de interfaz reutilizables: capas (para el botón Atrás), diálogos, hoja de acciones, snackbar y progreso.
import { icon } from './icons.js';
import { esc } from './util.js';

const root = () => document.getElementById('overlay-root');

/** Pila de capas abiertas. El botón Atrás de Android cierra la de arriba. */
export const layers = {
  stack: [],
  push(close) {
    const l = { close };
    this.stack.push(l);
    return l;
  },
  remove(l) {
    const i = this.stack.indexOf(l);
    if (i >= 0) this.stack.splice(i, 1);
  },
  closeTop() {
    const l = this.stack[this.stack.length - 1];
    if (!l) return false;
    l.close();
    return true;
  },
};

function mount(el) {
  root().appendChild(el);
  requestAnimationFrame(() => el.classList.add('in'));
}
function unmount(el) {
  el.classList.remove('in');
  setTimeout(() => el.remove(), 160);
}

let uid = 0;

export function confirmDialog({ title, message, confirmText = 'Aceptar', cancelText = 'Cancelar', danger = false }) {
  return new Promise((resolve) => {
    const id = `dlg${++uid}`;
    const el = document.createElement('div');
    el.className = 'scrim';
    el.innerHTML = `<div class="dialog" role="alertdialog" aria-modal="true" aria-labelledby="${id}t" aria-describedby="${id}m">
      <h2 id="${id}t">${esc(title)}</h2><p id="${id}m">${esc(message)}</p>
      <div class="dialog-actions">
        <button type="button" class="btn text" data-r="0">${esc(cancelText)}</button>
        <button type="button" class="btn ${danger ? 'danger' : 'primary'}" data-r="1">${esc(confirmText)}</button>
      </div></div>`;
    let done = false;
    const layer = layers.push(() => finish(false));
    function finish(v) {
      if (done) return;
      done = true;
      layers.remove(layer);
      unmount(el);
      resolve(v);
    }
    el.addEventListener('click', (e) => {
      const b = e.target.closest('[data-r]');
      if (b) finish(b.dataset.r === '1');
      else if (e.target === el) finish(false);
    });
    mount(el);
  });
}

export function infoDialog({ title, message, lines = [], okText = 'Entendido' }) {
  return new Promise((resolve) => {
    const id = `dlg${++uid}`;
    const el = document.createElement('div');
    el.className = 'scrim';
    el.innerHTML = `<div class="dialog" role="alertdialog" aria-modal="true" aria-labelledby="${id}t">
      <h2 id="${id}t">${esc(title)}</h2>${message ? `<p>${esc(message)}</p>` : ''}
      ${lines.length ? `<ul class="dialog-list">${lines.map((l) => `<li>${esc(l)}</li>`).join('')}</ul>` : ''}
      <div class="dialog-actions"><button type="button" class="btn primary" data-r="1">${esc(okText)}</button></div></div>`;
    let done = false;
    const layer = layers.push(() => finish());
    function finish() {
      if (done) return;
      done = true;
      layers.remove(layer);
      unmount(el);
      resolve();
    }
    el.addEventListener('click', (e) => {
      if (e.target.closest('[data-r]') || e.target === el) finish();
    });
    mount(el);
  });
}

/** Pide un nombre. `validate(base)` devuelve '' si está bien o el mensaje de error. Resuelve con el texto o null. */
export function renameDialog({ title, base, ext, validate }) {
  return new Promise((resolve) => {
    const el = document.createElement('div');
    el.className = 'scrim';
    el.innerHTML = `<form class="dialog" role="dialog" aria-modal="true" aria-label="${esc(title)}" novalidate>
      <h2>${esc(title)}</h2>
      <div class="field"><input type="text" class="input" autocomplete="off" autocapitalize="none" spellcheck="false" maxlength="150" aria-label="Nombre">${ext ? `<span class="ext">${esc(ext)}</span>` : ''}</div>
      <p class="field-error" role="alert"></p>
      <div class="dialog-actions">
        <button type="button" class="btn text" data-r="0">Cancelar</button>
        <button type="submit" class="btn primary">Guardar</button>
      </div></form>`;
    const input = el.querySelector('input');
    const err = el.querySelector('.field-error');
    const ok = el.querySelector('button[type=submit]');
    input.value = base;
    let done = false;
    const layer = layers.push(() => finish(null));
    function finish(v) {
      if (done) return;
      done = true;
      layers.remove(layer);
      unmount(el);
      resolve(v);
    }
    function check() {
      const m = validate(input.value);
      err.textContent = m;
      ok.disabled = !!m;
      input.classList.toggle('invalid', !!m);
      return !m;
    }
    input.addEventListener('input', check);
    el.addEventListener('submit', (e) => {
      e.preventDefault();
      if (check()) finish(input.value.trim());
    });
    el.addEventListener('click', (e) => {
      if (e.target.closest('[data-r="0"]') || e.target === el) finish(null);
    });
    mount(el);
    check();
    setTimeout(() => {
      input.focus();
      input.select();
    }, 60);
  });
}

/** Hoja inferior con acciones. items: [{id,label,icon,danger}]. Resuelve con el id elegido o null. */
export function sheet({ title, subtitle, items }) {
  return new Promise((resolve) => {
    const el = document.createElement('div');
    el.className = 'scrim sheet-scrim';
    el.innerHTML = `<div class="sheet" role="menu" aria-label="${esc(title)}">
      <div class="sheet-handle"></div>
      <div class="sheet-head"><div class="sheet-title">${esc(title)}</div>${subtitle ? `<div class="sheet-sub">${esc(subtitle)}</div>` : ''}</div>
      ${items
        .map(
          (it) =>
            `<button type="button" role="menuitem" class="sheet-item ${it.danger ? 'danger' : ''}" data-id="${esc(it.id)}">${icon(it.icon)}<span>${esc(it.label)}</span></button>`
        )
        .join('')}
    </div>`;
    let done = false;
    const layer = layers.push(() => finish(null));
    function finish(v) {
      if (done) return;
      done = true;
      layers.remove(layer);
      unmount(el);
      resolve(v);
    }
    el.addEventListener('click', (e) => {
      const b = e.target.closest('[data-id]');
      if (b) finish(b.dataset.id);
      else if (e.target === el) finish(null);
    });
    mount(el);
  });
}

/** Diálogo de progreso (subidas). El botón Atrás no lo cierra; "Cancelar" detiene tras el archivo en curso. */
export function progressDialog({ title, onCancel }) {
  const el = document.createElement('div');
  el.className = 'scrim';
  el.innerHTML = `<div class="dialog" role="alertdialog" aria-modal="true" aria-live="polite">
    <h2>${esc(title)}</h2>
    <p class="pg-name"></p>
    <div class="bar" role="progressbar" aria-valuemin="0" aria-valuemax="100"><div class="bar-fill"></div></div>
    <p class="pg-count"></p>
    <div class="dialog-actions"><button type="button" class="btn text" data-cancel>Cancelar</button></div></div>`;
  const layer = layers.push(() => {});
  const nameEl = el.querySelector('.pg-name');
  const countEl = el.querySelector('.pg-count');
  const fill = el.querySelector('.bar-fill');
  const bar = el.querySelector('.bar');
  const cancelBtn = el.querySelector('[data-cancel]');
  cancelBtn.addEventListener('click', () => {
    cancelBtn.disabled = true;
    cancelBtn.textContent = 'Cancelando…';
    onCancel();
  });
  mount(el);
  return {
    update({ index, total, name, fraction }) {
      nameEl.textContent = name;
      countEl.textContent = `Archivo ${index + 1} de ${total}`;
      const pct = Math.round(((index + fraction) / total) * 100);
      fill.style.width = `${pct}%`;
      bar.setAttribute('aria-valuenow', String(pct));
    },
    close() {
      layers.remove(layer);
      unmount(el);
    },
  };
}

// ---------------------------------------------------------------- snackbar
let snackTimer = null;

export function hideSnack() {
  const el = document.getElementById('snack');
  clearTimeout(snackTimer);
  el.classList.remove('show');
  setTimeout(() => {
    if (!el.classList.contains('show')) el.classList.add('hidden');
  }, 220);
}

export function snack(message, { action, onAction, duration = 6000 } = {}) {
  const el = document.getElementById('snack');
  clearTimeout(snackTimer);
  el.innerHTML = '<span class="snack-msg"></span>';
  el.firstChild.textContent = message;
  if (action) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'snack-btn';
    b.textContent = action;
    b.addEventListener('click', () => {
      hideSnack();
      if (onAction) onAction();
    });
    el.appendChild(b);
  }
  el.classList.remove('hidden');
  requestAnimationFrame(() => el.classList.add('show'));
  snackTimer = setTimeout(hideSnack, duration);
}

export const toast = (message) => snack(message, { duration: 3500 });
