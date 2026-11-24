// Copia las tipografías del diseño desde node_modules a www/fonts para que la app las lleve dentro (sin internet).
// Se ejecuta solo después de `npm install` (postinstall) o a mano con `npm run fonts`.
// Nunca falla: si algo no está, avisa y la app usa las tipografías del sistema.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'www', 'fonts');

// Mismos archivos que declara www/css/fonts.css
const WANTED = [
  { pkg: 'ibm-plex-sans', weights: [400, 600, 700] },
  { pkg: 'jetbrains-mono', weights: [400] },
];

let copied = 0;
const missing = [];
try {
  fs.mkdirSync(out, { recursive: true });
  for (const { pkg, weights } of WANTED) {
    for (const w of weights) {
      const file = `${pkg}-latin-${w}-normal.woff2`;
      const from = path.join(root, 'node_modules', '@fontsource', pkg, 'files', file);
      if (fs.existsSync(from)) {
        fs.copyFileSync(from, path.join(out, file));
        copied++;
      } else {
        missing.push(file);
      }
    }
  }
} catch (e) {
  console.warn(`Tipografías: no se pudieron copiar (${e.message}). Se usarán las del sistema.`);
}

const total = WANTED.reduce((n, f) => n + f.weights.length, 0);
console.log(`Tipografías: ${copied}/${total} copiadas a www/fonts`);
if (missing.length) console.warn(`Tipografías: faltan ${missing.join(', ')} (se usarán las del sistema).`);
process.exit(0);
