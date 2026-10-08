package com.vitals.android;

import android.app.*;
import android.os.*;
import android.content.*;
import android.database.sqlite.SQLiteDatabase;
import android.hardware.usb.*;
import android.net.Uri;
import android.content.pm.PackageManager;
import android.content.pm.ResolveInfo;
import android.print.PrintManager;
import android.webkit.*;
import androidx.core.content.FileProvider;
import android.util.Log;
import org.json.*;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.util.*;
import java.util.concurrent.*;
import com.hoho.android.usbserial.driver.*;

/** Only packaged assets can execute inside this bridge-enabled WebView. */
public class MainActivity extends Activity {
    private static final String ORIGIN = "https://appassets.androidplatform.net/";
    private static final String USB_PERMISSION = "com.vitals.android.USB_PERMISSION";
    private static final int REQ_EXPORT = 1;
    private static final int REQ_IMPORT = 2;
    private static final int REQ_PHOTO = 3;
    private static final int REQ_INSTALL_PERMISSION = 4;
    private WebView web;
    private SQLiteDatabase db;
    private VitalsDbHelper dbHelper;
    private UsbManager usb;
    private UsbLabelPrinter labelPrinter;
    private final Map<String, Session> sessions = new ConcurrentHashMap<>();
    private final Set<String> opening = ConcurrentHashMap.newKeySet();
    private final ExecutorService io = Executors.newCachedThreadPool();
    private String pendingRole;
    private UsbSerialPort pendingPort;
    private int pendingBaud;
    private String exportContent;
    private ValueCallback<Uri[]> files;
    private volatile boolean destroyed;
    private volatile boolean updateBusy;
    private volatile String pendingInstallPath;

