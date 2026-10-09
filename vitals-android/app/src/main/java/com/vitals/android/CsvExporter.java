package com.vitals.android;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;
import java.util.Iterator;

/** 契约 G：CSV 导出。UTF-8 + BOM（Excel 直接双击不乱码），CRLF 行尾，字段含分隔符/引号时加引号并转义。
 *  仅依赖 org.json，便于离线验证台直接跑。
 */
final class CsvExporter {
    private static final String BOM = "\uFEFF";
    private CsvExporter() {}

    /** records 列：时间,样本,编号,类型,明细,槽位,状态,任务号,来源。 */
    static String records(JSONArray records) throws JSONException {
        StringBuilder out = new StringBuilder(BOM);
        out.append("时间,样本,编号,类型,明细,槽位,状态,任务号,来源\r\n");
        for (int i = 0; i < records.length(); i++) {
            JSONObject r = records.getJSONObject(i);
            row(out, new String[]{cell(r, "time"), cell(r, "sample"), cell(r, "code"), cell(r, "type"), cell(r, "detail"), cell(r, "slot"), cell(r, "status"), cell(r, "taskId"), cell(r, "source")});
        }
        return out.toString();
    }

    /** samples 列：内部ID,名称,编号,类别,位置,状态,采集时间,温度,备注。 */
    static String samples(JSONObject samples) throws JSONException {
        StringBuilder out = new StringBuilder(BOM);
        out.append("内部ID,名称,编号,类别,位置,状态,采集时间,温度,备注\r\n");
        for (Iterator<String> keys = samples.keys(); keys.hasNext(); ) {
            JSONObject x = samples.getJSONObject(keys.next());
            row(out, new String[]{cell(x, "id"), cell(x, "name"), cell(x, "code"), cell(x, "type"), cell(x, "loc"), cell(x, "status"), cell(x, "timeTxt"), cell(x, "temp"), cell(x, "note")});
        }
        return out.toString();
    }

    /** env 列：样本ID,样本名称,时间,温度（一个温度点一行）。 */
    static String env(JSONObject samples) throws JSONException {
        StringBuilder out = new StringBuilder(BOM);
        out.append("样本ID,样本名称,时间,温度\r\n");
        for (Iterator<String> keys = samples.keys(); keys.hasNext(); ) {
            JSONObject x = samples.getJSONObject(keys.next());
            JSONArray env = x.optJSONArray("env");
            if (env == null) continue;
            for (int i = 0; i < env.length(); i++) {
                JSONObject point = env.optJSONObject(i);
                if (point == null) continue;
                row(out, new String[]{cell(x, "id"), cell(x, "name"), cell(point, "time"), cell(point, "temp")});
            }
        }
        return out.toString();
    }

    private static void row(StringBuilder out, String[] cells) {
        for (int i = 0; i < cells.length; i++) { if (i > 0) out.append(','); out.append(quote(cells[i])); }
        out.append("\r\n");
    }

    private static String cell(JSONObject object, String key) throws JSONException {
        if (!object.has(key) || object.isNull(key)) return "";
        Object value = object.get(key);
        if (value instanceof Number) return JSONObject.numberToString((Number) value);
        return String.valueOf(value);
    }

    private static String quote(String value) {
        if (value == null || value.isEmpty()) return "";
        boolean needs = false;
        for (int i = 0; i < value.length(); i++) {
            char c = value.charAt(i);
            if (c == ',' || c == '"' || c == '\n' || c == '\r' || c == '\t') { needs = true; break; }
        }
        String escaped = value.replace("\"", "\"\"");
        return needs ? "\"" + escaped + "\"" : escaped;
    }
}
