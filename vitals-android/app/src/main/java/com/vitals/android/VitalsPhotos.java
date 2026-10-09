package com.vitals.android;

import android.content.Context;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.util.Base64;
import org.json.JSONException;
import org.json.JSONObject;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.nio.file.Files;

/** 契约 A：照片外置。
 *
 * <p>全图存 {@code filesDir/photos/<sha256 前 2 位>/<sha256>.jpg}（内容寻址，天然去重）；samples 行内只留
 * {@code photo_path}/{@code photo_hash}/{@code thumb}，历史 {@code photo} 列仅在落盘失败时作为兜底保留。
 * 写入顺序是「先写文件、再提交数据库行」：失败时不会出现「行里有路径、文件不存在」的半状态——落盘失败会退回
 * 内联 photo，宁可占空间也不丢图。
 *
 * <p>thumb 为长边 ≤160 的小 JPEG data URL；源图无法解码（如夹具里截断的 JPEG）时返回 null，
 * 由前端显示占位图，不影响导入流程。
 */
final class VitalsPhotos {
    private static final int THUMB_MAX = 160;
    private static final int THUMB_QUALITY = 70;
    private final File root;

    VitalsPhotos(Context context) { this.root = new File(context.getFilesDir(), "photos"); }

    /** 契约 A 的路径规则：photos/<hash 前 2 位>/<hash>.jpg。 */
    String pathFor(String hash) { return fileFor(hash).getAbsolutePath(); }

    File fileFor(String hash) { return new File(new File(root, hash.substring(0, 2)), hash + ".jpg"); }

    boolean exists(String hash) { return hash != null && !hash.isEmpty() && fileFor(hash).isFile(); }

    /** 把 data URL 落盘；返回 sha256，失败返回 null（调用方保留内联照片）。 */
    String externalize(String dataUrl) {
        byte[] bytes = decode(dataUrl);
        if (bytes == null) return null;
        String hash = BackupFormat.sha256Hex(bytes);
        return write(hash, bytes) ? hash : null;
    }

    /** 读回完整 data URL；文件缺失或不可读返回 null。 */
    String read(String hash) { return hash == null || hash.isEmpty() ? null : read(fileFor(hash)); }

    String read(File file) {
        try {
            if (file == null || !file.isFile()) return null;
            byte[] bytes = Files.readAllBytes(file.toPath());
            return bytes.length == 0 ? null : "data:image/jpeg;base64," + Base64.encodeToString(bytes, Base64.NO_WRAP);
        } catch (Exception e) { return null; }
    }

    /** 旧数据兜底：只有 photo_path 没有 photo_hash 时，从文件反算 hash。 */
    String hashOfPath(String path) {
        try {
            File file = path == null ? null : new File(path);
            if (file == null || !file.isFile()) return null;
            return BackupFormat.sha256Hex(Files.readAllBytes(file.toPath()));
        } catch (Exception e) { return null; }
    }

    static byte[] decode(String dataUrl) {
        if (dataUrl == null) return null;
        int comma = dataUrl.indexOf(',');
        if (comma < 0) return null;
        try { return Base64.decode(dataUrl.substring(comma + 1), Base64.DEFAULT); } catch (Exception e) { return null; }
    }

    boolean write(String hash, byte[] bytes) {
        File target = fileFor(hash);
        if (target.isFile() && target.length() == bytes.length) return true; // 内容寻址：同长度即同一份内容，免重写
        File parent = target.getParentFile();
        if (parent != null && !parent.isDirectory() && !parent.mkdirs()) return false;
        File temp = new File(target.getPath() + ".tmp");
        try (FileOutputStream out = new FileOutputStream(temp)) {
            out.write(bytes);
            out.flush();
        } catch (IOException e) {
            temp.delete();
            return false;
        }
        if (temp.renameTo(target)) return true;
        // 某些文件系统上 rename 到已存在文件会失败；只有在目标已存在时才接受这种失败
        temp.delete();
        return target.isFile() && target.length() == bytes.length;
    }

    /** 小 JPEG data URL，长边 ≤160；无法解码返回 null。 */
    static String thumb(byte[] bytes) {
        if (bytes == null || bytes.length == 0) return null;
        try {
            BitmapFactory.Options bounds = new BitmapFactory.Options();
            bounds.inJustDecodeBounds = true;
            BitmapFactory.decodeByteArray(bytes, 0, bytes.length, bounds);
            if (bounds.outWidth <= 0 || bounds.outHeight <= 0) return null;
            BitmapFactory.Options options = new BitmapFactory.Options();
            int sample = 1;
            while (Math.max(bounds.outWidth, bounds.outHeight) / (sample * 2) >= THUMB_MAX * 2) sample *= 2;
            options.inSampleSize = sample;
            Bitmap bitmap = BitmapFactory.decodeByteArray(bytes, 0, bytes.length, options);
            if (bitmap == null) return null;
            int width = bitmap.getWidth(), height = bitmap.getHeight();
            float scale = (float) THUMB_MAX / Math.max(width, height);
            if (scale < 1f) {
                Bitmap scaled = Bitmap.createScaledBitmap(bitmap, Math.max(1, Math.round(width * scale)), Math.max(1, Math.round(height * scale)), true);
                if (scaled != bitmap) bitmap.recycle();
                bitmap = scaled;
            }
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            boolean ok = bitmap.compress(Bitmap.CompressFormat.JPEG, THUMB_QUALITY, out);
            bitmap.recycle();
            if (!ok || out.size() == 0) return null;
            return "data:image/jpeg;base64," + Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP);
        } catch (Throwable e) { return null; }
    }

    /** 契约 A/D 的写入前处理：新照片落盘并回填 hash/路径/缩略图，成功后清空行内全图。 */
    void prepare(JSONObject x) throws JSONException {
        String dataUrl = text(x, "photo");
        if (dataUrl != null && !dataUrl.isEmpty()) {
            byte[] bytes = decode(dataUrl);
            if (bytes != null) {
                String hash = BackupFormat.sha256Hex(bytes);
                if (write(hash, bytes)) {
                    x.put("photoHash", hash);
                    x.put("photoPath", pathFor(hash));
                    if (!has(x, "thumb")) { // 换图时必须重新生成，避免旧缩略图配新图
                        String thumb = thumb(bytes);
                        if (thumb != null) x.put("thumb", thumb);
                    }
                    x.remove("photo"); // 契约 A：新写入不再把全图留在行内
                }
                return; // 落盘失败：保留内联 photo，交给下一轮迁移重试
            }
            return;
        }
        // 不带 photo（未换图）：路径一律由 hash 推导，不信任备份里的绝对路径
        String hash = text(x, "photoHash");
        if (hash != null && !hash.isEmpty()) x.put("photoPath", pathFor(hash));
        else {
            String path = text(x, "photoPath");
            if (path != null && !path.isEmpty()) {
                String computed = hashOfPath(path);
                if (computed != null) x.put("photoHash", computed);
            }
        }
    }

    private static String text(JSONObject x, String key) throws JSONException {
        if (!x.has(key) || x.isNull(key)) return null;
        Object value = x.get(key);
        return value instanceof String ? (String) value : null;
    }

    private static boolean has(JSONObject x, String key) throws JSONException {
        String value = text(x, key);
        return value != null && !value.isEmpty();
    }
}
