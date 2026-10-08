package com.vitals.android;

import android.app.PendingIntent;
import android.content.*;
import android.hardware.usb.*;
import android.os.Build;
import android.graphics.*;
import android.util.Base64;
import org.json.*;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicBoolean;

/** USB printer-class transport for the attached DL-720 family. No serial-port claims. */
final class UsbLabelPrinter {
    interface Listener { void result(String type, String message); }
    private static final String ACTION = "com.vitals.android.PRINTER_PERMISSION";
    private final Context context;
    private final UsbManager manager;
    private final Listener listener;
    private final ExecutorService executor = Executors.newSingleThreadExecutor();
    private final AtomicBoolean busy = new AtomicBoolean();
    private volatile boolean closed;
    private volatile boolean permissionPending;
    UsbLabelPrinter(Context context, Listener listener) {
        this.context=context; this.listener=listener;
        manager=(UsbManager)context.getSystemService(Context.USB_SERVICE);
        IntentFilter filter=new IntentFilter(ACTION);
        if(Build.VERSION.SDK_INT>=33) context.registerReceiver(receiver,filter,Context.RECEIVER_NOT_EXPORTED);
        else context.registerReceiver(receiver,filter);
    }
    private UsbInterface printerInterface(UsbDevice device) {
        for(int i=0;i<device.getInterfaceCount();i++) {
            UsbInterface face=device.getInterface(i);
            if(face.getInterfaceClass()==UsbConstants.USB_CLASS_PRINTER) return face;
        }
        return null;
    }
    private UsbDevice device() throws IOException {
        UsbDevice found=null;
        for(UsbDevice d:manager.getDeviceList().values()) {
            if(d.getVendorId()==2501 && d.getProductId()==1640 && printerInterface(d)!=null) {
                if(found!=null) throw new IOException("检测到多台标签打印机，请只连接需要使用的一台");
                found=d;
            }
        }
        if(found==null) throw new IOException("未找到得力 USB 标签打印机，请检查电源与 USB 连接");
        return found;
    }
    private void emit(String type,String message) { if(!closed) listener.result(type,message); }
    void connect() {
        if(closed || busy.get() || permissionPending) { emit("error","打印机正在处理请求，请稍后"); return; }
        try {
            UsbDevice d=device();
            if(manager.hasPermission(d)) { inspect(); return; }
            permissionPending=true;
            int flags=PendingIntent.FLAG_UPDATE_CURRENT;
            if(Build.VERSION.SDK_INT>=Build.VERSION_CODES.M) flags|=PendingIntent.FLAG_MUTABLE;
            PendingIntent pending=PendingIntent.getBroadcast(context,720,new Intent(ACTION).setPackage(context.getPackageName()),flags);
            manager.requestPermission(d,pending);
        } catch(Exception e) { permissionPending=false; emit("error",e.getMessage()); }
    }
    private final BroadcastReceiver receiver=new BroadcastReceiver() {
        @Override public void onReceive(Context c,Intent intent) {
            permissionPending=false;
            try {
                if(!manager.hasPermission(device())) { emit("error","未允许访问 USB 打印机，请重新连接并授权"); return; }
                inspect(); // Permission never triggers a print job.
            } catch(Exception e) { emit("error",e.getMessage()); }
        }
    };
    private String deviceId(UsbDeviceConnection connection,UsbInterface face) {
        byte[] buffer=new byte[1024];
        int count=connection.controlTransfer(0xA1,0,0,face.getId(),buffer,buffer.length,1000);
        if(count<=2) return "";
        int length=((buffer[0]&255)<<8)|(buffer[1]&255);
        return new String(buffer,2,Math.max(0,Math.min(count,length)-2),StandardCharsets.US_ASCII).trim();
    }
    private String verifiedModel(UsbDeviceConnection connection,UsbInterface face) throws IOException {
        String id=deviceId(connection,face);
        android.util.Log.i("VitalsPrinter",id);
        if(!id.contains("TSPL") || !id.contains("DL-720")) throw new IOException("未能确认 DL-720 打印协议，请检查设备后重新连接");
        java.util.regex.Matcher model=java.util.regex.Pattern.compile("MODEL:([^;]+)").matcher(id);
        return model.find()?model.group(1).trim():"DL-720";
    }
    private int portStatus(UsbDeviceConnection connection,UsbInterface face) {
        byte[] b=new byte[1];
        return connection.controlTransfer(0xA1,1,0,face.getId(),b,1,1000)==1 ? b[0]&255 : -1;
    }
    private String statusText(int s) {
        if(s<0) return "设备未提供纸张状态，请人工确认装纸";
        if((s&0x20)!=0) return "缺纸，请装入标签纸";
        if((s&0x08)==0) return "打印机报告异常，请检查上盖和指示灯";
        if((s&0x10)==0) return "打印机未就绪";
        return "设备就绪，请确认标签尺寸";
    }
    private void inspect() {
        if(!busy.compareAndSet(false,true)) return;
        executor.execute(()->{
            try {
                UsbDevice d=device(); UsbInterface face=printerInterface(d);
                UsbDeviceConnection c=manager.openDevice(d);
                try {
                    if(c==null) throw new IOException("无法打开打印机，请重新授权");
                    if(!c.claimInterface(face,true)) throw new IOException("打印机接口正在被其他应用使用");
                    try {emit("ready","USB 已连接 · 得力 "+verifiedModel(c,face)+" · "+statusText(portStatus(c,face)));}
                    finally {c.releaseInterface(face);}
                } finally {if(c!=null)c.close();}
            } catch(Exception e) { emit("error",e.getMessage()); }
            finally {busy.set(false);}
        });
    }
    void print(String payload) {
        if(closed || permissionPending || !busy.compareAndSet(false,true)) { emit("error","打印机忙，请等待当前请求完成"); return; }
        executor.execute(()->{
            boolean sending=false;
            try {
                byte[] job=encode(payload);
                UsbDevice d=device();
                if(!manager.hasPermission(d)) throw new IOException("请先点击连接 USB 打印机并授权，再打印");
                UsbInterface face=printerInterface(d); UsbEndpoint output=null;
                for(int i=0;i<face.getEndpointCount();i++) { UsbEndpoint ep=face.getEndpoint(i); if(ep.getType()==UsbConstants.USB_ENDPOINT_XFER_BULK && ep.getDirection()==UsbConstants.USB_DIR_OUT) output=ep; }
                if(output==null) throw new IOException("打印机没有可用的 USB 输出端点");
                UsbDeviceConnection c=manager.openDevice(d);
                try {
                    if(c==null || !c.claimInterface(face,true)) throw new IOException("无法占用打印机接口，请关闭其他打印应用");
                    try {
                        verifiedModel(c,face);
                        int status=portStatus(c,face);
                        if(status>=0 && ((status&0x20)!=0 || (status&0x08)==0 || (status&0x10)==0)) throw new IOException(statusText(status));
                        sending=true;
                        long deadline=System.nanoTime()+TimeUnit.SECONDS.toNanos(30);
                        for(int offset=0;offset<job.length;) {
                            if(closed || System.nanoTime()>deadline) throw new IOException("USB 发送超时");
                            int n=c.bulkTransfer(output,job,offset,Math.min(4096,job.length-offset),3000);
                            if(n<=0) throw new IOException("USB 传输中断");
                            offset+=n;
                        }
                        emit("sent","已发送 1 张标签，请检查实际出纸结果");
                    } finally {c.releaseInterface(face);}
                } finally {if(c!=null)c.close();}
            } catch(Exception e) { emit("error",(sending?"发送可能不完整，请检查打印机；不会自动重试。":"未发送打印任务：")+e.getMessage()); }
            finally {busy.set(false);}
        });
    }
    /** Render black pixel runs with TSPL BAR, avoiding firmware bitmap polarity differences. */
    static byte[] encode(String payload) throws Exception {
        if(payload==null || payload.length()>1500000) throw new IOException("标签数据过大");
        JSONObject json=new JSONObject(payload);
        double width=json.getDouble("width"),height=json.getDouble("height"),gap=json.getDouble("gap");
        if(!Double.isFinite(width)||!Double.isFinite(height)||!Double.isFinite(gap)||width<20||width>80||height<20||height>100||gap<0||gap>10) throw new IOException("标签尺寸无效");
        String png=json.getString("png");
        if(!png.startsWith("data:image/png;base64,")) throw new IOException("标签必须为 PNG");
        byte[] data=Base64.decode(png.substring(22),Base64.DEFAULT);
        BitmapFactory.Options bounds=new BitmapFactory.Options(); bounds.inJustDecodeBounds=true;
        BitmapFactory.decodeByteArray(data,0,data.length,bounds);
        int w=(int)Math.round(width*8),h=(int)Math.round(height*8);
        if(bounds.outWidth!=w||bounds.outHeight!=h) throw new IOException("标签图像与纸张尺寸不符");
        Bitmap bitmap=BitmapFactory.decodeByteArray(data,0,data.length);
        if(bitmap==null) throw new IOException("无法读取标签图像");
        try {
            StringBuilder out=new StringBuilder("SIZE "+width+" mm,"+height+" mm\r\nGAP "+gap+" mm,0 mm\r\nDIRECTION 1\r\nREFERENCE 0,0\r\nCLS\r\n");
            int[] row=new int[w];
            for(int y=0;y<h;y++) {
                bitmap.getPixels(row,0,w,0,y,w,1);
                int start=-1;
                for(int x=0;x<=w;x++) {
                    boolean black=x<w && Color.alpha(row[x])>=128 && (Color.red(row[x])*299+Color.green(row[x])*587+Color.blue(row[x])*114)<128000;
                    if(black && start<0) start=x;
                    if(!black && start>=0) {out.append("BAR ").append(start).append(',').append(y).append(',').append(x-start).append(",1\r\n");start=-1;}
                }
            }
            out.append("PRINT 1,1\r\n");
            return out.toString().getBytes(StandardCharsets.US_ASCII);
        } finally {bitmap.recycle();}
    }
    void close() {closed=true;context.unregisterReceiver(receiver);executor.shutdownNow();}
}
