# Archivos

Administrador de archivos para Android con basurero. Todo es local en el teléfono: sin servidor, sin cuentas.
`appId`: `com.luismartinezprog.archivos` — se instala aparte del administrador de fábrica.

## Qué hace

- Subir varios archivos con el selector del sistema (máx. 20 MB cada uno; si uno se pasa, avisa y sigue con los demás).
- Nombres duplicados se renombran solos: `foto (2).jpg`.
- Búsqueda por nombre (sin distinguir acentos) y orden por recientes / nombre / tamaño.
- Pestañas **Todos** y **Basurero**, cada una con su contador. Almacenamiento usado arriba.
- Basurero: mover, restaurar, **deshacer** (snackbar), eliminar para siempre (con confirmación) y vaciar. Se borra solo a los 30 días (se revisa al abrir, al volver a la app y cada minuto mientras está abierta).
- Selección múltiple (mantén presionado un archivo) con acciones en lote: basurero, restaurar, eliminar, compartir, guardar en Descargas.
- Renombrar con validación; la extensión no se puede cambiar.
- Vista previa de imagen (toca para ampliar), video y audio, con flechas para pasar al siguiente. Otros tipos: ficha con nombre, tamaño, tipo y fecha.
- Compartir con la hoja de compartir de Android y guardar copia en **Descargas**.
- Botón Atrás: cierra diálogo → vista previa → selección → búsqueda → pestaña Basurero → sale.
- Modo oscuro automático, áreas seguras (notch y barra de gestos) y botones táctiles de 48 px o más.

Modelo de datos: `{ id, name, size, type, at, trashedAt }` (`trashedAt: null` = activo).

## Decisiones técnicas

- **Almacenamiento:** metadatos en IndexedDB y los bytes en Capacitor Filesystem (`Directory.Data/archivos/<id>`). Con archivos de 20 MB esto permite previsualizar video con una URL sin cargarlo en memoria, compartir sin duplicarlo en JavaScript y guardar en Descargas copiando en nativo.
- **Plugins:** `@capacitor/filesystem`, `@capacitor/share`, `@capacitor/app` (botón Atrás) y un plugin propio, `Downloads` (`native/java/DownloadsPlugin.java`), que copia a Descargas con MediaStore sin pedir permisos.
- **Capacitor 6:** Capacitor 7 exige JDK 21 y tú pediste JDK 17.
- **Sin bundler:** los plugins se usan con `Capacitor.registerPlugin(...)`; la carpeta `www/` se sirve tal cual.
- **Android 10 o superior** (`minSdk 29`). Tu Redmi Note 9S lo cumple.
- La carpeta `android/` **no se sube al repo**: el workflow la genera con `npx cap add android` y le aplica `scripts/prepare-android.mjs` (plugin, tema, ícono, versión y firma).
- Los íconos y colores siguen las referencias de styles.refero.design: lienzo claro con tarjetas blancas, y superficies casi negras con bordes finos en oscuro, con un solo acento.

## 1. Subir al repositorio

Desde la PC, dentro de esta carpeta:

```bash
git init
git add .
git commit -m "Archivos: primera versión"
git branch -M main
git remote add origin https://github.com/TU_USUARIO/archivos.git
git push -u origin main
```

Crea antes el repositorio vacío en github.com (botón **New**). Si GitHub rechaza `.github/workflows/build-apk.yml` por falta de permiso (el token debe tener el alcance `workflow`), crea el archivo desde la web: **Add file → Create new file**, nombre `.github/workflows/build-apk.yml`, y pega su contenido.

## 2. Activar Actions

Pestaña **Actions** del repo → si pide confirmación, **I understand my workflows, go ahead and enable them**.
Cada `push` a `main` compila solo; también puedes lanzarlo a mano: **Actions → Compilar APK → Run workflow**.

El workflow usa JDK 17 (Temurin), Node 20, Android SDK plataforma 34 con build-tools 34.0.0 y Capacitor 6.

## 3. Keystore fija y secretos (desde la PC)

Sin keystore fija el APK sale con firma debug y **no se podrá actualizar encima** de otro compilado con una firma distinta. Se crea una sola vez:

1. Necesitas `keytool` (viene con cualquier JDK 17). Genera la keystore:

   ```bash
   keytool -genkeypair -v -keystore archivos-release.jks -alias archivos -keyalg RSA -keysize 2048 -validity 10000
   ```

   Te pedirá una contraseña y tus datos. Con el formato por defecto (PKCS12) la contraseña de la clave es la misma que la del almacén.

2. Conviértela a texto base64:
   - Windows (PowerShell): `[Convert]::ToBase64String([IO.File]::ReadAllBytes("archivos-release.jks")) | Set-Clipboard`
   - Linux: `base64 -w0 archivos-release.jks | xclip -selection clipboard` (o redirige a un archivo)
   - macOS: `base64 -i archivos-release.jks | pbcopy`

3. En GitHub: **Settings → Secrets and variables → Actions → New repository secret**, y crea estos cuatro:

   | Secreto | Valor |
   |---|---|
   | `ANDROID_KEYSTORE_BASE64` | el texto base64 del paso 2 |
   | `KEYSTORE_PASSWORD` | la contraseña que elegiste |
   | `KEY_ALIAS` | `archivos` |
   | `KEY_PASSWORD` | la misma contraseña (con PKCS12) |

   Con la CLI de GitHub también sirve: `gh secret set KEY_ALIAS` (te pide el valor sin dejarlo en el historial).

4. **Guarda `archivos-release.jks` y su contraseña en un lugar seguro** (fuera del repo; ya está en `.gitignore`). Si se pierde, no podrás publicar actualizaciones instalables encima.

## 4. Descargar el APK

- **Releases** (columna derecha del repo): cada compilación crea la versión `v1.0.N` con `Archivos-1.0.N-firmado.apk`.
- O en **Actions → ejecución → Artifacts**.

La versión sube sola con cada ejecución (`versionCode` = número de ejecución), así que cada APK se instala encima del anterior. En el log del paso "Preparar APK" se imprime la huella SHA-256 de la firma; debe ser siempre la misma.

## 5. Instalar en el celular

1. Descarga el `.apk` en el teléfono (desde el navegador, entrando al Release).
2. Al abrirlo, Android pide permitir **instalar apps desconocidas** para ese navegador o administrador: actívalo y vuelve.
3. En Xiaomi/MIUI puede aparecer una pantalla de seguridad extra o un aviso de Play Protect; elige **Instalar de todos modos**.
4. Para actualizar, instala el APK nuevo encima: se conservan tus archivos (siempre que la firma sea la misma).

## Probar la interfaz en la PC (opcional)

```bash
npm install
npm test            # pruebas de la lógica
npm run serve       # abre www/ en el navegador
```

En el navegador los archivos se guardan en IndexedDB; compartir y Descargas usan las funciones del navegador. Lo nativo (Filesystem, Share, Descargas, botón Atrás) solo funciona en el APK.

## Notas y límites

- Los archivos vacíos se omiten (con aviso). Los nombres se limpian de caracteres no válidos (`/ \ : * ? " < > |`).
- Si la app se cierra a mitad de una subida, al abrir se limpian los restos.
- Las miniaturas se muestran solo para imágenes de hasta 6 MB. Si el teléfono no puede mostrar una vista previa (por ejemplo, ciertos HEIC), cae a la ficha con los datos.
- El respaldo automático de Android está desactivado a propósito: restaurarlo traería archivos sin sus metadatos o al revés.
- Si cambia la plantilla de Capacitor, `prepare-android.mjs` falla con un mensaje claro en vez de generar un APK a medias.
