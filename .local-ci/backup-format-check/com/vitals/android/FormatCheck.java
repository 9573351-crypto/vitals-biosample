package com.vitals.android;
import org.json.JSONArray;
import org.json.JSONObject;
import java.nio.file.*;

/** 直接驱动真实的 BackupFormat（不依赖 Android），验证夹具的 checksum 与规范化行为。 */
public class FormatCheck {
    static int pass=0,fail=0;
    static void ok(String n,boolean c,String d){ if(c){pass++;System.out.println("PASS "+n);} else {fail++;System.out.println("FAIL "+n+(d==null?"":" — "+d));} }
    public static void main(String[] a) throws Exception {
        Path dir=Paths.get("D:/PROJECT/VITALS/.local-ci/fixtures");
        JSONObject good=new JSONObject(new String(Files.readAllBytes(dir.resolve("good.json")),"UTF-8"));
        String computed=BackupFormat.checksum(good.getJSONObject("samples"),good.getJSONArray("records"),good.getJSONObject("settings"));
        ok("good.json checksum 与夹具一致",computed.equals(good.getString("checksum")),computed+" vs "+good.getString("checksum"));

        JSONObject tampered=new JSONObject(new String(Files.readAllBytes(dir.resolve("tampered.json")),"UTF-8"));
        String t=BackupFormat.checksum(tampered.getJSONObject("samples"),tampered.getJSONArray("records"),tampered.getJSONObject("settings"));
        ok("tampered.json 计算结果与声明不同（会被拒）",!t.equals(tampered.getString("checksum")),t);

        JSONObject merge=new JSONObject(new String(Files.readAllBytes(dir.resolve("merge.json")),"UTF-8"));
        String m=BackupFormat.checksum(merge.getJSONObject("samples"),merge.getJSONArray("records"),merge.getJSONObject("settings"));
        ok("merge.json checksum 与夹具一致",m.equals(merge.getString("checksum")),m);

        JSONObject wp=new JSONObject(new String(Files.readAllBytes(dir.resolve("with-photo.json")),"UTF-8"));
        String w=BackupFormat.checksum(wp.getJSONObject("samples"),wp.getJSONArray("records"),wp.getJSONObject("settings"));
        ok("with-photo.json checksum 与夹具一致",w.equals(wp.getString("checksum")),w);

        JSONObject subset=new JSONObject(new String(Files.readAllBytes(dir.resolve("subset.json")),"UTF-8"));
        String s=BackupFormat.checksum(subset.getJSONObject("samples"),subset.getJSONArray("records"),subset.getJSONObject("settings"));
        ok("subset.json checksum 与夹具一致",s.equals(subset.getString("checksum")),s);

        // truncated 必须解析失败
        boolean threw=false;
        try{ new JSONObject(new String(Files.readAllBytes(dir.resolve("truncated.json")),"UTF-8")); }catch(Exception e){ threw=true; }
        ok("truncated.json 解析抛出异常（会被拒）",threw,null);

        // 键序不影响结果
        JSONObject s1=new JSONObject().put("b",2).put("a",1);
        JSONObject s2=new JSONObject().put("a",1).put("b",2);
        ok("键顺序不同但规范化结果相同",BackupFormat.checksum(s1,new JSONArray(),new JSONObject()).equals(BackupFormat.checksum(s2,new JSONArray(),new JSONObject())),null);

        System.out.println("\nTOTAL "+pass+" passed, "+fail+" failed");
        if(fail>0) System.exit(1);
    }
}