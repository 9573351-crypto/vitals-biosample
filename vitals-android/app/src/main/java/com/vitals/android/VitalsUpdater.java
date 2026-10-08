package com.vitals.android;

import android.content.Context;
import android.os.Build;
import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Locale;

/**
 * 内置更新：以本仓库的 GitHub 公开 Release 为唯一升级源。
 * <p>
 * 安全边界：只允许 https 且主机在 {@link #ALLOWED_HOSTS} 之内（API 与 Release 下载域名），
 * 校验 APK 包名与当前应用一致，并在 Release 提供校验摘要时校验 SHA-256。
 * 所有网络与磁盘操作都由调用方放到工作线程执行，本类不触碰 UI 线程。
 */
final class VitalsUpdater {

    static final String REPO = "9573351-crypto/vitals-biosample";
    private static final String API_LATEST = "https://api.github.com/repos/" + REPO + "/releases/latest";
    private static final String API_TAG = "https://api.github.com/repos/" + REPO + "/releases/tags/";
    private static final String ACCEPT = "application/vnd.github+json";
    private static final String USER_AGENT = "Vitals-Android-Updater";
    private static final int CONNECT_TIMEOUT_MS = 15000;
    // GitHub Release 资产在国内网络下经常只有几十 KB/s，读超时过短会导致大包必然失败
    private static final int READ_TIMEOUT_MS = 90000;
    private static final long MAX_APK_BYTES = 200L * 1024 * 1024;
    /**
     * Release 资产下载的实际跳转目标会随 GitHub 基础设施变化：
     * 曾经的 objects.githubusercontent.com，现在是 release-assets.githubusercontent.com。
     * 两者都必须放行，否则下载会在重定向处被白名单拦下（表现为“下载失败/连接超时”）。
     */
    private static final String[] ALLOWED_HOSTS = {
            "api.github.com", "github.com", "codeload.github.com",
            "objects.githubusercontent.com", "release-assets.githubusercontent.com",
            "github-releases.githubusercontent.com", "github-production-release-asset-2e65be.s3.amazonaws.com"
    };

    private VitalsUpdater() {}

    /* ==================== 数据结构 ==================== */

    static final class Release {
        String tag, version, notes, pageUrl, publishedAt, apkUrl, apkName, sha256;
        /** 资产在 API 上的地址，可直接跳到签名后的 CDN 直链（重定向更少） */
        String apiUrl;
        long apkSize;
    }

    /** 按 tag 解析出的候选下载地址：API 直链优先，其次浏览器下载地址。 */
    static java.util.List<String> downloadCandidates(Release release) {
        java.util.List<String> list = new java.util.ArrayList<>();
        if (release == null) return list;
        if (release.apiUrl != null && !release.apiUrl.isEmpty()) list.add(release.apiUrl);
        if (release.apkUrl != null && !release.apkUrl.isEmpty() && !release.apkUrl.equals(release.apiUrl)) list.add(release.apkUrl);
        return list;
    }

    interface Progress {
        /**
         * @return false 表示调用方要求取消下载
         */
        boolean onProgress(long downloaded, long total);
    }

    /* ==================== 检查更新 ==================== */

    static JSONObject check(Context context, int currentVersionCode, String currentVersionName) throws IOException {
        try {
            JSONObject release = new JSONObject(fetch(API_LATEST, null));
            return checkRelease(context, release, currentVersionCode, currentVersionName);
        } catch (HttpStatus e) {
            if (e.code == 404) {
                // 仓库还没有任何 Release：视为已是最新，而不是报错。
                try {
                    return new JSONObject().put("ok", true).put("hasUpdate", false)
                            .put("currentVersion", currentVersionName).put("currentVersionCode", currentVersionCode)
                            .put("latestVersion", currentVersionName).put("tag", "").put("notes", "")
                            .put("message", "仓库尚未发布任何版本");
                } catch (Exception impossible) {
                    throw new IOException(impossible);
                }
            }
            throw new IOException(describe(e));
        } catch (org.json.JSONException e) {
            throw new IOException("版本信息解析失败：" + e.getMessage(), e);
        } catch (IOException e) {
            // 连接超时 / DNS / TLS / 被拦截等：给出可据此排查的说明
            throw new IOException(networkMessage(e), e);
        }
    }

