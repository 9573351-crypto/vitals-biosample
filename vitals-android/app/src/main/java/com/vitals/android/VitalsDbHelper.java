package com.vitals.android;

import android.content.ContentValues;
import android.content.Context;
import android.database.Cursor;
import android.database.sqlite.SQLiteConstraintException;
import android.database.sqlite.SQLiteDatabase;
import android.database.sqlite.SQLiteOpenHelper;
import org.json.*;
import java.io.File;
import java.time.LocalDateTime;
import java.time.format.DateTimeFormatter;
import java.time.temporal.ChronoUnit;
import java.util.*;

/** SQLite is the only durable source. All public reads/writes share this helper's lock (synchronized),
 * so a caller always observes a consistent revision; snapshot() additionally wraps its four reads in one
 * read transaction. JS keeps its rendering model; only changed rows cross the Bridge during normal writes.
 *
 * <p><b>照片外置（契约 A）</b>：samples.photo 仅作历史兼容列；新写入把全图落到
 * {@code files/photos/<sha256[:2]>/<sha256>.jpg}，行内只留 photo_path/photo_hash/thumb（thumb 长边≤160）。
 * 先写文件再提交数据库行，落盘失败时保留内联 photo，绝不出现「有路径无文件」的半状态。
 * 一次性迁移幂等记录在 {@code db_meta.photo_migrated=done}。
 *
 * <p><b>备份校验和（契约 F）</b>：{@code checksum = "sha256:" + sha256(UTF-8(canonical(samples) + canonical(records) + canonical(settings)))}。
 * canonical 为「对象键按 UTF-16 码元升序、数组保序、无多余空白」的 JSON 文本，字符串转义与数字表示与
 * {@code JSON.stringify} 一致；三段分别规范化后直接首尾拼接、不加分隔符。实现见 {@link BackupFormat}，
 * 校验时对 payload 原文计算（含 records[].recordId，保证夹具/good.json 级别的一致性）；导出时不写 recordId
 * （本机自增行号），因此「导出→导入→再导出」规范文本与 checksum 相同。
 *
 * <p><b>schema 版本策略</b>：user_version 保持 3（既有 DatabaseInstrumentation 断言锁定它），新列/新索引由
 * {@link #ensureSchemaLocked} 幂等增量补齐；备份自描述版本另用 {@link #BACKUP_SCHEMA_VERSION}（=4）。
 *
 * <p>契约偏离（已报备）：旧签名 replaceBackup(String) 保持「无条件整体替换 + 失败抛错」的原语义（现有断言依赖），
 * 空库限制只作用于 importBackupEx(..., "replace")。
 */
public final class VitalsDbHelper extends SQLiteOpenHelper {
    public static final String DB_NAME = "vitals.db";
    /** 保持 3：DatabaseInstrumentation 断言锁定 user_version；新 schema 通过 ensureSchemaLocked() 增量升级。 */
    public static final int DB_VERSION = 3;
    /** 契约 F：备份自描述格式版本（schemaVersion ≤ 该值才可导入）。 */
    public static final int BACKUP_SCHEMA_VERSION = 4;
    /** 应用版本号由 MainActivity 用 BuildConfig.VERSION_NAME 注入，避免数据层编译期依赖生成的 BuildConfig。 */
    static String appVersion = "";
    private static final String[] JS = {"id","name","code","status","slot","lastSlot","pendingIntake","type","loc","timeRaw","timeTxt","temp","note","photo","photoPath","photoHash","thumb","createdAt","updatedAt","monitor","lastTemp","lastHum","lastLight","lastUpdate","alert","qrSnap"};
    private static final String[] SQL = {"sample_id","name","barcode","status","slot","last_slot","pending_intake","type","location","collected_at","collected_time_text","temperature","note","photo","photo_path","photo_hash","thumb","created_at","updated_at","monitor","last_temperature","last_humidity","last_light","last_update","alert","qr_snapshot"};
    private static final Set<String> INTS = new HashSet<>(Arrays.asList("slot","lastSlot","createdAt","updatedAt"));
    private static final Set<String> NUMS = new HashSet<>(Arrays.asList("temp","lastTemp","lastHum","lastLight"));
    private static final Set<String> BOOLS = new HashSet<>(Arrays.asList("monitor","pendingIntake"));
    private static final String[] RJS={"recordId","sampleId","sample","time","type","detail","code","slot","status","taskId","operator","source","typeCode"};
    private static final String[] RSQL={"id","sample_id","sample_name","time","type","detail","barcode","slot","status","task_id","operator","source","type_code"};
    private static final String[] ENV_FIELDS={"temp","hum","light"};
    private static final Set<String> STORAGE_TYPES = new HashSet<>(Arrays.asList("全血","血清","血浆"));
    private static final Set<String> RECORD_SOURCES = new HashSet<>(Arrays.asList("manual","hardware","scanner","system"));
    private static final Set<String> IMPORT_MODES = new HashSet<>(Arrays.asList("preview","replace","merge"));
    /** 随备份往返的 db_meta 键（旧库 state.s 其余字段），不参与 checksum，也不动其它 meta。 */
    private static final String[] LEGACY_META_KEYS = {"legacy_s_extra","legacy_migrated_at"};
    private static final DateTimeFormatter ISO_MINUTE = DateTimeFormatter.ofPattern("yyyy-MM-dd'T'HH:mm",Locale.ROOT);
    private static final int PAGE_DEFAULT = 200, PAGE_MAX = 500;
    private static final int ENV_LIMIT = 2000, ENV_KEEP = 200;
    private static final int[] ENV_BUCKETS = {1,2,5,10,15,30,60,120,240,720,1440};
    private static final int PAYLOAD_LIMIT = 24 * 1024 * 1024;
    private static final String SAMPLES_COLUMNS = "sample_id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL, barcode TEXT UNIQUE, status TEXT NOT NULL CHECK(status IN ('in','out')), slot INTEGER CHECK(slot IS NULL OR (typeof(slot)='integer' AND slot BETWEEN 1 AND 5)), last_slot INTEGER CHECK(last_slot IS NULL OR (typeof(last_slot)='integer' AND last_slot BETWEEN 1 AND 5)), pending_intake INTEGER NOT NULL DEFAULT 0 CHECK(pending_intake IN (0,1)), type TEXT, location TEXT, collected_at TEXT, collected_time_text TEXT, temperature REAL, note TEXT, photo TEXT, photo_path TEXT, photo_hash TEXT, thumb TEXT, created_at INTEGER, updated_at INTEGER, monitor INTEGER NOT NULL DEFAULT 0 CHECK(monitor IN (0,1)), last_temperature REAL, last_humidity REAL, last_light REAL, last_update TEXT, alert TEXT CHECK(alert IS NULL OR alert IN ('good','warn','bad')), qr_snapshot TEXT, extra_json TEXT NOT NULL DEFAULT '{}', UNIQUE(type,slot), CHECK(slot IS NULL OR type IN ('全血','血清','血浆')), CHECK(status='in' OR slot IS NULL)";
    private static final String RECORDS_COLUMNS = "id INTEGER PRIMARY KEY AUTOINCREMENT, sample_id TEXT, sample_name TEXT NOT NULL DEFAULT '', time TEXT NOT NULL DEFAULT '', type TEXT NOT NULL DEFAULT '', detail TEXT NOT NULL DEFAULT '', barcode TEXT, slot INTEGER CHECK(slot IS NULL OR (typeof(slot)='integer' AND slot BETWEEN 1 AND 5)), status TEXT CHECK(status IS NULL OR status IN ('in','out')), task_id TEXT, operator TEXT, source TEXT CHECK(source IS NULL OR source IN ('manual','hardware','scanner','system')), type_code TEXT, extra_json TEXT NOT NULL DEFAULT '{}', FOREIGN KEY(sample_id) REFERENCES samples(sample_id) ON DELETE SET NULL";
    /** 契约 C：records 留存上限，超出部分搬到 records_archive。包内可写，便于测试用更小阈值快速验证。 */
    int recordLimit = 5000;
    private final VitalsPhotos photos;

