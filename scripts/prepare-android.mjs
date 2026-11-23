// Se ejecuta DESPUÉS de `npx cap add android` y ANTES de `npx cap sync android`.
// Deja el proyecto Android listo: plugin nativo de Descargas, tema/íconos, minSdk, versión y firma.
//
// Variables de entorno opcionales:
//   VERSION_NAME, VERSION_CODE                      versión del APK (el workflow usa el número de ejecución)
//   KEYSTORE_FILE, KEYSTORE_PASSWORD, KEY_ALIAS, KEY_PASSWORD   si KEYSTORE_FILE existe, se firma con esa keystore
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const android = process.env.ANDROID_DIR ? path.resolve(process.env.ANDROID_DIR) : path.join(root, 'android');
const cfg = JSON.parse(fs.readFileSync(path.join(root, 'capacitor.config.json'), 'utf8'));
const appId = cfg.appId;

const read = (p) => fs.readFileSync(p, 'utf8');
const write = (p, s) => fs.writeFileSync(p, s);

function patch(file, regex, replacement, label) {
  const src = read(file);
  if (!regex.test(src)) throw new Error(`No se pudo aplicar "${label}" en ${path.relative(android, file)}: la plantilla de Capacitor cambió.`);
  write(file, src.replace(regex, replacement));
  console.log(`✔ ${label}`);
}

function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    const a = path.join(from, e.name);
    const b = path.join(to, e.name);
    if (e.isDirectory()) copyDir(a, b);
    else fs.copyFileSync(a, b);
  }
}

function findFiles(dir, name, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) findFiles(p, name, out);
    else if (e.name === name) out.push(p);
  }
  return out;
}

if (!fs.existsSync(android)) throw new Error('No existe la carpeta android/. Ejecuta primero: npx cap add android');

// 1) Código Java: MainActivity registra el plugin "Downloads"
const javaRoot = path.join(android, 'app/src/main/java');
const pkgDir = path.join(javaRoot, ...appId.split('.'));
fs.mkdirSync(pkgDir, { recursive: true });
for (const f of findFiles(javaRoot, 'MainActivity.java')) {
  if (path.dirname(f) !== pkgDir) fs.rmSync(f);
}
for (const f of fs.readdirSync(path.join(root, 'native/java'))) {
  write(path.join(pkgDir, f), read(path.join(root, 'native/java', f)).replaceAll('__APP_ID__', appId));
}
console.log('✔ MainActivity y DownloadsPlugin copiados');

// 2) Recursos: tema (barras del sistema claro/oscuro), ícono adaptable, fondo de arranque
copyDir(path.join(root, 'native/res'), path.join(android, 'app/src/main/res'));
console.log('✔ Recursos (tema, ícono) copiados');

// 3) Android 10+ (necesario para guardar en Descargas sin permisos)
patch(path.join(android, 'variables.gradle'), /minSdkVersion\s*=\s*\d+/, 'minSdkVersion = 29', 'minSdkVersion = 29');

// 4) Manifiesto: sin copias de seguridad automáticas (evita restaurar archivos sin sus metadatos) y teclado que no tapa el diálogo
const manifest = path.join(android, 'app/src/main/AndroidManifest.xml');
if (!read(manifest).includes('android:allowBackup="false"')) {
  patch(manifest, /android:allowBackup="true"/, 'android:allowBackup="false"', 'allowBackup=false');
}
if (!read(manifest).includes('windowSoftInputMode')) {
  patch(manifest, /<activity\b/, '<activity android:windowSoftInputMode="adjustResize"', 'windowSoftInputMode=adjustResize');
}

// 5) Versión: versionCode debe subir en cada compilación para que se pueda instalar encima
const gradle = path.join(android, 'app/build.gradle');
const versionName = process.env.VERSION_NAME || '1.0.0';
const versionCode = parseInt(process.env.VERSION_CODE || '1', 10);
if (!Number.isInteger(versionCode) || versionCode < 1) throw new Error('VERSION_CODE no válido');
patch(gradle, /versionCode\s+\d+/, `versionCode ${versionCode}`, `versionCode ${versionCode}`);
patch(gradle, /versionName\s+"[^"]*"/, `versionName "${versionName}"`, `versionName ${versionName}`);

// 6) Firma con keystore fija (si hay)
if (process.env.KEYSTORE_FILE && read(gradle).includes('signingConfigs {')) {
  console.log('ℹ La firma ya estaba configurada.');
} else if (process.env.KEYSTORE_FILE) {
  for (const k of ['KEYSTORE_PASSWORD', 'KEY_ALIAS', 'KEY_PASSWORD']) {
    if (!process.env[k]) throw new Error(`Falta la variable ${k} para firmar.`);
  }
  patch(gradle, /(buildTypes\s*\{\s*release\s*\{)/, (m) => `${m}\n            signingConfig signingConfigs.release`, 'release usa signingConfigs.release');
  const signing = `    signingConfigs {
        release {
            storeFile file(System.getenv("KEYSTORE_FILE"))
            storePassword System.getenv("KEYSTORE_PASSWORD")
            keyAlias System.getenv("KEY_ALIAS")
            keyPassword System.getenv("KEY_PASSWORD")
        }
    }

`;
  patch(gradle, /(\n[ \t]*)buildTypes\s*\{/, (m, ws) => `\n${signing}${ws.replace('\n', '')}buildTypes {`, 'signingConfigs.release');
} else {
  console.log('ℹ Sin keystore: se firmará con la clave debug.');
}

console.log(`\nListo: ${appId} · versión ${versionName} (${versionCode})`);