    /**
     * 按 tag 重新拉取 Release 并解析安装包地址：桥接口只接受 tag，不接受前端传入的 URL。
     */
    static Release resolve(String tag) throws IOException {
        if (tag == null || !tag.matches("[-a-zA-Z0-9._+]+")) throw new IOException("版本标签无效");
        try {
            Release r = parse(new JSONObject(fetch(API_TAG + tag, null)));
            if (r.apkUrl == null) throw new IOException("该版本没有提供 APK 安装包");
            return r;
        } catch (org.json.JSONException e) {
            throw new IOException("版本信息解析失败：" + e.getMessage(), e);
        } catch (HttpStatus e) {
            throw new IOException(describe(e));
        } catch (IOException e) {
            throw new IOException(networkMessage(e), e);
        }
    }

    private static JSONObject checkRelease(Context context, JSONObject release, int currentVersionCode, String currentVersionName) throws IOException {
        try {
            Release r = parse(release);
            boolean newer = compare(r.version, currentVersionName) > 0;
            JSONObject out = new JSONObject()
                    .put("ok", true)
                    .put("hasUpdate", newer)
                    .put("tag", nullToEmpty(r.tag))
                    .put("latestVersion", nullToEmpty(r.version))
                    .put("currentVersion", nullToEmpty(currentVersionName))
                    .put("currentVersionCode", currentVersionCode)
                    .put("notes", nullToEmpty(r.notes))
                    .put("pageUrl", nullToEmpty(r.pageUrl))
                    .put("publishedAt", nullToEmpty(r.publishedAt))
                    .put("apkName", nullToEmpty(r.apkName))
                    .put("apkSize", r.apkSize)
                    .put("sha256", nullToEmpty(r.sha256))
                    .put("hasApk", r.apkUrl != null);
            if (newer && r.apkUrl == null) {
                out.put("message", "最新版本未提供 APK 安装包，请前往发布页手动下载");
            } else if (newer) {
                String installed = installedVersion(context);
                if (installed != null && !installed.equals(r.version)) {
                    out.put("installedVersion", installed);
                    out.put("note", "本机已安装的版本为 " + installed + "，覆盖安装到 " + r.version + " 后将无法回退到更高版本号");
                }
            }
            return out;
        } catch (org.json.JSONException e) {
            throw new IOException("版本信息解析失败：" + e.getMessage(), e);
        }
    }

    /* ==================== 下载 ==================== */

    private static final int DOWNLOAD_ATTEMPTS = 3;

    static File download(Context context, String apkUrl, long expectedSize, String expectedSha256, Progress progress) throws IOException {
        requireAllowed(apkUrl);
        if (expectedSha256 == null || expectedSha256.isEmpty()) {
            expectedSha256 = sha256OfReleaseAsset(apkUrl);
        }
        File dir = new File(context.getFilesDir(), "updates");
        if (!dir.isDirectory() && !dir.mkdirs() && !dir.isDirectory()) throw new IOException("无法创建更新缓存目录");
        File temp = new File(dir, "vitals-update.apk.part");
        File target = new File(dir, "vitals-update.apk");
        IOException last = null;
        // GitHub 资产在部分网络下首次连接常超时，重试几次可显著提高成功率；已下载到的字节在重试时丢弃重来。
        for (int attempt = 1; attempt <= DOWNLOAD_ATTEMPTS; attempt++) {
            try {
                return attemptDownload(apkUrl, temp, target, expectedSize, expectedSha256, progress);
            } catch (IOException e) {
                last = e;
                if (e.getMessage() != null && e.getMessage().contains("已取消")) throw e; // 用户取消不重试
                if (attempt < DOWNLOAD_ATTEMPTS) {
                    try {
                        Thread.sleep(1500L * attempt);
                    } catch (InterruptedException interrupted) {
                        Thread.currentThread().interrupt();
                        throw new IOException("下载已中断", interrupted);
                    }
                }
            }
        }
        throw last == null ? new IOException("下载失败") : last;
    }

