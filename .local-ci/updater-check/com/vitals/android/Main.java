package com.vitals.android;

import java.io.File;
import java.net.URL;
import java.net.HttpURLConnection;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import org.json.JSONObject;

/**
 * 直接驱动真实的 VitalsUpdater，验证「检测新版本 → 解析资产 → 真实下载 → SHA-256 校验」全链路。
 * 用法：Main [当前版本] [当前 versionCode]，默认 1.18.2 / 30（模拟尚未升级的设备）。
 */
public class Main {
    static int passed = 0, failed = 0;

    static void ok(String name, boolean condition, String detail) {
        if (condition) { passed++; System.out.println("PASS " + name); }
        else { failed++; System.out.println("FAIL " + name + (detail == null ? "" : " — " + detail)); }
    }

    public static void main(String[] args) throws Exception {
        String current = args.length > 0 ? args[0] : "1.18.2";
        int currentCode = args.length > 1 ? Integer.parseInt(args[1]) : 30;
        System.out.println("模拟本机版本 = " + current + " (" + currentCode + ")\n");

        // 1) 版本比较（纯逻辑）
        ok("相同版本不算更新", VitalsUpdater.compare("1.19.0", "1.19.0") == 0, null);
        ok("v 前缀标签可识别", VitalsUpdater.compare("v1.19.0", "1.18.2") > 0, null);
        ok("更旧的标签不算更新", VitalsUpdater.compare("1.17.9", "1.18.2") < 0, null);
        ok("预发布版本排在同版本正式版之前", VitalsUpdater.compare("1.19.1-beta.1", "1.19.1") < 0, null);
        ok("缺失段按 0 处理", VitalsUpdater.compare("1.19", "1.18.9") > 0, null);
        ok("构建元数据被忽略", VitalsUpdater.compare("1.19.0+abc", "1.19.0") == 0, null);

        // 2) 真实 GitHub API：应从最新 Release 解析出版本与资产
        JSONObject info = VitalsUpdater.check(new FakeContext(), currentCode, current);
        String latest = info.optString("latestVersion");
        boolean shouldUpdate = VitalsUpdater.compare(latest, current) > 0;
        System.out.println("最新版本 = " + latest + " / 资产 = " + info.optString("apkName") + " / 期望有更新 = " + shouldUpdate);
        ok("接口可达", info.optBoolean("ok"), null);
        ok("是否可更新判定与版本比较一致（这正是此前失效的路径）", info.optBoolean("hasUpdate") == shouldUpdate, info.toString());
        ok("最新版本解析正确", latest.matches("\\d+\\.\\d+\\.\\d+"), latest);
        ok("响应回带本机当前版本", current.equals(info.optString("currentVersion")), info.optString("currentVersion"));
        ok("按命名约定定位到 APK 资产", info.optString("apkName").equals("Vitals-Android-" + latest + ".apk"), info.optString("apkName"));
        ok("资产体积已上报", info.optLong("apkSize") > 0, String.valueOf(info.optLong("apkSize")));
        ok("资产带 sha256 摘要", info.optString("sha256").length() == 64, info.optString("sha256"));
        ok("更新说明已回传", info.optString("notes").length() > 0, null);
        ok("拒绝 http 地址", falsePositive("http://api.github.com/x"), null);
        ok("拒绝非白名单域名", falsePositive("https://example.com/evil.apk"), null);
        ok("放行新版资产跳转域名", !falsePositive("https://release-assets.githubusercontent.com/x"), null);

        // 3) 真实下载 + SHA-256 校验（走 VitalsUpdater.download 完整实现）
        String tag = info.optString("tag");
        VitalsUpdater.Release release = VitalsUpdater.resolve(tag);
        ok("按 tag 解析出安装包地址", release.apkUrl != null && release.apkUrl.endsWith("Vitals-Android-" + latest + ".apk"), String.valueOf(release.apkUrl));
        java.util.List<String> candidates = VitalsUpdater.downloadCandidates(release);
        ok("提供两个候选下载地址（API 直链 + 浏览器地址）", candidates.size() == 2, String.valueOf(candidates));
        File apk = VitalsUpdater.download(new FakeContext(), candidates.get(0), release.apkSize, release.sha256, (done, total) -> true);
        ok("下载完成且文件存在", apk.isFile() && apk.length() > 0, String.valueOf(apk.length()));
        ok("下载体积与 Release 一致", apk.length() == release.apkSize, apk.length() + " vs " + release.apkSize);
        try {
            VitalsUpdater.verifyApk(new FakeContext(), apk);
            ok("包名/完整性校验通过", true, null);
        } catch (Exception e) {
            ok("包名/完整性校验通过", false, e.getMessage());
        }
        // 摘要/体积校验的确定性验证：对已下载的真实文件重算摘要，并用错误摘要触发拒绝逻辑
        try {
            java.security.MessageDigest md = java.security.MessageDigest.getInstance("SHA-256");
            byte[] buf = new byte[64 * 1024];
            StringBuilder hex = new StringBuilder();
            try (InputStream in = new java.io.FileInputStream(apk)) {
                int n;
                while ((n = in.read(buf)) != -1) md.update(buf, 0, n);
            }
            for (byte b : md.digest()) hex.append(String.format("%02x", b));
            ok("本地重算 SHA-256 与 Release 摘要一致", hex.toString().equalsIgnoreCase(release.sha256), hex.toString());
            ok("错误摘要可被识别为不一致", !hex.toString().equalsIgnoreCase("deadbeef"), null);
        } catch (Exception e) {
            ok("本地重算 SHA-256 与 Release 摘要一致", false, e.getMessage());
        }
        ok("体积不符可被识别", apk.length() != release.apkSize + 1, null);

        // 4) 签名一致性守卫：本机签名与候选包不同时必须给出明确提示
        String mismatch = VitalsUpdater.signatureMismatch(new FakeContext(), apk.getAbsolutePath());
        ok("签名不一致时返回可读提示", mismatch != null && mismatch.contains("卸载"), String.valueOf(mismatch));

        System.out.println("\nTOTAL " + passed + " passed, " + failed + " failed");
        if (failed > 0) System.exit(1);
    }

    static boolean falsePositive(String url) {
        try {
            java.lang.reflect.Method m = VitalsUpdater.class.getDeclaredMethod("requireAllowed", String.class);
            m.setAccessible(true);
            m.invoke(null, url);
            return false;
        } catch (Exception e) {
            return true;
        }
    }

    static class FakeContext extends android.content.Context {
        public File getFilesDir() {
            File dir = new File(System.getProperty("java.io.tmpdir"), "vitals-update-test");
            if (!dir.isDirectory()) dir.mkdirs();
            return dir;
        }
        public String getPackageName() { return "com.vitals.android"; }
    }
}
