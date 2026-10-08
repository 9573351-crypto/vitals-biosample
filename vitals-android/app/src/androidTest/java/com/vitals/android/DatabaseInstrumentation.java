package com.vitals.android;

import android.app.Instrumentation;
import android.app.Activity;
import android.content.ContentValues;
import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;
import android.os.Bundle;
import org.json.*;
import java.util.*;

/** Real Android SQLite tests, with separate test DB files; never edits production vitals.db. */
public final class DatabaseInstrumentation extends Instrumentation {
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
    private JSONObject sample(String id,String code)throws Exception{return new JSONObject().put("id",id).put("name","样本 "+id).put("code",code).put("status","out").put("temp",4.2).put("createdAt",123456789L).put("updatedAt",123456790L).put("photo","data:image/jpeg;base64,YWJj").put("qrSnap","旧二维码快照").put("env",new JSONArray().put(new JSONObject().put("time","2026-09-14 12:00").put("temp",4.2))).put("customField",new JSONObject().put("keep",true));}
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
            eq(h.getSamples().length(),0);eq(h.getRecords(null).length(),0);eq(h.info().getInt("version"),2);
            try(Cursor c=h.getReadableDatabase().rawQuery("PRAGMA foreign_keys",null)){c.moveToFirst();eq(c.getInt(0),1);}
        });
        test("create sample plus linked record",()->{h.saveSample(sample("A","CODE-A"),rec("A"));eq(h.getRecords("A").length(),1);eq(h.getSample("A",false).getString("code"),"CODE-A");});
        test("update retains FK and photo/extra fields",()->{JSONObject a=h.getSample("A",false);a.put("name","改名");h.saveSample(a,null);eq(h.getRecords("A").length(),1);eq(h.getSample("A",false).getJSONObject("customField").getBoolean("keep"),true);eq(h.getSample("A",false).getString("photo"),"data:image/jpeg;base64,YWJj");});
        test("barcode unique and parameter binding",()->{fails(()->h.saveSample(sample("B","CODE-A"),null));eq(h.getSample("CODE-A",true).getString("id"),"A");eq(h.getSample("' OR 1=1 --",true),null);});
        test("slot range and integer validation",()->{fails(()->h.saveSample(sample("B","B").put("status","in").put("slot",6),null));fails(()->h.saveSample(sample("B","B").put("status","in").put("slot",1.5),null));});
        test("status and field types",()->{fails(()->h.saveSample(sample("B","B").put("status","pending"),null));fails(()->h.saveSample(sample("B","B").put("monitor","yes"),null));fails(()->h.saveSample(sample("B","B").put("temp","4"),null));});
        test("inbound atomic with history",()->{JSONObject a=h.getSample("A",false).put("status","in").put("slot",1);h.saveSample(a,rec("A").put("type","入库").put("slot",1));eq(h.getRecords("A").length(),2);eq(h.getSample("A",false).getInt("slot"),1);});
        test("occupied slot rejects second sample",()->{fails(()->h.saveSample(sample("B","B").put("status","in").put("slot",1),null));eq(h.getSamples().length(),1);});
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
    }
}
