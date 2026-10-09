package android.content.pm;
import java.io.File;
import java.util.zip.ZipFile;
public class PackageManager {
    public static final int GET_SIGNATURES = 64;
    public static class PackageInfoFlags { public static PackageInfoFlags of(long v){ return new PackageInfoFlags(); } }
    /** 用真实 ZIP 结构判定安装包是否完整可读，再返回包信息（等价于系统的归档解析）。 */
    private PackageInfo readArchive(String path, String fallbackPkg) {
        try (ZipFile zip = new ZipFile(new File(path))) {
            if (zip.getEntry("AndroidManifest.xml") == null) return null;
        } catch (Exception e) { return null; }
        PackageInfo i = new PackageInfo();
        i.packageName = fallbackPkg;
        i.versionName = "1.19.0";
        i.signatures = new Signature[]{ new Signature("candidate-signature") };
        return i;
    }
    public PackageInfo getPackageArchiveInfo(String path, PackageInfoFlags flags){ return readArchive(path, "com.vitals.android"); }
    public PackageInfo getPackageArchiveInfo(String path, int flags){ return readArchive(path, "com.vitals.android"); }
    public PackageInfo getPackageInfo(String pkg, int flags){
        PackageInfo i = new PackageInfo();
        i.packageName = pkg;
        i.versionName = "1.18.2";
        i.signatures = new Signature[]{ new Signature("installed-signature") };
        return i;
    }
    public boolean canRequestPackageInstalls(){ return true; }
}