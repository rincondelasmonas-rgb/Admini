# Archivos

Administrador de archivos completo para Android (Capacitor 6). Todo es local: sin servidor, sin cuentas, sin internet.

## Qué hace

- **Acceso real a todo el almacenamiento**: interno y tarjeta SD/USB, con carpetas, rutas navegables y volúmenes con espacio usado.
- **Operaciones**: copiar, cortar y pegar (con aviso de nombres repetidos: conservar ambos, reemplazar u omitir), renombrar, crear carpetas y archivos de texto, comprimir en ZIP y extraer (protegido contra rutas maliciosas), detalles y tamaño de carpetas. Progreso con botón Cancelar.
- **Papelera por volumen** con "Deshacer", restaurar, vaciar y conservación configurable (7 / 30 / 90 días o siempre).
- **Categorías** (imágenes, videos, audio, documentos, comprimidos, APK), **recientes**, **archivos grandes**, **búsqueda** sin distinguir acentos ni mayúsculas.
- **Limpieza**: detector de duplicados (tamaño → huella SHA-1) y selección de copias sobrantes.
- **Visor** de imágenes (zoom), video y audio con flechas, **editor de texto**, "Abrir con…", compartir y abrir/instalar APK.
- Lista o cuadrícula, orden por nombre/fecha/tamaño/tipo, archivos ocultos, favoritos, selección múltiple con pulsación larga.
- Tema claro/oscuro automático.
- **Migración**: si usabas la versión 1 (bóveda interna), sus archivos pasan a `Documents/Archivos` y lo que estaba en su papelera va a la nueva.

## Diseño

Estilo "Fernway": calmado y editorial. Paleta cálida (marfil, oliva y dorado oscuro) en modo claro y oscuro automáticos, esquinas cuadradas, sin sombras (la jerarquía sale de líneas de 1px y de la superficie sobre el fondo), títulos en Cormorant Garamond y el resto en Manrope. Todos los valores son variables al inicio de `www/css/styles.css`.

Las tipografías viajan dentro de la app: `npm install` las copia a `www/fonts` (`npm run fonts` para repetirlo). Si faltan, se usan las del sistema.

## Permiso

La primera vez pide "Acceso a todos los archivos" (Android 11+): toca **Dar permiso**, activa *Permitir acceso para gestionar todos los archivos* y vuelve a la app. En Android 10 es el permiso de almacenamiento normal.

## Compilar el APK (sin PC)

Cada `push` a `main` ejecuta `.github/workflows/build-apk.yml`: pruebas (`npm test`) → `cap add android` → `scripts/prepare-android.mjs` (plugin, permisos, FileProvider, versión) → APK.
Descárgalo en **Actions → última ejecución → Artifacts** o en **Releases**. La versión es `2.0.<número de ejecución>`.

### Actualizar encima de una instalación previa
Sin keystore propia, cada compilación se firma con una clave debug distinta y Android no deja instalar encima: **desinstala la anterior primero**. Para poder actualizar, hace falta una firma fija guardada como secretos del repositorio: `ANDROID_KEYSTORE_BASE64`, `KEYSTORE_PASSWORD`, `KEY_ALIAS`, `KEY_PASSWORD` (el script `prepare-android.mjs` la usa si existe `KEYSTORE_FILE`).

#### Firma fija, solo desde GitHub (sin PC)
1. En GitHub: foto de perfil → **Settings** → **Developer settings** → **Personal access tokens** → **Fine-grained tokens** → **Generate new token**. Ponle un nombre (por ejemplo `firma-archivos`), vencimiento de 7 días, en *Repository access* elige **Only select repositories** → `Admini`, y en *Repository permissions* pon **Secrets: Read and write**. Genera el token y cópialo.
2. En el repositorio: **Settings** → **Secrets and variables** → **Actions** → **New repository secret**. Nombre `ADMIN_TOKEN`, valor el token.
3. En la pestaña **Actions** → **Crear firma (una sola vez)** → **Run workflow** (deja el campo en `no`).
4. Cuando termine en verde, **borra** el secreto `ADMIN_TOKEN` y el token (ya no hacen falta).
5. Ejecuta **Compilar APK**. Esa primera vez desinstala la app anterior; desde ahí todas las versiones se instalan encima.

La clave solo existe dentro de los secretos de GitHub (no se puede leer de vuelta). Si algún día se pierde, se repite el proceso y hay que desinstalar una vez más.

## Desarrollo

```
npm install
npm test          # lógica + almacenamiento simulado
npm run serve     # interfaz en el navegador con datos de ejemplo (?noaccess=1 prueba la pantalla de permiso)
```

- `www/js/mock.js` simula el plugin nativo, por eso la interfaz funciona en el navegador.
- `native/java/FilesPlugin.java` es el plugin nativo (listar, copiar/mover con progreso, papelera, zip, búsqueda, duplicados, MediaStore…).

## Límites conocidos

- ZIP con contraseña y RAR/7z no se extraen (solo ZIP).
- La reproducción de video/audio depende del WebView; si falla, ofrece "Abrir con otra app".
- Android restringe `Android/data` y `Android/obb` en versiones recientes aunque se conceda el permiso.