    @android.annotation.SuppressLint("UnspecifiedRegisterReceiverFlag") // pre-33 branch is protected by our signature permission; 33+ explicitly NOT_EXPORTED.
    @Override public void onCreate(Bundle saved) {
        super.onCreate(saved);
        dbHelper = new VitalsDbHelper(this);
        usb = (UsbManager)getSystemService(USB_SERVICE);
        labelPrinter = new UsbLabelPrinter(this, (type,message) -> event(type,"printer",message));
        web = new WebView(this);
        setContentView(web);
        getWindow().addFlags(android.view.WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(true); // only user-selected SAF files for image uploads
        s.setAllowFileAccessFromFileURLs(false);
        s.setAllowUniversalAccessFromFileURLs(false);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        web.addJavascriptInterface(new Bridge(), "AndroidHost");
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG);
        web.setWebViewClient(new WebViewClient() {
            @Override public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest r) { return true; }
            @Override public WebResourceResponse shouldInterceptRequest(WebView v, WebResourceRequest r) {
                Uri u = r.getUrl();
                try {
                    if (!"https".equals(u.getScheme()) || !"appassets.androidplatform.net".equals(u.getHost())) return blocked();
                    String path = u.getPath();
                    if(path == null || path.contains("..") || !path.startsWith("/web/")) return blocked();
                    String mime = path.endsWith(".html") ? "text/html" : path.endsWith(".js") ? "application/javascript" : path.endsWith(".css") ? "text/css" : path.endsWith(".png") ? "image/png" : "application/octet-stream";
                    WebResourceResponse res = new WebResourceResponse(mime, "UTF-8", getAssets().open(path.substring(1)));
                    Map<String,String> headers = new HashMap<>();
                    headers.put("Content-Security-Policy", "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: content:; font-src 'self'; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'");
                    res.setResponseHeaders(headers);
                    return res;
                } catch(Exception e) { return blocked(); }
            }
        });
        web.setWebChromeClient(new WebChromeClient() {
            @Override public boolean onConsoleMessage(ConsoleMessage m) { Log.d("VitalsWeb", m.message()+" @"+m.lineNumber()); return true; }
            @Override public boolean onShowFileChooser(WebView v, ValueCallback<Uri[]> cb, FileChooserParams params) {
                if(files != null) files.onReceiveValue(null);
                files=cb;
                Intent pick = new Intent(Intent.ACTION_OPEN_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).setType("image/*");
                try { startActivityForResult(pick, 3); } catch(Exception e) { files.onReceiveValue(null); files=null; }
                return true;
            }
        });
        IntentFilter filter = new IntentFilter(USB_PERMISSION);
        if(Build.VERSION.SDK_INT >= 33) registerReceiver(receiver, filter, Context.RECEIVER_NOT_EXPORTED);
        else registerReceiver(receiver, filter);
        IntentFilter deviceFilter = new IntentFilter(UsbManager.ACTION_USB_DEVICE_ATTACHED);
        deviceFilter.addAction(UsbManager.ACTION_USB_DEVICE_DETACHED);
        if(Build.VERSION.SDK_INT >= 33) registerReceiver(deviceReceiver, deviceFilter, Context.RECEIVER_NOT_EXPORTED);
        else registerReceiver(deviceReceiver, deviceFilter);
        // Legacy migrations can include photos. Do the open/upgrade off the UI thread.
        io.execute(() -> {
            try {
                db = dbHelper.getWritableDatabase();
                runOnUiThread(() -> {if(!destroyed)web.loadUrl(ORIGIN+"web/index.html");});
            } catch(Exception e) {
                Log.e("VitalsDB","Database open failed; legacy data retained",e);
                runOnUiThread(() -> {if(!destroyed)new AlertDialog.Builder(this).setTitle("数据库升级未完成").setMessage("原数据已保留，请勿卸载或清除数据。\n"+e.getMessage()).setPositiveButton("关闭",(d,w)->finish()).setCancelable(false).show();});
            }
        });
    }
    private WebResourceResponse blocked() { return new WebResourceResponse("text/plain", "UTF-8", 403, "Blocked", new HashMap<>(), new ByteArrayInputStream(new byte[0])); }
    private void event(String type, String role, String text) {
        if(destroyed) return;
        runOnUiThread(() -> { if(!destroyed) web.evaluateJavascript("window.onAndroidEvent && window.onAndroidEvent("+JSONObject.quote(type)+","+JSONObject.quote(role)+","+JSONObject.quote(text)+")", null); });
    }
    /** 更新状态统一以 update 事件回传，状态正文经 JSON 序列化，避免引号破坏 JS 语法。 */
    private void updateEvent(String status, JSONObject extra) {
        try {
            JSONObject payload = new JSONObject().put("status", status);
            if (extra != null) {
                for (Iterator<String> it = extra.keys(); it.hasNext(); ) { String k = it.next(); payload.put(k, extra.get(k)); }
            }
            event("update", "", payload.toString());
        } catch (JSONException ignored) { }
    }
    private void checkUpdateAsync() {
        if (updateBusy) { updateEvent("busy", null); return; }
        if (destroyed) { updateEvent("error", updateMessage("应用已关闭")); return; }
        updateBusy = true;
        updateEvent("checking", null);
        io.execute(() -> {
            try {
                updateEvent("checked", VitalsUpdater.check(this, BuildConfig.VERSION_CODE, BuildConfig.VERSION_NAME));
            } catch (Exception e) {
                updateEvent("error", updateMessage(e.getMessage() == null ? "检查更新失败" : e.getMessage()));
            } finally {
                updateBusy = false;
            }
        });
    }
    private void downloadUpdateAsync(String tag, long size, String sha256) {
        if (updateBusy) { updateEvent("busy", null); return; }
        if (tag == null || tag.isEmpty()) { updateEvent("error", updateMessage("没有可用的版本标签，请先检查更新")); return; }
        updateBusy = true;
        try {
            updateEvent("downloading", new JSONObject().put("total", size));
        } catch (JSONException ignored) { }
        io.execute(() -> {
            try {
                // 只信任 tag：安装包地址由原生重新解析，并再次通过域名白名单校验。
                VitalsUpdater.Release release = VitalsUpdater.resolve(tag);
                File apk = VitalsUpdater.download(this, release.apkUrl, release.apkSize > 0 ? release.apkSize : size, release.sha256 != null ? release.sha256 : sha256, (downloaded, total) -> {
                    try {
                        updateEvent("progress", new JSONObject().put("downloaded", downloaded).put("total", total).put("percent", total > 0 ? (int) (downloaded * 100 / total) : -1)
                                .put("percentText", total > 0 ? (downloaded * 100 / total) + "%" : humanSize(downloaded)));
                    } catch (JSONException ignored) { }
                    return !destroyed;
                });
                pendingInstallPath = VitalsUpdater.verifyApk(this, apk);
                try {
                    updateEvent("downloaded", new JSONObject().put("name", apk.getName()).put("size", apk.length()).put("sizeText", humanSize(apk.length())));
                } catch (JSONException ignored) { }
            } catch (Exception e) {
                updateEvent("error", updateMessage(e.getMessage() == null ? "下载更新失败" : e.getMessage()));
            } finally {
                updateBusy = false;
            }
        });
    }
    private void installUpdateAsync() {
        String path = pendingInstallPath;
        if (path == null) { updateEvent("error", updateMessage("请先下载更新包")); return; }
        runOnUiThread(() -> beginInstall(path));
    }
    /** 交系统安装器处理新版本；未授予「安装未知应用」权限时先引导到系统设置。 */
    private void beginInstall(String path) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && !getPackageManager().canRequestPackageInstalls()) {
            pendingInstallPath = path;
            updateEvent("permissionRequired", updateMessage("请在系统中允许本应用安装未知应用，返回后会自动继续"));
            try {
                startActivityForResult(new Intent(android.provider.Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:" + getPackageName())), REQ_INSTALL_PERMISSION);
            } catch (Exception e) {
                updateEvent("error", updateMessage("无法打开安装权限设置页：" + e.getMessage()));
            }
            return;
        }
        updateEvent("installing", null);
        try {
            Uri uri = FileProvider.getUriForFile(this, getPackageName() + ".fileprovider", new File(path));
            startActivity(new Intent(Intent.ACTION_VIEW).setDataAndType(uri, "application/vnd.android.package-archive").addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION));
        } catch (Exception e) {
            Log.e("VitalsUpdate", "install failed", e);
            updateEvent("error", updateMessage("无法启动系统安装器：" + e.getMessage()));
        }
    }
    private static String humanSize(long bytes) {
        if (bytes < 1024) return bytes + " B";
        if (bytes < 1024 * 1024) return String.format(Locale.ROOT, "%.1f KB", bytes / 1024.0);
        return String.format(Locale.ROOT, "%.1f MB", bytes / (1024.0 * 1024.0));
    }
    private static JSONObject updateMessage(String text) {
        try { return new JSONObject().put("message", text); } catch (JSONException impossible) { return new JSONObject(); }
    }
    private String externalDevicesJson() {
        int scanners=0,printers=0;
        for(UsbDevice device:usb.getDeviceList().values()) {
            boolean printer=false;
            for(int i=0;i<device.getInterfaceCount();i++) {
                int deviceClass=device.getInterface(i).getInterfaceClass();
                if(deviceClass==UsbConstants.USB_CLASS_PRINTER) printer=true;
            }
            if(isScanner(device))scanners++;
            if(printer)printers++;
        }
        try {return new JSONObject().put("scanner",scanners).put("printer",printers).toString();}
        catch(JSONException impossible) {return "{\"scanner\":0,\"printer\":0}";}
    }
    private static boolean isScanner(UsbDevice device) {
        String product=device.getProductName();
        return (device.getVendorId()==0x152A && device.getProductId()==0x880F) ||
            (product!=null && product.toLowerCase(Locale.ROOT).contains("vserial"));
    }
    private void notifyExternalDevices() { event("devices","external",externalDevicesJson()); }
    public class Bridge {
        // These methods run on WebView's Java Bridge thread, not the Android UI thread.
        @JavascriptInterface public String loadState(){return databaseCall(() -> dbHelper.loadState());}
        @JavascriptInterface public String getDatabaseInfo(){return databaseCall(() -> dbHelper.info());}
        @JavascriptInterface public String getSamples(){return databaseCall(() -> dbHelper.getSamples());}
        @JavascriptInterface public String getSample(String id){return databaseCall(() -> dbHelper.getSample(id,false));}
        @JavascriptInterface public String getSampleByBarcode(String code){return databaseCall(() -> dbHelper.getSample(code,true));}
        @JavascriptInterface public String getRecords(String sampleId){return databaseCall(() -> dbHelper.getRecords(sampleId));}
        @JavascriptInterface public String getSettings(){return databaseCall(() -> dbHelper.getSettings());}
        @JavascriptInterface public String saveSample(String payload,String record){return databaseCall(() -> dbHelper.saveSample(new JSONObject(payload),optionalRecord(record)));}
        @JavascriptInterface public String deleteSample(String id,String record){return databaseCall(() -> dbHelper.deleteSample(id,optionalRecord(record)));}
        @JavascriptInterface public String addRecord(String payload){return databaseCall(() -> dbHelper.addRecord(new JSONObject(payload)));}
        @JavascriptInterface public String setSetting(String key,String jsonValue){return databaseCall(() -> dbHelper.setSetting(key,new JSONTokener(jsonValue).nextValue()));}
        @JavascriptInterface public String commitChanges(String payload){return databaseCall(() -> dbHelper.commit(new JSONObject(payload)));}
        @JavascriptInterface public String importBackup(String payload){return databaseCall(() -> dbHelper.replaceBackup(payload));}
        @JavascriptInterface public String getBackup(){return databaseCall(() -> dbHelper.exportBackup());}
        @JavascriptInterface public String getExternalDevices(){return externalDevicesJson();}
        @JavascriptInterface public String getAppVersion(){try{return new JSONObject().put("version",BuildConfig.VERSION_NAME).put("versionCode",BuildConfig.VERSION_CODE).put("repo",VitalsUpdater.REPO).toString();}catch(JSONException impossible){return "{}";}}
        @JavascriptInterface public void checkUpdate(){checkUpdateAsync();}
        @JavascriptInterface public void downloadUpdate(String tag,long size,String sha256){downloadUpdateAsync(tag,size,sha256);}
        @JavascriptInterface public void installUpdate(){installUpdateAsync();}
        @JavascriptInterface public void exportJson(String filename,String content) {
            runOnUiThread(() -> {
                if(exportContent!=null) { event("export","","已有导出窗口，请先完成或取消"); return; }
                exportContent=content;
                try { startActivityForResult(new Intent(Intent.ACTION_CREATE_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).setType("application/json").putExtra(Intent.EXTRA_TITLE,filename),1); }
                catch(Exception e) { exportContent=null; event("export","","无法打开文件选择器"); }
            });
        }
        @JavascriptInterface public void importJson() {
            runOnUiThread(() -> { try { startActivityForResult(new Intent(Intent.ACTION_OPEN_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).setType("*/*"),2); } catch(Exception e) { event("error","","无法打开文件选择器"); } });
        }
        @JavascriptInterface public void printLabel() {
            runOnUiThread(() -> ((PrintManager)getSystemService(PRINT_SERVICE)).print("Vitals 样本标签",web.createPrintDocumentAdapter("Vitals 标签"),null));
        }
        @JavascriptInterface public void connectLabelPrinter() { runOnUiThread(() -> labelPrinter.connect()); }
        @JavascriptInterface public void printUsbLabel(String payload) { labelPrinter.print(payload); }
        @JavascriptInterface public void connect(String role,int baud) {
            if(!role.equals("sensor") && !role.equals("motion") && !role.equals("scanner")) return;
            if(baud<300 || baud>2000000) { event("error",role,"波特率无效"); return; }
            runOnUiThread(() -> choosePort(role,baud));
        }
        @JavascriptInterface public void disconnect(String role) { close(role); }
        @JavascriptInterface public void send(String role,String line) {
            if(line.length()>4096 || line.indexOf('\n')>=0 || line.indexOf('\r')>=0) { event("error",role,"无效命令行"); return; }
            Session connection=sessions.get(role);
            io.execute(() -> {
                try {
                    if(connection==null || sessions.get(role)!=connection) throw new IOException("设备未连接");
                    connection.port.write((line+"\n").getBytes(StandardCharsets.UTF_8),2000);
                    event("sent",role,line);
                } catch(Exception e) { event("error",role,"发送失败："+e.getMessage()); }
            });
        }
    }
    private interface DatabaseOperation {Object run() throws Exception;}
    private JSONObject optionalRecord(String json)throws JSONException{return json==null||json.isEmpty()||json.equals("null")?null:new JSONObject(json);}
    private String databaseCall(DatabaseOperation operation){
        try {if(destroyed)throw new IllegalStateException("应用已关闭");Object result=operation.run();return result==null?"null":result.toString();}
        catch(Exception e){Log.e("VitalsDB","Database operation failed",e);try{return new JSONObject().put("ok",false).put("error",e.getMessage()==null?"数据库操作失败":e.getMessage()).toString();}catch(JSONException impossible){return "{\"ok\":false,\"error\":\"数据库操作失败\"}";}}
    }
    private void choosePort(String role,int baud) {
        if(pendingPort!=null || !opening.isEmpty()) { event("error",role,"请先完成当前 USB 授权／连接"); return; }
        if(sessions.containsKey(role)) { event("error",role,"此用途已有设备，请先断开"); return; }
        List<UsbSerialPort> ports=new ArrayList<>(); List<String> names=new ArrayList<>();
        for(UsbSerialDriver driver:UsbSerialProber.getDefaultProber().findAllDrivers(usb)) {
            if(role.equals("scanner")!=isScanner(driver.getDevice())) continue;
            for(UsbSerialPort p:driver.getPorts()) {
                boolean used=false;
                for(Session c:sessions.values()) if(c.port.getDriver().getDevice().getDeviceId()==driver.getDevice().getDeviceId()) used=true;
                if(!used) { ports.add(p); names.add(driver.getClass().getSimpleName()+" / "+driver.getDevice().getDeviceName()+" / 端口 "+p.getPortNumber()); }
            }
        }
        if(ports.isEmpty()) { event("error",role,role.equals("scanner")?"未找到得力 AA307 扫码枪。请确认已切换为 USB 虚拟串口模式并重新插接。":"未找到可用 USB 串口。请检查线缆、串口芯片和 USB Host 模式。"); return; }
        if(role.equals("scanner")&&ports.size()==1) { requestOpen(role,ports.get(0),baud); return; }
        String title=role.equals("sensor")?"选择温控设备":role.equals("scanner")?"选择扫码枪":"选择机械设备";
        new AlertDialog.Builder(this).setTitle(title)
            .setItems(names.toArray(new String[0]),(dialog,which)-> {
                if(pendingPort!=null || !opening.isEmpty() || sessions.containsKey(role)) return;
                UsbSerialPort p=ports.get(which);
                for(Session c:sessions.values()) if(c.port.getDriver().getDevice().getDeviceId()==p.getDriver().getDevice().getDeviceId()) { event("error",role,"设备已被占用"); return; }
                requestOpen(role,p,baud);
            }).setNegativeButton("取消",null).show();
    }
    private void requestOpen(String role,UsbSerialPort p,int baud) {
        if(usb.hasPermission(p.getDriver().getDevice())) {open(role,p,baud);return;}
        pendingRole=role;pendingPort=p;pendingBaud=baud;
        int flags=PendingIntent.FLAG_UPDATE_CURRENT;
        if(Build.VERSION.SDK_INT>=Build.VERSION_CODES.M) flags|=PendingIntent.FLAG_MUTABLE;
        usb.requestPermission(p.getDriver().getDevice(),PendingIntent.getBroadcast(this,0,new Intent(USB_PERMISSION).setPackage(getPackageName()),flags));
    }
    private void open(String role,UsbSerialPort p,int baud) {
        opening.add(role);
        io.execute(() -> {
            UsbDeviceConnection c=null;
            try {
                c=usb.openDevice(p.getDriver().getDevice());
                if(c==null) throw new IOException("设备已断开或没有授权");
                p.open(c); p.setParameters(baud,8,UsbSerialPort.STOPBITS_1,UsbSerialPort.PARITY_NONE);
                if(destroyed) throw new IOException("应用已关闭");
                Session session=new Session(p,c); sessions.put(role,session);
                event("connected",role,"已连接 · "+baud+" baud / 8N1");
                io.execute(() -> read(role,session));
            } catch(Exception e) { try {p.close();} catch(Exception ignored){} if(c!=null)c.close(); event("error",role,e.getMessage()); }
            finally { opening.remove(role); }
        });
    }
    private void read(String role,Session session) {
        byte[] buffer=new byte[4096]; ByteArrayOutputStream line=new ByteArrayOutputStream(); boolean overflow=false;
        try {
            while(sessions.get(role)==session && !destroyed) {
                int n=session.port.read(buffer,250);
                if(role.equals("scanner")) {
                    // A scan is a short burst followed by idle time. Buffer the whole burst so embedded
                    // CR/LF in legacy multiline QR payloads cannot split one scan into several messages.
                    for(int i=0;i<n && !overflow;i++) {
                        if(line.size()>=8192) {line.reset();overflow=true;event("error",role,"收到超长扫码数据，已丢弃");}
                        else line.write(buffer[i]);
                    }
                    if(n<=0) {
                        if(!overflow && line.size()>0) event("line",role,line.toString("UTF-8").trim());
                        line.reset();overflow=false;
                    }
                    continue;
                }
                for(int i=0;i<n;i++) {
                    if(buffer[i]==10 || buffer[i]==13) {
                        if(!overflow && line.size()>0) event("line",role,line.toString("UTF-8").trim());
                        line.reset(); overflow=false;
                    } else if(!overflow) {
                        if(line.size()>=8192) {line.reset();overflow=true; event("error",role,"收到超长数据行，已丢弃");}
                        else line.write(buffer[i]);
                    }
                }
                // Some temperature boards periodically send one ASCII value without CR/LF.
                // Treat 250 ms of bus silence as the end of that value while retaining normal line framing.
                if(role.equals("sensor") && n<=0 && line.size()>0) {
                    if(!overflow) event("line",role,line.toString("UTF-8").trim());
                    line.reset();overflow=false;
                }
            }
        } catch(Exception e) { if(sessions.get(role)==session) { event("error",role,"连接中断："+e.getMessage()); close(role); } }
    }
    private void close(String role) {
        Session s=sessions.remove(role);
        if(s!=null) {try{s.port.close();}catch(Exception ignored){} s.connection.close(); event("disconnected",role,"已断开");}
    }
    private final BroadcastReceiver receiver=new BroadcastReceiver() {
        @Override public void onReceive(Context c,Intent i) {
            UsbDevice d=i.getParcelableExtra(UsbManager.EXTRA_DEVICE);
            if(USB_PERMISSION.equals(i.getAction())) {
                if(pendingPort==null || d==null || d.getDeviceId()!=pendingPort.getDriver().getDevice().getDeviceId()) return;
                String r=pendingRole; UsbSerialPort p=pendingPort; int b=pendingBaud; pendingPort=null; pendingRole=null;
                if(usb.hasPermission(d)) open(r,p,b); else event("error",r,"USB 授权被拒绝");
            }
        }
    };
    private final BroadcastReceiver deviceReceiver=new BroadcastReceiver() {
        @Override public void onReceive(Context c,Intent i) {
            UsbDevice d=i.getParcelableExtra(UsbManager.EXTRA_DEVICE);
            if(UsbManager.ACTION_USB_DEVICE_DETACHED.equals(i.getAction()) && d!=null) {
                for(String r:new ArrayList<>(sessions.keySet())) { Session s=sessions.get(r); if(s!=null && s.port.getDriver().getDevice().getDeviceId()==d.getDeviceId()) close(r); }
                if(pendingPort!=null && pendingPort.getDriver().getDevice().getDeviceId()==d.getDeviceId()) {event("error",pendingRole,"授权期间设备已拔出");pendingPort=null;pendingRole=null;}
            }
            new Handler(Looper.getMainLooper()).postDelayed(() -> notifyExternalDevices(),250);
        }
    };
    @android.annotation.SuppressLint({"MissingSuperCall","Deprecated"}) // 沿用既有的 requestCode 文件流程
    @Override protected void onActivityResult(int req,int result,Intent data) {
        super.onActivityResult(req,result,data);
        // 从「安装未知应用」权限设置页返回：只有用户真的开启了权限才继续安装。
        if (req == REQ_INSTALL_PERMISSION) {
            String path = pendingInstallPath;
            if (path != null && Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && getPackageManager().canRequestPackageInstalls()) { beginInstall(path); }
            else { pendingInstallPath = null; updateEvent("cancelled", updateMessage("未授予安装权限，更新已暂停；可稍后再次点击「一键更新」")); }
            return;
        }
        if(req==3) { if(files!=null){files.onReceiveValue(result==RESULT_OK && data!=null?new Uri[]{data.getData()}:null);files=null;}return; }
        if(result!=RESULT_OK || data==null || data.getData()==null) {if(req==1)exportContent=null;event("info","","已取消文件操作");return;}
        Uri uri=data.getData(); String content=exportContent; if(req==1)exportContent=null;
        io.execute(() -> {
            try {
                if(req==1 && content!=null) {try(OutputStream out=getContentResolver().openOutputStream(uri,"wt")){if(out==null)throw new IOException("无法写入");out.write(content.getBytes(StandardCharsets.UTF_8));}event("export","","备份已保存");}
                if(req==2) {
                    try(InputStream in=getContentResolver().openInputStream(uri); ByteArrayOutputStream out=new ByteArrayOutputStream()) {
                        if(in==null)throw new IOException("无法读取");byte[] b=new byte[8192];int n;
                        while((n=in.read(b))!=-1){if(out.size()+n>20*1024*1024)throw new IOException("备份超过 20MB，请分批迁移");out.write(b,0,n);}
                        event("import","",out.toString("UTF-8"));
                    }
                }
            } catch(Exception e) {event("error","","文件操作失败："+e.getMessage());}
        });
    }
    @Override public void onBackPressed() {web.evaluateJavascript("window.androidBack && window.androidBack()",null);}
    @Override protected void onDestroy() {
        labelPrinter.close();
        destroyed=true;for(String r:new ArrayList<>(sessions.keySet()))close(r);
        unregisterReceiver(receiver);unregisterReceiver(deviceReceiver);io.shutdownNow();web.removeJavascriptInterface("AndroidHost");web.destroy();
        dbHelper.close();
        super.onDestroy();
    }
    private static class Session {final UsbSerialPort port;final UsbDeviceConnection connection;Session(UsbSerialPort p,UsbDeviceConnection c){port=p;connection=c;}}
}
