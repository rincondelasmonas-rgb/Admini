// Acceso al almacenamiento. En el celular usa el plugin nativo "Files" (FilesPlugin.java);
// en un navegador (solo para probar en la PC) usa un almacenamiento simulado en memoria (mock.js).
import { createMock } from './mock.js';

const cap = window.Capacitor;
export const isNative = !!(cap && typeof cap.isNativePlatform === 'function' && cap.isNativePlatform());

export function plugin(name) {
  if (!cap) return null;
  if (cap.Plugins && cap.Plugins[name]) return cap.Plugins[name];
  return cap.registerPlugin(name);
}

export const Files = (() => {
  if (isNative) return plugin('Files');
  const params = new URLSearchParams(location.search);
  const mock = createMock({ granted: params.get('noaccess') !== '1' });
  window.__mock = mock; // para pruebas
  return mock;
})();

/** URL que el WebView puede cargar para una ruta del almacenamiento (miniaturas, imágenes, audio, video). */
export function fileUrl(path) {
  if (isNative) return cap.convertFileSrc(`file://${path.split('/').map(encodeURIComponent).join('/')}`);
  let h = 0;
  for (const ch of path) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  const hue = h % 360;
  return `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="hsl(${hue} 55% 60%)"/></svg>`)}`;
}

// ---------------------------------------------------------------- progreso de operaciones largas
const watchers = new Map();

export async function initProgress() {
  try {
    await Files.addListener('progress', (e) => {
      const w = e && watchers.get(e.opId);
      if (w) w(e);
    });
  } catch (e) {
    console.error(e);
  }
}

export const newOpId = () => `op${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

export function watch(opId, cb) {
  watchers.set(opId, cb);
  return () => watchers.delete(opId);
}

export const isCancel = (e) => !!e && (e.code === 'CANCELLED' || /cancel/i.test(e.message || String(e)));
