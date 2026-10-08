package com.vitals.android;

import android.content.Context;
import android.content.SharedPreferences;
import android.net.Uri;
import androidx.documentfile.provider.DocumentFile;
import org.json.JSONObject;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.text.SimpleDateFormat;
import java.util.Arrays;
import java.util.Comparator;
import java.util.Date;
import java.util.Locale;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.TimeUnit;

/** Writes recoverable JSON backups to a user-approved directory in shared internal storage. */
final class BackupManager implements AutoCloseable {
    interface Listener { void onResult(boolean ok, String message); }

    private static final String PREFS = "vitals_backup";
    private static final String KEY_TREE_URI = "tree_uri";
    private static final String KEY_LAST_SUCCESS = "last_success";
    private static final int RETAIN_COUNT = 30;
    private static final long AUTO_DELAY_SECONDS = 5;
    private static final long STARTUP_BACKUP_INTERVAL_MS = 24L * 60L * 60L * 1000L;

    private final Context context;
    private final VitalsDbHelper database;
    private final SharedPreferences preferences;
    private final ScheduledExecutorService executor = Executors.newSingleThreadScheduledExecutor();
    private ScheduledFuture<?> pending;

    BackupManager(Context context, VitalsDbHelper database) {
        this.context = context.getApplicationContext();
        this.database = database;
        this.preferences = this.context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    synchronized void configure(Uri treeUri) throws Exception {
        if (treeUri == null) throw new IllegalArgumentException("未选择备份目录");
        DocumentFile directory = DocumentFile.fromTreeUri(context, treeUri);
        if (directory == null || !directory.exists() || !directory.isDirectory() || !directory.canWrite()) {
            throw new IllegalArgumentException("所选目录不可写，请重新选择一体机内部存储目录");
        }
        preferences.edit().putString(KEY_TREE_URI, treeUri.toString()).apply();
    }

    synchronized void clear() {
        if (pending != null) pending.cancel(false);
        preferences.edit().remove(KEY_TREE_URI).apply();
    }

    JSONObject status() throws Exception {
        String raw = preferences.getString(KEY_TREE_URI, "");
        JSONObject result = new JSONObject()
            .put("configured", !raw.isEmpty())
            .put("lastSuccess", preferences.getLong(KEY_LAST_SUCCESS, 0));
        if (!raw.isEmpty()) {
            Uri uri = Uri.parse(raw);
            DocumentFile directory = DocumentFile.fromTreeUri(context, uri);
            result.put("directory", directory != null && directory.getName() != null ? directory.getName() : "已选择目录");
            result.put("writable", directory != null && directory.exists() && directory.canWrite());
        }
        return result;
    }

    synchronized void scheduleAfterChange() {
        if (!isConfigured()) return;
        if (pending != null) pending.cancel(false);
        pending = executor.schedule(() -> writeBackup(null), AUTO_DELAY_SECONDS, TimeUnit.SECONDS);
    }

    synchronized void scheduleStartupIfDue() {
        long last = preferences.getLong(KEY_LAST_SUCCESS, 0);
        if (isConfigured() && System.currentTimeMillis() - last >= STARTUP_BACKUP_INTERVAL_MS) {
            if (pending != null) pending.cancel(false);
            pending = executor.schedule(() -> writeBackup(null), 2, TimeUnit.SECONDS);
        }
    }

    void backupNow(Listener listener) {
        executor.execute(() -> writeBackup(listener));
    }

    private boolean isConfigured() {
        return !preferences.getString(KEY_TREE_URI, "").isEmpty();
    }

    private void writeBackup(Listener listener) {
        String raw = preferences.getString(KEY_TREE_URI, "");
        if (raw.isEmpty()) { notify(listener, false, "请先选择一体机内部备份目录"); return; }
        DocumentFile temp = null;
        try {
            Uri treeUri = Uri.parse(raw);
            DocumentFile directory = DocumentFile.fromTreeUri(context, treeUri);
            if (directory == null || !directory.exists() || !directory.canWrite()) throw new IllegalStateException("备份目录不可写，请重新选择");

            String stamp = new SimpleDateFormat("yyyy-MM-dd_HH-mm-ss", Locale.ROOT).format(new Date());
            String finalName = "vitals-backup-" + stamp + ".json";
            temp = directory.createFile("application/json", finalName + ".tmp");
            if (temp == null) throw new IllegalStateException("无法创建备份文件");
            byte[] bytes = database.exportBackup().toString(2).getBytes(StandardCharsets.UTF_8);
            try (OutputStream output = context.getContentResolver().openOutputStream(temp.getUri(), "wt")) {
                if (output == null) throw new IllegalStateException("无法写入备份文件");
                output.write(bytes);
                output.flush();
            }
            if (!temp.renameTo(finalName)) throw new IllegalStateException("备份文件写入完成但重命名失败");
            temp = null;
            preferences.edit().putLong(KEY_LAST_SUCCESS, System.currentTimeMillis()).apply();
            removeOldBackups(directory);
            notify(listener, true, "备份已保存到一体机内部存储：" + finalName);
        } catch (Exception error) {
            if (temp != null) temp.delete();
            notify(listener, false, "自动备份失败：" + (error.getMessage() == null ? "未知错误" : error.getMessage()));
        }
    }

    private void removeOldBackups(DocumentFile directory) {
        DocumentFile[] files = Arrays.stream(directory.listFiles())
            .filter(file -> file.isFile() && file.getName() != null && file.getName().startsWith("vitals-backup-") && file.getName().endsWith(".json"))
            .sorted(Comparator.comparingLong(DocumentFile::lastModified).reversed())
            .toArray(DocumentFile[]::new);
        for (int index = RETAIN_COUNT; index < files.length; index++) files[index].delete();
    }

    private static void notify(Listener listener, boolean ok, String message) {
        if (listener != null) listener.onResult(ok, message);
    }

    @Override public synchronized void close() {
        if (pending != null) pending.cancel(false);
        executor.shutdownNow();
    }
}