    private static File attemptDownload(String apkUrl, File temp, File target, long expectedSize, String expectedSha256, Progress progress) throws IOException {
        if (temp.exists() && !temp.delete()) throw new IOException("无法清理上次未完成的下载文件");
        HttpURLConnection conn = open(apkUrl, "application/octet-stream", true);
        try {
            int code = conn.getResponseCode();
            if (code < 200 || code >= 300) throw new IOException("下载失败：HTTP " + code);
            long total = expectedSize > 0 ? expectedSize : conn.getContentLengthLong();
            if (total <= 0) total = -1;
            if (total > MAX_APK_BYTES) throw new IOException("安装包体积异常（超过 200MB），已中止");
            MessageDigest digest;
            try {
                digest = MessageDigest.getInstance("SHA-256");
            } catch (Exception e) {
                digest = null;
            }
            long read = 0;
            byte[] buffer = new byte[64 * 1024];
            try (InputStream in = conn.getInputStream(); FileOutputStream out = new FileOutputStream(temp)) {
                int n;
                while ((n = in.read(buffer)) != -1) {
                    out.write(buffer, 0, n);
                    if (digest != null) digest.update(buffer, 0, n);
                    read += n;
                    if (read > MAX_APK_BYTES) throw new IOException("安装包体积异常（超过 200MB），已中止");
                    if (progress != null && !progress.onProgress(read, total)) throw new IOException("下载已取消");
                }
                out.flush();
                out.getFD().sync();
            }
            if (read <= 0) throw new IOException("下载内容为空，请稍后重试");
            if (expectedSize > 0 && read != expectedSize) throw new IOException("安装包不完整：应为 " + expectedSize + " 字节，实际 " + read + " 字节");
            if (expectedSha256 != null && !expectedSha256.isEmpty() && digest != null) {
                String actual = toHex(digest.digest());
                if (!actual.equalsIgnoreCase(expectedSha256)) throw new IOException("校验和不匹配，安装包可能损坏或被篡改，已中止安装");
            }
            if (target.exists() && !target.delete()) throw new IOException("无法覆盖上次下载的安装包");
            if (!temp.renameTo(target)) {
                copy(temp, target);
                if (!temp.delete()) temp.deleteOnExit();
            }
            return target;
        } finally {
            conn.disconnect();
        }
    }

    private static void copy(File from, File to) throws IOException {
        try (InputStream in = new java.io.FileInputStream(from); FileOutputStream out = new FileOutputStream(to)) {
            byte[] buffer = new byte[64 * 1024];
            int n;
            while ((n = in.read(buffer)) != -1) out.write(buffer, 0, n);
        }
    }

    /**
     * 从该 Release 的校验摘要里取出安装包的 SHA-256；取不到时返回 null（此时仅校验包名与体积）。
     */
    private static String sha256OfReleaseAsset(String apkUrl) {
        if (apkUrl == null || !apkUrl.startsWith("https://github.com/") || !apkUrl.contains("/releases/download/")) return null;
        String rest = apkUrl.substring("https://github.com/".length());
        String[] parts = rest.split("/");
        if (parts.length < 5) return null;
        try {
            JSONObject release = new JSONObject(fetch(API_TAG + parts[2] + "/" + parts[3], null));
            JSONArray assets = release.optJSONArray("assets");
            if (assets == null) return null;
            String name = parts[parts.length - 1];
            for (int i = 0; i < assets.length(); i++) {
                JSONObject asset = assets.getJSONObject(i);
                if (!name.equals(asset.optString("name"))) continue;
                String digest = asset.optString("digest", "");
                if (digest.startsWith("sha256:")) return digest.substring(7);
            }
        } catch (Exception ignored) {
            // 拿不到摘要不影响主流程，包名与体积校验仍然生效。
        }
        return null;
    }

    /* ==================== 安装前置校验 ==================== */

