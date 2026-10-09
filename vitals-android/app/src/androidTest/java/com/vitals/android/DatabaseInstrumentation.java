package com.vitals.android;

import android.app.Instrumentation;
import android.app.Activity;
import android.content.ContentValues;
import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;
import android.os.Bundle;
import android.util.Base64;
import org.json.*;
import java.io.File;
import java.nio.charset.StandardCharsets;
import java.time.LocalDateTime;
import java.time.format.DateTimeFormatter;
import java.util.*;

/** Real Android SQLite tests, with separate test DB files; never edits production vitals.db.
 *  契约 A–G 的断言见文件末尾：新库路径、旧库（v3 无新列）升级路径、以及 .local-ci 夹具的内嵌副本。 */
public final class DatabaseInstrumentation extends Instrumentation {
    /* .local-ci/fixtures/good.json、merge.json 的压缩（去空白）base64 内嵌副本：checksum 是夹具里的原值，
       用于在设备上独立复现 BackupFormat 的规范化算法，而不是用被测函数算出来自证。 */
    private static final String FIXTURE_GOOD_B64 = "eyJhcHAiOiJ2aXRhbHMtYmlvc2FtcGxlIiwic2NoZW1hVmVyc2lvbiI6NCwiYXBwVmVyc2lvbiI6IjEuMTkuMyIsImV4cG9ydGVkQXQiOiIyMDI2LTEwLTA5VDA4OjAwOjAwKzA4OjAwIiwiY291bnRzIjp7InNhbXBsZXMiOjEsInJlY29yZHMiOjJ9LCJjaGVja3N1bSI6InNoYTI1Njo0Yjc5NGRmZGI5ODE1MzMzZDUxYzI5MzcwMzUyYzg3NzBmNGJhYWMzN2FjZmJhMDE1MzNiMGU1MDMyZTU2NDUyIiwic2FtcGxlcyI6eyJTQi0xMDAwMSI6eyJpZCI6IlNCLTEwMDAxIiwibmFtZSI6IuihgOa4heagt+acrC0wMSIsImNvZGUiOiJTQi05MDAwMSIsInR5cGUiOiLooYDmuIUiLCJzdGF0dXMiOiJpbiIsInNsb3QiOjEsImxvYyI6IuWchuebmC0wIiwidGltZVR4dCI6IjIwMjYtMTAtMDkgMDg6MDAiLCJ0aW1lUmF3IjoiMjAyNi0xMC0wOVQwODowMCIsInRlbXAiOjQuMiwibW9uaXRvciI6ZmFsc2UsImFsZXJ0IjoiZ29vZCIsImNyZWF0ZWRBdCI6MTc1OTk2ODAwMDAwMCwidXBkYXRlZEF0IjoxNzU5OTY4MDAwMDAwLCJwZW5kaW5nSW50YWtlIjpmYWxzZSwiZW52IjpbeyJ0aW1lIjoiMjAyNi0xMC0wOVQwODowMCIsInRlbXAiOjQuMn0seyJ0aW1lIjoiMjAyNi0xMC0wOVQwODowMSIsInRlbXAiOjQuM31dfX0sInJlY29yZHMiOlt7InJlY29yZElkIjoxLCJzYW1wbGVJZCI6IlNCLTEwMDAxIiwic2FtcGxlIjoi6KGA5riF5qC35pysLTAxIiwidGltZSI6IjIwMjYtMTAtMDlUMDg6MDAiLCJ0eXBlIjoi5YWl5bqTIiwiZGV0YWlsIjoi5aS55YW36K6w5b2VIDEiLCJjb2RlIjoiU0ItOTAwMDEiLCJzbG90IjoxLCJzdGF0dXMiOiJpbiIsInRhc2tJZCI6IlQtRklYVFVSRS0xIiwic291cmNlIjoibWFudWFsIiwidHlwZV9jb2RlIjoiaW4iLCJvcGVyYXRvciI6IuWkueWFtyJ9LHsicmVjb3JkSWQiOjIsInNhbXBsZUlkIjoiU0ItMTAwMDEiLCJzYW1wbGUiOiLooYDmuIXmoLfmnKwtMDEiLCJ0aW1lIjoiMjAyNi0xMC0wOVQwODowMCIsInR5cGUiOiLlhaXlupMiLCJkZXRhaWwiOiLlpLnlhbforrDlvZUgMiIsImNvZGUiOiJTQi05MDAwMiIsInNsb3QiOjEsInN0YXR1cyI6ImluIiwidGFza0lkIjoiVC1GSVhUVVJFLTIiLCJzb3VyY2UiOiJtYW51YWwiLCJ0eXBlX2NvZGUiOiJpbiIsIm9wZXJhdG9yIjoi5aS55YW3In1dLCJzZXR0aW5ncyI6eyJoaSI6OCwibG8iOi04OCwic2ltT24iOmZhbHNlLCJvbmxpbmUiOjB9fQ==";
    private static final String FIXTURE_MERGE_B64 = "eyJhcHAiOiJ2aXRhbHMtYmlvc2FtcGxlIiwic2NoZW1hVmVyc2lvbiI6NCwiYXBwVmVyc2lvbiI6IjEuMTkuMyIsImV4cG9ydGVkQXQiOiIyMDI2LTEwLTA5VDA4OjAwOjAwKzA4OjAwIiwiY291bnRzIjp7InNhbXBsZXMiOjMsInJlY29yZHMiOjN9LCJjaGVja3N1bSI6InNoYTI1Njo0OTgzYjBkYTIxODBiZDA3ZDUyMTQ3NWE2MTZkZTJmNWQ3OWQzNmM0YjdkMjBmYjI0NzA0MzZkNjIzYjM4MmE3Iiwic2FtcGxlcyI6eyJTQi0xMDAwMSI6eyJpZCI6IlNCLTEwMDAxIiwibmFtZSI6IuihgOa4heagt+acrC0wMe+8iOW3suabtOaWsO+8iSIsImNvZGUiOiJTQi05MDAwMSIsInR5cGUiOiLooYDmuIUiLCJzdGF0dXMiOiJpbiIsInNsb3QiOjIsImxvYyI6IuWchuebmC0xIiwidGltZVR4dCI6IjIwMjYtMTAtMDkgMDg6MDAiLCJ0aW1lUmF3IjoiMjAyNi0xMC0wOVQwODowMCIsInRlbXAiOjQuMiwibW9uaXRvciI6ZmFsc2UsImFsZXJ0IjoiZ29vZCIsImNyZWF0ZWRBdCI6MTc1OTk2ODAwMDAwMCwidXBkYXRlZEF0IjoxNzU5OTY4MDAwMDAwLCJwZW5kaW5nSW50YWtlIjpmYWxzZSwiZW52IjpbeyJ0aW1lIjoiMjAyNi0xMC0wOVQwODowMCIsInRlbXAiOjQuMn0seyJ0aW1lIjoiMjAyNi0xMC0wOVQwODowMSIsInRlbXAiOjQuM31dLCJub3RlIjoi5ZCI5bm25pu05pawIn0sIlNCLTEwMDAyIjp7ImlkIjoiU0ItMTAwMDIiLCJuYW1lIjoi5YWo6KGA5qC35pysLTAyIiwiY29kZSI6IlNCLTkwMDAyIiwidHlwZSI6IuWFqOihgCIsInN0YXR1cyI6ImluIiwic2xvdCI6MSwibG9jIjoi5ZyG55uYLTAiLCJ0aW1lVHh0IjoiMjAyNi0xMC0wOSAwODowMCIsInRpbWVSYXciOiIyMDI2LTEwLTA5VDA4OjAwIiwidGVtcCI6NC4yLCJtb25pdG9yIjpmYWxzZSwiYWxlcnQiOiJnb29kIiwiY3JlYXRlZEF0IjoxNzU5OTY4MDAwMDAwLCJ1cGRhdGVkQXQiOjE3NTk5NjgwMDAwMDAsInBlbmRpbmdJbnRha2UiOmZhbHNlLCJlbnYiOlt7InRpbWUiOiIyMDI2LTEwLTA5VDA4OjAwIiwidGVtcCI6NC4yfSx7InRpbWUiOiIyMDI2LTEwLTA5VDA4OjAxIiwidGVtcCI6NC4zfV19LCJTQi0xMDAwMyI6eyJpZCI6IlNCLTEwMDAzIiwibmFtZSI6IuadoeeggeWGsueqgeagt+acrCIsImNvZGUiOiJTQi05MDAwMSIsInR5cGUiOiLooYDmtYYiLCJzdGF0dXMiOiJpbiIsInNsb3QiOjMsImxvYyI6IuWchuebmC0yIiwidGltZVR4dCI6IjIwMjYtMTAtMDkgMDg6MDAiLCJ0aW1lUmF3IjoiMjAyNi0xMC0wOVQwODowMCIsInRlbXAiOjQuMiwibW9uaXRvciI6ZmFsc2UsImFsZXJ0IjoiZ29vZCIsImNyZWF0ZWRBdCI6MTc1OTk2ODAwMDAwMCwidXBkYXRlZEF0IjoxNzU5OTY4MDAwMDAwLCJwZW5kaW5nSW50YWtlIjpmYWxzZSwiZW52IjpbeyJ0aW1lIjoiMjAyNi0xMC0wOVQwODowMCIsInRlbXAiOjQuMn0seyJ0aW1lIjoiMjAyNi0xMC0wOVQwODowMSIsInRlbXAiOjQuM31dfX0sInJlY29yZHMiOlt7InJlY29yZElkIjoxLCJzYW1wbGVJZCI6IlNCLTEwMDAxIiwic2FtcGxlIjoi6KGA5riF5qC35pysLTAxIiwidGltZSI6IjIwMjYtMTAtMDlUMDg6MDAiLCJ0eXBlIjoi5YWl5bqTIiwiZGV0YWlsIjoi5aS55YW36K6w5b2VIDEiLCJjb2RlIjoiU0ItOTAwMDEiLCJzbG90IjoxLCJzdGF0dXMiOiJpbiIsInRhc2tJZCI6IlQtRklYVFVSRS0xIiwic291cmNlIjoibWFudWFsIiwidHlwZV9jb2RlIjoiaW4iLCJvcGVyYXRvciI6IuWkueWFtyJ9LHsicmVjb3JkSWQiOjMsInNhbXBsZUlkIjoiU0ItMTAwMDIiLCJzYW1wbGUiOiLlhajooYDmoLfmnKwtMDIiLCJ0aW1lIjoiMjAyNi0xMC0wOVQwODowMCIsInR5cGUiOiLlhaXlupMiLCJkZXRhaWwiOiLlpLnlhbforrDlvZUgMyIsImNvZGUiOiJTQi05MDAwMyIsInNsb3QiOjEsInN0YXR1cyI6ImluIiwidGFza0lkIjoiVC1GSVhUVVJFLTMiLCJzb3VyY2UiOiJtYW51YWwiLCJ0eXBlX2NvZGUiOiJpbiIsIm9wZXJhdG9yIjoi5aS55YW3In0seyJyZWNvcmRJZCI6NCwic2FtcGxlSWQiOiJTQi0xMDAwMiIsInNhbXBsZSI6IuWFqOihgOagt+acrC0wMiIsInRpbWUiOiIyMDI2LTEwLTA5VDA4OjAwIiwidHlwZSI6IuWFpeW6kyIsImRldGFpbCI6IuWkueWFt+iusOW9lSA0IiwiY29kZSI6IlNCLTkwMDA0Iiwic2xvdCI6MSwic3RhdHVzIjoiaW4iLCJ0YXNrSWQiOiJULUZJWFRVUkUtNCIsInNvdXJjZSI6Im1hbnVhbCIsInR5cGVfY29kZSI6ImluIiwib3BlcmF0b3IiOiLlpLnlhbcifV0sInNldHRpbmdzIjp7ImhpIjo4LCJsbyI6LTg4LCJzaW1PbiI6ZmFsc2UsIm9ubGluZSI6MH19";
    /** with-photo.json 的 checksum（夹具原值）：good.json 内容 + SB-10001.photo。 */
    private static final String WITH_PHOTO_CHECKSUM = "sha256:56e57084e568a64965c976d7f7352e56edbf1379eecb003033dbba2990eb46ae";
    private static final String WITH_PHOTO_DATA_URL = "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAA==";
    private static JSONObject fixture(String base64)throws Exception{return new JSONObject(new String(Base64.decode(base64,Base64.DEFAULT),StandardCharsets.UTF_8));}
    private static String photoHashOf(String dataUrl){return BackupFormat.sha256Hex(Base64.decode(dataUrl.substring(dataUrl.indexOf(',')+1),Base64.DEFAULT));}
    private File photoFile(String hash){return new File(new File(new File(getTargetContext().getFilesDir(),"photos"),hash.substring(0,2)),hash+".jpg");}
    private int passed;
    private final StringBuilder report=new StringBuilder();
    private int sequence;
    private final List<String> names=new ArrayList<>();
    private interface Check {void run()throws Exception;}
    private void test(String name,Check check)throws Exception{check.run();passed++;report.append("PASS ").append(name).append('\n');}
    private void eq(Object a,Object b){if(!Objects.equals(String.valueOf(a),String.valueOf(b)))throw new AssertionError(a+" != "+b);}
    private void yes(boolean b){if(!b)throw new AssertionError("expected true");}
    private void fails(Check c)throws Exception{boolean failed=false;try{c.run();}catch(Exception e){failed=true;}yes(failed);}
    private String fresh(){String n="vitals-refactor-test-"+(++sequence)+".db";getTargetContext().deleteDatabase(n);names.add(n);return n;}
    private JSONObject sample(String id,String code)throws Exception{return new JSONObject().put("id",id).put("name","样本 "+id).put("code",code).put("type","全血").put("status","out").put("temp",4.2).put("createdAt",123456789L).put("updatedAt",123456790L).put("photo","data:image/jpeg;base64,YWJj").put("qrSnap","旧二维码快照").put("env",new JSONArray().put(new JSONObject().put("time","2026-09-14 12:00").put("temp",4.2))).put("customField",new JSONObject().put("keep",true));}
    private JSONObject rec(String id)throws Exception{return new JSONObject().put("sampleId",id).put("sample","名称快照").put("time","2026-09-14 12:00").put("type","录入").put("detail","记录内容");}
    private JSONObject backup(JSONObject sample)throws Exception{return new JSONObject().put("samples",new JSONObject().put(sample.getString("id"),sample)).put("records",new JSONArray()).put("settings",new JSONObject().put("hi",8).put("lo",-88).put("custom",new JSONObject().put("keep",1)));}
    private String canonical(JSONObject b)throws Exception{
        JSONObject copy=new JSONObject(b.toString());copy.remove("exportedAt");JSONArray rr=copy.getJSONArray("records");for(int i=0;i<rr.length();i++)rr.getJSONObject(i).remove("recordId");return sorted(copy);
    }
    private String sorted(Object x)throws Exception{
        if(x instanceof JSONObject){TreeMap<String,String> map=new TreeMap<>();Iterator<String> it=((JSONObject)x).keys();while(it.hasNext()){String k=it.next();map.put(k,sorted(((JSONObject)x).get(k)));}return map.toString();}
        if(x instanceof JSONArray){List<String> l=new ArrayList<>();for(int i=0;i<((JSONArray)x).length();i++)l.add(sorted(((JSONArray)x).get(i)));return l.toString();}return String.valueOf(x);
    }
    private JSONObject legacy()throws Exception{
        JSONObject a=sample("OLD1","OLD-CODE").put("status","in").put("slot",2);
        return new JSONObject().put("s",new JSONObject().put("samples",new JSONObject().put("OLD1",a)).put("samplesSeeded",true))
          .put("rec",new JSONArray().put(new JSONObject().put("sample",a.getString("name")).put("time","旧时间").put("type","录入").put("detail","旧记录")))
          .put("set",new JSONObject().put("hi",8).put("lo",-88).put("custom",new JSONObject().put("keep",7)));
    }
    private void createLegacy(String name,JSONObject payload,int version){SQLiteDatabase db=getTargetContext().openOrCreateDatabase(name,0,null);db.execSQL("CREATE TABLE app_state (id INTEGER PRIMARY KEY,payload TEXT NOT NULL)");db.execSQL("INSERT INTO app_state VALUES(1,?)",new Object[]{payload.toString()});db.setVersion(version);db.close();}
    @Override public void onCreate(Bundle arguments){super.onCreate(arguments);start();}
    @Override public void onStart(){Bundle result=new Bundle();try{runTests();result.putString("stream","\n"+report+"TOTAL "+passed+" passed\n");finish(Activity.RESULT_OK,result);}catch(Throwable t){report.append("FAIL ").append(t).append('\n');result.putString("stream",report+android.util.Log.getStackTraceString(t));finish(Activity.RESULT_CANCELED,result);}finally{for(String name:names)getTargetContext().deleteDatabase(name);}}
    private void runTests()throws Exception{
        test("USB label encoder preserves black runs and emits one print; rejects invalid size",()->{
            android.graphics.Bitmap image=android.graphics.Bitmap.createBitmap(160,160,android.graphics.Bitmap.Config.ARGB_8888);
            image.eraseColor(android.graphics.Color.WHITE);
            image.setPixel(5,8,android.graphics.Color.BLACK);image.setPixel(6,8,android.graphics.Color.BLACK);
            java.io.ByteArrayOutputStream png=new java.io.ByteArrayOutputStream();image.compress(android.graphics.Bitmap.CompressFormat.PNG,100,png);image.recycle();
            JSONObject job=new JSONObject().put("width",20).put("height",20).put("gap",2).put("png","data:image/png;base64,"+android.util.Base64.encodeToString(png.toByteArray(),android.util.Base64.NO_WRAP));
            String commands=new String(UsbLabelPrinter.encode(job.toString()),java.nio.charset.StandardCharsets.US_ASCII);
            eq(commands,"SIZE 20.0 mm,20.0 mm\r\nGAP 2.0 mm,0 mm\r\nDIRECTION 1\r\nREFERENCE 0,0\r\nCLS\r\nBAR 5,8,2,1\r\nPRINT 1,1\r\n");
            fails(()->UsbLabelPrinter.encode(job.put("width",81).toString()));
            fails(()->UsbLabelPrinter.encode(job.put("width",21).toString()));
            fails(()->UsbLabelPrinter.encode(job.put("width",20).put("gap",-1).toString()));
        });
        String name=fresh();VitalsDbHelper h=new VitalsDbHelper(getTargetContext(),name);
        test("new empty database, version and foreign keys",()->{
            eq(h.getSamples().length(),0);eq(h.getRecords(null).length(),0);eq(h.info().getInt("version"),3);
            try(Cursor c=h.getReadableDatabase().rawQuery("PRAGMA foreign_keys",null)){c.moveToFirst();eq(c.getInt(0),1);}
        });
        test("create sample plus linked record",()->{h.saveSample(sample("A","CODE-A"),rec("A"));eq(h.getRecords("A").length(),1);eq(h.getSample("A",false).getString("code"),"CODE-A");});
        test("update retains FK and photo/extra fields",()->{JSONObject a=h.getSample("A",false);a.put("name","改名");h.saveSample(a,null);eq(h.getRecords("A").length(),1);eq(h.getSample("A",false).getJSONObject("customField").getBoolean("keep"),true);eq(h.getSample("A",false).getString("photo"),"data:image/jpeg;base64,YWJj");});
        test("barcode unique and parameter binding",()->{fails(()->h.saveSample(sample("B","CODE-A"),null));eq(h.getSample("CODE-A",true).getString("id"),"A");eq(h.getSample("' OR 1=1 --",true),null);});
        test("slot range and integer validation",()->{fails(()->h.saveSample(sample("B","B").put("status","in").put("slot",6),null));fails(()->h.saveSample(sample("B","B").put("status","in").put("slot",1.5),null));});
        test("status and field types",()->{fails(()->h.saveSample(sample("B","B").put("status","pending"),null));fails(()->h.saveSample(sample("B","B").put("monitor","yes"),null));fails(()->h.saveSample(sample("B","B").put("temp","4"),null));});
        test("inbound atomic with history",()->{JSONObject a=h.getSample("A",false).put("status","in").put("slot",1);h.saveSample(a,rec("A").put("type","入库").put("slot",1));eq(h.getRecords("A").length(),2);eq(h.getSample("A",false).getInt("slot"),1);});
        test("occupied slot rejects second sample",()->{fails(()->h.saveSample(sample("B","B").put("status","in").put("slot",1),null));eq(h.getSamples().length(),1);});
        test("same slot number is allowed on another sample disc",()->{h.saveSample(sample("SERUM","SERUM").put("type","血清").put("status","in").put("slot",1),null);eq(h.getSample("SERUM",false).getInt("slot"),1);});
        test("record failure rolls sample update back",()->{JSONObject a=h.getSample("A",false).put("name","不应保存");fails(()->h.saveSample(a,rec("MISSING")));eq(h.getSample("A",false).getString("name"),"改名");eq(h.getRecords("A").length(),2);});
        test("outbound frees slot with retained last slot",()->{JSONObject a=h.getSample("A",false).put("status","out");h.saveSample(a,rec("A").put("type","出库"));yes(!h.getSample("A",false).has("slot"));eq(h.getSample("A",false).getInt("lastSlot"),1);h.saveSample(sample("B","B").put("status","in").put("slot",1),null);});
        test("settings JSON values and read",()->{h.setSetting("hi",9.5);h.setSetting("custom",new JSONObject().put("a",1));eq(h.getSettings().getDouble("hi"),9.5);eq(h.getSettings().getJSONObject("custom").getInt("a"),1);});
        test("delete parent retains history via SET NULL",()->{h.deleteSample("A",null);eq(h.getSample("A",false),null);eq(h.getRecords(null).length(),3);yes(h.getRecords(null).getJSONObject(0).isNull("sampleId"));});
        test("stale revision and invalid FK reject",()->{long rev=h.info().getLong("revision");h.setSetting("lo",-80);fails(()->h.commit(new JSONObject().put("expectedRevision",rev).put("deleteSamples",new JSONArray().put("B"))));yes(h.getSample("B",false)!=null);fails(()->h.addRecord(rec("MISSING")));});
        test("full legacy state JSON import",()->{h.replaceBackup(legacy().toString());eq(h.getRecords("OLD1").length(),1);eq(h.getSample("OLD1",false).getJSONArray("env").length(),1);});
        test("current backup and raw collections import",()->{h.replaceBackup(backup(sample("C","C")).toString());eq(h.getSamples().length(),1);h.replaceBackup(new JSONArray().put(sample("D","D")).toString());eq(h.getSample("D",false).getString("code"),"D");h.replaceBackup(new JSONObject().put("E",sample("E","E")).toString());eq(h.getSample("E",false).getString("code"),"E");});
        test("invalid import rolls back after deletes/inserts",()->{String before=canonical(h.exportBackup());JSONObject bad=backup(sample("NEW","NEW")).put("records",new JSONArray().put(rec("UNKNOWN")));fails(()->h.replaceBackup(bad.toString()));eq(canonical(h.exportBackup()),before);});
        test("export import preserves logical data",()->{h.addRecord(rec("E"));JSONObject b=h.exportBackup();h.replaceBackup(b.toString());eq(canonical(h.exportBackup()),canonical(b));});
        test("closed/reopened DB retains data",()->{VitalsDbHelper second=new VitalsDbHelper(getTargetContext(),name);eq(second.getSamples().length(),h.getSamples().length());second.close();});
        test("ambiguous legacy names remain unlinked",()->{JSONObject a=sample("N1","N1").put("name","同名"),b=sample("N2","N2").put("name","同名");JSONObject data=new JSONObject().put("samples",new JSONArray().put(a).put(b)).put("records",new JSONArray().put(new JSONObject().put("sample","同名").put("detail","旧记录")));h.replaceBackup(data.toString());yes(h.getRecords(null).getJSONObject(0).isNull("sampleId"));});
        test("SQL itself enforces CHECK and NOT NULL",()->{
            fails(()->h.getWritableDatabase().execSQL("UPDATE samples SET status='invalid' WHERE sample_id='N1'"));
            fails(()->h.getWritableDatabase().execSQL("UPDATE samples SET slot=6 WHERE sample_id='N1'"));
            fails(()->h.getWritableDatabase().execSQL("UPDATE samples SET name=NULL WHERE sample_id='N1'"));
            eq(h.getSample("N1",false).getString("status"),"out");
        });
        test("concurrent setting writes remain consistent",()->{
            java.util.concurrent.atomic.AtomicReference<Throwable> problem=new java.util.concurrent.atomic.AtomicReference<>();
            Thread a=new Thread(()->{try{for(int i=0;i<10;i++)h.setSetting("threadA",i);}catch(Throwable e){problem.set(e);}});
            Thread b=new Thread(()->{try{for(int i=0;i<10;i++)h.setSetting("threadB",i);}catch(Throwable e){problem.set(e);}});
            a.start();b.start();a.join();b.join();if(problem.get()!=null)throw new AssertionError(problem.get());
            eq(h.getSettings().getInt("threadA"),9);eq(h.getSettings().getInt("threadB"),9);
        });
        h.close();
        for(int version:new int[]{0,1}){
            test("legacy DB version "+version+" migrates once; clearing does not resurrect",()->{
                String n=fresh();JSONObject old=legacy();createLegacy(n,old,version);
                VitalsDbHelper migrated=new VitalsDbHelper(getTargetContext(),n);
                eq(migrated.getSamples().length(),1);eq(migrated.getRecords("OLD1").length(),1);eq(migrated.getSettings().getJSONObject("custom").getInt("keep"),7);
                try(Cursor c=migrated.getReadableDatabase().rawQuery("SELECT payload FROM app_state WHERE id=1",null)){c.moveToFirst();eq(c.getString(0),old.toString());}
                migrated.close();migrated=new VitalsDbHelper(getTargetContext(),n);eq(migrated.getRecords(null).length(),1);
                migrated.replaceBackup("{\"samples\":{},\"records\":[],\"settings\":{}}");migrated.close();
                migrated=new VitalsDbHelper(getTargetContext(),n);eq(migrated.getSamples().length(),0);eq(migrated.getRecords(null).length(),0);migrated.close();
            });
        }
        test("failed legacy migration retains payload and version",()->{
            String n=fresh();JSONObject old=legacy();old.getJSONObject("s").getJSONObject("samples").put("BAD",sample("BAD","OLD-CODE"));createLegacy(n,old,0);
            VitalsDbHelper broken=new VitalsDbHelper(getTargetContext(),n);fails(()->broken.getWritableDatabase());broken.close();
            SQLiteDatabase db=getTargetContext().openOrCreateDatabase(n,0,null);eq(db.getVersion(),0);try(Cursor c=db.rawQuery("SELECT payload FROM app_state",null)){c.moveToFirst();eq(c.getString(0),old.toString());}db.close();
        });
        test("legacy unfinished task survives migration",()->{
            String n=fresh();JSONObject old=legacy();old.getJSONObject("set").put("motionTask",new JSONObject().put("taskId","PENDING").put("sampleId","OLD1").put("action","out").put("slot",2).put("mode","hardware").put("phase","sent").put("createdAt",123));createLegacy(n,old,0);
            VitalsDbHelper m=new VitalsDbHelper(getTargetContext(),n);eq(m.getSettings().getJSONObject("motionTask").getString("taskId"),"PENDING");fails(()->m.replaceBackup("{\"samples\":{}}"));m.close();
        });

        /* ---------- 契约 A–E/G：新库路径 ---------- */
        String extendedName=fresh();VitalsDbHelper x=new VitalsDbHelper(getTargetContext(),extendedName);
        test("契约A 新库：照片落盘、行内清空、thumb 长边≤160",()->{
            android.graphics.Bitmap image=android.graphics.Bitmap.createBitmap(640,480,android.graphics.Bitmap.Config.ARGB_8888);
            image.eraseColor(android.graphics.Color.RED);image.setPixel(9,9,android.graphics.Color.WHITE);
            java.io.ByteArrayOutputStream jpeg=new java.io.ByteArrayOutputStream();image.compress(android.graphics.Bitmap.CompressFormat.JPEG,90,jpeg);image.recycle();
            String dataUrl="data:image/jpeg;base64,"+Base64.encodeToString(jpeg.toByteArray(),Base64.NO_WRAP);
            String hash=BackupFormat.sha256Hex(jpeg.toByteArray());
            x.saveSample(sample("PHOTO1","PHOTO-1").put("photo",dataUrl),null);
            yes(photoFile(hash).isFile());
            try(Cursor c=x.getReadableDatabase().rawQuery("SELECT photo,photo_path,photo_hash,thumb FROM samples WHERE sample_id='PHOTO1'",null)){
                c.moveToFirst();
                yes(c.isNull(0));                                    // 契约A：新写入不再填全图
                eq(c.getString(1),photoFile(hash).getAbsolutePath()); // files/photos/<hash[:2]>/<hash>.jpg
                eq(c.getString(2),hash);
                yes(c.getString(3)!=null&&c.getString(3).startsWith("data:image/jpeg;base64,"));
                byte[] thumb=Base64.decode(c.getString(3).substring(c.getString(3).indexOf(',')+1),Base64.DEFAULT);
                android.graphics.BitmapFactory.Options bounds=new android.graphics.BitmapFactory.Options();bounds.inJustDecodeBounds=true;
                android.graphics.BitmapFactory.decodeByteArray(thumb,0,thumb.length,bounds);
                yes(bounds.outWidth>0&&bounds.outHeight>0);
                yes(Math.max(bounds.outWidth,bounds.outHeight)<=160);
            }
            JSONObject photo=x.getSamplePhoto("PHOTO1",true);
            eq(photo.getBoolean("missing"),false);eq(photo.getString("hash"),hash);
            eq(photo.getString("photo"),dataUrl);
            eq(x.getSamplePhoto("PHOTO1",false).has("photo"),false);
            eq(x.getSamplePhoto("NO-SUCH-ID",true).getBoolean("missing"),true);
            eq(x.getSample("PHOTO1",false).getString("photo"),dataUrl); // 单样本读取仍兼容旧前端
        });
        test("契约A 未换图保存不清空已有照片引用",()->{
            JSONObject current=x.getSample("PHOTO1",false);String hash=current.getString("photoHash");
            current.remove("photo");current.remove("photoPath");current.remove("photoHash");current.remove("thumb");current.put("name","改名后");
            x.saveSample(current,null);
            JSONObject back=x.getSample("PHOTO1",false);
            eq(back.getString("name"),"改名后");eq(back.getString("photoHash"),hash);
            yes(back.getString("photo").length()>0);yes(back.getString("thumb").startsWith("data:image/jpeg;base64,"));
        });
        test("契约B snapshot：单事务四段一致且不含全图",()->{
            x.setSetting("hi",8);
            JSONObject snap=x.snapshot();
            eq(snap.getLong("revision"),x.info().getLong("revision"));
            eq(snap.getJSONObject("set").getInt("hi"),8);
            JSONObject map=snap.getJSONObject("s").getJSONObject("samples");
            yes(map.has("PHOTO1"));
            yes(!map.getJSONObject("PHOTO1").has("photo"));
            yes(map.getJSONObject("PHOTO1").getString("thumb").startsWith("data:image/jpeg"));
            eq(snap.getJSONArray("rec").length(),0);
        });
        test("契约A 照片三态：键缺省保留、null/空串清空、dataURL 覆盖",()->{
            String hash=x.getSample("PHOTO1",false).getString("photoHash");
            JSONObject keep=x.getSample("PHOTO1",false);keep.remove("photo");keep.remove("photoPath");keep.remove("photoHash");keep.remove("thumb");
            keep.put("name","三态-保留");x.saveSample(keep,null);
            eq(x.getSample("PHOTO1",false).getString("photoHash"),hash); // 键缺省 → 引用不变
            JSONObject remove=x.getSample("PHOTO1",false);remove.put("photo",JSONObject.NULL); // 显式 null → 移除
            x.saveSample(remove,null);
            try(Cursor c=x.getReadableDatabase().rawQuery("SELECT photo,photo_path,photo_hash,thumb FROM samples WHERE sample_id='PHOTO1'",null)){c.moveToFirst();yes(c.isNull(0)&&c.isNull(1)&&c.isNull(2)&&c.isNull(3));}
            eq(x.getSamplePhoto("PHOTO1",true).getBoolean("missing"),true);
            yes(!x.snapshot().getJSONObject("s").getJSONObject("samples").getJSONObject("PHOTO1").has("photoHash"));
            JSONObject blank=x.getSample("PHOTO1",false);blank.put("photo",""); // 空串 → 同样移除
            x.saveSample(blank,null);
            try(Cursor c=x.getReadableDatabase().rawQuery("SELECT photo,photo_path,photo_hash,thumb FROM samples WHERE sample_id='PHOTO1'",null)){c.moveToFirst();yes(c.isNull(0)&&c.isNull(1)&&c.isNull(2)&&c.isNull(3));}
            JSONObject restore=x.getSample("PHOTO1",false);restore.put("photo","data:image/jpeg;base64,YWJj"); // dataURL → 覆盖落盘
            x.saveSample(restore,null);
            JSONObject back=x.getSample("PHOTO1",false);
            eq(back.getString("photoHash"),BackupFormat.sha256Hex("abc".getBytes(StandardCharsets.UTF_8)));
            eq(back.getString("photo"),"data:image/jpeg;base64,YWJj");
            eq(x.getSamplePhoto("PHOTO1",true).getBoolean("missing"),false);
        });
        test("契约C 记录新列/ISO 时间/分页/筛选/枚举约束",()->{
            x.addRecord(rec("PHOTO1").put("time","2026-10-09 08:00").put("source","manual").put("type_code","in").put("operator","张三"));
            x.addRecord(rec("PHOTO1").put("time","2026-10-09T09:30").put("source","hardware").put("typeCode","move").put("operator","李四"));
            x.addRecord(rec("PHOTO1").put("time","2026-10-10T07:00").put("source","scanner").put("typeCode","out"));
            JSONObject all=x.recordsPage("","","",0,0);
            eq(all.getInt("total"),3);eq(all.getJSONArray("records").length(),3);eq(all.getBoolean("hasMore"),false);
            JSONObject newest=all.getJSONArray("records").getJSONObject(0); // id DESC
            eq(newest.getString("typeCode"),"out");eq(newest.getString("type_code"),"out");eq(newest.getString("source"),"scanner");
            JSONObject page=x.recordsPage("","","",2,0);
            eq(page.getJSONArray("records").length(),2);eq(page.getBoolean("hasMore"),true);
            eq(x.recordsPage("","","",5000,0).getJSONArray("records").length(),3); // 超上限按 500 截断，仅 3 条时仍是 3
            eq(x.recordsPage("2026-10-10T00:00","2026-10-10","",0,0).getInt("total"),1);
            eq(x.recordsPage("","","out",0,0).getInt("total"),1);
            try(Cursor c=x.getReadableDatabase().rawQuery("SELECT time FROM records ORDER BY id ASC LIMIT 1",null)){c.moveToFirst();eq(c.getString(0),"2026-10-09T08:00");} // 写入即 ISO
            fails(()->x.addRecord(rec("PHOTO1").put("source","bogus")));
            x.addRecord(rec("PHOTO1").put("time","2026-10-11T07:00")); // source 允许为空
            eq(x.recordsPage("","","",0,0).getInt("total"),4);
        });
        test("契约C records 超限归档到 records_archive",()->{
            String n=fresh();VitalsDbHelper r=new VitalsDbHelper(getTargetContext(),n);r.recordLimit=10;
            r.saveSample(sample("R1","R1"),null);
            JSONArray adds=new JSONArray();
            for(int i=0;i<12;i++)adds.put(rec("R1").put("time","2026-10-09T08:"+String.format(Locale.ROOT,"%02d",i)).put("detail","批量 "+i));
            r.commit(new JSONObject().put("addRecords",adds));
            eq(r.getRecords(null).length(),10);
            try(Cursor c=r.getReadableDatabase().rawQuery("SELECT COUNT(*) FROM records_archive",null)){c.moveToFirst();eq(c.getLong(0),2);}
            try(Cursor c=r.getReadableDatabase().rawQuery("SELECT detail FROM records_archive ORDER BY id ASC",null)){c.moveToFirst();eq(c.getString(0),"批量 0");}
            r.close();
        });
        test("契约D env 上限 2000：分钟聚合 + 最近 200 点原样",()->{
            String n=fresh();VitalsDbHelper d=new VitalsDbHelper(getTargetContext(),n);
            LocalDateTime start=LocalDateTime.of(2026,1,1,0,0);DateTimeFormatter fmt=DateTimeFormatter.ofPattern("yyyy-MM-dd'T'HH:mm");
            JSONArray same=new JSONArray();
            for(int i=0;i<2500;i++)same.put(new JSONObject().put("time",start.format(fmt)).put("temp",4.0+(i%100)/100.0));
            d.saveSample(sample("ENV-SAME","ENV-SAME").put("env",same),null);
            JSONArray collapsed=d.getSample("ENV-SAME",false).getJSONArray("env");
            eq(collapsed.length(),201); // 2300 个同分钟点聚合为 1 个 + 最近 200 点原样
            eq(collapsed.getJSONObject(0).getString("time"),start.format(fmt));
            yes(Math.abs(collapsed.getJSONObject(0).getDouble("temp")-4.495)<1e-9); // avg
            JSONArray spread=new JSONArray();
            for(int i=0;i<2500;i++)spread.put(new JSONObject().put("time",start.plusMinutes(i).format(fmt)).put("temp",4.0+(i%100)/100.0));
            d.saveSample(sample("ENV-SPREAD","ENV-SPREAD").put("env",spread),null);
            JSONArray saved=d.getSample("ENV-SPREAD",false).getJSONArray("env");
            yes(saved.length()<=2000);
            JSONObject tailFirst=saved.getJSONObject(saved.length()-200); // 最近 200 点保持原始
            eq(tailFirst.getString("time"),start.plusMinutes(2300).format(fmt));
            yes(Math.abs(tailFirst.getDouble("temp")-4.0)<1e-9);
            eq(saved.getJSONObject(saved.length()-1).getString("time"),start.plusMinutes(2499).format(fmt));
            d.close();
        });
        test("契约E WAL 与外键启用，snapshot revision 与库一致",()->{
            try(Cursor c=x.getReadableDatabase().rawQuery("PRAGMA journal_mode",null)){c.moveToFirst();eq(c.getString(0).toLowerCase(Locale.ROOT),"wal");}
            try(Cursor c=x.getReadableDatabase().rawQuery("PRAGMA foreign_keys",null)){c.moveToFirst();eq(c.getInt(0),1);}
            x.setSetting("lo",-80);
            eq(x.snapshot().getLong("revision"),x.info().getLong("revision"));
        });
        test("契约G CSV：BOM/表头/筛选/转义/非法 kind",()->{
            String recordsCsv=x.exportCsv("records","");
            yes(recordsCsv.startsWith("\uFEFF时间,样本,编号,类型,明细,槽位,状态,任务号,来源\r\n"));
            yes(recordsCsv.contains("2026-10-10T07:00"));yes(recordsCsv.contains("scanner"));
            String samplesCsv=x.exportCsv("samples","");
            yes(samplesCsv.startsWith("\uFEFF内部ID,名称,编号,类别,位置,状态,采集时间,温度,备注\r\n"));
            yes(samplesCsv.contains("PHOTO1"));yes(samplesCsv.contains("PHOTO-1"));
            String envCsv=x.exportCsv("env","");
            yes(envCsv.startsWith("\uFEFF样本ID,样本名称,时间,温度\r\n"));yes(envCsv.contains("PHOTO1"));
            String filtered=x.exportCsv("records","{\"typeCode\":\"out\"}");
            yes(filtered.contains("scanner"));yes(!filtered.contains("manual"));
            String n=fresh();VitalsDbHelper g=new VitalsDbHelper(getTargetContext(),n);
            g.saveSample(sample("X","X"),null);
            g.addRecord(rec("X").put("detail","含,逗号\"引号\"\n换行"));
            yes(g.exportCsv("records","").contains("\"含,逗号\"\"引号\"\"\n换行\""));
            fails(()->g.exportCsv("bogus",""));
            g.close();
        });
        x.close();

        /* ---------- 契约 F：自描述备份 / 校验 / 合并 / 子集恢复 ---------- */
        String backupName=fresh();VitalsDbHelper b=new VitalsDbHelper(getTargetContext(),backupName);
        test("契约F 导出：app/schemaVersion/counts/checksum 与导出去 recordId",()->{
            b.setSetting("simOn",false);b.setSetting("online",0); // 导入会强制复位这两项，先写入才能比较往返 checksum
            b.saveSample(sample("B1","B1"),null);
            JSONObject payload=b.exportBackup(false);
            eq(payload.getString("app"),"vitals-biosample");
            eq(payload.getInt("schemaVersion"),4);
            eq(payload.getJSONObject("counts").getInt("samples"),1);
            eq(payload.getJSONObject("counts").getInt("records"),0);
            yes(payload.getString("checksum").startsWith("sha256:"));
            eq(payload.getString("checksum"),BackupFormat.checksum(payload.getJSONObject("samples"),payload.getJSONArray("records"),payload.getJSONObject("settings")));
            JSONObject mine=payload.getJSONObject("samples").getJSONObject("B1");
            yes(!mine.has("photo"));eq(mine.getString("photoHash").length(),64);
            yes(mine.getString("photoPath").endsWith(mine.getString("photoHash")+".jpg")); // 只留 hash/路径，不留全图
            JSONObject withPhotos=b.exportBackup(true);
            eq(withPhotos.getJSONObject("samples").getJSONObject("B1").getString("photo"),"data:image/jpeg;base64,YWJj");
            String roundName=fresh();VitalsDbHelper rt=new VitalsDbHelper(getTargetContext(),roundName);
            eq(rt.importBackupEx(withPhotos.toString(),"replace",null).getBoolean("ok"),true);
            eq(rt.exportBackup(true).getString("checksum"),withPhotos.getString("checksum")); // recordId 不进备份，checksum 可复现
            rt.close();
        });
        test("契约F 夹具 good.json：preview/merge/记录指纹去重",()->{
            JSONObject preview=b.importBackupEx(fixture(FIXTURE_GOOD_B64).toString(),"preview",null);
            eq(preview.getBoolean("ok"),true);eq(preview.getBoolean("dryRun"),true);
            eq(preview.getJSONObject("counts").getInt("samples"),1);eq(preview.getJSONObject("counts").getInt("records"),2);
            eq(preview.getJSONObject("diff").getInt("newSamples"),1);
            eq(preview.getJSONObject("diff").getInt("newRecords"),2);
            eq(preview.getJSONObject("diff").getJSONArray("conflictCodes").length(),0);
            eq(b.getSample("SB-10001",false),null); // preview 不改库
            JSONObject merged=b.importBackupEx(fixture(FIXTURE_GOOD_B64).toString(),"merge",null);
            eq(merged.getBoolean("ok"),true);
            eq(merged.getJSONObject("applied").getInt("newSamples"),1);
            eq(merged.getJSONObject("applied").getInt("newRecords"),2);
            eq(b.getSample("SB-10001",false).getInt("slot"),1);
            JSONArray list=b.getRecords("SB-10001");
            eq(list.length(),2);
            eq(list.getJSONObject(0).getString("source"),"manual");
            eq(list.getJSONObject(0).getString("type_code"),"in");
            eq(list.getJSONObject(0).getString("operator"),"夹具");
            eq(b.getSettings().getInt("hi"),8);
            JSONObject again=b.importBackupEx(fixture(FIXTURE_GOOD_B64).toString(),"preview",null);
            eq(again.getJSONObject("diff").getInt("newSamples"),0);
            eq(again.getJSONObject("diff").getInt("updatedSamples"),1);
            eq(again.getJSONObject("diff").getInt("duplicateRecords"),2);
            eq(again.getJSONObject("diff").getInt("newRecords"),0);
        });
        test("契约F 篡改/计数/app/版本/截断 一律拒绝且库不变",()->{
            int samples=b.getSamples().length(),records=b.getRecords(null).length();
            JSONObject tampered=fixture(FIXTURE_GOOD_B64);tampered.getJSONObject("samples").getJSONObject("SB-10001").put("name","被篡改");
            JSONObject counts=fixture(FIXTURE_GOOD_B64);counts.getJSONObject("counts").put("samples",99);
            JSONObject foreign=fixture(FIXTURE_GOOD_B64);foreign.put("app","other-app");
            JSONObject future=fixture(FIXTURE_GOOD_B64);future.put("schemaVersion",99);
            for(JSONObject payload:new JSONObject[]{tampered,counts,foreign,future}){
                JSONObject result=b.importBackupEx(payload.toString(),"merge",null);
                eq(result.getBoolean("ok"),false);yes(result.getString("error").length()>0);
            }
            String raw=fixture(FIXTURE_GOOD_B64).toString();
            eq(b.importBackupEx(raw.substring(0,raw.length()*3/5),"merge",null).getBoolean("ok"),false);
            eq(b.getSamples().length(),samples);eq(b.getRecords(null).length(),records);
        });
        test("契约F replace 限空库、条码冲突回滚、子集恢复",()->{
            JSONObject refused=b.importBackupEx(fixture(FIXTURE_GOOD_B64).toString(),"replace",null);
            eq(refused.getBoolean("ok"),false);yes(refused.getString("error").contains("merge"));
            String emptyName=fresh();VitalsDbHelper e=new VitalsDbHelper(getTargetContext(),emptyName);
            eq(e.importBackupEx(fixture(FIXTURE_GOOD_B64).toString(),"replace",null).getBoolean("ok"),true);
            eq(e.getSamples().length(),1);e.close();
            int before=b.getSamples().length();
            JSONObject conflict=b.importBackupEx(fixture(FIXTURE_MERGE_B64).toString(),"merge",null); // SB-10003 与 SB-10001 共用 SB-90001
            eq(conflict.getBoolean("ok"),false);yes(conflict.getString("error").contains("SB-90001"));
            eq(b.getSamples().length(),before);
            JSONObject preview=b.importBackupEx(fixture(FIXTURE_MERGE_B64).toString(),"preview",null);
            eq(preview.getBoolean("ok"),true);
            yes(preview.getJSONObject("diff").getJSONArray("conflictCodes").length()>=1);
            eq(preview.getJSONObject("diff").getInt("duplicateRecords"),1);
            String subName=fresh();VitalsDbHelper sub=new VitalsDbHelper(getTargetContext(),subName);
            JSONObject subset=sub.importBackupEx(fixture(FIXTURE_MERGE_B64).toString(),"merge","{\"onlySampleIds\":[\"SB-10002\"]}");
            eq(subset.getBoolean("ok"),true);
            eq(sub.getSamples().length(),1);yes(sub.getSample("SB-10002",false)!=null);
            eq(sub.getRecords(null).length(),2);
            sub.close();
        });
        test("契约F with-photo 夹具：photo 落盘/清空行内/getSamplePhoto 校验 hash",()->{
            JSONObject payload=fixture(FIXTURE_GOOD_B64);
            payload.getJSONObject("samples").getJSONObject("SB-10001").put("photo",WITH_PHOTO_DATA_URL);
            payload.put("checksum",WITH_PHOTO_CHECKSUM);
            String hash=photoHashOf(WITH_PHOTO_DATA_URL);
            String photoDbName=fresh();VitalsDbHelper p=new VitalsDbHelper(getTargetContext(),photoDbName);
            eq(p.importBackupEx(payload.toString(),"merge",null).getBoolean("ok"),true);
            try(Cursor c=p.getReadableDatabase().rawQuery("SELECT photo,photo_path,photo_hash,thumb FROM samples WHERE sample_id='SB-10001'",null)){
                c.moveToFirst();
                yes(c.isNull(0));                                     // 契约A：photo 列被清空
                eq(c.getString(1),photoFile(hash).getAbsolutePath());
                eq(c.getString(2),hash);
                if(!c.isNull(3))yes(c.getString(3).startsWith("data:image/jpeg;base64,")); // 夹具里是截断 JPEG，解不出 thumb 时允许为空
            }
            yes(photoFile(hash).isFile());
            JSONObject got=p.getSamplePhoto("SB-10001",true);
            eq(got.getBoolean("missing"),false);eq(got.getString("hash"),hash);
            eq(photoHashOf(got.getString("photo")),hash);
            yes(!p.exportBackup(false).getJSONObject("samples").getJSONObject("SB-10001").has("photo"));
            p.close();
        });
        test("契约F legacyMeta：旧库 state.s 元信息随备份往返且不进 checksum",()->{
            String srcName=fresh();VitalsDbHelper src=new VitalsDbHelper(getTargetContext(),srcName);
            src.getWritableDatabase().execSQL("INSERT OR REPLACE INTO db_meta (key,value) VALUES ('legacy_s_extra',?)",new Object[]{"{\"samplesSeeded\":true,\"online\":3}"});
            src.getWritableDatabase().execSQL("INSERT OR REPLACE INTO db_meta (key,value) VALUES ('legacy_migrated_at','1700000000000')");
            src.saveSample(sample("L1","L1"),null);
            JSONObject payload=src.exportBackup(false);
            yes(payload.has("legacyMeta"));
            eq(payload.getJSONObject("legacyMeta").getString("legacy_s_extra"),"{\"samplesSeeded\":true,\"online\":3}");
            eq(payload.getJSONObject("legacyMeta").getString("legacy_migrated_at"),"1700000000000");
            eq(payload.getString("checksum"),BackupFormat.checksum(payload.getJSONObject("samples"),payload.getJSONArray("records"),payload.getJSONObject("settings")));
            String dstName=fresh();VitalsDbHelper dst=new VitalsDbHelper(getTargetContext(),dstName);
            eq(dst.importBackupEx(payload.toString(),"replace",null).getBoolean("ok"),true); // 清库后导入 → 恢复
            eq(dst.exportBackup(false).getJSONObject("legacyMeta").getString("legacy_s_extra"),"{\"samplesSeeded\":true,\"online\":3}");
            eq(dst.exportBackup(false).getJSONObject("legacyMeta").getString("legacy_migrated_at"),"1700000000000");
            eq(dst.loadState().getJSONObject("s").getBoolean("samplesSeeded"),true); // loadState 以 legacy_s_extra 作基底
            eq(dst.loadState().getJSONObject("s").getInt("online"),0);
            String cleanName=fresh();VitalsDbHelper clean=new VitalsDbHelper(getTargetContext(),cleanName);
            clean.saveSample(sample("C1","C1"),null);
            yes(!clean.exportBackup(false).has("legacyMeta")); // 无 legacy 键 → 不产生该字段
            eq(dst.importBackupEx(clean.exportBackup(false).toString(),"merge",null).getBoolean("ok"),true);
            eq(dst.exportBackup(false).getJSONObject("legacyMeta").getString("legacy_s_extra"),"{\"samplesSeeded\":true,\"online\":3}"); // 不含 legacyMeta 的导入不动现有值
            src.close();dst.close();clean.close();
        });
        b.close();

        /* ---------- 契约 A/C/E：旧库（v3 旧表结构）升级路径 ---------- */
        test("旧库升级：v3 无新列 → 补列/重建 records/照片外置/时间 ISO/新索引",()->{
            String upgradeName=fresh();
            SQLiteDatabase db=getTargetContext().openOrCreateDatabase(upgradeName,0,null);
            db.execSQL("CREATE TABLE samples (sample_id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL, barcode TEXT UNIQUE, status TEXT NOT NULL CHECK(status IN ('in','out')), slot INTEGER, last_slot INTEGER, pending_intake INTEGER NOT NULL DEFAULT 0, type TEXT, location TEXT, collected_at TEXT, collected_time_text TEXT, temperature REAL, note TEXT, photo TEXT, created_at INTEGER, updated_at INTEGER, monitor INTEGER NOT NULL DEFAULT 0, last_temperature REAL, last_humidity REAL, last_light REAL, last_update TEXT, alert TEXT, qr_snapshot TEXT, extra_json TEXT NOT NULL DEFAULT '{}')");
            db.execSQL("CREATE TABLE records (id INTEGER PRIMARY KEY AUTOINCREMENT, sample_id TEXT, sample_name TEXT NOT NULL DEFAULT '', time TEXT NOT NULL DEFAULT '', type TEXT NOT NULL DEFAULT '', detail TEXT NOT NULL DEFAULT '', barcode TEXT, slot INTEGER, status TEXT, task_id TEXT, extra_json TEXT NOT NULL DEFAULT '{}')");
            db.execSQL("CREATE TABLE settings (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL)");
            db.execSQL("CREATE TABLE db_meta (key TEXT PRIMARY KEY NOT NULL,value TEXT NOT NULL)");
            db.execSQL("INSERT INTO db_meta VALUES('legacy_migration','done')");
            db.execSQL("INSERT INTO samples (sample_id,name,barcode,status,slot,type,photo,extra_json) VALUES('V3-1','旧样本','V3-CODE','in',1,'全血','data:image/jpeg;base64,YWJj','{}')");
            db.execSQL("INSERT INTO records (sample_id,sample_name,time,type,detail) VALUES('V3-1','旧样本','2026-09-14 12:00','入库','旧记录')");
            db.setVersion(3);db.close();
            VitalsDbHelper up=new VitalsDbHelper(getTargetContext(),upgradeName);
            String hash=BackupFormat.sha256Hex("abc".getBytes(StandardCharsets.UTF_8));
            JSONObject upgraded=up.getSample("V3-1",false);
            eq(upgraded.getString("photoHash"),hash);
            eq(upgraded.getString("photo"),"data:image/jpeg;base64,YWJj");
            try(Cursor c=up.getReadableDatabase().rawQuery("SELECT photo FROM samples WHERE sample_id='V3-1'",null)){c.moveToFirst();yes(c.isNull(0));}
            yes(photoFile(hash).isFile());
            try(Cursor c=up.getReadableDatabase().rawQuery("SELECT time,operator,source,type_code FROM records LIMIT 1",null)){c.moveToFirst();eq(c.getString(0),"2026-09-14T12:00");yes(c.isNull(1)&&c.isNull(2)&&c.isNull(3));}
            try(Cursor c=up.getReadableDatabase().rawQuery("SELECT name FROM sqlite_master WHERE type='index' AND name IN ('records_time','records_type_code') ORDER BY name",null)){c.moveToFirst();eq(c.getString(0),"records_time");c.moveToNext();eq(c.getString(0),"records_type_code");}
            try(Cursor c=up.getReadableDatabase().rawQuery("SELECT 1 FROM sqlite_master WHERE type='table' AND name='records_archive'",null)){yes(c.moveToFirst());}
            fails(()->up.getWritableDatabase().execSQL("INSERT INTO records (time,detail,source) VALUES('2026-09-14T12:00','x','bogus')"));
            eq(up.info().getInt("version"),3); // 兼容既有断言：user_version 不前进
            up.close();
        });
    }
}
