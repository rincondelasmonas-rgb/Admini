package __APP_ID__;

import android.content.ContentResolver;
import android.content.ContentValues;
import android.database.Cursor;
import android.net.Uri;
import android.os.Environment;
import android.provider.MediaStore;
import android.webkit.MimeTypeMap;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.File;
import java.io.FileInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;

/**
 * Copia un archivo de la app a la carpeta pública Descargas usando MediaStore (Android 10+),
 * sin pedir permisos. Los bytes se copian en nativo: no pasan por el puente de JavaScript.
 */
@CapacitorPlugin(name = "Downloads")
public class DownloadsPlugin extends Plugin {

    @PluginMethod
    public void saveToDownloads(PluginCall call) {
        String uri = call.getString("uri");
        String name = call.getString("name");
        String mime = call.getString("mime");

        if (uri == null || name == null || name.isEmpty()) {
            call.reject("Faltan datos para guardar el archivo.");
            return;
        }

        File src = new File(Uri.parse(uri).getPath());
        if (!src.exists()) {
            call.reject("El archivo ya no existe.");
            return;
        }

        // Si el mime no coincide con la extensión, Android le agrega otra extensión al nombre.
        int dot = name.lastIndexOf('.');
        String byExt = null;
        if (dot > 0 && dot < name.length() - 1) {
            String ext = name.substring(dot + 1).toLowerCase();
            byExt = MimeTypeMap.getSingleton().getMimeTypeFromExtension(ext);
        }
        if (byExt != null) {
            mime = byExt;
        } else if (mime == null || mime.isEmpty()) {
            mime = "application/octet-stream";
        }

        ContentResolver resolver = getContext().getContentResolver();
        ContentValues values = new ContentValues();
        values.put(MediaStore.MediaColumns.DISPLAY_NAME, name);
        values.put(MediaStore.MediaColumns.MIME_TYPE, mime);
        values.put(MediaStore.MediaColumns.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS);
        values.put(MediaStore.MediaColumns.IS_PENDING, 1);

        Uri item = null;
        try {
            item = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values);
            if (item == null) {
                throw new IOException("No se pudo crear el archivo en Descargas.");
            }

            try (InputStream in = new FileInputStream(src); OutputStream out = resolver.openOutputStream(item)) {
                if (out == null) {
                    throw new IOException("No se pudo escribir en Descargas.");
                }
                byte[] buf = new byte[64 * 1024];
                int n;
                while ((n = in.read(buf)) > 0) {
                    out.write(buf, 0, n);
                }
                out.flush();
            }

            ContentValues done = new ContentValues();
            done.put(MediaStore.MediaColumns.IS_PENDING, 0);
            resolver.update(item, done, null, null);

            // Android renombra si ya existía uno igual: devolvemos el nombre final.
            String finalName = name;
            Cursor c = resolver.query(item, new String[] { MediaStore.MediaColumns.DISPLAY_NAME }, null, null, null);
            if (c != null) {
                try {
                    if (c.moveToFirst()) {
                        String n = c.getString(0);
                        if (n != null && !n.isEmpty()) finalName = n;
                    }
                } finally {
                    c.close();
                }
            }

            JSObject ret = new JSObject();
            ret.put("uri", item.toString());
            ret.put("name", finalName);
            call.resolve(ret);
        } catch (Exception e) {
            if (item != null) {
                try {
                    resolver.delete(item, null, null);
                } catch (Exception ignored) {
                    // nada que hacer
                }
            }
            call.reject("No se pudo guardar en Descargas: " + e.getMessage());
        }
    }
}
