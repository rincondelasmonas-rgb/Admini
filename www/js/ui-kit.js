// Piezas de interfaz reutilizables: capas (para el botón Atrás), diálogos, hojas de acciones, progreso y snackbar.
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
  get open() {
    return this.stack.length > 0;
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

/** Crea un diálogo modal. `build(finish)` rellena el contenido; `finish(valor)` lo cierra. Devuelve una promesa. */
function modal({ html, cls = '', onMount, dismiss = null, tag = 'div' }) {
  return new Promise((resolve) => {
    const id = `dlg${++uid}`;
    const el = document.createElement('div');
    el.className = 'scrim';
    el.innerHTML = `<${tag} class="dialog ${cls}" role="dialog" aria-modal="true" aria-labelledby="${id}t" novalidate>${html(id)}</${tag}>`;
    let done = false;
    const layer = layers.push(() => finish(dismiss));
    function finish(v) {
      if (done) return;
      done = true;
      layers.remove(layer);
      unmount(el);
      resolve(v);
    }
    el.addEventListener('click', (e) => {
      if (e.target === el) finish(dismiss);
    });
    mount(el);
    if (onMount) onMount(el, finish);
  });
}

export function confirmDialog({ title, message, confirmText = 'Aceptar', cancelText = 'Cancelar', danger = false }) {
  return modal({
    dismiss: false,
    html: (id) => `<h2 id="${id}t">${esc(title)}</h2><p>${esc(message)}</p>
      <div class="dialog-actions">
        <button type="button" class="btn text" data-r="0">${esc(cancelText)}</button>
        <button type="button" class="btn ${danger ? 'danger' : 'primary'}" data-r="1">${esc(confirmText)}</button>
      </div>`,
    onMount: (el, finish) => el.addEventListener('click', (e) => {
      const b = e.target.closest('[data-r]');
      if (b) finish(b.dataset.r === '1');
    }),
  });
}

export function infoDialog({ title, message, lines = [], okText = 'Entendido' }) {
  return modal({
    html: (id) => `<h2 id="${id}t">${esc(title)}</h2>${message ? `<p>${esc(message)}</p>` : ''}
      ${lines.length ? `<ul class="dialog-list">${lines.map((l) => `<li>${esc(l)}</li>`).join('')}</ul>` : ''}
      <div class="dialog-actions"><button type="button" class="btn primary" data-r="1">${esc(okText)}</button></div>`,
    onMount: (el, finish) => el.addEventListener('click', (e) => {
      if (e.target.closest('[data-r]')) finish();
    }),
  });
}

/** Varias opciones apiladas. choices: [{id,label,danger,primary}]. Resuelve con el id elegido o null. */
export function choiceDialog({ title, message, choices }) {
  return modal({
    dismiss: null,
    html: (id) => `<h2 id="${id}t">${esc(title)}</h2>${message ? `<p>${esc(message)}</p>` : ''}
      <div class="choices">${choices
        .map((c) => `<button type="button" class="btn ${c.danger ? 'danger' : c.primary ? 'primary' : 'tonal'}" data-id="${esc(c.id)}">${esc(c.label)}</button>`)
        .join('')}</div>
      <div class="dialog-actions"><button type="button" class="btn text" data-id="">Cancelar</button></div>`,
    onMount: (el, finish) => el.addEventListener('click', (e) => {
      const b = e.target.closest('[data-id]');
      if (b) finish(b.dataset.id || null);
    }),
  });
}

/**
 * Pide un texto. `validate(valor)` devuelve '' si está bien o el mensaje de error.
 * `select`: 'all' | 'base' (selecciona el nombre sin extensión) | 'end'. Resuelve con el texto o null.
 */
export function promptDialog({ title, value = '', validate, confirmText = 'Guardar', select = 'all', multiline = false }) {
  return modal({
    tag: 'form',
    dismiss: null,
    html: (id) => `<h2 id="${id}t">${esc(title)}</h2>
      <div class="field">${multiline ? '<textarea class="input area" rows="4" aria-label="Texto"></textarea>' : '<input type="text" class="input" autocomplete="off" autocapitalize="none" spellcheck="false" maxlength="255" aria-label="Nombre">'}</div>
      <p class="field-error" role="alert"></p>
      <div class="dialog-actions">
        <button type="button" class="btn text" data-r="0">Cancelar</button>
        <button type="submit" class="btn primary">${esc(confirmText)}</button>
      </div>`,
    onMount: (el, finish) => {
      const input = el.querySelector('.input');
      const err = el.querySelector('.field-error');
      const ok = el.querySelector('button[type=submit]');
      input.value = value;
      const check = () => {
        const m = validate ? validate(input.value) : '';
        err.textContent = m;
        ok.disabled = !!m;
        input.classList.toggle('invalid', !!m);
        return !m;
      };
      input.addEventListener('input', check);
      el.addEventListener('submit', (e) => {
        e.preventDefault();
        if (check()) finish(multiline ? input.value : input.value.trim());
      });
      el.addEventListener('click', (e) => {
        if (e.target.closest('[data-r="0"]')) finish(null);
      });
      check();
      setTimeout(() => {
        input.focus();
        const dot = value.lastIndexOf('.');
        if (select === 'base' && dot > 0) input.setSelectionRange(0, dot);
        else if (select === 'end') input.setSelectionRange(value.length, value.length);
        else input.select();
      }, 60);
    },
  });
}

/** Ficha de datos (propiedades). rows: [[nombre, valor]]. Devuelve { update(rows), done }. */
export function detailsDialog({ title, rows }) {
  let setRows = () => {};
  const done = modal({
    html: (id) => `<h2 id="${id}t">${esc(title)}</h2><dl class="details"></dl>
      <div class="dialog-actions"><button type="button" class="btn primary" data-r="1">Cerrar</button></div>`,
    onMount: (el, finish) => {
      const dl = el.querySelector('.details');
      setRows = (r) => {
        dl.innerHTML = r.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join('');
      };
      setRows(rows);
      el.addEventListener('click', (e) => {
        if (e.target.closest('[data-r]')) finish();
      });
    },
  });
  return { update: (r) => setRows(r), done };
}

/** Hoja inferior. items: [{id,label,icon,danger,sub,checked}] o { divider:true }. Resuelve con el id o null. */
export function sheet({ title, subtitle, items }) {
  return new Promise((resolve) => {
    const el = document.createElement('div');
    el.className = 'scrim sheet-scrim';
    el.innerHTML = `<div class="sheet" role="menu" aria-label="${esc(title)}">
      <div class="sheet-handle"></div>
      <div class="sheet-head"><div class="sheet-title">${esc(title)}</div>${subtitle ? `<div class="sheet-sub">${esc(subtitle)}</div>` : ''}</div>
      <div class="sheet-body">${items
        .map((it) =>
          it.divider
            ? '<div class="sheet-divider"></div>'
            : `<button type="button" role="menuitem" class="sheet-item ${it.danger ? 'danger' : ''}" data-id="${esc(it.id)}">${it.icon ? icon(it.icon) : '<span class="ic"></span>'}<span class="sheet-label">${esc(it.label)}${it.sub ? `<small>${esc(it.sub)}</small>` : ''}</span>${it.checked ? `<span class="sheet-check">${icon('check')}</span>` : ''}</button>`
        )
        .join('')}</div>
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

/** Diálogo de progreso. fraction null = indeterminado. El botón Atrás no lo cierra; "Cancelar" pide detener la operación. */
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
    update({ name, fraction, text }) {
      if (name != null) nameEl.textContent = name;
      if (text != null) countEl.textContent = text;
      if (fraction == null) {
        bar.classList.add('indeterminate');
      } else {
        bar.classList.remove('indeterminate');
        const pct = Math.max(0, Math.min(100, Math.round(fraction * 100)));
        fill.style.width = `${pct}%`;
        bar.setAttribute('aria-valuenow', String(pct));
      }
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