    public VitalsDbHelper(Context context){this(context,DB_NAME);}
    VitalsDbHelper(Context context,String name){super(context,name,null,DB_VERSION);setWriteAheadLoggingEnabled(true);this.photos=new VitalsPhotos(context.getApplicationContext());} // 契约E：打开即 WAL（onConfigure 里再兜底一次）
    @Override public void onConfigure(SQLiteDatabase db){
        db.setForeignKeyConstraintsEnabled(true);                       // 契约E：外键在每个连接上生效
        try{db.enableWriteAheadLogging();}catch(Exception ignored){}    // 契约E：WAL 提升读写并发；失败时退回默认 journal 模式
        try{db.execSQL("PRAGMA busy_timeout=5000");}catch(Exception ignored){} // 契约E：锁等待 5s，避免瞬时并发直接 SQLITE_BUSY
    }
    @Override public void onCreate(SQLiteDatabase db){createTables(db);migrateLegacy(db);migratePhotos(db);}
    @Override public void onUpgrade(SQLiteDatabase db,int oldVersion,int newVersion){if(oldVersion<3)upgradeToThreeDiscs(db);createTables(db);migrateLegacy(db);ensureSchema(db);migratePhotos(db);}
    @Override public void onOpen(SQLiteDatabase db){super.onOpen(db);migrateLegacy(db);ensureSchema(db);migratePhotos(db);}
    private static void createTables(SQLiteDatabase db){
        db.execSQL("CREATE TABLE IF NOT EXISTS samples ("+SAMPLES_COLUMNS+")");
        db.execSQL("CREATE TABLE IF NOT EXISTS records ("+RECORDS_COLUMNS+")");
        db.execSQL("CREATE INDEX IF NOT EXISTS records_sample_time ON records(sample_id,time)");
        db.execSQL("CREATE TABLE IF NOT EXISTS records_archive ("+RECORDS_COLUMNS+")");
        db.execSQL("CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL)");
        db.execSQL("CREATE TABLE IF NOT EXISTS db_meta (key TEXT PRIMARY KEY NOT NULL,value TEXT NOT NULL)");
    }
    private static void upgradeToThreeDiscs(SQLiteDatabase db){
        if(!table(db,"samples"))return;
        db.execSQL("CREATE TABLE samples_v3 (sample_id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL, barcode TEXT UNIQUE, status TEXT NOT NULL CHECK(status IN ('in','out')), slot INTEGER CHECK(slot IS NULL OR (typeof(slot)='integer' AND slot BETWEEN 1 AND 5)), last_slot INTEGER CHECK(last_slot IS NULL OR (typeof(last_slot)='integer' AND last_slot BETWEEN 1 AND 5)), pending_intake INTEGER NOT NULL DEFAULT 0 CHECK(pending_intake IN (0,1)), type TEXT, location TEXT, collected_at TEXT, collected_time_text TEXT, temperature REAL, note TEXT, photo TEXT, created_at INTEGER, updated_at INTEGER, monitor INTEGER NOT NULL DEFAULT 0 CHECK(monitor IN (0,1)), last_temperature REAL, last_humidity REAL, last_light REAL, last_update TEXT, alert TEXT CHECK(alert IS NULL OR alert IN ('good','warn','bad')), qr_snapshot TEXT, extra_json TEXT NOT NULL DEFAULT '{}', UNIQUE(type,slot), CHECK(slot IS NULL OR type IN ('全血','血清','血浆')), CHECK(status='in' OR slot IS NULL))");
        db.execSQL("INSERT INTO samples_v3 SELECT sample_id,name,barcode,status,slot,last_slot,pending_intake,type,location,collected_at,collected_time_text,temperature,note,photo,created_at,updated_at,monitor,last_temperature,last_humidity,last_light,last_update,alert,qr_snapshot,extra_json FROM samples");
        db.execSQL("CREATE TABLE records_v3 (id INTEGER PRIMARY KEY AUTOINCREMENT, sample_id TEXT, sample_name TEXT NOT NULL DEFAULT '', time TEXT NOT NULL DEFAULT '', type TEXT NOT NULL DEFAULT '', detail TEXT NOT NULL DEFAULT '', barcode TEXT, slot INTEGER CHECK(slot IS NULL OR (typeof(slot)='integer' AND slot BETWEEN 1 AND 5)), status TEXT CHECK(status IS NULL OR status IN ('in','out')), task_id TEXT, extra_json TEXT NOT NULL DEFAULT '{}', FOREIGN KEY(sample_id) REFERENCES samples_v3(sample_id) ON DELETE SET NULL)");
        db.execSQL("INSERT INTO records_v3 SELECT id,sample_id,sample_name,time,type,detail,barcode,slot,status,task_id,extra_json FROM records");
        db.execSQL("DROP TABLE records");
        db.execSQL("DROP TABLE samples");
        db.execSQL("ALTER TABLE samples_v3 RENAME TO samples");
        db.execSQL("ALTER TABLE records_v3 RENAME TO records");
    }
    /** 契约 C/A：幂等补列、建索引、归一时间；整体一个事务，任何失败都上抛给 getWritableDatabase()。 */
    private void ensureSchema(SQLiteDatabase db){
        db.beginTransaction();
        try{ensureSchemaLocked(db);db.setTransactionSuccessful();}
        finally{db.endTransaction();}
    }
    private static void ensureSchemaLocked(SQLiteDatabase db){
        if(!table(db,"samples")||!table(db,"records"))createTables(db);
        addColumn(db,"samples","photo_path","TEXT");
        addColumn(db,"samples","photo_hash","TEXT");
        addColumn(db,"samples","thumb","TEXT");
        if(!hasColumn(db,"records","operator")||!hasColumn(db,"records","source")||!hasColumn(db,"records","type_code"))rebuildRecords(db);
        // 归档表必须在这里兜底：旧库升级路径（onUpgrade/onOpen）不会重新执行 createTables 的全部语句，
        // 而 retainRecords() 会向 records_archive 写入；缺失时留存一旦触发就会抛 no such table。
        db.execSQL("CREATE TABLE IF NOT EXISTS records_archive ("+RECORDS_COLUMNS+")");
        db.execSQL("CREATE INDEX IF NOT EXISTS records_sample_time ON records(sample_id,time)");
        db.execSQL("CREATE INDEX IF NOT EXISTS records_time ON records(time)");
        db.execSQL("CREATE INDEX IF NOT EXISTS records_type_code ON records(type_code)");
        // 契约C：'YYYY-MM-DD HH:MM' → 'YYYY-MM-DDTHH:MM'（幂等：转换后第 11 位不再是空格）
        db.execSQL("UPDATE records SET time=substr(time,1,10)||'T'||substr(time,12) WHERE length(time)>=16 AND substr(time,11,1)=' ' AND substr(time,5,1)='-' AND substr(time,8,1)='-'");
    }
    /** records 需要带 CHECK 约束的新列，ALTER TABLE 加不了 CHECK，只能重建一次。 */
    private static void rebuildRecords(SQLiteDatabase db){
        db.execSQL("DROP TABLE IF EXISTS records_next");
        db.execSQL("CREATE TABLE records_next ("+RECORDS_COLUMNS+")");
        db.execSQL("INSERT INTO records_next (id,sample_id,sample_name,time,type,detail,barcode,slot,status,task_id,extra_json) SELECT id,sample_id,sample_name,time,type,detail,barcode,slot,status,task_id,extra_json FROM records");
        db.execSQL("DROP TABLE records");
        db.execSQL("ALTER TABLE records_next RENAME TO records");
    }
    private static void addColumn(SQLiteDatabase db,String table,String column,String type){if(hasColumn(db,table,column))return;db.execSQL("ALTER TABLE "+table+" ADD COLUMN "+column+" "+type);} // identifiers are internal constants only
    private static boolean hasColumn(SQLiteDatabase db,String table,String column){
        try(Cursor c=db.rawQuery("PRAGMA table_info("+table+")",null)){
            int name=c.getColumnIndexOrThrow("name");
            while(c.moveToNext())if(column.equalsIgnoreCase(c.getString(name)))return true;
            return false;
        }
    }
    private static boolean table(SQLiteDatabase db,String name){try(Cursor c=db.rawQuery("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?",new String[]{name})){return c.moveToFirst();}}
    private static String meta(SQLiteDatabase db,String key,String fallback){try(Cursor c=db.rawQuery("SELECT value FROM db_meta WHERE key=?",new String[]{key})){return c.moveToFirst()?c.getString(0):fallback;}}
    private static void putMeta(SQLiteDatabase db,String key,String value){ContentValues v=new ContentValues();v.put("key",key);v.put("value",value);db.insertWithOnConflict("db_meta",null,v,SQLiteDatabase.CONFLICT_REPLACE);}
    private static long count(SQLiteDatabase db,String table){try(Cursor c=db.rawQuery("SELECT COUNT(*) FROM "+table,null)){c.moveToFirst();return c.getLong(0);}} // table is internal constant only
    /** 契约 A：一次性把历史内联 photo 落盘并回填；幂等记录 photo_migrated=done。 */
    private void migratePhotos(SQLiteDatabase db){
        if("done".equals(meta(db,"photo_migrated","")))return;
        db.beginTransaction();
        try{
            List<String[]> rows=new ArrayList<>();
            try(Cursor c=db.query("samples",new String[]{"sample_id","photo"},"photo IS NOT NULL AND photo<>''",null,null,null,null)){
                while(c.moveToNext())rows.add(new String[]{c.getString(0),c.getString(1)});
            }
            for(String[] row:rows){
                byte[] bytes=VitalsPhotos.decode(row[1]);
                String hash=bytes==null?null:BackupFormat.sha256Hex(bytes);
                if(hash==null||!photos.write(hash,bytes))continue; // 解码/落盘失败：保留内联照片，不制造半状态
                ContentValues v=new ContentValues();
                v.put("photo_path",photos.pathFor(hash));v.put("photo_hash",hash);
                String thumb=VitalsPhotos.thumb(bytes);if(thumb!=null)v.put("thumb",thumb);
                v.putNull("photo"); // 落盘成功才清空内联全图
                db.update("samples",v,"sample_id=?",new String[]{row[0]});
            }
            putMeta(db,"photo_migrated","done");
            db.setTransactionSuccessful();
        }finally{db.endTransaction();}
    }
    private void migrateLegacy(SQLiteDatabase db){
        if("done".equals(meta(db,"legacy_migration","")))return;
        db.beginTransaction();
        try {
            // 先补齐新列/索引：老库（v0/v1 的 app_state、v2 的旧表结构）在导入时就要用 photo_path 等新列，
            // 且必须与迁移同一事务——任何一步失败都一起回滚并把异常上抛给 getWritableDatabase()。
            ensureSchemaLocked(db);
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
    private static String isoTimeValue(String value){
        if(value==null||value.length()<16||value.charAt(10)!=' '||value.charAt(4)!='-'||value.charAt(7)!='-')return value;
        return value.substring(0,10)+'T'+value.substring(11); // 契约C：时间统一 ISO 8601
    }
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
        if(value(x,"slot")&&!STORAGE_TYPES.contains(text(x,"type",true)))throw new JSONException("当前只支持全血、血清、血浆三个存储圆盘");
        if(value(x,"alert")&&!Arrays.asList("good","warn","bad").contains(x.getString("alert")))throw new JSONException("无效温度状态");
        if(value(x,"photo")&&!x.getString("photo").isEmpty()&&!x.getString("photo").matches("(?s)^data:image/(png|jpeg|webp);base64,[a-zA-Z0-9+/=\\s]+$"))throw new JSONException("照片格式不支持");
        if(value(x,"thumb")&&!x.getString("thumb").isEmpty()&&!x.getString("thumb").matches("(?s)^data:image/(png|jpeg|webp);base64,[a-zA-Z0-9+/=\\s]+$"))throw new JSONException("缩略图格式不支持");
        if(value(x,"env")){
            if(!(x.get("env") instanceof JSONArray))throw new JSONException("env 必须为数组");
            JSONArray env=x.getJSONArray("env");
            for(int i=0;i<env.length();i++){
                if(!(env.get(i) instanceof JSONObject))throw new JSONException("env 采样点格式无效");
                JSONObject p=env.getJSONObject(i);text(p,"time",false);
                for(String k:ENV_FIELDS)if(value(p,k))number(p.get(k),k,false);
            }
            if(env.length()>ENV_LIMIT)x.put("env",aggregateEnv(env)); // 契约D：超限降采样（写入与导入共用）
        }
        return x;
    }
    /** 契约 D：最近 200 点原样保留，更早的点按分钟聚合取 avg；若仍超上限则逐级加粗桶宽，保证 ≤2000 的硬上限。 */
    private static JSONArray aggregateEnv(JSONArray env)throws JSONException{
        int length=env.length(),head=length-ENV_KEEP;
        if(head<=0)return env;
        JSONArray tail=new JSONArray();for(int i=head;i<length;i++)tail.put(env.get(i));
        for(int minutes:ENV_BUCKETS){
            JSONArray out=aggregateHead(env,head,minutes);
            if(out.length()+tail.length()<=ENV_LIMIT){for(int i=0;i<tail.length();i++)out.put(tail.get(i));return out;}
        }
        JSONArray out=aggregateHead(env,head,ENV_BUCKETS[ENV_BUCKETS.length-1]);
        while(out.length()+tail.length()>ENV_LIMIT&&out.length()>0)out.remove(0); // 极端数据：只保留最新部分
        for(int i=0;i<tail.length();i++)out.put(tail.get(i));
        return out;
    }
    private static JSONArray aggregateHead(JSONArray env,int head,int minutes)throws JSONException{
        TreeMap<String,double[]> buckets=new TreeMap<>();
        for(int i=0;i<head;i++){
            JSONObject point=env.getJSONObject(i);
            String time=text(point,"time",false);
            LocalDateTime parsed=parseMinute(time);
            String key=parsed==null?(time==null?"":time):bucketKey(parsed,minutes);
            double[] sums=buckets.get(key);if(sums==null){sums=new double[6];buckets.put(key,sums);}
            for(int f=0;f<ENV_FIELDS.length;f++){
                Object raw=point.opt(ENV_FIELDS[f]);
                if(raw instanceof Number){sums[f]+=((Number)raw).doubleValue();sums[ENV_FIELDS.length+f]+=1;}
            }
        }
        JSONArray out=new JSONArray();
        for(Map.Entry<String,double[]> entry:buckets.entrySet()){
            JSONObject point=new JSONObject().put("time",entry.getKey());
            for(int f=0;f<ENV_FIELDS.length;f++)if(entry.getValue()[ENV_FIELDS.length+f]>0)point.put(ENV_FIELDS[f],entry.getValue()[f]/entry.getValue()[ENV_FIELDS.length+f]);
            out.put(point);
        }
        return out;
    }
    private static LocalDateTime parseMinute(String value){
        if(value==null)return null;
        String text=value.length()>16?value.substring(0,16):value;
        if(text.length()==16&&text.charAt(10)==' ')text=text.substring(0,10)+'T'+text.substring(11);
        try{return LocalDateTime.parse(text,ISO_MINUTE);}catch(Exception e){return null;}
    }
    private static String bucketKey(LocalDateTime time,int minutes){
        LocalDateTime bucket=time.truncatedTo(ChronoUnit.MINUTES);
        int offset=bucket.getMinute()%minutes;
        if(offset!=0)bucket=bucket.minusMinutes(offset);
        return bucket.format(ISO_MINUTE);
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
    /** 记录字段归一化：type_code/typeCode 双名兼容、ISO 时间、枚举与槽位校验、slot 统一为整数（指纹用）。 */
    private static JSONObject normalizeRecord(JSONObject raw)throws JSONException{
        JSONObject r=copy(raw);
        if(!value(r,"typeCode")&&value(r,"type_code"))r.put("typeCode",r.get("type_code"));
        r.remove("type_code"); // 统一成 camelCase，避免同一字段在 extra_json 里重复留存
        String sid=text(r,"sampleId",false);if(sid!=null)id(sid);
        if(value(r,"slot")){range(r.get("slot"),"slot");r.put("slot",(int)number(r.get("slot"),"slot",true));}
        if(value(r,"status")&&!Arrays.asList("in","out").contains(text(r,"status",true)))throw new JSONException("记录状态无效");
        String source=text(r,"source",false);
        if(source!=null&&!source.isEmpty()&&!RECORD_SOURCES.contains(source))throw new JSONException("记录来源无效："+source);
        String time=text(r,"time",false);if(time!=null)r.put("time",isoTimeValue(time));
        for(String k:Arrays.asList("sample","type","detail","code","taskId","operator","typeCode"))text(r,k,false);
        return r;
    }
    static JSONObject normalizeBackup(Object source,boolean migration)throws JSONException{
        JSONObject data=source instanceof JSONObject?(JSONObject)source:new JSONObject();
        Object samples=source;JSONArray records=new JSONArray();JSONObject settings=new JSONObject();
        if(data.has("s")){JSONObject s=data.getJSONObject("s");samples=s.get("samples");records=data.has("rec")?data.getJSONArray("rec"):s.optJSONArray("records");settings=data.has("set")?data.getJSONObject("set"):s.optJSONObject("settings");}
        else if(data.has("samples")){samples=data.get("samples");records=data.has("records")?data.getJSONArray("records"):new JSONArray();settings=data.has("settings")?data.getJSONObject("settings"):new JSONObject();}
        if(!(samples instanceof JSONObject)&&!(samples instanceof JSONArray))throw new JSONException("样本集合格式无效");
        JSONObject normalized=new JSONObject();Set<String> codes=new HashSet<>();Set<String> slots=new HashSet<>();
        List<String> keys=new ArrayList<>();
        if(samples instanceof JSONObject)((JSONObject)samples).keys().forEachRemaining(keys::add);
        else for(int i=0;i<((JSONArray)samples).length();i++)keys.add(Integer.toString(i));
        for(String key:keys){
            JSONObject item=samples instanceof JSONObject?((JSONObject)samples).getJSONObject(key):((JSONArray)samples).getJSONObject(Integer.parseInt(key));
            JSONObject x=normalizeSample(item,key);String sid=x.getString("id");
            if(normalized.has(sid))throw new JSONException("样本 ID 重复："+sid);
            String code=text(x,"code",false);if(code!=null&&!code.isEmpty()&&!codes.add(code))throw new JSONException("条码重复："+code);
            if(value(x,"slot")){String slot=x.getString("type")+"\u0000"+x.getInt("slot");if(!slots.add(slot))throw new JSONException(x.getString("type")+"圆盘槽位重复："+x.getInt("slot"));}
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
    /** 契约 A 照片三态：photo 键缺省=保持现有照片不变；photo=null 或 ""=用户主动移除（清空三列引用）；photo=dataURL=落盘覆盖。 */
    private void upsert(SQLiteDatabase db,JSONObject raw)throws JSONException{
        JSONObject x=normalizeSample(raw,null);
        boolean clearPhoto=x.has("photo")&&(x.isNull("photo")||text(x,"photo",false).isEmpty()); // 显式 null/空串=移除；键缺省=false，走下面的保留分支
        if(clearPhoto){x.remove("photo");x.remove("photoPath");x.remove("photoHash");x.remove("thumb");}
        else if(!value(x,"photo")&&!value(x,"photoPath")&&!value(x,"photoHash")){ // 老前端/未编辑照片：保留库中已有引用，避免一次保存就丢图
            try(Cursor c=db.query("samples",new String[]{"photo","photo_path","photo_hash","thumb"},"sample_id=?",new String[]{x.getString("id")},null,null,null)){
                if(c.moveToFirst()){
                    if(!value(x,"photoHash")&&!c.isNull(2))x.put("photoHash",c.getString(2));
                    if(!value(x,"photoPath")&&!c.isNull(1))x.put("photoPath",c.getString(1));
                    if(!value(x,"thumb")&&!c.isNull(3))x.put("thumb",c.getString(3));
                    if(!value(x,"photo")&&!c.isNull(0))x.put("photo",c.getString(0));
                }
            }
        }
        photos.prepare(x);
        ContentValues v=sampleValues(x);
        // UPDATE preserves children; INSERT OR REPLACE would delete/recreate the parent.
        if(db.update("samples",v,"sample_id=?",new String[]{x.getString("id")})==0)db.insertOrThrow("samples",null,v);
    }
    private JSONObject sample(Cursor c,boolean withPhoto)throws JSONException{
        JSONObject x=new JSONObject(c.getString(c.getColumnIndexOrThrow("extra_json")));
        for(int i=0;i<JS.length;i++){int col=c.getColumnIndexOrThrow(SQL[i]);if(c.isNull(col))continue;
            if(BOOLS.contains(JS[i]))x.put(JS[i],c.getInt(col)!=0);else if(INTS.contains(JS[i]))x.put(JS[i],c.getLong(col));else if(NUMS.contains(JS[i]))x.put(JS[i],c.getDouble(col));else x.put(JS[i],c.getString(col));}
        if(withPhoto){
            String hash=text(x,"photoHash",false),data=null;
            if(hash!=null&&!hash.isEmpty())data=photos.read(hash);
            if(data==null){String path=text(x,"photoPath",false);if(path!=null&&!path.isEmpty())data=photos.read(new File(path));}
            if(data!=null)x.put("photo",data); // 单样本读取保留全图，兼容旧前端
        }
        return x;
    }
    private JSONObject samples(SQLiteDatabase db)throws JSONException{
        JSONObject out=new JSONObject();try(Cursor c=db.query("samples",null,null,null,null,null,"sample_id")){while(c.moveToNext()){JSONObject x=sample(c,false);out.put(x.getString("id"),x);}}return out;
    }
    private static JSONObject record(Cursor c)throws JSONException{
        JSONObject r=new JSONObject(c.getString(c.getColumnIndexOrThrow("extra_json")));
        for(int i=0;i<RJS.length;i++){
            int col=c.getColumnIndexOrThrow(RSQL[i]);
            if(c.isNull(col)){if(i==1)r.put("sampleId",JSONObject.NULL);continue;}
            r.put(RJS[i],i==0||i==7?c.getLong(col):c.getString(col));
        }
        if(r.has("typeCode"))r.put("type_code",r.get("typeCode")); // 兼容蛇形命名的消费方
        return r;
    }
    private static long insertRecord(SQLiteDatabase db,JSONObject raw,boolean inferLegacy)throws JSONException{
        JSONObject r=normalizeRecord(raw),extra=copy(r);ContentValues v=new ContentValues();
        for(String k:RJS)extra.remove(k);
        String sid=text(r,"sampleId",false);
        String name=text(r,"sample",false);
        if(sid==null&&inferLegacy&&name!=null&&!name.equals("系统")){
            try(Cursor c=db.rawQuery("SELECT sample_id FROM samples WHERE name=? LIMIT 2",new String[]{name})){if(c.getCount()==1){c.moveToFirst();sid=c.getString(0);}}
        }
        if(sid==null)v.putNull("sample_id");else v.put("sample_id",sid);
        for(int i=2;i<RJS.length;i++){
            String k=RJS[i];
            if(k.equals("slot")){if(value(r,k))v.put(RSQL[i],r.getInt(k));continue;}
            String val=text(r,k,false);if(i<=5)v.put(RSQL[i],val==null?"":val);else if(val!=null)v.put(RSQL[i],val);
        }
        v.put("extra_json",extra.toString());return db.insertOrThrow("records",null,v);
    }
    private static JSONArray records(SQLiteDatabase db,String sid)throws JSONException{
        JSONArray out=new JSONArray();try(Cursor c=db.query("records",null,sid==null?null:"sample_id=?",sid==null?null:new String[]{sid},null,null,"id DESC")){
            while(c.moveToNext())out.put(record(c));
        }return out;
    }
    private static JSONObject settings(SQLiteDatabase db)throws JSONException{JSONObject s=new JSONObject();try(Cursor c=db.query("settings",null,null,null,null,null,"key")){while(c.moveToNext())s.put(c.getString(c.getColumnIndexOrThrow("key")),new JSONTokener(c.getString(c.getColumnIndexOrThrow("value"))).nextValue());}return s;}
    private static void setting(SQLiteDatabase db,String key,Object value)throws JSONException{checkKey(key);ContentValues v=new ContentValues();v.put("key",key);String json=new JSONArray().put(value).toString();v.put("value",json.substring(1,json.length()-1));db.insertWithOnConflict("settings",null,v,SQLiteDatabase.CONFLICT_REPLACE);}
    private void importRows(SQLiteDatabase db,JSONObject b)throws JSONException{
        JSONObject samples=b.getJSONObject("samples");for(Iterator<String> it=samples.keys();it.hasNext();)upsert(db,samples.getJSONObject(it.next()));
        JSONArray rec=b.getJSONArray("records");for(int i=rec.length()-1;i>=0;i--)insertRecord(db,rec.getJSONObject(i),true);
        applySettings(db,b.getJSONObject("settings"));
        validateTask(db);
    }
    private static void applySettings(SQLiteDatabase db,JSONObject set)throws JSONException{for(Iterator<String> it=set.keys();it.hasNext();){String k=it.next();setting(db,k,set.get(k));}}
    private static void validateTask(SQLiteDatabase db)throws JSONException{
        JSONObject set=normalizeSettings(settings(db));if(!value(set,"motionTask"))return;
        JSONObject t=set.getJSONObject("motionTask");String sid=t.getString("sampleId");
        String sampleType;
        try(Cursor c=db.rawQuery("SELECT status,slot,type FROM samples WHERE sample_id=?",new String[]{sid})){
            if(!c.moveToFirst())throw new JSONException("任务样本不存在");
            if(t.getString("action").equals("out")&&(!c.getString(0).equals("in")||c.isNull(1)||c.getInt(1)!=t.getInt("slot")))throw new JSONException("出库任务与在库槽位不一致");
            if(t.getString("action").equals("in")&&!c.getString(0).equals("out"))throw new JSONException("入库任务样本已在库");
            sampleType=c.getString(2);if(!STORAGE_TYPES.contains(sampleType))throw new JSONException("任务样本没有对应存储圆盘");
        }
        try(Cursor c=db.rawQuery("SELECT 1 FROM samples WHERE type=? AND slot=? AND sample_id<>?",new String[]{sampleType,Integer.toString(t.getInt("slot")),sid})){if(c.moveToFirst())throw new JSONException("任务圆盘槽位被其他样本占用");}
    }
    private static long revision(SQLiteDatabase db){return Long.parseLong(meta(db,"revision","0"));}
    /**
     * 契约 C：records 超上限时把最旧的行搬进 records_archive（同结构）再删除，在 commit/导入事务内调用。
     * <p>
     * 这里用 {@code id ASC} 界定「最旧」，依赖下面这条调用约定：addRecords 按「最新在前」传入
     * （前端 state.rec 用 unshift 维护，persistence.js 直接切片下发），而 commit 里为 id DESC 展示做了
     * 倒序插入，于是「数组最后一条（最旧）」拿到最小 id、「第一条（最新）」拿到最大 id ——
     * id 升序即时间由旧到新，按 id 归档就是按时间归档，且走主键索引。
     * 若将来调用方改成「最旧在前」下发，必须同步调整插入方向，否则会把最新的一批归档掉。
     */
    private void retainRecords(SQLiteDatabase db){
        long over=count(db,"records")-recordLimit;
        if(over<=0)return;
        // over 由行数算出，不含外部输入；SQLite 的 LIMIT 只接受字面量
        db.execSQL("INSERT OR REPLACE INTO records_archive (id,sample_id,sample_name,time,type,detail,barcode,slot,status,task_id,operator,source,type_code,extra_json) SELECT id,sample_id,sample_name,time,type,detail,barcode,slot,status,task_id,operator,source,type_code,extra_json FROM records ORDER BY id ASC LIMIT "+over);
        db.execSQL("DELETE FROM records WHERE id IN (SELECT id FROM records ORDER BY id ASC LIMIT "+over+")");
    }
    public synchronized JSONObject info()throws JSONException{SQLiteDatabase db=getReadableDatabase();return new JSONObject().put("version",db.getVersion()).put("revision",revision(db)).put("legacyMigration",meta(db,"legacy_migration",""));}
    public synchronized JSONObject getSamples()throws JSONException{return samples(getReadableDatabase());}
    public synchronized JSONObject getSample(String key,boolean barcode)throws JSONException{
        if(barcode){if(key==null||key.isEmpty())throw new JSONException("条码不能为空");}else id(key);
        try(Cursor c=getReadableDatabase().query("samples",null,barcode?"barcode=?":"sample_id=?",new String[]{key},null,null,null)){return c.moveToFirst()?sample(c,true):null;}
    }
    public synchronized JSONArray getRecords(String sid)throws JSONException{if(sid!=null&&!sid.isEmpty())id(sid);return records(getReadableDatabase(),sid==null||sid.isEmpty()?null:sid);}
    public synchronized JSONObject getSettings()throws JSONException{return settings(getReadableDatabase());}
    /** 契约 B：单事务一致读 revision+samples+records+settings；samples 一律不含全图，只有 thumb/photoPath。 */
    public synchronized JSONObject snapshot()throws JSONException{
        SQLiteDatabase db=getReadableDatabase();
        db.beginTransactionNonExclusive();
        try{
            JSONObject s=new JSONObject(meta(db,"legacy_s_extra","{}"));
            JSONObject list=samples(db);
            for(Iterator<String> it=list.keys();it.hasNext();)list.getJSONObject(it.next()).remove("photo");
            s.put("samples",list).put("total",list.length()).put("online",0);
            JSONObject out=new JSONObject().put("s",s).put("rec",records(db,null)).put("set",settings(db)).put("revision",revision(db));
            db.setTransactionSuccessful();
            return out;
        }finally{db.endTransaction();}
    }
    /** 契约 A：按需取照片；缺文件不抛异常，返回 missing=true。 */
    public synchronized JSONObject getSamplePhoto(String id,boolean full){
        JSONObject out=new JSONObject();
        try{
            out.put("id",id==null?"":id).put("hash","").put("thumb","").put("missing",true);
            if(id==null||id.isEmpty())return out;
            id(id);
            String hash=null,thumb=null,inline=null;
            try(Cursor c=getReadableDatabase().query("samples",new String[]{"photo_hash","thumb","photo_path","photo"},"sample_id=?",new String[]{id},null,null,null)){
                if(!c.moveToFirst())return out;
                hash=c.isNull(0)?null:c.getString(0);thumb=c.isNull(1)?null:c.getString(1);inline=c.isNull(3)?null:c.getString(3);
                if((hash==null||hash.isEmpty())&&!c.isNull(2))hash=photos.hashOfPath(c.getString(2));
            }
            out.put("thumb",thumb==null?"":thumb);
            out.put("hash",hash==null?"":hash);
            if(hash!=null&&!hash.isEmpty()&&photos.exists(hash)){
                out.put("missing",false);
                if(full){String data=photos.read(hash);if(data==null)out.put("missing",true);else out.put("photo",data);}
            }else if(inline!=null&&!inline.isEmpty()){ // 迁移失败/未迁移的内联照片兜底
                byte[] bytes=VitalsPhotos.decode(inline);
                if(bytes!=null){out.put("missing",false).put("hash",BackupFormat.sha256Hex(bytes));if(full)out.put("photo",inline);}
            }
            return out;
        }catch(Exception e){try{return out.put("missing",true).put("error",e.getMessage()==null?"读取照片失败":e.getMessage());}catch(JSONException impossible){return new JSONObject();}}
    }
    /** 契约 C：记录分页；按 id DESC；limit 上限 500、默认 200。 */
    public synchronized JSONObject recordsPage(String fromIso,String toIso,String typeCode,int limit,int offset)throws JSONException{
        if(limit<=0)limit=PAGE_DEFAULT;
        if(limit>PAGE_MAX)limit=PAGE_MAX;
        if(offset<0)offset=0;
        SQLiteDatabase db=getReadableDatabase();
        List<String> args=new ArrayList<>();
        String where=recordWhere(fromIso,toIso,typeCode,args);
        JSONArray out=new JSONArray();long total;
        db.beginTransactionNonExclusive(); // count 与数据页必须来自同一快照
        try{
            try(Cursor c=db.rawQuery("SELECT COUNT(*) FROM records"+where,args.toArray(new String[0]))){c.moveToFirst();total=c.getLong(0);}
            List<String> pageArgs=new ArrayList<>(args);pageArgs.add(Integer.toString(limit));pageArgs.add(Integer.toString(offset));
            try(Cursor c=db.rawQuery("SELECT * FROM records"+where+" ORDER BY id DESC LIMIT ? OFFSET ?",pageArgs.toArray(new String[0]))){while(c.moveToNext())out.put(record(c));}
            db.setTransactionSuccessful();
        }finally{db.endTransaction();}
        return new JSONObject().put("records",out).put("total",total).put("hasMore",offset+out.length()<total);
    }
    private static String recordWhere(String fromIso,String toIso,String typeCode,List<String> args){
        List<String> parts=new ArrayList<>();
        if(fromIso!=null&&!fromIso.isEmpty()){parts.add("time>=?");args.add(fromIso);}
        if(toIso!=null&&!toIso.isEmpty()){parts.add("time<=?");args.add(toIso.length()<=10?toIso+"T23:59":toIso);}
        if(typeCode!=null&&!typeCode.isEmpty()){parts.add("type_code=?");args.add(typeCode);}
        return parts.isEmpty()?"":" WHERE "+String.join(" AND ",parts);
    }
    public synchronized JSONObject loadState()throws JSONException{
        SQLiteDatabase db=getReadableDatabase();JSONObject s=new JSONObject(meta(db,"legacy_s_extra","{}"));
        JSONObject list=samples(db);s.put("samples",list).put("total",list.length()).put("online",0);
        return new JSONObject().put("s",s).put("rec",records(db,null)).put("set",settings(db));
    }
    /** 兼容入口：自动备份与旧前端仍用无参版本，保持「含照片的完整备份」原语义。 */
    public synchronized JSONObject exportBackup()throws JSONException{return exportBackup(true);}
    /** 契约 F：自描述备份（app/schemaVersion/appVersion/exportedAt/counts/checksum/samples/records/settings）。
     *  额外带 legacyMeta（旧库 state.s 的其余元信息，见 exportLegacyMeta）：它是附加审计信息，<b>不参与 checksum</b>。 */
    public synchronized JSONObject exportBackup(boolean includePhotos)throws JSONException{
        SQLiteDatabase db=getReadableDatabase();
        db.beginTransactionNonExclusive(); // 一致读：四段数据来自同一快照
        try{
            JSONObject sampleMap=exportSamples(db,includePhotos);
            JSONArray recordList=exportRecords(db);
            JSONObject settingMap=settings(db);
            JSONObject out=new JSONObject()
                .put("app",BackupFormat.APP_ID)
                .put("schemaVersion",BACKUP_SCHEMA_VERSION)
                .put("appVersion",appVersion)
                .put("exportedAt",new java.text.SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ssXXX",Locale.ROOT).format(new Date()))
                .put("counts",new JSONObject().put("samples",sampleMap.length()).put("records",recordList.length()))
                .put("checksum",BackupFormat.checksum(sampleMap,recordList,settingMap))
                .put("samples",sampleMap).put("records",recordList).put("settings",settingMap);
            JSONObject legacy=exportLegacyMeta(db);
            if(legacy.length()>0)out.put("legacyMeta",legacy); // 两个 meta 键都不存在时整个字段省略，老库备份保持干净
            db.setTransactionSuccessful();
            return out;
        }finally{db.endTransaction();}
    }
    /** 旧库迁移留下的 state.s 其余字段：loadState 会以它作基底重建 state.s，因此必须随备份走，否则换机后丢元信息。 */
    private static JSONObject exportLegacyMeta(SQLiteDatabase db)throws JSONException{
        JSONObject out=new JSONObject();
        for(String key:LEGACY_META_KEYS){
            String value=meta(db,key,null);
            if(value!=null&&!value.isEmpty())out.put(key,value);
        }
        return out;
    }
    /** 导入成功后恢复 legacy 元信息：只写备份里存在的键，缺省不动现有值，也不碰 photo_migrated/revision 等其它 meta。 */
    private static void restoreLegacyMeta(SQLiteDatabase db,JSONObject legacy)throws JSONException{
        if(legacy==null)return;
        for(String key:LEGACY_META_KEYS){
            if(!legacy.has(key)||legacy.isNull(key))continue;
            Object value=legacy.get(key);
            if(!(value instanceof String))continue;
            if("legacy_s_extra".equals(key)){
                try{new JSONObject((String)value);}catch(JSONException invalid){continue;} // 非法 JSON 不写入，否则 loadState 每次都抛
            }
            putMeta(db,key,(String)value);
        }
    }
    private JSONObject exportSamples(SQLiteDatabase db,boolean includePhotos)throws JSONException{
        JSONObject all=samples(db);
        for(Iterator<String> it=all.keys();it.hasNext();){
            JSONObject x=all.getJSONObject(it.next());
            String hash=text(x,"photoHash",false);
            if(includePhotos){
                if((!value(x,"photo")||x.getString("photo").isEmpty())&&hash!=null&&!hash.isEmpty()){
                    String data=photos.read(hash);
                    if(data!=null)x.put("photo",data);
                }
            }else x.remove("photo"); // 契约A/B：不含照片时只留 thumb/photoPath/photoHash
        }
        return all;
    }
    private static JSONArray exportRecords(SQLiteDatabase db)throws JSONException{
        JSONArray out=new JSONArray();
        try(Cursor c=db.query("records",null,null,null,null,null,"id ASC")){
            while(c.moveToNext()){JSONObject r=record(c);r.remove("recordId");out.put(r);} // 本机自增行号不进备份
        }
        return out;
    }
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
            applySettings(db,set);
            JSONArray keys=change.has("deleteSettings")?change.getJSONArray("deleteSettings"):new JSONArray();for(int i=0;i<keys.length();i++){String k=keys.getString(i);checkKey(k);db.delete("settings","key=?",new String[]{k});}
            validateTask(db);
            retainRecords(db); // 契约C：留存策略在 commit 事务内执行
            long revision=revision(db)+1;putMeta(db,"revision",Long.toString(revision));
            db.setTransactionSuccessful();return new JSONObject().put("ok",true).put("revision",revision).put("recordIds",ids);
        }finally{db.endTransaction();}
    }
    /** 兼容入口：旧前端整体替换语义不变（无条件清空后导入，失败抛错）。 */
    public synchronized JSONObject replaceBackup(String payload)throws JSONException{
        if(payload==null||payload.length()>PAYLOAD_LIMIT)throw new JSONException("备份过大或为空");
        JSONObject b=normalizeBackup(new JSONTokener(payload.replaceFirst("^\\uFEFF","")).nextValue(),false);
        SQLiteDatabase db=getWritableDatabase();db.beginTransaction();
        try{
            if(value(settings(db),"motionTask"))throw new JSONException("请先处理当前机械任务");
            db.delete("records",null,null);db.delete("samples",null,null);db.delete("settings",null,null);
            importRows(db,b);retainRecords(db);putMeta(db,"revision",Long.toString(revision(db)+1));db.setTransactionSuccessful();return new JSONObject().put("ok",true);
        }finally{db.endTransaction();}
    }
    /** 契约 F：preview/replace/merge + 子集恢复。校验失败返回 ok=false，库不变（先校验后进事务）。 */
    public synchronized JSONObject importBackupEx(String payload,String mode,String filterJson)throws JSONException{
        if(payload==null||payload.length()>PAYLOAD_LIMIT)return failure("备份过大或为空");
        String selectedMode=mode==null||mode.isEmpty()?"preview":mode;
        if(!IMPORT_MODES.contains(selectedMode))return failure("导入模式无效："+selectedMode);
        Object parsed;
        try{parsed=new JSONTokener(payload.replaceFirst("^\\uFEFF","")).nextValue();}
        catch(Exception e){return failure("备份文件不是有效的 JSON，可能已损坏或被截断");}
        if(!(parsed instanceof JSONObject))return failure("备份文件格式无效：顶层必须是对象");
        JSONObject data=(JSONObject)parsed;
        List<String> warnings=new ArrayList<>();
        JSONObject legacyMeta=null; // 契约F补充：随备份往返的旧库元信息（不参与 checksum）
        JSONObject rawSamples;JSONArray rawRecords;JSONObject rawSettings;
        boolean modern=data.has("schemaVersion")||data.has("checksum");
        if(modern){
            String app=data.optString("app","");
            if(!BackupFormat.APP_ID.equals(app))return failure("备份应用标识不匹配："+(app.isEmpty()?"（缺失）":app));
            if(!data.has("schemaVersion")||!data.has("checksum"))return failure("备份缺少 schemaVersion 或 checksum，无法校验");
            try{
                int schema=(int)number(data.opt("schemaVersion"),"schemaVersion",true);
                if(schema<=0)return failure("备份 schemaVersion 无效");
                if(schema>BACKUP_SCHEMA_VERSION)return failure("备份来自更高版本（schemaVersion="+schema+"），请先升级应用再导入");
                if(schema<BACKUP_SCHEMA_VERSION)warnings.add("备份 schemaVersion="+schema+"，低于当前 "+BACKUP_SCHEMA_VERSION+"，已按兼容方式导入");
                if(!(data.opt("samples") instanceof JSONObject)&&!(data.opt("samples") instanceof JSONArray))return failure("备份缺少 samples");
                if(!(data.opt("records") instanceof JSONArray))return failure("备份缺少 records");
                if(!(data.opt("settings") instanceof JSONObject))return failure("备份缺少 settings");
                JSONObject counts=data.optJSONObject("counts");
                if(counts==null)return failure("备份缺少 counts");
                rawSamples=BackupFormat.asObject(data.opt("samples"));
                rawRecords=(JSONArray)data.opt("records");
                rawSettings=(JSONObject)data.opt("settings");
                int expectSamples=(int)number(counts.opt("samples"),"counts.samples",true),expectRecords=(int)number(counts.opt("records"),"counts.records",true);
                if(expectSamples!=rawSamples.length()||expectRecords!=rawRecords.length())return failure("备份计数与内容不一致（counts="+expectSamples+"/"+expectRecords+"，实际="+rawSamples.length()+"/"+rawRecords.length()+"）");
                // 校验和一律按 payload 原样计算（含 recordId 等本机字段），保证篡改必被发现
                if(!BackupFormat.checksum(rawSamples,rawRecords,rawSettings).equals(data.optString("checksum","")))return failure("备份校验和不匹配，文件可能已损坏或被修改");
                JSONObject legacy=data.optJSONObject("legacyMeta");
                if(legacy!=null&&legacy.length()>0){legacyMeta=legacy;warnings.add("备份包含旧库迁移元信息，导入后将一并恢复");}
            }catch(JSONException e){return failure("备份校验失败："+(e.getMessage()==null?"字段格式无效":e.getMessage()));}
        }else{
            try{
                JSONObject normalized=normalizeBackup(data,false);
                rawSamples=normalized.getJSONObject("samples");rawRecords=normalized.getJSONArray("records");rawSettings=normalized.getJSONObject("settings");
                warnings.add("旧格式备份（无 schemaVersion/checksum），已按兼容方式处理");
            }catch(JSONException e){return failure("旧格式备份无效："+(e.getMessage()==null?"字段格式无效":e.getMessage()));}
        }
        LinkedHashMap<String,JSONObject> normalizedSamples=new LinkedHashMap<>();
        for(Iterator<String> it=rawSamples.keys();it.hasNext();){
            String key=it.next();Object item=rawSamples.opt(key);
            if(!(item instanceof JSONObject))return failure("样本 "+key+" 格式无效");
            JSONObject x;
            try{x=normalizeSample((JSONObject)item,key);}catch(JSONException e){return failure("样本 "+key+" 无效："+e.getMessage());}
            String sid=x.getString("id");
            if(normalizedSamples.containsKey(sid))return failure("样本 ID 重复："+sid);
            normalizedSamples.put(sid,x);
        }
        List<JSONObject> normalizedRecords=new ArrayList<>();
        for(int i=0;i<rawRecords.length();i++){
            Object item=rawRecords.opt(i);
            if(!(item instanceof JSONObject))return failure("记录格式无效（第 "+(i+1)+" 条）");
            try{normalizedRecords.add(normalizeRecord((JSONObject)item));}catch(JSONException e){return failure("记录 "+(i+1)+" 无效："+e.getMessage());}
        }
        JSONObject settings;
        try{
            settings=normalizeSettings(rawSettings);
            if(value(settings,"motionTask"))return failure("备份含未完成机械任务，请先在原设备核实");
            settings.put("simOn",false);settings.put("online",0);
        }catch(JSONException e){return failure("设置无效："+e.getMessage());}
        JSONObject filter=parseFilter(filterJson);
        Set<String> onlyIds=stringSet(filter.optJSONArray("onlySampleIds")),onlyCodes=stringSet(filter.optJSONArray("onlyCodes"));
        boolean filtered=!onlyIds.isEmpty()||!onlyCodes.isEmpty();
        LinkedHashMap<String,JSONObject> selected=new LinkedHashMap<>();
        for(Map.Entry<String,JSONObject> entry:normalizedSamples.entrySet()){
            String code=text(entry.getValue(),"code",false);
            if(!filtered||onlyIds.contains(entry.getKey())||(code!=null&&onlyCodes.contains(code)))selected.put(entry.getKey(),entry.getValue());
        }
        List<JSONObject> selectedRecords=new ArrayList<>();
        for(JSONObject r:normalizedRecords){
            String sid=text(r,"sampleId",false);
            if(filtered&&(sid==null||!selected.containsKey(sid)))continue; // 子集恢复只带命中样本的记录
            selectedRecords.add(r);
        }
        if(filtered)warnings.add("已按子集过滤：命中 "+selected.size()+" 个样本、"+selectedRecords.size()+" 条记录");
        SQLiteDatabase db=getReadableDatabase();
        Set<String> existingIds=new HashSet<>();Map<String,String> existingCodes=new HashMap<>(),existingSlots=new HashMap<>();
        try(Cursor c=db.rawQuery("SELECT sample_id,barcode,type,slot FROM samples",null)){
            while(c.moveToNext()){
                existingIds.add(c.getString(0));
                if(!c.isNull(1)&&!c.getString(1).isEmpty())existingCodes.put(c.getString(1),c.getString(0));
                if(!c.isNull(3))existingSlots.put(slotKey(c.getString(2),c.getInt(3)),c.getString(0));
            }
        }
        Set<String> dbFingerprints=fingerprints(db),seenCodes=new LinkedHashSet<>(),conflictCodes=new LinkedHashSet<>(),seenSlots=new LinkedHashSet<>(),conflictSlots=new LinkedHashSet<>();
        for(Map.Entry<String,JSONObject> entry:selected.entrySet()){
            JSONObject x=entry.getValue();
            String code=text(x,"code",false);
            if(code!=null&&!code.isEmpty()){
                if(!seenCodes.add(code))conflictCodes.add(code);                      // 备份内部条码重复
                String owner=existingCodes.get(code);
                if(owner!=null&&!owner.equals(entry.getKey()))conflictCodes.add(code); // 与库中其它样本冲突
            }
            if(value(x,"slot")){
                String key=slotKey(x.getString("type"),x.getInt("slot"));
                if(!seenSlots.add(key))conflictSlots.add(x.getString("type")+"圆盘"+x.getInt("slot"));
                String owner=existingSlots.get(key);
                if(owner!=null&&!owner.equals(entry.getKey()))conflictSlots.add(x.getString("type")+"圆盘"+x.getInt("slot"));
            }
        }
        if(!conflictSlots.isEmpty())warnings.add("备份中存在圆盘槽位冲突："+String.join("、",conflictSlots)+"，合并需先腾空槽位");
        int newSamples=0,updatedSamples=0;
        for(String sid:selected.keySet()){if(existingIds.contains(sid))updatedSamples++;else newSamples++;}
        int newRecords=0,duplicateRecords=0;Set<String> seenFingerprints=new HashSet<>();
        for(JSONObject r:selectedRecords){if(dbFingerprints.contains(fingerprint(r))||!seenFingerprints.add(fingerprint(r)))duplicateRecords++;else newRecords++;}
        JSONObject counts=new JSONObject().put("samples",selected.size()).put("records",selectedRecords.size());
        if("preview".equals(selectedMode)){
            JSONObject out=new JSONObject().put("ok",true).put("dryRun",true).put("mode","preview")
                .put("counts",counts)
                .put("backupCounts",new JSONObject().put("samples",normalizedSamples.size()).put("records",normalizedRecords.size()))
                .put("diff",new JSONObject().put("newSamples",newSamples).put("updatedSamples",updatedSamples).put("conflictCodes",new JSONArray(conflictCodes)).put("conflictSlots",new JSONArray(conflictSlots)).put("newRecords",newRecords).put("duplicateRecords",duplicateRecords))
                .put("warnings",new JSONArray(warnings));
            if(filtered)out.put("filter",new JSONObject().put("onlySampleIds",new JSONArray(onlyIds)).put("onlyCodes",new JSONArray(onlyCodes)));
            return out;
        }
        if("replace".equals(selectedMode)){
            long samples=count(db,"samples"),records=count(db,"records");
            if(samples>0||records>0)return failure("当前数据库不为空（样本 "+samples+"、记录 "+records+"），请改用合并导入（merge）");
        }
        if("merge".equals(selectedMode)&&!conflictCodes.isEmpty())return failure("备份含冲突条码："+String.join("、",conflictCodes)+"，合并已取消");
        if("merge".equals(selectedMode)&&!conflictSlots.isEmpty())return failure("备份含圆盘槽位冲突："+String.join("、",conflictSlots)+"，合并已取消");
        db=getWritableDatabase();db.beginTransaction();
        try{
            if(value(settings(db),"motionTask"))throw new JSONException("请先处理当前机械任务");
            if("replace".equals(selectedMode)){db.delete("records",null,null);db.delete("samples",null,null);db.delete("settings",null,null);}
            Map<String,String> codesNow=new HashMap<>(),slotsNow=new HashMap<>();
            try(Cursor c=db.rawQuery("SELECT sample_id,barcode,type,slot FROM samples",null)){
                while(c.moveToNext()){
                    if(!c.isNull(1)&&!c.getString(1).isEmpty())codesNow.put(c.getString(1),c.getString(0));
                    if(!c.isNull(3))slotsNow.put(slotKey(c.getString(2),c.getInt(3)),c.getString(0));
                }
            }
            Set<String> codeSeen=new LinkedHashSet<>(),slotSeen=new LinkedHashSet<>();
            int addedSamples=0,updatedApplied=0;
            for(Map.Entry<String,JSONObject> entry:selected.entrySet()){
                JSONObject x=entry.getValue();
                String sid=entry.getKey(),code=text(x,"code",false);
                if(code!=null&&!code.isEmpty()){
                    String owner=codesNow.get(code);
                    if(owner!=null&&!owner.equals(sid))throw new JSONException("条码冲突："+code+" 已属于样本 "+owner+"，合并已回滚");
                    if(!codeSeen.add(code))throw new JSONException("条码冲突："+code+" 在备份中重复出现，合并已回滚");
                }
                if(value(x,"slot")){
                    String key=slotKey(x.getString("type"),x.getInt("slot"));
                    String owner=slotsNow.get(key);
                    if(owner!=null&&!owner.equals(sid))throw new JSONException("圆盘槽位冲突："+x.getString("type")+"圆盘"+x.getInt("slot")+" 已被样本 "+owner+" 占用，合并已回滚");
                    if(!slotSeen.add(key))throw new JSONException("圆盘槽位冲突："+x.getString("type")+"圆盘"+x.getInt("slot")+" 在备份中重复，合并已回滚");
                    slotsNow.put(key,sid);
                }
                boolean exists=false;
                try(Cursor c=db.rawQuery("SELECT 1 FROM samples WHERE sample_id=?",new String[]{sid})){exists=c.moveToFirst();}
                upsert(db,x);
                if(exists)updatedApplied++;else addedSamples++;
                if(code!=null&&!code.isEmpty())codesNow.put(code,sid);
            }
            Set<String> fingerprints=fingerprints(db);
            int appended=0,skipped=0;
            for(JSONObject r:selectedRecords){
                if(!fingerprints.add(fingerprint(r))){skipped++;continue;} // 契约F：内容指纹去重后追加
                insertRecord(db,r,false);appended++;
            }
            applySettings(db,settings);
            restoreLegacyMeta(db,legacyMeta); // 契约F补充：导入成功才在事务内恢复旧库元信息
            retainRecords(db);
            long revision=revision(db)+1;putMeta(db,"revision",Long.toString(revision));
            db.setTransactionSuccessful();
            return new JSONObject().put("ok",true).put("mode",selectedMode).put("revision",revision)
                .put("applied",new JSONObject().put("newSamples",addedSamples).put("updatedSamples",updatedApplied).put("newRecords",appended).put("duplicateRecords",skipped))
                .put("warnings",new JSONArray(warnings));
        }catch(JSONException e){return failure(e.getMessage());}
        catch(SQLiteConstraintException e){return failure("导入失败：槽位或条码与现有数据冲突，已回滚");}
        catch(Exception e){return failure("导入失败："+(e.getMessage()==null?"未知错误":e.getMessage())+"，已回滚");}
        finally{db.endTransaction();}
    }
    /** 契约 G：CSV 导出，UTF-8 BOM + CRLF。 */
    public synchronized String exportCsv(String kind,String optionsJson)throws JSONException{
        JSONObject options=optionsJson==null||optionsJson.isEmpty()||"null".equals(optionsJson)?new JSONObject():new JSONObject(optionsJson);
        SQLiteDatabase db=getReadableDatabase();
        if("records".equals(kind)){
            List<String> args=new ArrayList<>();
            String where=recordWhere(optText(options,"fromIso"),optText(options,"toIso"),optText(options,"typeCode"),args);
            JSONArray out=new JSONArray();
            db.beginTransactionNonExclusive();
            try{
                try(Cursor c=db.rawQuery("SELECT * FROM records"+where+" ORDER BY time ASC, id ASC",args.toArray(new String[0]))){while(c.moveToNext())out.put(record(c));}
                db.setTransactionSuccessful();
            }finally{db.endTransaction();}
            return CsvExporter.records(out);
        }
        JSONObject all=samples(db);
        if("samples".equals(kind))return CsvExporter.samples(pickSamples(all,options));
        if("env".equals(kind))return CsvExporter.env(pickSamples(all,options));
        throw new JSONException("不支持的导出类型："+kind+"（可用 records/samples/env）");
    }
    private static JSONObject pickSamples(JSONObject all,JSONObject options)throws JSONException{
        JSONArray ids=options.optJSONArray("sampleIds");
        if(ids==null||ids.length()==0)return all;
        JSONObject out=new JSONObject();
        for(int i=0;i<ids.length();i++){Object v=ids.opt(i);if(v instanceof String&&all.has((String)v))out.put((String)v,all.get((String)v));}
        return out;
    }
    private static String optText(JSONObject options,String key){String v=options.optString(key,"");return v.isEmpty()?null:v;}
    private static JSONObject parseFilter(String filterJson){
        if(filterJson==null||filterJson.isEmpty()||"null".equals(filterJson))return new JSONObject();
        try{Object parsed=new JSONTokener(filterJson).nextValue();return parsed instanceof JSONObject?(JSONObject)parsed:new JSONObject();}catch(Exception e){return new JSONObject();}
    }
    private static Set<String> stringSet(JSONArray array)throws JSONException{
        Set<String> out=new LinkedHashSet<>();
        if(array==null)return out;
        for(int i=0;i<array.length();i++){Object v=array.opt(i);if(v instanceof String&&!((String)v).isEmpty())out.add((String)v);}
        return out;
    }
    private static Set<String> fingerprints(SQLiteDatabase db)throws JSONException{
        Set<String> out=new HashSet<>();
        try(Cursor c=db.rawQuery("SELECT time,sample_name,type,detail,barcode,slot,status FROM records",null)){
            while(c.moveToNext())out.add(fingerprint(c.isNull(0)?null:c.getString(0),c.isNull(1)?null:c.getString(1),c.isNull(2)?null:c.getString(2),c.isNull(3)?null:c.getString(3),c.isNull(4)?null:c.getString(4),c.isNull(5)?null:Long.toString(c.getLong(5)),c.isNull(6)?null:c.getString(6)));
        }
        return out;
    }
    /** 契约F：内容指纹 time|sample|type|detail|code|slot|status（不含 recordId）。 */
    private static String fingerprint(JSONObject r)throws JSONException{
        Object slot=value(r,"slot")?r.get("slot"):null;
        return fingerprint(text(r,"time",false),text(r,"sample",false),text(r,"type",false),text(r,"detail",false),text(r,"code",false),slot==null?null:String.valueOf(slot),text(r,"status",false));
    }
    private static String fingerprint(String time,String sample,String type,String detail,String code,String slot,String status){
        return orEmpty(time)+"|"+orEmpty(sample)+"|"+orEmpty(type)+"|"+orEmpty(detail)+"|"+orEmpty(code)+"|"+orEmpty(slot)+"|"+orEmpty(status);
    }
    private static String orEmpty(String value){return value==null?"":value;}
    private static String slotKey(String type,int slot){return orEmpty(type)+"\u0000"+slot;}
    private static JSONObject failure(String message){try{return new JSONObject().put("ok",false).put("error",message);}catch(JSONException impossible){return new JSONObject();}}
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
