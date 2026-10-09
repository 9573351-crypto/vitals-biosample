package android.content;
import java.io.File;
public class Context {
    public File getFilesDir(){ return new File(System.getProperty("java.io.tmpdir")); }
    public String getPackageName(){ return "com.vitals.android"; }
    public android.content.pm.PackageManager getPackageManager(){ return new android.content.pm.PackageManager(); }
}
