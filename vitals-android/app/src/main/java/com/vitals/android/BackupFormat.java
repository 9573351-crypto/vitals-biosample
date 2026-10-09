package com.vitals.android;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.TreeMap;

/** 备份自描述格式（契约 F）：规范化 JSON 与校验和。
 *
 * <p><b>checksum 算法（前端与校验脚本必须逐字一致，夹具见 .local-ci/fixtures，生成脚本 .local-ci/make-backup-fixtures.mjs）：</b>
 * <ol>
 *   <li>{@code canonical(x)}：对象键按 UTF-16 码元升序排序（等价 JS {@code Object.keys(x).sort()}）；
 *       数组保持原顺序；不输出任何多余空白（无空格/换行）；字符串转义与 {@code JSON.stringify} 一致
 *       （只转义 {@code " \ } 与 &lt;0x20 控制字符，{@code /} 与中文等非 ASCII 字符原样输出）；数字按
 *       JS {@code JSON.stringify} 的最短形式（整数值不带小数点，如 4.0 → {@code 4}）；布尔 {@code true/false}；{@code null} 原样。</li>
 *   <li>{@code checksum = "sha256:" + hex(sha256(UTF-8(canonical(samples) + canonical(records) + canonical(settings))))}：
 *       三段分别规范化后<b>直接首尾拼接，不加分隔符</b>。</li>
 *   <li>范式来自 <b>payload 原文</b>（含 {@code records[].recordId}）；导出备份时 recordId 不写入（本机自增行号，导入会重新分配），
 *       因此「导出 → 导入 → 再导出」可得到逐字符等价的规范文本与相同 checksum。</li>
 * </ol>
 * <p><b>不参与 checksum 的字段：</b>{@code app}、{@code appVersion}、{@code exportedAt}、{@code counts}，以及
 * {@code legacyMeta}（旧库 state.s 其余元信息：legacy_s_extra / legacy_migrated_at，属附加审计信息）。
 * 校验和只覆盖 samples + records + settings，以保证与既有夹具（.local-ci/fixtures）和已发布备份兼容。
 * 本类刻意不依赖任何 Android 类，便于在 JVM 离线验证台上直接跑（.local-ci/native-harness）。
 */
final class BackupFormat {
    static final String APP_ID = "vitals-biosample";
    /** 契约 F：备份自描述格式版本（与 SQLite user_version 无关，后者为兼容既有断言保持 3）。 */
    static final int SCHEMA_VERSION = 4;
    private BackupFormat() {}
    /** 规范化 JSON 文本：键排序、数组保序、无多余空白。 */
    static String canonical(Object value) throws JSONException {
        StringBuilder out = new StringBuilder();
        write(value, out);
        return out.toString();
    }
    /** 契约 F：checksum = sha256(canonical(samples)+canonical(records)+canonical(settings))。 */
    static String checksum(JSONObject samples, JSONArray records, JSONObject settings) throws JSONException {
        String payload = canonical(samples) + canonical(records) + canonical(settings);
        return "sha256:" + sha256Hex(payload.getBytes(StandardCharsets.UTF_8));
    }
    static String sha256Hex(byte[] bytes) {
        try {
            byte[] digest = MessageDigest.getInstance("SHA-256").digest(bytes);
            StringBuilder out = new StringBuilder(digest.length * 2);
            for (byte b : digest) { out.append(Character.forDigit((b >> 4) & 0xF, 16)).append(Character.forDigit(b & 0xF, 16)); }
            return out.toString();
        } catch (Exception e) {
            throw new IllegalStateException("SHA-256 不可用", e);
        }
    }
    private static void write(Object value, StringBuilder out) throws JSONException {
        if (value == null || value == JSONObject.NULL) { out.append("null"); return; }
        if (value instanceof JSONObject) {
            JSONObject object = (JSONObject) value;
            TreeMap<String, Object> sorted = new TreeMap<>();
            for (java.util.Iterator<String> keys = object.keys(); keys.hasNext(); ) { String key = keys.next(); sorted.put(key, object.get(key)); }
            out.append('{');
            boolean first = true;
            for (java.util.Map.Entry<String, Object> entry : sorted.entrySet()) {
                if (!first) out.append(',');
                first = false;
                quote(entry.getKey(), out);
                out.append(':');
                write(entry.getValue(), out);
            }
            out.append('}');
            return;
        }
        if (value instanceof JSONArray) {
            JSONArray array = (JSONArray) value;
            out.append('[');
            for (int i = 0; i < array.length(); i++) { if (i > 0) out.append(','); write(array.get(i), out); }
            out.append(']');
            return;
        }
        if (value instanceof String) { quote((String) value, out); return; }
        if (value instanceof Boolean) { out.append(((Boolean) value) ? "true" : "false"); return; }
        if (value instanceof Number) { out.append(number((Number) value)); return; }
        quote(String.valueOf(value), out);
    }
    /** 与 JS JSON.stringify 的数字输出对齐：整数值不带小数点，其余用最短往返表示。 */
    private static String number(Number value) throws JSONException {
        double d = value.doubleValue();
        if (!Double.isFinite(d)) throw new JSONException("数值不能是 NaN 或无穷");
        if (value instanceof Integer || value instanceof Long || value instanceof Short || value instanceof Byte) return Long.toString(value.longValue());
        if (d == Math.rint(d) && Math.abs(d) < 1e15d) return Long.toString((long) d);
        String text = Double.toString(d);
        int exponent = text.indexOf('E');
        if (exponent < 0) return text;
        String mantissa = text.substring(0, exponent);
        if (mantissa.endsWith(".0")) mantissa = mantissa.substring(0, mantissa.length() - 2);
        String power = text.substring(exponent + 1);
        return mantissa + "e" + (power.startsWith("-") ? power : "+" + power);
    }
    /** JSON.stringify 风格字符串转义：/ 与多字节字符原样输出，控制字符与孤立代理项转成反斜杠 u 转义形式。 */
    private static void quote(String value, StringBuilder out) {
        out.append('"');
        for (int i = 0; i < value.length(); i++) {
            char c = value.charAt(i);
            switch (c) {
                case '"': out.append("\\\""); break;
                case '\\': out.append("\\\\"); break;
                case '\b': out.append("\\b"); break;
                case '\f': out.append("\\f"); break;
                case '\n': out.append("\\n"); break;
                case '\r': out.append("\\r"); break;
                case '\t': out.append("\\t"); break;
                default:
                    if (c < 0x20 || loneSurrogate(value, i)) out.append(String.format(Locale.ROOT, "\\u%04x", (int) c));
                    else out.append(c);
            }
        }
        out.append('"');
    }
    private static boolean loneSurrogate(String value, int index) {
        char c = value.charAt(index);
        if (Character.isHighSurrogate(c)) return index + 1 >= value.length() || !Character.isLowSurrogate(value.charAt(index + 1));
        if (Character.isLowSurrogate(c)) return index == 0 || !Character.isHighSurrogate(value.charAt(index - 1));
        return false;
    }
    /** JSON 数组形式的样本集合（兼容旧备份）统一成对象。 */
    static JSONObject asObject(Object samples) throws JSONException {
        if (samples instanceof JSONObject) return (JSONObject) samples;
        if (samples instanceof JSONArray) {
            JSONArray array = (JSONArray) samples;
            JSONObject out = new JSONObject();
            List<String> order = new ArrayList<>();
            for (int i = 0; i < array.length(); i++) order.add(Integer.toString(i));
            for (String key : order) out.put(key, array.get(Integer.parseInt(key)));
            return out;
        }
        throw new JSONException("样本集合格式无效");
    }
}
