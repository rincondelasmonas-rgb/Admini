package __APP_ID__;

import android.Manifest;
import android.content.ActivityNotFoundException;
import android.content.ClipData;
import android.content.ContentResolver;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.database.Cursor;
import android.media.MediaScannerConnection;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.os.StatFs;
import android.provider.MediaStore;
import android.provider.Settings;
import android.webkit.MimeTypeMap;

import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;
import androidx.core.content.FileProvider;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedInputStream;
import java.io.BufferedOutputStream;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.text.Normalizer;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Deque;
import java.util.Enumeration;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.zip.ZipEntry;
import java.util.zip.ZipFile;
import java.util.zip.ZipOutputStream;

/**
 * Administrador de archivos real: recorre todo el almacenamiento (interno, tarjeta SD, USB),
 * copia/mueve/borra/comprime, tiene papelera propia por volumen, búsqueda, categorías (MediaStore),
 * duplicados y apertura/compartición con FileProvider.
 *
 * Todo el trabajo pesado corre en un pool de hilos; los bytes nunca pasan por el puente de JavaScript.
 * Las operaciones largas reportan avance con el evento "progress" y se pueden cancelar con cancel({opId}).
 */
@CapacitorPlugin(name = "Files")
public class FilesPlugin extends Plugin {

    private static final String TRASH = ".ArchivosPapelera";
    private static final int PERM_REQ = 4242;
    private static final long DAY_MS = 86400000L;

