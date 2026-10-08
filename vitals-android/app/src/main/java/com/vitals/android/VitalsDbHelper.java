package com.vitals.android;

import android.content.ContentValues;
import android.content.Context;
import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;
import android.database.sqlite.SQLiteOpenHelper;
import org.json.*;
import java.util.*;

/** SQLite is the only durable source. All public reads/writes share this helper's lock.
 * JS keeps its rendering model; only changed rows cross the Bridge during normal writes.
 * Base64 photos remain TEXT for compatibility. Large deployments should migrate images separately.
 */
public final class VitalsDbHelper extends SQLiteOpenHelper {
    public static final String DB_NAME = "vitals.db";
    public static final int DB_VERSION = 2;
    private static final String[] JS = {"id","name","code","status","slot","lastSlot","pendingIntake","type","loc","timeRaw","timeTxt","temp","note","photo","createdAt","updatedAt","monitor","lastTemp","lastHum","lastLight","lastUpdate","alert","qrSnap"};
    private static final String[] SQL = {"sample_id","name","barcode","status","slot","last_slot","pending_intake","type","location","collected_at","collected_time_text","temperature","note","photo","created_at","updated_at","monitor","last_temperature","last_humidity","last_light","last_update","alert","qr_snapshot"};
    private static final Set<String> INTS = new HashSet<>(Arrays.asList("slot","lastSlot","createdAt","updatedAt"));
    private static final Set<String> NUMS = new HashSet<>(Arrays.asList("temp","lastTemp","lastHum","lastLight"));
    private static final Set<String> BOOLS = new HashSet<>(Arrays.asList("monitor","pendingIntake"));
    private static final String[] RJS={"recordId","sampleId","sample","time","type","detail","code","slot","status","taskId"};
    private static final String[] RSQL={"id","sample_id","sample_name","time","type","detail","barcode","slot","status","task_id"};
    public VitalsDbHelper(Context context){this(context,DB_NAME);}
    VitalsDbHelper(Context context,String name){super(context,name,null,DB_VERSION);}
    @Override public void onConfigure(SQLiteDatabase db){db.setForeignKeyConstraintsEnabled(true);}
    @Override public void onCreate(SQLiteDatabase db){createTables(db);migrateLegacy(db);}
    @Override public void onUpgrade(SQLiteDatabase db,int oldVersion,int newVersion){createTables(db);migrateLegacy(db);}
    @Override public void onOpen(SQLiteDatabase db){super.onOpen(db);migrateLegacy(db);}
    private void createTables(SQLiteDatabase db){
        db.execSQL("CREATE TABLE IF NOT EXISTS samples (sample_id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL, barcode TEXT UNIQUE, status TEXT NOT NULL CHECK(status IN ('in','out')), slot INTEGER UNIQUE CHECK(slot IS NULL OR (typeof(slot)='integer' AND slot BETWEEN 1 AND 5)), last_slot INTEGER CHECK(last_slot IS NULL OR (typeof(last_slot)='integer' AND last_slot BETWEEN 1 AND 5)), pending_intake INTEGER NOT NULL DEFAULT 0 CHECK(pending_intake IN (0,1)), type TEXT, location TEXT, collected_at TEXT, collected_time_text TEXT, temperature REAL, note TEXT, photo TEXT, created_at INTEGER, updated_at INTEGER, monitor INTEGER NOT NULL DEFAULT 0 CHECK(monitor IN (0,1)), last_temperature REAL, last_humidity REAL, last_light REAL, last_update TEXT, alert TEXT CHECK(alert IS NULL OR alert IN ('good','warn','bad')), qr_snapshot TEXT, extra_json TEXT NOT NULL DEFAULT '{}', CHECK(status='in' OR slot IS NULL))");
        db.execSQL("CREATE TABLE IF NOT EXISTS records (id INTEGER PRIMARY KEY AUTOINCREMENT, sample_id TEXT, sample_name TEXT NOT NULL DEFAULT '', time TEXT NOT NULL DEFAULT '', type TEXT NOT NULL DEFAULT '', detail TEXT NOT NULL DEFAULT '', barcode TEXT, slot INTEGER CHECK(slot IS NULL OR (typeof(slot)='integer' AND slot BETWEEN 1 AND 5)), status TEXT CHECK(status IS NULL OR status IN ('in','out')), task_id TEXT, extra_json TEXT NOT NULL DEFAULT '{}', FOREIGN KEY(sample_id) REFERENCES samples(sample_id) ON DELETE SET NULL)");
        db.execSQL("CREATE INDEX IF NOT EXISTS records_sample_time ON records(sample_id,time)");
        db.execSQL("CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL)");
        db.execSQL("CREATE TABLE IF NOT EXISTS db_meta (key TEXT PRIMARY KEY NOT NULL,value TEXT NOT NULL)");
    }
    private static boolean table(SQLiteDatabase db,String name){try(Cursor c=db.rawQuery("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?",new String[]{name})){return c.moveToFirst();}}
    private static String meta(SQLiteDatabase db,String key,String fallback){try(Cursor c=db.rawQuery("SELECT value FROM db_meta WHERE key=?",new String[]{key})){return c.moveToFirst()?c.getString(0):fallback;}}
    private static void putMeta(SQLiteDatabase db,String key,String value){ContentValues v=new ContentValues();v.put("key",key);v.put("value",value);db.insertWithOnConflict("db_meta",null,v,SQLiteDatabase.CONFLICT_REPLACE);}
    private static long count(SQLiteDatabase db,String table){try(Cursor c=db.rawQuery("SELECT COUNT(*) FROM "+table,null)){c.moveToFirst();return c.getLong(0);}} // table is internal constant only
    private void migrateLegacy(SQLiteDatabase db){
        if("done".equals(meta(db,"legacy_migration","")))return;
        db.beginTransaction();
        try {
            if(count(db,"samples")==0 && count(db,"records")==0 && count(db,"settings")==0 && table(db,"app_state")){
                try(Cursor c=db.rawQuery("SELECT payload FROM app_state WHERE id=?",new String[]{"1"})){
                    if(c.moveToFirst()){
                        JSONObject raw=new JSONObject(c.getString(0));
                        importRows(db,normalizeBackup(raw,true));
                        if(raw.has("s")){
                            JSONObject other=copy(raw.getJSONObject("s"));other.remove("samples");other.remove("records");other.remove("settings");
                            putMeta(db,"legacy_s_extra",other.toString());
                        }
                        putMeta(db,"legacy_migrated_at",Long.toString(System.currentTimeMillis()));
                    }
                }
            }
            putMeta(db,"legacy_migration","done");
            putMeta(db,"revision",meta(db,"revision","0"));
            db.setTransactionSuccessful();
        } catch(Exception e){throw new IllegalStateException("旧数据库迁移失败，原数据已保留："+e.getMessage(),e);}
        finally {db.endTransaction();}
    }
    private static JSONObject copy(JSONObject x)throws JSONException{return new JSONObject(x.toString());}
    private static boolean value(JSONObject x,String k){return x.has(k)&&!x.isNull(k);}
    private static String text(JSONObject x,String key,boolean required)throws JSONException{
        if(!value(x,key)){if(required)throw new JSONException("缺少字段 "+key);return null;}
        Object v=x.get(key);if(!(v instanceof String))throw new JSONException(key+" 必须为文本");
        return (String)v;
    }
    private static double number(Object v,String key,boolean integer)throws JSONException{
        if(!(v instanceof Number)||!Double.isFinite(((Number)v).doubleValue()))throw new JSONException(key+" 必须为有效数值");
        double n=((Number)v).doubleValue();if(integer&&(n!=Math.rint(n)||Math.abs(n)>9007199254740991d))throw new JSONException(key+" 必须为安全整数");return n;
    }
    private static void id(String id)throws JSONException{if(id==null||!id.matches("[-a-zA-Z0-9_]+")||Arrays.asList("__proto__","constructor","prototype").contains(id))throw new JSONException("无效内部样本 ID");}
    private static void range(Object v,String name)throws JSONException{double n=number(v,name,true);if(n<1||n>5)throw new JSONException(name+" 必须在 1—5");}
    private static JSONObject normalizeSample(JSONObject source,String fallback)throws JSONException{
        JSONObject x=copy(source);if(!value(x,"id"))x.put("id",fallback);id(text(x,"id",true));
        text(x,"name",true);
        if(!value(x,"status"))x.put("status","in");
        if(!Arrays.asList("in","out").contains(text(x,"status",true)))throw new JSONException("无效库存状态");
        for(String k:JS){
            if(!value(x,k))continue;
            if(INTS.contains(k))number(x.get(k),k,true);
            else if(NUMS.contains(k))number(x.get(k),k,false);
            else if(BOOLS.contains(k)){if(!(x.get(k) instanceof Boolean))throw new JSONException(k+" 必须为布尔值");}
            else text(x,k,false);
        }
        for(String k:Arrays.asList("slot","lastSlot"))if(value(x,k))range(x.get(k),k);
        if("out".equals(x.getString("status"))&&value(x,"slot")){x.put("lastSlot",x.get("slot"));x.remove("slot");}
        if(value(x,"alert")&&!Arrays.asList("good","warn","bad").contains(x.getString("alert")))throw new JSONException("无效温度状态");
        if(value(x,"photo")&&!x.getString("photo").isEmpty()&&!x.getString("photo").matches("(?s)^data:image/(png|jpeg|webp);base64,[a-zA-Z0-9+/=\\s]+$"))throw new JSONException("照片格式不支持");
        if(value(x,"env")){
            JSONArray env=x.getJSONArray("env");
            for(int i=0;i<env.length();i++){JSONObject p=env.getJSONObject(i);text(p,"time",false);for(String k:Arrays.asList("temp","hum","light"))if(value(p,k))number(p.get(k),k,false);}
        }
        return x;
    }
    private static JSONObject normalizeSettings(JSONObject src)throws JSONException{
        JSONObject s=copy(src);
        for(Iterator<String> it=s.keys();it.hasNext();){String k=it.next();checkKey(k);if(k.equals("hi")||k.equals("lo"))number(s.get(k),k,false);}
        if(value(s,"simOn")&&!(s.get("simOn") instanceof Boolean))throw new JSONException("simOn 必须为布尔值");
        if(value(s,"online"))number(s.get("online"),"online",true);
        if(value(s,"motionTask")){
            JSONObject t=s.getJSONObject("motionTask");id(text(t,"sampleId",true));text(t,"taskId",true);
            if(!Arrays.asList("in","out").contains(text(t,"action",true)))throw new JSONException("任务动作无效");
            if(!Arrays.asList("manual","hardware").contains(text(t,"mode",true)))throw new JSONException("任务模式无效");
            if(!Arrays.asList("sent","accepted","arrived","verify","uncertain").contains(text(t,"phase",true)))throw new JSONException("任务阶段无效");
            range(t.get("slot"),"task.slot");number(t.get("createdAt"),"task.createdAt",true);text(t,"error",false);
        }
        return s;
    }
    private static void checkKey(String k)throws JSONException{if(k==null||k.isEmpty()||k.length()>200||Arrays.asList("__proto__","constructor","prototype").contains(k))throw new JSONException("设置键无效");}
    static JSONObject normalizeBackup(Object source,boolean migration)throws JSONException{
        JSONObject data=source instanceof JSONObject?(JSONObject)source:new JSONObject();
        Object samples=source;JSONArray records=new JSONArray();JSONObject settings=new JSONObject();
        if(data.has("s")){JSONObject s=data.getJSONObject("s");samples=s.get("samples");records=data.has("rec")?data.getJSONArray("rec"):s.optJSONArray("records");settings=data.has("set")?data.getJSONObject("set"):s.optJSONObject("settings");}
        else if(data.has("samples")){samples=data.get("samples");records=data.has("records")?data.getJSONArray("records"):new JSONArray();settings=data.has("settings")?data.getJSONObject("settings"):new JSONObject();}
        if(!(samples instanceof JSONObject)&&!(samples instanceof JSONArray))throw new JSONException("样本集合格式无效");
        JSONObject normalized=new JSONObject();Set<String> codes=new HashSet<>();Set<Integer> slots=new HashSet<>();
        List<String> keys=new ArrayList<>();
        if(samples instanceof JSONObject)((JSONObject)samples).keys().forEachRemaining(keys::add);
        else for(int i=0;i<((JSONArray)samples).length();i++)keys.add(Integer.toString(i));
        for(String key:keys){
            JSONObject item=samples instanceof JSONObject?((JSONObject)samples).getJSONObject(key):((JSONArray)samples).getJSONObject(Integer.parseInt(key));
            JSONObject x=normalizeSample(item,key);String sid=x.getString("id");
            if(normalized.has(sid))throw new JSONException("样本 ID 重复："+sid);
            String code=text(x,"code",false);if(code!=null&&!code.isEmpty()&&!codes.add(code))throw new JSONException("条码重复："+code);
            if(value(x,"slot")&&!slots.add(x.getInt("slot")))throw new JSONException("槽位重复："+x.getInt("slot"));
            normalized.put(sid,x);
        }
        JSONObject set=normalizeSettings(settings==null?new JSONObject():settings);
        if(!migration&&value(set,"motionTask"))throw new JSONException("备份含未完成机械任务，请先在原设备核实");
        if(!migration){set.put("simOn",false);set.put("online",0);}
        return new JSONObject().put("samples",normalized).put("records",records==null?new JSONArray():records).put("settings",set);
    }
    private static ContentValues sampleValues(JSONObject x)throws JSONException{
        ContentValues v=new ContentValues();JSONObject extra=copy(x);
        for(int i=0;i<JS.length;i++){
            String k=JS[i],col=SQL[i];extra.remove(k);
            if(BOOLS.contains(k)){v.put(col,x.optBoolean(k,false)?1:0);continue;}
            if(!value(x,k)||(k.equals("code")&&x.getString(k).isEmpty())){v.putNull(col);continue;}
            if(INTS.contains(k))v.put(col,x.getLong(k));else if(NUMS.contains(k))v.put(col,x.getDouble(k));else v.put(col,x.getString(k));
        }
        v.put("extra_json",extra.toString());return v;
    }
    private static void upsert(SQLiteDatabase db,JSONObject raw)throws JSONException{
        JSONObject x=normalizeSample(raw,null);ContentValues v=sampleValues(x);
        // UPDATE preserves children; INSERT OR REPLACE would delete/recreate the parent.
        if(db.update("samples",v,"sample_id=?",new String[]{x.getString("id")})==0)db.insertOrThrow("samples",null,v);
    }
    private static JSONObject sample(Cursor c)throws JSONException{
        JSONObject x=new JSONObject(c.getString(c.getColumnIndexOrThrow("extra_json")));
        for(int i=0;i<JS.length;i++){int col=c.getColumnIndexOrThrow(SQL[i]);if(c.isNull(col))continue;
            if(BOOLS.contains(JS[i]))x.put(JS[i],c.getInt(col)!=0);else if(INTS.contains(JS[i]))x.put(JS[i],c.getLong(col));else if(NUMS.contains(JS[i]))x.put(JS[i],c.getDouble(col));else x.put(JS[i],c.getString(col));}
        return x;
    }
    private static JSONObject samples(SQLiteDatabase db)throws JSONException{
        JSONObject out=new JSONObject();try(Cursor c=db.query("samples",null,null,null,null,null,"sample_id")){while(c.moveToNext()){JSONObject x=sample(c);out.put(x.getString("id"),x);}}return out;
    }
    private static long insertRecord(SQLiteDatabase db,JSONObject raw,boolean inferLegacy)throws JSONException{
        JSONObject r=copy(raw),extra=copy(r);ContentValues v=new ContentValues();
        for(String k:RJS)extra.remove(k);
        String sid=text(r,"sampleId",false);
        if(sid!=null)id(sid);
        String name=text(r,"sample",false);
        if(sid==null&&inferLegacy&&name!=null&&!name.equals("系统")){
            try(Cursor c=db.rawQuery("SELECT sample_id FROM samples WHERE name=? LIMIT 2",new String[]{name})){if(c.getCount()==1){c.moveToFirst();sid=c.getString(0);}}
        }
        if(sid==null)v.putNull("sample_id");else v.put("sample_id",sid);
        for(int i=2;i<RJS.length;i++){
            String k=RJS[i];if(k.equals("slot")){if(value(r,k)){range(r.get(k),k);v.put(RSQL[i],r.getInt(k));}continue;}
            String val=text(r,k,false);if(i<=5)v.put(RSQL[i],val==null?"":val);else if(val!=null)v.put(RSQL[i],val);
        }
        if(value(r,"status")&&!Arrays.asList("in","out").contains(r.getString("status")))throw new JSONException("记录状态无效");
        v.put("extra_json",extra.toString());return db.insertOrThrow("records",null,v);
    }
    private static JSONArray records(SQLiteDatabase db,String sid)throws JSONException{
        JSONArray out=new JSONArray();try(Cursor c=db.query("records",null,sid==null?null:"sample_id=?",sid==null?null:new String[]{sid},null,null,"id DESC")){
            while(c.moveToNext()){JSONObject r=new JSONObject(c.getString(c.getColumnIndexOrThrow("extra_json")));
                for(int i=0;i<RJS.length;i++){int col=c.getColumnIndexOrThrow(RSQL[i]);if(c.isNull(col)){if(i==1)r.put("sampleId",JSONObject.NULL);continue;}r.put(RJS[i],i==0||i==7?c.getLong(col):c.getString(col));}out.put(r);}
        }return out;
    }
    private static JSONObject settings(SQLiteDatabase db)throws JSONException{JSONObject s=new JSONObject();try(Cursor c=db.query("settings",null,null,null,null,null,"key")){while(c.moveToNext())s.put(c.getString(c.getColumnIndexOrThrow("key")),new JSONTokener(c.getString(c.getColumnIndexOrThrow("value"))).nextValue());}return s;}
    private static void setting(SQLiteDatabase db,String key,Object value)throws JSONException{checkKey(key);ContentValues v=new ContentValues();v.put("key",key);String json=new JSONArray().put(value).toString();v.put("value",json.substring(1,json.length()-1));db.insertWithOnConflict("settings",null,v,SQLiteDatabase.CONFLICT_REPLACE);}
    private static void importRows(SQLiteDatabase db,JSONObject b)throws JSONException{
        JSONObject samples=b.getJSONObject("samples");for(Iterator<String> it=samples.keys();it.hasNext();)upsert(db,samples.getJSONObject(it.next()));
        JSONArray rec=b.getJSONArray("records");for(int i=rec.length()-1;i>=0;i--)insertRecord(db,rec.getJSONObject(i),true);
        JSONObject set=b.getJSONObject("settings");for(Iterator<String> it=set.keys();it.hasNext();){String k=it.next();setting(db,k,set.get(k));}
        validateTask(db);
    }
    private static void validateTask(SQLiteDatabase db)throws JSONException{
        JSONObject set=normalizeSettings(settings(db));if(!value(set,"motionTask"))return;
        JSONObject t=set.getJSONObject("motionTask");String sid=t.getString("sampleId");
        try(Cursor c=db.rawQuery("SELECT status,slot FROM samples WHERE sample_id=?",new String[]{sid})){
            if(!c.moveToFirst())throw new JSONException("任务样本不存在");
            if(t.getString("action").equals("out")&&(!c.getString(0).equals("in")||c.isNull(1)||c.getInt(1)!=t.getInt("slot")))throw new JSONException("出库任务与在库槽位不一致");
            if(t.getString("action").equals("in")&&!c.getString(0).equals("out"))throw new JSONException("入库任务样本已在库");
        }
        try(Cursor c=db.rawQuery("SELECT 1 FROM samples WHERE slot=? AND sample_id<>?",new String[]{Integer.toString(t.getInt("slot")),sid})){if(c.moveToFirst())throw new JSONException("任务槽位被其他样本占用");}
    }
    private static long revision(SQLiteDatabase db){return Long.parseLong(meta(db,"revision","0"));}
    public synchronized JSONObject info()throws JSONException{SQLiteDatabase db=getReadableDatabase();return new JSONObject().put("version",db.getVersion()).put("revision",revision(db)).put("legacyMigration",meta(db,"legacy_migration",""));}
    public synchronized JSONObject getSamples()throws JSONException{return samples(getReadableDatabase());}
    public synchronized JSONObject getSample(String key,boolean barcode)throws JSONException{
        if(barcode){if(key==null||key.isEmpty())throw new JSONException("条码不能为空");}else id(key);
        try(Cursor c=getReadableDatabase().query("samples",null,barcode?"barcode=?":"sample_id=?",new String[]{key},null,null,null)){return c.moveToFirst()?sample(c):null;}
    }
    public synchronized JSONArray getRecords(String sid)throws JSONException{if(sid!=null&&!sid.isEmpty())id(sid);return records(getReadableDatabase(),sid==null||sid.isEmpty()?null:sid);}
    public synchronized JSONObject getSettings()throws JSONException{return settings(getReadableDatabase());}
    public synchronized JSONObject loadState()throws JSONException{
        SQLiteDatabase db=getReadableDatabase();JSONObject s=new JSONObject(meta(db,"legacy_s_extra","{}"));
        JSONObject list=samples(db);s.put("samples",list).put("total",list.length()).put("online",0);
        return new JSONObject().put("s",s).put("rec",records(db,null)).put("set",settings(db));
    }
    public synchronized JSONObject exportBackup()throws JSONException{return new JSONObject().put("app","vitals-biosample").put("version",2).put("exportedAt",new java.text.SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ssXXX",Locale.ROOT).format(new Date())).put("samples",getSamples()).put("records",getRecords(null)).put("settings",getSettings());}
    public synchronized JSONObject commit(JSONObject change)throws JSONException{
        SQLiteDatabase db=getWritableDatabase();db.beginTransaction();
        try{
            if(value(change,"expectedRevision")&&(long)number(change.get("expectedRevision"),"expectedRevision",true)!=revision(db))throw new JSONException("数据已变化，请刷新后重试");
            for(Iterator<String> it=change.keys();it.hasNext();)if(!Arrays.asList("expectedRevision","upsertSamples","deleteSamples","addRecords","deleteRecords","setSettings","deleteSettings").contains(it.next()))throw new JSONException("未知变更字段");
            JSONArray del=change.has("deleteRecords")?change.getJSONArray("deleteRecords"):new JSONArray();
            for(int i=0;i<del.length();i++){long rid=(long)number(del.get(i),"recordId",true);if(rid<=0)throw new JSONException("记录 ID 无效");db.delete("records","id=?",new String[]{Long.toString(rid)});}
            JSONArray remove=change.has("deleteSamples")?change.getJSONArray("deleteSamples"):new JSONArray();
            for(int i=0;i<remove.length();i++){String sid=remove.getString(i);id(sid);db.delete("samples","sample_id=?",new String[]{sid});}
            JSONArray up=change.has("upsertSamples")?change.getJSONArray("upsertSamples"):new JSONArray();
            for(int i=0;i<up.length();i++)upsert(db,up.getJSONObject(i));
            JSONArray adds=change.has("addRecords")?change.getJSONArray("addRecords"):new JSONArray(),ids=new JSONArray();
            // oldest first for stable id DESC presentation; return IDs in the caller's array order
            long[] newIds=new long[adds.length()];for(int i=adds.length()-1;i>=0;i--)newIds[i]=insertRecord(db,adds.getJSONObject(i),false);for(long n:newIds)ids.put(n);
            JSONObject set=change.has("setSettings")?normalizeSettings(change.getJSONObject("setSettings")):new JSONObject();
            for(Iterator<String> it=set.keys();it.hasNext();){String k=it.next();setting(db,k,set.get(k));}
            JSONArray keys=change.has("deleteSettings")?change.getJSONArray("deleteSettings"):new JSONArray();for(int i=0;i<keys.length();i++){String k=keys.getString(i);checkKey(k);db.delete("settings","key=?",new String[]{k});}
            validateTask(db);
            long revision=revision(db)+1;putMeta(db,"revision",Long.toString(revision));
            db.setTransactionSuccessful();return new JSONObject().put("ok",true).put("revision",revision).put("recordIds",ids);
        }finally{db.endTransaction();}
    }
    public synchronized JSONObject replaceBackup(String payload)throws JSONException{
        if(payload==null||payload.length()>24*1024*1024)throw new JSONException("备份过大或为空");
        JSONObject b=normalizeBackup(new JSONTokener(payload.replaceFirst("^\\uFEFF","")).nextValue(),false);
        SQLiteDatabase db=getWritableDatabase();db.beginTransaction();
        try{
            if(value(settings(db),"motionTask"))throw new JSONException("请先处理当前机械任务");
            db.delete("records",null,null);db.delete("samples",null,null);db.delete("settings",null,null);
            importRows(db,b);putMeta(db,"revision",Long.toString(revision(db)+1));db.setTransactionSuccessful();return new JSONObject().put("ok",true);
        }finally{db.endTransaction();}
    }
    public synchronized JSONObject saveSample(JSONObject sample,JSONObject record)throws JSONException{
        JSONObject c=new JSONObject().put("upsertSamples",new JSONArray().put(sample));if(record!=null)c.put("addRecords",new JSONArray().put(record));return commit(c);
    }
    public synchronized JSONObject deleteSample(String sid,JSONObject record)throws JSONException{
        id(sid);JSONObject c=new JSONObject().put("deleteSamples",new JSONArray().put(sid));if(record!=null)c.put("addRecords",new JSONArray().put(record));return commit(c);
    }
    public synchronized JSONObject addRecord(JSONObject record)throws JSONException{return commit(new JSONObject().put("addRecords",new JSONArray().put(record)));}
    public synchronized JSONObject setSetting(String key,Object value)throws JSONException{return commit(new JSONObject().put("setSettings",new JSONObject().put(key,value)));}
    @Override public synchronized void close(){super.close();}
}