    static String verifyApk(Context context, File apk) throws IOException {
        if (apk == null || !apk.isFile()) throw new IOException("安装包不存在，请重新下载");
        if (apk.length() <= 0) throw new IOException("安装包为空，请重新下载");
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            android.content.pm.PackageInfo info = context.getPackageManager()
                    .getPackageArchiveInfo(apk.getAbsolutePath(), android.content.pm.PackageManager.PackageInfoFlags.of(0));
            if (info == null) throw new IOException("安装包已损坏，无法读取包信息");
            if (!context.getPackageName().equals(info.packageName)) throw new IOException("安装包包名不匹配，已中止安装");
        }
        return apk.getAbsolutePath();
    }

    @SuppressWarnings("deprecation") // getPackageInfo(String,int) 在 API 33+ 过时，兼容 minSdk 26 时仍可用
    static String installedVersion(Context context) {
        try {
            android.content.pm.PackageInfo info = context.getPackageManager().getPackageInfo(context.getPackageName(), 0);
            return info.versionName;
        } catch (Exception e) {
            return null;
        }
    }

    /**
     * 覆盖安装要求新旧 APK 使用同一签名。这里在交给系统安装器之前先比对签名，
     * 避免系统只抛出“应用未安装”这类无法定位的失败。
     *
     * @return 校验通过返回 null，否则返回面向用户的说明
     */
    @SuppressWarnings("deprecation") // GET_SIGNATURES 在 API 28+ 标记过时，但为兼容 minSdk 26 仍用它对签名做整体比较
    static String signatureMismatch(Context context, String apkPath) {
        try {
            android.content.pm.PackageManager pm = context.getPackageManager();
            android.content.pm.PackageInfo installed = pm.getPackageInfo(context.getPackageName(), android.content.pm.PackageManager.GET_SIGNATURES);
            android.content.pm.PackageInfo candidate = pm.getPackageArchiveInfo(apkPath, android.content.pm.PackageManager.GET_SIGNATURES);
            if (candidate == null || candidate.signatures == null || candidate.signatures.length == 0) return null;
            if (installed == null || installed.signatures == null || installed.signatures.length == 0) return null;
            for (android.content.pm.Signature a : installed.signatures) {
                for (android.content.pm.Signature b : candidate.signatures) if (a.equals(b)) return null;
            }
            return "更新包与本机应用的签名不一致，系统会拒绝覆盖安装。请先导出备份后卸载旧版本再安装，"
                    + "或改用与旧版本相同签名的构建（发布方需固定签名）。";
        } catch (Exception e) {
            return null; // 取不到签名信息时不阻塞安装，交给系统安装器判断
        }
    }

    /* ==================== 版本比较 ==================== */

    /**
     * 比较版本号：忽略 v 前缀、预发布后缀（-beta.1）与构建元数据；各段按数值比较，缺失段按 0，预发布视为更旧。
     */
    static int compare(String latest, String current) {
        String a = latest == null ? "" : latest.trim();
        String b = current == null ? "" : current.trim();
        if (a.startsWith("v") || a.startsWith("V")) a = a.substring(1);
        if (b.startsWith("v") || b.startsWith("V")) b = b.substring(1);
        String apre = "", bpre = "";
        int ai = a.indexOf('-');
        if (ai >= 0) { apre = a.substring(ai + 1); a = a.substring(0, ai); }
        int bi = b.indexOf('-');
        if (bi >= 0) { bpre = b.substring(bi + 1); b = b.substring(0, bi); }
        int aPlus = a.indexOf('+');
        if (aPlus >= 0) a = a.substring(0, aPlus);
        int bPlus = b.indexOf('+');
        if (bPlus >= 0) b = b.substring(0, bPlus);
        String[] ap = a.split("\\.");
        String[] bp = b.split("\\.");
        for (int i = 0; i < Math.max(ap.length, bp.length); i++) {
            int x = part(ap, i), y = part(bp, i);
            if (x != y) return x > y ? 1 : -1;
        }
        if (apre.isEmpty() && bpre.isEmpty()) return 0;
        if (apre.isEmpty()) return 1;
        if (bpre.isEmpty()) return -1;
        return apre.compareTo(bpre) > 0 ? 1 : (apre.equals(bpre) ? 0 : -1);
    }

    private static int part(String[] parts, int index) {
        if (index >= parts.length) return 0;
        try {
            return Integer.parseInt(parts[index].replaceAll("[^0-9]", ""));
        } catch (Exception e) {
            return 0;
        }
    }

    /* ==================== Release 字段解析 ==================== */

    private static Release parse(JSONObject release) throws org.json.JSONException {
        Release r = new Release();
        r.tag = release.optString("tag_name", "");
        r.notes = release.optString("body", "");
        r.pageUrl = release.optString("html_url", "");
        r.publishedAt = release.optString("published_at", "");
        r.version = r.tag.startsWith("v") || r.tag.startsWith("V") ? r.tag.substring(1) : r.tag;
        JSONArray assets = release.optJSONArray("assets");
        JSONObject fallback = null;
        if (assets != null) {
            String norm = r.version.toLowerCase(Locale.ROOT);
            for (int i = 0; i < assets.length(); i++) {
                JSONObject asset = assets.optJSONObject(i);
                if (asset == null) continue;
                String name = asset.optString("name", "");
                if (!name.toLowerCase(Locale.ROOT).endsWith(".apk")) continue;
                String lower = name.toLowerCase(Locale.ROOT);
                if (fallback == null) fallback = asset;
                // 约定命名 Vitals-Android-<version>.apk，命中即优先
                if (lower.contains(norm)) {
                    fill(r, asset, name);
                    return r;
                }
            }
        }
        if (fallback != null) fill(r, fallback, fallback.optString("name", ""));
        return r;
    }

    private static void fill(Release r, JSONObject asset, String name) {
        r.apkUrl = asset.optString("browser_download_url", null);
        if (r.apkUrl != null && r.apkUrl.isEmpty()) r.apkUrl = null;
        r.apiUrl = asset.optString("url", null);
        if (r.apiUrl != null && r.apiUrl.isEmpty()) r.apiUrl = null;
        r.apkName = name;
        r.apkSize = asset.optLong("size", 0);
        String digest = asset.optString("digest", "");
        if (digest.startsWith("sha256:")) r.sha256 = digest.substring(7);
    }

    /* ==================== HTTP ==================== */

    private static String fetch(String url, String accept) throws IOException {
        HttpURLConnection conn = open(url, accept == null ? ACCEPT : accept, false);
        try {
            int code = conn.getResponseCode();
            if (code < 200 || code >= 300) throw new HttpStatus(code);
            return read(conn.getInputStream());
        } finally {
            conn.disconnect();
        }
    }

    private static HttpURLConnection open(String url, String accept, boolean download) throws IOException {
        requireAllowed(url);
        HttpURLConnection conn = (HttpURLConnection) new URL(url).openConnection();
        conn.setConnectTimeout(CONNECT_TIMEOUT_MS);
        conn.setReadTimeout(download ? READ_TIMEOUT_MS : CONNECT_TIMEOUT_MS);
        conn.setInstanceFollowRedirects(false);
        conn.setRequestProperty("Accept", accept);
        conn.setRequestProperty("User-Agent", USER_AGENT);
        // Release 下载会 302 到 objects.githubusercontent.com，只放行白名单主机。
        String current = url;
        for (int hop = 0; hop < 6; hop++) {
            int code = conn.getResponseCode();
            if (code != 301 && code != 302 && code != 303 && code != 307 && code != 308) return conn;
            String location = conn.getHeaderField("Location");
            conn.disconnect();
            if (location == null) throw new IOException("重定向缺少目标地址");
            current = new URL(new URL(current), location).toString();
            conn = (HttpURLConnection) new URL(current).openConnection();
            conn.setConnectTimeout(CONNECT_TIMEOUT_MS);
            conn.setReadTimeout(download ? READ_TIMEOUT_MS : CONNECT_TIMEOUT_MS);
            conn.setInstanceFollowRedirects(false);
            conn.setRequestProperty("Accept", accept);
            conn.setRequestProperty("User-Agent", USER_AGENT);
        }
        conn.disconnect();
        throw new IOException("重定向次数过多");
    }

    private static void requireAllowed(String url) throws IOException {
        if (url == null) throw new IOException("更新地址为空");
        URL parsed;
        try {
            parsed = new URL(url);
        } catch (Exception e) {
            throw new IOException("更新地址无效");
        }
        if (!"https".equalsIgnoreCase(parsed.getProtocol())) throw new IOException("只允许 https 更新地址");
        String host = parsed.getHost() == null ? "" : parsed.getHost().toLowerCase(Locale.ROOT);
        for (String allowed : ALLOWED_HOSTS) if (host.equals(allowed)) return;
        throw new IOException("更新地址不在允许的域名内：" + host);
    }

    /** 把网络异常翻译成用户能据此判断原因的提示，避免只说一句“检查更新失败”。 */
    private static String networkMessage(Exception e) {
        Throwable cause = e;
        while (cause.getCause() != null && cause.getCause() != cause) cause = cause.getCause();
        String text = cause.getMessage() == null ? cause.getClass().getSimpleName() : cause.getMessage();
        if (cause instanceof java.net.SocketTimeoutException) return "连接 GitHub 超时，请检查本机网络或代理后重试";
        if (cause instanceof java.net.UnknownHostException) return "无法解析 api.github.com，请检查网络与 DNS 设置";
        if (cause instanceof javax.net.ssl.SSLException) return "与 GitHub 建立安全连接失败（TLS/证书）：" + text;
        if (cause instanceof java.net.ConnectException) return "无法连接 GitHub：网络可能被拦截，请更换网络后重试";
        return "网络请求失败：" + text;
    }

    private static String read(InputStream in) throws IOException {
        try (InputStream stream = in; ByteArrayOutputStream out = new ByteArrayOutputStream()) {
            byte[] buffer = new byte[16 * 1024];
            int n;
            while ((n = stream.read(buffer)) != -1) out.write(buffer, 0, n);
            return out.toString(StandardCharsets.UTF_8.name());
        }
    }

    private static String describe(HttpStatus e) {
        if (e.code == 403) return "GitHub API 访问受限（可能是请求过于频繁），请稍后重试";
        if (e.code == 404) return "未找到发布记录";
        return "GitHub 返回错误：HTTP " + e.code;
    }

    private static String toHex(byte[] bytes) {
        StringBuilder sb = new StringBuilder(bytes.length * 2);
        for (byte b : bytes) sb.append(String.format(Locale.ROOT, "%02x", b));
        return sb.toString();
    }

    private static String nullToEmpty(String value) {
        return value == null ? "" : value;
    }

    private static final class HttpStatus extends IOException {
        final int code;

        HttpStatus(int code) {
            super("HTTP " + code);
            this.code = code;
        }
    }
}