    private static final String[] DOC_EXT = {"pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "txt", "rtf", "odt", "ods", "odp", "csv", "epub", "md"};
    private static final String[] ARC_EXT = {"zip", "rar", "7z", "tar", "gz", "tgz", "bz2", "xz"};
    private static final String[] APK_EXT = {"apk"};

    private static final String DATA = MediaStore.Files.FileColumns.DATA;
    private static final String SIZE = MediaStore.Files.FileColumns.SIZE;
    private static final String MTIME = MediaStore.Files.FileColumns.DATE_MODIFIED;
    private static final String MTYPE = MediaStore.Files.FileColumns.MEDIA_TYPE;

    private final ExecutorService pool = Executors.newFixedThreadPool(3);
    private final Map<String, AtomicBoolean> ops = new ConcurrentHashMap<>();

    // ------------------------------------------------------------------ utilidades

    private static class Cancelled extends RuntimeException {
        Cancelled() {
            super("Cancelado", null, false, false);
        }
    }

    private interface Job {
        void run(PluginCall call) throws Exception;
    }

    private void async(final PluginCall call, final Job job) {
        pool.execute(() -> {
            try {
                job.run(call);
            } catch (Cancelled c) {
                call.reject("Cancelado", "CANCELLED");
            } catch (Exception e) {
                call.reject(message(e));
            }
        });
    }

    private static String message(Throwable e) {
        String m = e.getMessage();
        return m != null && !m.isEmpty() ? m : e.getClass().getSimpleName();
    }

    private static String need(PluginCall c, String key) throws IOException {
        String v = c.getData().optString(key, "");
        if (v.isEmpty()) throw new IOException("Falta el dato: " + key);
        return v;
    }

    private static List<String> strings(PluginCall c, String key) throws Exception {
        JSONArray a = c.getData().optJSONArray(key);
        List<String> out = new ArrayList<>();
        if (a != null) {
            for (int i = 0; i < a.length(); i++) out.add(a.getString(i));
        }
        return out;
    }

    private AtomicBoolean op(String id) {
        AtomicBoolean b = new AtomicBoolean(false);
        if (id != null && !id.isEmpty()) ops.put(id, b);
        return b;
    }

    private void finish(String id) {
        if (id != null && !id.isEmpty()) ops.remove(id);
    }

    @PluginMethod
    public void cancel(PluginCall call) {
        String id = call.getData().optString("opId", "");
        AtomicBoolean b = id.isEmpty() ? null : ops.get(id);
        if (b != null) b.set(true);
        call.resolve();
    }

    private void fire(JSObject o) {
        notifyListeners("progress", o);
    }

    private class Progress {
        final String id;
        final AtomicBoolean cancel;
        long total;
        long done;
        long lastEmit;
        String name = "";

        Progress(String id, long total, AtomicBoolean cancel) {
            this.id = id;
            this.total = total;
            this.cancel = cancel;
        }

        void check() {
            if (cancel.get()) throw new Cancelled();
        }

        void add(long n) {
            done += n;
            check();
            long now = System.currentTimeMillis();
            if (now - lastEmit > 150) {
                lastEmit = now;
                emit();
            }
        }

        void item(String n) {
            name = n;
            check();
            lastEmit = System.currentTimeMillis();
            emit();
        }

        void emit() {
            if (id == null || id.isEmpty()) return;
            JSObject o = new JSObject();
            o.put("opId", id);
            o.put("done", done);
            o.put("total", total);
            o.put("name", name);
            fire(o);
        }
    }

    // ------------------------------------------------------------------ permiso y volúmenes

    private boolean hasAccessNow() {
        if (Build.VERSION.SDK_INT >= 30) return Environment.isExternalStorageManager();
        return ContextCompat.checkSelfPermission(getContext(), Manifest.permission.READ_EXTERNAL_STORAGE) == PackageManager.PERMISSION_GRANTED
                && ContextCompat.checkSelfPermission(getContext(), Manifest.permission.WRITE_EXTERNAL_STORAGE) == PackageManager.PERMISSION_GRANTED;
    }

    @PluginMethod
    public void hasAccess(PluginCall call) {
        JSObject r = new JSObject();
        r.put("granted", hasAccessNow());
        r.put("sdk", Build.VERSION.SDK_INT);
        call.resolve(r);
    }

    /** Android 11+: abre la pantalla "Acceso a todos los archivos". Android 10: pide el permiso clásico. */
    @PluginMethod
    public void requestAccess(PluginCall call) {
        try {
            if (Build.VERSION.SDK_INT >= 30) {
                try {
                    Intent i = new Intent(Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION, Uri.parse("package:" + getContext().getPackageName()));
                    getActivity().startActivity(i);
                } catch (Exception e) {
                    getActivity().startActivity(new Intent(Settings.ACTION_MANAGE_ALL_FILES_ACCESS_PERMISSION));
                }
            } else {
                ActivityCompat.requestPermissions(getActivity(),
                        new String[]{Manifest.permission.READ_EXTERNAL_STORAGE, Manifest.permission.WRITE_EXTERNAL_STORAGE}, PERM_REQ);
            }
            call.resolve();
        } catch (Exception e) {
            call.reject("No se pudo abrir la pantalla de permisos: " + message(e));
        }
    }

    @PluginMethod
    public void openAppSettings(PluginCall call) {
        try {
            Intent i = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:" + getContext().getPackageName()));
            getActivity().startActivity(i);
            call.resolve();
        } catch (Exception e) {
            call.reject("No se pudieron abrir los ajustes: " + message(e));
        }
    }

    /** Raíces de almacenamiento: la interna primero, luego tarjeta SD / USB. */
    private List<File> roots() {
        List<File> list = new ArrayList<>();
        File primary = Environment.getExternalStorageDirectory();
        list.add(primary);
        File[] dirs = getContext().getExternalFilesDirs(null);
        if (dirs != null) {
            for (File d : dirs) {
                if (d == null) continue;
                String p = d.getAbsolutePath();
                int i = p.indexOf("/Android/");
                if (i <= 0) continue;
                File r = new File(p.substring(0, i));
                if (r.exists() && !list.contains(r)) list.add(r);
            }
        }
        return list;
    }

    private File volumeRoot(File f) {
        String p = f.getAbsolutePath();
        File best = null;
        for (File r : roots()) {
            String rp = r.getAbsolutePath();
            if (p.equals(rp) || p.startsWith(rp + "/")) {
                if (best == null || rp.length() > best.getAbsolutePath().length()) best = r;
            }
        }
        return best != null ? best : Environment.getExternalStorageDirectory();
    }

    @PluginMethod
    public void getVolumes(PluginCall call) {
        async(call, c -> {
            JSArray out = new JSArray();
            List<File> roots = roots();
            int sd = 0;
            for (int i = 0; i < roots.size(); i++) {
                File r = roots.get(i);
                JSObject v = new JSObject();
                String label;
                if (i == 0) {
                    label = "Almacenamiento interno";
                } else {
                    sd++;
                    label = sd == 1 ? "Tarjeta SD / USB" : "Almacenamiento externo " + sd;
                }
                long total = 0;
                long free = 0;
                try {
                    StatFs st = new StatFs(r.getAbsolutePath());
                    total = st.getTotalBytes();
                    free = st.getAvailableBytes();
                } catch (Exception ignored) {
                    // volumen no disponible
                }
                v.put("path", r.getAbsolutePath());
                v.put("label", label);
                v.put("total", total);
                v.put("free", free);
                v.put("primary", i == 0);
                out.put(v);
            }
            JSObject res = new JSObject();
            res.put("volumes", out);
            c.resolve(res);
        });
    }

    @PluginMethod
    public void existsMany(PluginCall call) {
        async(call, c -> {
            JSArray out = new JSArray();
            for (String p : strings(c, "paths")) {
                File f = new File(p);
                if (f.isDirectory()) out.put(f.getAbsolutePath());
            }
            JSObject res = new JSObject();
            res.put("existing", out);
            c.resolve(res);
        });
    }

    // ------------------------------------------------------------------ lectura

    private JSObject entry(File f) {
        JSObject o = new JSObject();
        boolean dir = f.isDirectory();
        o.put("name", f.getName());
        o.put("path", f.getAbsolutePath());
        o.put("dir", dir);
        o.put("size", dir ? 0 : f.length());
        o.put("mtime", f.lastModified());
        if (dir) {
            String[] k = f.list();
            o.put("count", k == null ? 0 : k.length);
        }
        return o;
    }

    @PluginMethod
    public void list(PluginCall call) {
        async(call, c -> {
            File dir = new File(need(c, "path"));
            boolean hidden = c.getData().optBoolean("showHidden", false);
            File[] files = dir.listFiles();
            if (files == null) throw new IOException(dir.exists() ? "No se puede abrir esta carpeta (sin permiso)." : "La carpeta ya no existe.");
            JSArray out = new JSArray();
            for (File f : files) {
                if (!hidden && f.getName().startsWith(".")) continue;
                out.put(entry(f));
            }
            JSObject res = new JSObject();
            res.put("path", dir.getAbsolutePath());
            res.put("entries", out);
            c.resolve(res);
        });
    }

    @PluginMethod
    public void stat(PluginCall call) {
        async(call, c -> {
            File f = new File(need(c, "path"));
            if (!f.exists()) throw new IOException("El archivo ya no existe.");
            JSObject o = entry(f);
            o.put("canRead", f.canRead());
            o.put("canWrite", f.canWrite());
            o.put("hidden", f.getName().startsWith("."));
            File parent = f.getParentFile();
            o.put("parent", parent == null ? "" : parent.getAbsolutePath());
            c.resolve(o);
        });
    }

    @PluginMethod
    public void dirSize(PluginCall call) {
        async(call, c -> {
            String opId = c.getData().optString("opId", "");
            AtomicBoolean cancel = op(opId);
            try {
                long[] t = treeSize(new File(need(c, "path")), cancel);
                JSObject o = new JSObject();
                o.put("size", t[0]);
                o.put("files", t[1]);
                o.put("folders", t[2]);
                c.resolve(o);
            } finally {
                finish(opId);
            }
        });
    }

    /** { bytes, archivos, carpetas } */
    private long[] treeSize(File f, AtomicBoolean cancel) {
        long[] t = new long[3];
        Deque<File> stack = new ArrayDeque<>();
        stack.push(f);
        while (!stack.isEmpty()) {
            if (cancel != null && cancel.get()) throw new Cancelled();
            File x = stack.pop();
            if (isSymlink(x)) continue;
            if (x.isDirectory()) {
                if (x != f) t[2]++;
                File[] kids = x.listFiles();
                if (kids != null) for (File k : kids) stack.push(k);
            } else {
                t[0] += x.length();
                t[1]++;
            }
        }
        return t;
    }

    private static boolean isSymlink(File f) {
        try {
            return java.nio.file.Files.isSymbolicLink(f.toPath());
        } catch (Exception e) {
            return false;
        }
    }

    // ------------------------------------------------------------------ nombres y rutas

    private static boolean validName(String n) {
        if (n == null) return false;
        String t = n.trim();
        if (t.isEmpty() || t.equals(".") || t.equals("..")) return false;
        if (t.getBytes(StandardCharsets.UTF_8).length > 255) return false;
        for (int i = 0; i < t.length(); i++) {
            char ch = t.charAt(i);
            if (ch == '/' || ch == '\\' || ch == 0 || ch < 32) return false;
        }
        return true;
    }

    private static final Pattern DUP = Pattern.compile("^(.*) \\((\\d+)\\)$");

    private static File uniqueIn(File dir, String name, boolean isDir) {
        File f = new File(dir, name);
        if (!f.exists()) return f;
        int dot = isDir ? -1 : name.lastIndexOf('.');
        String base = dot > 0 ? name.substring(0, dot) : name;
        String ext = dot > 0 ? name.substring(dot) : "";
        Matcher m = DUP.matcher(base);
        String stem = m.matches() ? m.group(1) : base;
        for (int n = 2; ; n++) {
            File c = new File(dir, stem + " (" + n + ")" + ext);
            if (!c.exists()) return c;
        }
    }

    private static boolean sameFile(File a, File b) {
        try {
            return a.getCanonicalPath().equals(b.getCanonicalPath());
        } catch (IOException e) {
            return a.getAbsolutePath().equals(b.getAbsolutePath());
        }
    }

    /** ¿`inner` está dentro de `outer` (o es la misma carpeta)? */
    private static boolean isInside(File inner, File outer) {
        try {
            String i = inner.getCanonicalPath();
            String o = outer.getCanonicalPath();
            return i.equals(o) || i.startsWith(o + "/");
        } catch (IOException e) {
            return false;
        }
    }

    private static String extOf(String name) {
        int dot = name.lastIndexOf('.');
        if (dot <= 0 || dot == name.length() - 1) return "";
        String e = name.substring(dot).toLowerCase(Locale.ROOT).replaceAll("[^a-z0-9.]", "");
        return e.length() > 9 ? "" : e;
    }

    private static String mimeOf(String name) {
        int dot = name.lastIndexOf('.');
        if (dot > 0 && dot < name.length() - 1) {
            String m = MimeTypeMap.getSingleton().getMimeTypeFromExtension(name.substring(dot + 1).toLowerCase(Locale.ROOT));
            if (m != null) return m;
        }
        return "application/octet-stream";
    }

    private static String fold(String s) {
        return Normalizer.normalize(s, Normalizer.Form.NFD).replaceAll("\\p{M}+", "").toLowerCase(Locale.ROOT);
    }

    private void scan(List<String> paths) {
        if (paths == null || paths.isEmpty()) return;
        try {
            MediaScannerConnection.scanFile(getContext(), paths.toArray(new String[0]), null, null);
        } catch (Exception ignored) {
            // la galería se pondrá al día sola más tarde
        }
    }

    // ------------------------------------------------------------------ crear / renombrar / editar

    @PluginMethod
    public void createFolder(PluginCall call) {
        async(call, c -> {
            File parent = new File(need(c, "parent"));
            String name = need(c, "name").trim();
            if (!validName(name)) throw new IOException("Nombre no válido.");
            File dir = new File(parent, name);
            if (dir.exists()) throw new IOException("Ya existe algo con ese nombre.");
            if (!dir.mkdirs()) throw new IOException("No se pudo crear la carpeta.");
            JSObject o = new JSObject();
            o.put("path", dir.getAbsolutePath());
            c.resolve(o);
        });
    }

    @PluginMethod
    public void createFile(PluginCall call) {
        async(call, c -> {
            File parent = new File(need(c, "parent"));
            String name = need(c, "name").trim();
            if (!validName(name)) throw new IOException("Nombre no válido.");
            File f = new File(parent, name);
            if (f.exists()) throw new IOException("Ya existe algo con ese nombre.");
            writeBytes(f, c.getData().optString("text", "").getBytes(StandardCharsets.UTF_8));
            scan(Collections.singletonList(f.getAbsolutePath()));
            JSObject o = new JSObject();
            o.put("path", f.getAbsolutePath());
            c.resolve(o);
        });
    }

    @PluginMethod
    public void rename(PluginCall call) {
        async(call, c -> {
            File f = new File(need(c, "path"));
            String name = need(c, "name").trim();
            if (!validName(name)) throw new IOException("Nombre no válido.");
            if (!f.exists()) throw new IOException("El archivo ya no existe.");
            File target = new File(f.getParentFile(), name);
            if (target.exists() && !f.getName().equalsIgnoreCase(name)) throw new IOException("Ya existe algo con ese nombre.");
            if (!f.renameTo(target)) throw new IOException("No se pudo renombrar.");
            List<String> touched = new ArrayList<>();
            touched.add(f.getAbsolutePath());
            touched.add(target.getAbsolutePath());
            scan(touched);
            JSObject o = new JSObject();
            o.put("path", target.getAbsolutePath());
            c.resolve(o);
        });
    }

    private static void writeBytes(File f, byte[] data) throws IOException {
        File tmp = new File(f.getParentFile(), f.getName() + ".tmp" + System.currentTimeMillis());
        try (OutputStream out = new FileOutputStream(tmp)) {
            out.write(data);
            out.flush();
        } catch (IOException e) {
            tmp.delete();
            throw e;
        }
        if (!tmp.renameTo(f)) {
            f.delete();
            if (!tmp.renameTo(f)) {
                tmp.delete();
                throw new IOException("No se pudo guardar el archivo.");
            }
        }
    }

    @PluginMethod
    public void readText(PluginCall call) {
        async(call, c -> {
            File f = new File(need(c, "path"));
            long max = c.getData().optLong("max", 1024 * 1024);
            if (!f.isFile()) throw new IOException("El archivo ya no existe.");
            JSObject o = new JSObject();
            o.put("size", f.length());
            o.put("mtime", f.lastModified());
            if (f.length() > max) {
                o.put("tooLarge", true);
                c.resolve(o);
                return;
            }
            ByteArrayOutputStream bos = new ByteArrayOutputStream((int) Math.max(16, f.length()));
            try (InputStream in = new FileInputStream(f)) {
                byte[] buf = new byte[64 * 1024];
                int n;
                while ((n = in.read(buf)) > 0) bos.write(buf, 0, n);
            }
            byte[] data = bos.toByteArray();
            for (int i = 0; i < Math.min(data.length, 4096); i++) {
                if (data[i] == 0) {
                    o.put("binary", true);
                    c.resolve(o);
                    return;
                }
            }
            o.put("text", new String(data, StandardCharsets.UTF_8));
            c.resolve(o);
        });
    }

    @PluginMethod
    public void writeText(PluginCall call) {
        async(call, c -> {
            File f = new File(need(c, "path"));
            writeBytes(f, c.getData().optString("text", "").getBytes(StandardCharsets.UTF_8));
            scan(Collections.singletonList(f.getAbsolutePath()));
            JSObject o = new JSObject();
            o.put("size", f.length());
            o.put("mtime", f.lastModified());
            c.resolve(o);
        });
    }

    // ------------------------------------------------------------------ copiar / mover / borrar

    private void copyTree(File src, File dst, Progress p) throws IOException {
        if (p != null) p.check();
        if (isSymlink(src)) return;
        if (src.isDirectory()) {
            if (!dst.exists() && !dst.mkdirs()) throw new IOException("No se pudo crear la carpeta " + dst.getName());
            File[] kids = src.listFiles();
            if (kids != null) for (File k : kids) copyTree(k, new File(dst, k.getName()), p);
        } else {
            try (InputStream in = new FileInputStream(src); OutputStream out = new FileOutputStream(dst)) {
                byte[] buf = new byte[128 * 1024];
                int n;
                while ((n = in.read(buf)) > 0) {
                    out.write(buf, 0, n);
                    if (p != null) p.add(n);
                }
                out.flush();
            } catch (IOException | RuntimeException e) {
                dst.delete(); // no dejar archivos a medias
                throw e;
            }
            dst.setLastModified(src.lastModified());
        }
    }

    private static boolean deleteTree(File f) {
        boolean ok = true;
        if (f.isDirectory() && !isSymlink(f)) {
            File[] kids = f.listFiles();
            if (kids != null) for (File k : kids) ok &= deleteTree(k);
        }
        return f.delete() && ok;
    }

    private static JSObject failure(String name, Throwable e) {
        JSObject o = new JSObject();
        o.put("name", name);
        o.put("reason", message(e));
        return o;
    }

    @PluginMethod
    public void conflicts(PluginCall call) {
        async(call, c -> {
            File dest = new File(need(c, "dest"));
            JSArray names = new JSArray();
            for (String p : strings(c, "items")) {
                File src = new File(p);
                File target = new File(dest, src.getName());
                if (target.exists() && !sameFile(src, target)) names.put(src.getName());
            }
            JSObject o = new JSObject();
            o.put("names", names);
            c.resolve(o);
        });
    }

    @PluginMethod
    public void copy(PluginCall call) {
        transfer(call, false);
    }

    @PluginMethod
    public void move(PluginCall call) {
        transfer(call, true);
    }

    private void transfer(final PluginCall call, final boolean move) {
        async(call, c -> {
            List<String> items = strings(c, "items");
            File destDir = new File(need(c, "dest"));
            String policy = c.getData().optString("policy", "rename");
            String opId = c.getData().optString("opId", "");
            AtomicBoolean cancel = op(opId);
            List<String> touched = new ArrayList<>();
            try {
                if (!destDir.isDirectory()) throw new IOException("La carpeta de destino no existe.");
                List<File> files = new ArrayList<>();
                List<Long> sizes = new ArrayList<>();
                JSArray failed = new JSArray();
                long total = 0;
                long need = 0;
                for (String p : items) {
                    File f = new File(p);
                    if (!f.exists()) {
                        failed.put(failure(f.getName(), new IOException("Ya no existe.")));
                        continue;
                    }
                    long size = f.isDirectory() ? treeSize(f, cancel)[0] : f.length();
                    files.add(f);
                    sizes.add(size);
                    total += size;
                    if (!move || !volumeRoot(f).equals(volumeRoot(destDir))) need += size;
                }
                if (need > 0) {
                    long free = new StatFs(destDir.getAbsolutePath()).getAvailableBytes();
                    if (need > free) throw new IOException("No hay espacio suficiente en el destino.");
                }
                Progress pr = new Progress(opId, total, cancel);
                JSArray results = new JSArray();
                int ok = 0;
                int skipped = 0;
                for (int i = 0; i < files.size(); i++) {
                    File src = files.get(i);
                    long size = sizes.get(i);
                    pr.item(src.getName());
                    try {
                        if (src.isDirectory() && isInside(destDir, src)) {
                            throw new IOException("No se puede " + (move ? "mover" : "copiar") + " una carpeta dentro de sí misma.");
                        }
                        File target = new File(destDir, src.getName());
                        boolean same = sameFile(src, target);
                        if (move && same) {
                            skipped++;
                            pr.add(size);
                            continue;
                        }
                        if (same || target.exists()) {
                            if (same || "rename".equals(policy)) {
                                target = uniqueIn(destDir, src.getName(), src.isDirectory());
                            } else if ("skip".equals(policy)) {
                                skipped++;
                                pr.add(size);
                                continue;
                            } else if (!deleteTree(target)) {
                                throw new IOException("No se pudo reemplazar el archivo existente.");
                            }
                        }
                        if (move) {
                            if (src.renameTo(target)) {
                                pr.add(size);
                            } else {
                                copyTree(src, target, pr);
                                if (!deleteTree(src)) throw new IOException("Se copió, pero no se pudo borrar el original.");
                            }
                        } else {
                            copyTree(src, target, pr);
                        }
                        touched.add(src.getAbsolutePath());
                        touched.add(target.getAbsolutePath());
                        results.put(target.getAbsolutePath());
                        ok++;
                    } catch (Cancelled x) {
                        throw x;
                    } catch (Exception e) {
                        failed.put(failure(src.getName(), e));
                    }
                }
                JSObject res = new JSObject();
                res.put("ok", ok);
                res.put("skipped", skipped);
                res.put("failed", failed);
                res.put("results", results);
                c.resolve(res);
            } finally {
                scan(touched);
                finish(opId);
            }
        });
    }

    @PluginMethod
    public void delete(PluginCall call) {
        async(call, c -> {
            List<String> items = strings(c, "items");
            String opId = c.getData().optString("opId", "");
            AtomicBoolean cancel = op(opId);
            List<String> touched = new ArrayList<>();
            try {
                Progress pr = new Progress(opId, items.size(), cancel);
                JSArray failed = new JSArray();
                int ok = 0;
                for (String p : items) {
                    File f = new File(p);
                    pr.item(f.getName());
                    try {
                        if (f.exists() && !deleteTree(f)) throw new IOException("No se pudo borrar.");
                        touched.add(f.getAbsolutePath());
                        ok++;
                    } catch (Exception e) {
                        failed.put(failure(f.getName(), e));
                    }
                    pr.add(1);
                }
                JSObject res = new JSObject();
                res.put("ok", ok);
                res.put("failed", failed);
                c.resolve(res);
            } finally {
                scan(touched);
                finish(opId);
            }
        });
    }

    // ------------------------------------------------------------------ papelera (una por volumen)
    //  <volumen>/.ArchivosPapelera/data/<uuid>[.ext]   el archivo o carpeta
    //  <volumen>/.ArchivosPapelera/meta/<uuid>.json    { name, orig, deletedAt, dir, size, dataName }

    private File trashData(File root) {
        return new File(new File(root, TRASH), "data");
    }

    private File trashMeta(File root) {
        return new File(new File(root, TRASH), "meta");
    }

    /** Mueve `src` a la papelera de `root` y escribe sus metadatos. Devuelve la ruta dentro de la papelera. */
    private String trashOne(File src, String orig, long deletedAt, File root, Progress p) throws Exception {
        File base = new File(root, TRASH);
        File data = trashData(root);
        File meta = trashMeta(root);
        if (!data.isDirectory() && !data.mkdirs()) throw new IOException("No se pudo crear la papelera.");
        if (!meta.isDirectory() && !meta.mkdirs()) throw new IOException("No se pudo crear la papelera.");
        File nomedia = new File(base, ".nomedia");
        if (!nomedia.exists()) {
            try {
                nomedia.createNewFile();
            } catch (IOException ignored) {
                // solo evita que la galería indexe la papelera
            }
        }
        boolean dir = src.isDirectory();
        String id = UUID.randomUUID().toString();
        String dataName = id + (dir ? "" : extOf(src.getName()));
        File dst = new File(data, dataName);
        long size = dir ? treeSize(src, null)[0] : src.length();
        if (!src.renameTo(dst)) {
            copyTree(src, dst, p);
            if (!deleteTree(src)) {
                deleteTree(dst);
                throw new IOException("No se pudo mover a la papelera.");
            }
        }
        JSObject m = new JSObject();
        m.put("name", src.getName());
        m.put("orig", orig);
        m.put("deletedAt", deletedAt);
        m.put("dir", dir);
        m.put("size", size);
        m.put("dataName", dataName);
        writeBytes(new File(meta, id + ".json"), m.toString().getBytes(StandardCharsets.UTF_8));
        return dst.getAbsolutePath();
    }

    @PluginMethod
    public void trash(PluginCall call) {
        async(call, c -> {
            List<String> items = strings(c, "items");
            String opId = c.getData().optString("opId", "");
            AtomicBoolean cancel = op(opId);
            List<String> touched = new ArrayList<>();
            try {
                Progress pr = new Progress(opId, items.size(), cancel);
                JSArray failed = new JSArray();
                JSArray moved = new JSArray();
                long now = System.currentTimeMillis();
                for (String p : items) {
                    File f = new File(p);
                    pr.item(f.getName());
                    try {
                        if (!f.exists()) throw new IOException("Ya no existe.");
                        String dst = trashOne(f, f.getAbsolutePath(), now, volumeRoot(f), null);
                        touched.add(f.getAbsolutePath());
                        moved.put(dst);
                    } catch (Cancelled x) {
                        throw x;
                    } catch (Exception e) {
                        failed.put(failure(f.getName(), e));
                    }
                    pr.add(1);
                }
                JSObject res = new JSObject();
                res.put("ok", moved.length());
                res.put("failed", failed);
                res.put("trashed", moved);
                c.resolve(res);
            } finally {
                scan(touched);
                finish(opId);
            }
        });
    }

    private File metaFor(File dataFile) {
        String n = dataFile.getName();
        int dot = n.indexOf('.');
        String id = dot > 0 ? n.substring(0, dot) : n;
        File root = dataFile.getParentFile().getParentFile().getParentFile();
        return new File(trashMeta(root), id + ".json");
    }

    private JSObject readMeta(File metaFile) {
        try (InputStream in = new FileInputStream(metaFile)) {
            ByteArrayOutputStream bos = new ByteArrayOutputStream();
            byte[] buf = new byte[4096];
            int n;
            while ((n = in.read(buf)) > 0) bos.write(buf, 0, n);
            return new JSObject(new String(bos.toByteArray(), StandardCharsets.UTF_8));
        } catch (Exception e) {
            return null;
        }
    }

    @PluginMethod
    public void trashList(PluginCall call) {
        async(call, c -> {
            JSArray out = new JSArray();
            for (File root : roots()) {
                File[] metas = trashMeta(root).listFiles();
                if (metas == null) continue;
                for (File mf : metas) {
                    if (!mf.getName().endsWith(".json")) continue;
                    JSObject m = readMeta(mf);
                    if (m == null) continue;
                    File data = new File(trashData(root), m.optString("dataName", ""));
                    if (!data.exists()) {
                        mf.delete(); // metadatos huérfanos
                        continue;
                    }
                    JSObject o = new JSObject();
                    o.put("name", m.optString("name", data.getName()));
                    o.put("orig", m.optString("orig", ""));
                    o.put("deletedAt", m.optLong("deletedAt", data.lastModified()));
                    o.put("dir", m.optBoolean("dir", data.isDirectory()));
                    o.put("size", m.optLong("size", data.length()));
                    o.put("path", data.getAbsolutePath());
                    out.put(o);
                }
            }
            JSObject res = new JSObject();
            res.put("entries", out);
            c.resolve(res);
        });
    }

    @PluginMethod
    public void trashRestore(PluginCall call) {
        async(call, c -> {
            List<String> paths = strings(c, "paths");
            String opId = c.getData().optString("opId", "");
            AtomicBoolean cancel = op(opId);
            List<String> touched = new ArrayList<>();
            try {
                Progress pr = new Progress(opId, paths.size(), cancel);
                JSArray failed = new JSArray();
                JSArray restored = new JSArray();
                for (String p : paths) {
                    File data = new File(p);
                    pr.item(data.getName());
                    try {
                        File mf = metaFor(data);
                        JSObject m = readMeta(mf);
                        if (m == null) throw new IOException("Faltan los datos de este elemento.");
                        File orig = new File(m.optString("orig", ""));
                        File parent = orig.getParentFile();
                        if (parent == null) throw new IOException("No se conoce la carpeta original.");
                        if (!parent.isDirectory() && !parent.mkdirs()) throw new IOException("No se pudo recrear la carpeta original.");
                        File target = uniqueIn(parent, orig.getName(), data.isDirectory());
                        if (!data.renameTo(target)) {
                            copyTree(data, target, null);
                            if (!deleteTree(data)) throw new IOException("No se pudo quitar de la papelera.");
                        }
                        mf.delete();
                        touched.add(target.getAbsolutePath());
                        restored.put(target.getAbsolutePath());
                    } catch (Cancelled x) {
                        throw x;
                    } catch (Exception e) {
                        failed.put(failure(data.getName(), e));
                    }
                    pr.add(1);
                }
                JSObject res = new JSObject();
                res.put("ok", restored.length());
                res.put("failed", failed);
                res.put("restored", restored);
                c.resolve(res);
            } finally {
                scan(touched);
                finish(opId);
            }
        });
    }

    @PluginMethod
    public void trashDelete(PluginCall call) {
        async(call, c -> {
            List<String> paths = strings(c, "paths");
            String opId = c.getData().optString("opId", "");
            AtomicBoolean cancel = op(opId);
            try {
                Progress pr = new Progress(opId, paths.size(), cancel);
                int ok = 0;
                for (String p : paths) {
                    File data = new File(p);
                    pr.item(data.getName());
                    File mf = metaFor(data);
                    if (deleteTree(data) || !data.exists()) {
                        mf.delete();
                        ok++;
                    }
                    pr.add(1);
                }
                JSObject res = new JSObject();
                res.put("ok", ok);
                c.resolve(res);
            } finally {
                finish(opId);
            }
        });
    }

    @PluginMethod
    public void trashEmpty(PluginCall call) {
        async(call, c -> {
            int n = 0;
            for (File root : roots()) {
                File[] metas = trashMeta(root).listFiles();
                if (metas != null) {
                    for (File mf : metas) {
                        JSObject m = readMeta(mf);
                        if (m != null) deleteTree(new File(trashData(root), m.optString("dataName", "x")));
                        mf.delete();
                        n++;
                    }
                }
                File[] rest = trashData(root).listFiles(); // restos sin metadatos
                if (rest != null) for (File r : rest) deleteTree(r);
            }
            JSObject res = new JSObject();
            res.put("ok", n);
            c.resolve(res);
        });
    }

    /** Borra de la papelera lo que lleva `days` días o más. days <= 0: no hace nada. */
    @PluginMethod
    public void trashPurge(PluginCall call) {
        async(call, c -> {
            int days = c.getData().optInt("days", 0);
            int n = 0;
            if (days > 0) {
                long limit = System.currentTimeMillis() - days * DAY_MS;
                for (File root : roots()) {
                    File[] metas = trashMeta(root).listFiles();
                    if (metas == null) continue;
                    for (File mf : metas) {
                        JSObject m = readMeta(mf);
                        if (m == null) continue;
                        if (m.optLong("deletedAt", Long.MAX_VALUE) <= limit) {
                            deleteTree(new File(trashData(root), m.optString("dataName", "x")));
                            mf.delete();
                            n++;
                        }
                    }
                }
            }
            JSObject res = new JSObject();
            res.put("ok", n);
            c.resolve(res);
        });
    }

    // ------------------------------------------------------------------ comprimir / extraer

    @PluginMethod
    public void zip(PluginCall call) {
        async(call, c -> {
            List<String> items = strings(c, "items");
            File dest = new File(need(c, "dest"));
            String opId = c.getData().optString("opId", "");
            AtomicBoolean cancel = op(opId);
            boolean done = false;
            try {
                if (dest.exists()) throw new IOException("Ya existe un archivo con ese nombre.");
                List<File> files = new ArrayList<>();
                long total = 0;
                for (String p : items) {
                    File f = new File(p);
                    if (!f.exists()) continue;
                    files.add(f);
                    total += f.isDirectory() ? treeSize(f, cancel)[0] : f.length();
                }
                if (files.isEmpty()) throw new IOException("No hay nada que comprimir.");
                Progress pr = new Progress(opId, total, cancel);
                Set<String> used = new HashSet<>();
                try (ZipOutputStream zos = new ZipOutputStream(new BufferedOutputStream(new FileOutputStream(dest)))) {
                    for (File f : files) {
                        String name = f.getName();
                        String entryName = name;
                        for (int n = 2; used.contains(entryName.toLowerCase(Locale.ROOT)); n++) entryName = name + " (" + n + ")";
                        used.add(entryName.toLowerCase(Locale.ROOT));
                        pr.item(f.getName());
                        addToZip(zos, f, entryName, dest, pr);
                    }
                }
                done = true;
                scan(Collections.singletonList(dest.getAbsolutePath()));
                JSObject o = new JSObject();
                o.put("path", dest.getAbsolutePath());
                o.put("size", dest.length());
                c.resolve(o);
            } finally {
                if (!done) dest.delete();
                finish(opId);
            }
        });
    }

    private void addToZip(ZipOutputStream zos, File f, String name, File self, Progress pr) throws IOException {
        pr.check();
        if (isSymlink(f) || sameFile(f, self)) return;
        if (f.isDirectory()) {
            ZipEntry e = new ZipEntry(name + "/");
            e.setTime(f.lastModified());
            zos.putNextEntry(e);
            zos.closeEntry();
            File[] kids = f.listFiles();
            if (kids != null) for (File k : kids) addToZip(zos, k, name + "/" + k.getName(), self, pr);
        } else {
            ZipEntry e = new ZipEntry(name);
            e.setTime(f.lastModified());
            zos.putNextEntry(e);
            try (InputStream in = new FileInputStream(f)) {
                byte[] buf = new byte[128 * 1024];
                int n;
                while ((n = in.read(buf)) > 0) {
                    zos.write(buf, 0, n);
                    pr.add(n);
                }
            }
            zos.closeEntry();
        }
    }

    @PluginMethod
    public void unzip(PluginCall call) {
        async(call, c -> {
            File zip = new File(need(c, "path"));
            File dest = new File(need(c, "dest"));
            String opId = c.getData().optString("opId", "");
            AtomicBoolean cancel = op(opId);
            boolean ok = false;
            boolean created = false;
            try {
                if (!zip.isFile()) throw new IOException("El archivo ya no existe.");
                created = !dest.exists();
                if (!dest.isDirectory() && !dest.mkdirs()) throw new IOException("No se pudo crear la carpeta de destino.");
                String destCanon = dest.getCanonicalPath();
                long total = 0;
                try (ZipFile zf = new ZipFile(zip)) {
                    Enumeration<? extends ZipEntry> en = zf.entries();
                    while (en.hasMoreElements()) {
                        long s = en.nextElement().getSize();
                        if (s > 0) total += s;
                    }
                    if (total > new StatFs(dest.getAbsolutePath()).getAvailableBytes()) throw new IOException("No hay espacio suficiente.");
                    Progress pr = new Progress(opId, total, cancel);
                    int files = 0;
                    en = zf.entries();
                    while (en.hasMoreElements()) {
                        ZipEntry e = en.nextElement();
                        String name = e.getName().replace('\\', '/');
                        File out = new File(dest, name);
                        String outCanon = out.getCanonicalPath();
                        if (!outCanon.equals(destCanon) && !outCanon.startsWith(destCanon + "/")) {
                            throw new IOException("El ZIP contiene rutas no válidas y no se extrajo.");
                        }
                        if (e.isDirectory()) {
                            out.mkdirs();
                            continue;
                        }
                        pr.item(out.getName());
                        File parent = out.getParentFile();
                        if (parent != null && !parent.isDirectory() && !parent.mkdirs()) throw new IOException("No se pudo crear " + parent.getName());
                        if (out.exists()) out = uniqueIn(parent, out.getName(), false);
                        try (InputStream in = zf.getInputStream(e); OutputStream os = new FileOutputStream(out)) {
                            byte[] buf = new byte[128 * 1024];
                            int n;
                            while ((n = in.read(buf)) > 0) {
                                os.write(buf, 0, n);
                                pr.add(n);
                            }
                        } catch (IOException | RuntimeException ex) {
                            out.delete();
                            throw ex;
                        }
                        if (e.getTime() > 0) out.setLastModified(e.getTime());
                        files++;
                    }
                    ok = true;
                    scan(Collections.singletonList(dest.getAbsolutePath()));
                    JSObject o = new JSObject();
                    o.put("path", dest.getAbsolutePath());
                    o.put("files", files);
                    c.resolve(o);
                }
            } finally {
                if (!ok && created) deleteTree(dest); // cancelado o con error: no dejar una carpeta a medias
                finish(opId);
            }
        });
    }

    // ------------------------------------------------------------------ búsqueda

    @PluginMethod
    public void search(PluginCall call) {
        async(call, c -> {
            File root = new File(need(c, "root"));
            String q = fold(c.getData().optString("query", "").trim());
            boolean hidden = c.getData().optBoolean("showHidden", false);
            int limit = c.getData().optInt("limit", 300);
            String opId = c.getData().optString("opId", "");
            AtomicBoolean cancel = op(opId);
            try {
                if (q.isEmpty()) throw new IOException("Escribe algo para buscar.");
                JSArray out = new JSArray();
                boolean truncated = false;
                Deque<File> stack = new ArrayDeque<>();
                stack.push(root);
                outer:
                while (!stack.isEmpty()) {
                    if (cancel.get()) throw new Cancelled();
                    File dir = stack.pop();
                    File[] kids = dir.listFiles();
                    if (kids == null) continue;
                    for (File k : kids) {
                        String n = k.getName();
                        if (!hidden && n.startsWith(".")) continue;
                        if (fold(n).contains(q)) {
                            out.put(entry(k));
                            if (out.length() >= limit) {
                                truncated = true;
                                break outer;
                            }
                        }
                        if (k.isDirectory() && !isSymlink(k)) stack.push(k);
                    }
                }
                JSObject res = new JSObject();
                res.put("entries", out);
                res.put("truncated", truncated);
                c.resolve(res);
            } finally {
                finish(opId);
            }
        });
    }

    // ------------------------------------------------------------------ categorías (MediaStore)

    private static String baseFilter() {
        return "(" + DATA + " NOT LIKE '%/.%' AND " + DATA + " NOT LIKE '%/Android/data/%' AND " + DATA + " NOT LIKE '%/Android/obb/%')";
    }

    private static String[] selectionFor(String type) {
        // devuelve { selección, arg1, arg2, ... }
        List<String> out = new ArrayList<>();
        String sel;
        switch (type) {
            case "images":
                sel = MTYPE + "=1 AND " + baseFilter();
                break;
            case "audio":
                sel = MTYPE + "=2 AND " + baseFilter();
                break;
            case "videos":
                sel = MTYPE + "=3 AND " + baseFilter();
                break;
            case "docs":
            case "archives":
            case "apks": {
                String[] exts = type.equals("docs") ? DOC_EXT : type.equals("archives") ? ARC_EXT : APK_EXT;
                StringBuilder sb = new StringBuilder("(");
                for (int i = 0; i < exts.length; i++) {
                    if (i > 0) sb.append(" OR ");
                    sb.append(DATA).append(" LIKE ?");
                    out.add("%." + exts[i]);
                }
                sb.append(") AND ").append(baseFilter());
                sel = sb.toString();
                break;
            }
            default:
                sel = "0";
        }
        out.add(0, sel);
        return out.toArray(new String[0]);
    }

    private JSArray mediaQuery(String selection, String[] args, String sort, int limit, int offset) {
        JSArray out = new JSArray();
        Bundle b = new Bundle();
        b.putString(ContentResolver.QUERY_ARG_SQL_SELECTION, selection);
        if (args != null && args.length > 0) b.putStringArray(ContentResolver.QUERY_ARG_SQL_SELECTION_ARGS, args);
        if (sort != null) b.putString(ContentResolver.QUERY_ARG_SQL_SORT_ORDER, sort);
        if (limit > 0) b.putInt(ContentResolver.QUERY_ARG_LIMIT, limit);
        if (offset > 0) b.putInt(ContentResolver.QUERY_ARG_OFFSET, offset);
        try (Cursor cur = getContext().getContentResolver().query(MediaStore.Files.getContentUri("external"), new String[]{DATA, SIZE, MTIME}, b, null)) {
            if (cur == null) return out;
            while (cur.moveToNext()) {
                String path = cur.getString(0);
                if (path == null) continue;
                File f = new File(path);
                if (!f.isFile()) continue; // registros viejos de la galería
                JSObject o = new JSObject();
                o.put("name", f.getName());
                o.put("path", path);
                o.put("dir", false);
                o.put("size", cur.getLong(1));
                o.put("mtime", cur.getLong(2) * 1000L);
                out.put(o);
            }
        }
        return out;
    }

    @PluginMethod
    public void category(PluginCall call) {
        async(call, c -> {
            String type = need(c, "type");
            int limit = c.getData().optInt("limit", 500);
            int offset = c.getData().optInt("offset", 0);
            String[] s = selectionFor(type);
            String[] args = new String[s.length - 1];
            System.arraycopy(s, 1, args, 0, args.length);
            JSArray list = mediaQuery(s[0], args, MTIME + " DESC", limit, offset);
            JSObject res = new JSObject();
            res.put("entries", list);
            res.put("more", list.length() >= limit);
            c.resolve(res);
        });
    }

    @PluginMethod
    public void categoryCounts(PluginCall call) {
        async(call, c -> {
            JSObject res = new JSObject();
            for (String type : new String[]{"images", "videos", "audio", "docs", "archives", "apks"}) {
                String[] s = selectionFor(type);
                String[] args = new String[s.length - 1];
                System.arraycopy(s, 1, args, 0, args.length);
                int n = 0;
                Bundle b = new Bundle();
                b.putString(ContentResolver.QUERY_ARG_SQL_SELECTION, s[0]);
                if (args.length > 0) b.putStringArray(ContentResolver.QUERY_ARG_SQL_SELECTION_ARGS, args);
                try (Cursor cur = getContext().getContentResolver().query(MediaStore.Files.getContentUri("external"), new String[]{MediaStore.Files.FileColumns._ID}, b, null)) {
                    if (cur != null) n = cur.getCount();
                } catch (Exception ignored) {
                    // sin dato para esta categoría
                }
                res.put(type, n);
            }
            c.resolve(res);
        });
    }

    @PluginMethod
    public void categorySizes(PluginCall call) {
        async(call, c -> {
            JSObject res = new JSObject();
            for (String type : new String[]{"images", "videos", "audio", "docs", "archives", "apks"}) {
                String[] s = selectionFor(type);
                String[] args = new String[s.length - 1];
                System.arraycopy(s, 1, args, 0, args.length);
                long total = 0;
                Bundle b = new Bundle();
                b.putString(ContentResolver.QUERY_ARG_SQL_SELECTION, s[0]);
                if (args.length > 0) b.putStringArray(ContentResolver.QUERY_ARG_SQL_SELECTION_ARGS, args);
                try (Cursor cur = getContext().getContentResolver().query(MediaStore.Files.getContentUri("external"), new String[]{MediaStore.Files.FileColumns.SIZE}, b, null)) {
                    if (cur != null) while (cur.moveToNext()) total += cur.getLong(0);
                } catch (Exception ignored) {
                    // sin dato para esta categoría
                }
                res.put(type, total);
            }
            c.resolve(res);
        });
    }

    @PluginMethod
    public void recent(PluginCall call) {
        async(call, c -> {
            int limit = c.getData().optInt("limit", 80);
            JSArray list = mediaQuery(SIZE + ">0 AND " + baseFilter(), null, MTIME + " DESC", limit, 0);
            JSObject res = new JSObject();
            res.put("entries", list);
            c.resolve(res);
        });
    }

    @PluginMethod
    public void largest(PluginCall call) {
        async(call, c -> {
            long min = c.getData().optLong("minSize", 50L * 1024 * 1024);
            int limit = c.getData().optInt("limit", 150);
            JSArray list = mediaQuery(SIZE + ">=" + min + " AND " + baseFilter(), null, SIZE + " DESC", limit, 0);
            JSObject res = new JSObject();
            res.put("entries", list);
            c.resolve(res);
        });
    }

    // ------------------------------------------------------------------ duplicados

    private static String hashOf(File f, long limit, Progress pr) throws Exception {
        MessageDigest md = MessageDigest.getInstance("SHA-1");
        try (InputStream in = new BufferedInputStream(new FileInputStream(f), 64 * 1024)) {
            byte[] buf = new byte[64 * 1024];
            long read = 0;
            int n;
            while ((n = in.read(buf)) > 0) {
                md.update(buf, 0, n);
                read += n;
                if (pr != null) pr.add(n);
                if (limit > 0 && read >= limit) break;
            }
        }
        StringBuilder sb = new StringBuilder();
        for (byte b : md.digest()) sb.append(String.format(Locale.ROOT, "%02x", b));
        return sb.toString();
    }

    @PluginMethod
    public void duplicates(PluginCall call) {
        async(call, c -> {
            long min = c.getData().optLong("minSize", 1024);
            String opId = c.getData().optString("opId", "");
            AtomicBoolean cancel = op(opId);
            try {
                // 1) agrupar por tamaño
                Map<Long, List<File>> bySize = new HashMap<>();
                Bundle b = new Bundle();
                b.putString(ContentResolver.QUERY_ARG_SQL_SELECTION, SIZE + ">=" + min + " AND " + baseFilter());
                try (Cursor cur = getContext().getContentResolver().query(MediaStore.Files.getContentUri("external"), new String[]{DATA, SIZE}, b, null)) {
                    if (cur != null) {
                        while (cur.moveToNext()) {
                            if (cancel.get()) throw new Cancelled();
                            String path = cur.getString(0);
                            if (path == null) continue;
                            File f = new File(path);
                            if (!f.isFile()) continue;
                            List<File> l = bySize.get(f.length());
                            if (l == null) {
                                l = new ArrayList<>();
                                bySize.put(f.length(), l);
                            }
                            l.add(f);
                        }
                    }
                }
                long work = 0;
                for (Map.Entry<Long, List<File>> e : bySize.entrySet()) {
                    if (e.getValue().size() > 1) work += e.getKey() * e.getValue().size();
                }
                Progress pr = new Progress(opId, work, cancel);
                // 2) confirmar con SHA-1 (primero solo el inicio, luego el archivo entero)
                List<JSObject> groups = new ArrayList<>();
                for (Map.Entry<Long, List<File>> e : bySize.entrySet()) {
                    List<File> same = e.getValue();
                    if (same.size() < 2) continue;
                    long size = e.getKey();
                    Map<String, List<File>> quick = new HashMap<>();
                    for (File f : same) {
                        pr.check();
                        try {
                            String h = hashOf(f, 64 * 1024, null);
                            List<File> l = quick.get(h);
                            if (l == null) {
                                l = new ArrayList<>();
                                quick.put(h, l);
                            }
                            l.add(f);
                            pr.add(Math.min(size, 64 * 1024));
                        } catch (Cancelled x) {
                            throw x;
                        } catch (Exception ignored) {
                            // archivo ilegible: se ignora
                        }
                    }
                    for (List<File> cand : quick.values()) {
                        if (cand.size() < 2) {
                            pr.add(Math.max(0, size - 64 * 1024) * cand.size());
                            continue;
                        }
                        Map<String, List<File>> full = new HashMap<>();
                        for (File f : cand) {
                            try {
                                String h = hashOf(f, 0, pr);
                                List<File> l = full.get(h);
                                if (l == null) {
                                    l = new ArrayList<>();
                                    full.put(h, l);
                                }
                                l.add(f);
                            } catch (Cancelled x) {
                                throw x;
                            } catch (Exception ignored) {
                                // archivo ilegible: se ignora
                            }
                        }
                        for (List<File> g : full.values()) {
                            if (g.size() < 2) continue;
                            JSArray items = new JSArray();
                            for (File f : g) items.put(entry(f));
                            JSObject go = new JSObject();
                            go.put("size", size);
                            go.put("items", items);
                            groups.add(go);
                        }
                    }
                }
                Collections.sort(groups, (x, y) -> Long.compare(
                        y.optLong("size") * (y.optJSONArray("items").length() - 1),
                        x.optLong("size") * (x.optJSONArray("items").length() - 1)));
                JSArray out = new JSArray();
                for (int i = 0; i < Math.min(150, groups.size()); i++) out.put(groups.get(i));
                JSObject res = new JSObject();
                res.put("groups", out);
                c.resolve(res);
            } finally {
                finish(opId);
            }
        });
    }

    // ------------------------------------------------------------------ abrir y compartir

    private Uri uriFor(File f) {
        return FileProvider.getUriForFile(getContext(), getContext().getPackageName() + ".fileprovider", f);
    }

    @PluginMethod
    public void open(PluginCall call) {
        try {
            File f = new File(need(call, "path"));
            boolean chooser = call.getData().optBoolean("chooser", false);
            if (!f.isFile()) {
                call.reject("El archivo ya no existe.");
                return;
            }
            String mime = mimeOf(f.getName());
            boolean apk = f.getName().toLowerCase(Locale.ROOT).endsWith(".apk");
            if (apk && Build.VERSION.SDK_INT >= 26 && !getContext().getPackageManager().canRequestPackageInstalls()) {
                Intent s = new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:" + getContext().getPackageName()));
                getActivity().startActivity(s);
                JSObject r = new JSObject();
                r.put("needsInstallPermission", true);
                call.resolve(r);
                return;
            }
            Uri uri = uriFor(f);
            Intent i = new Intent(Intent.ACTION_VIEW);
            i.setDataAndType(uri, mime);
            i.setClipData(ClipData.newRawUri("", uri));
            i.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            getActivity().startActivity(chooser ? Intent.createChooser(i, "Abrir con") : i);
            call.resolve();
        } catch (ActivityNotFoundException e) {
            call.reject("No hay ninguna app que pueda abrir este tipo de archivo.");
        } catch (Exception e) {
            call.reject("No se pudo abrir: " + message(e));
        }
    }

    @PluginMethod
    public void share(PluginCall call) {
        try {
            List<String> paths = strings(call, "paths");
            ArrayList<Uri> uris = new ArrayList<>();
            String mime = null;
            for (String p : paths) {
                File f = new File(p);
                if (!f.isFile()) continue;
                uris.add(uriFor(f));
                String m = mimeOf(f.getName());
                if (mime == null) mime = m;
                else if (!mime.equals(m)) mime = "*/*";
            }
            if (uris.isEmpty()) {
                call.reject("Solo se pueden compartir archivos, no carpetas.");
                return;
            }
            Intent i;
            if (uris.size() == 1) {
                i = new Intent(Intent.ACTION_SEND);
                i.putExtra(Intent.EXTRA_STREAM, uris.get(0));
            } else {
                i = new Intent(Intent.ACTION_SEND_MULTIPLE);
                i.putParcelableArrayListExtra(Intent.EXTRA_STREAM, uris);
            }
            i.setType(mime == null ? "*/*" : mime);
            ClipData clip = ClipData.newRawUri("", uris.get(0));
            for (int k = 1; k < uris.size(); k++) clip.addItem(new ClipData.Item(uris.get(k)));
            i.setClipData(clip);
            i.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            getActivity().startActivity(Intent.createChooser(i, "Compartir"));
            call.resolve();
        } catch (Exception e) {
            call.reject("No se pudo compartir: " + message(e));
        }
    }

    @PluginMethod
    public void scan(PluginCall call) {
        async(call, c -> {
            scan(strings(c, "paths"));
            c.resolve();
        });
    }

    // ------------------------------------------------------------------ importar la bóveda de la versión 1

    /**
     * Pasa a carpetas reales lo que la versión 1 guardaba dentro de la app.
     * items: [{ id, name, trashedAt | null }] · srcDir: carpeta privada con los archivos (nombre = id).
     * Los que estaban en el basurero pasan a la papelera nueva, con su fecha original.
     */
    @PluginMethod
    public void importLegacy(PluginCall call) {
        async(call, c -> {
            File srcDir = new File(need(c, "srcDir"));
            File destDir = new File(need(c, "destDir"));
            JSONArray items = c.getData().optJSONArray("items");
            JSArray okIds = new JSArray();
            JSArray failed = new JSArray();
            List<String> touched = new ArrayList<>();
            if (items != null) {
                for (int i = 0; i < items.length(); i++) {
                    JSONObject it = items.getJSONObject(i);
                    String id = it.optString("id");
                    String name = it.optString("name", id);
                    File src = new File(srcDir, id);
                    try {
                        if (!src.isFile()) {
                            okIds.put(id); // el archivo ya no existe: solo se limpia el registro
                            continue;
                        }
                        if (!destDir.isDirectory() && !destDir.mkdirs()) throw new IOException("No se pudo crear la carpeta de destino.");
                        File target = uniqueIn(destDir, validName(name) ? name : id, false);
                        if (it.isNull("trashedAt")) {
                            copyTree(src, target, null);
                            if (target.length() != src.length()) {
                                target.delete();
                                throw new IOException("La copia no coincide con el original.");
                            }
                            src.delete();
                            touched.add(target.getAbsolutePath());
                        } else {
                            trashOne(src, target.getAbsolutePath(), it.optLong("trashedAt", System.currentTimeMillis()), Environment.getExternalStorageDirectory(), null);
                        }
                        okIds.put(id);
                    } catch (Exception e) {
                        failed.put(failure(name, e));
                    }
                }
            }
            scan(touched);
            JSObject res = new JSObject();
            res.put("okIds", okIds);
            res.put("failed", failed);
            c.resolve(res);
        });
    }
}
