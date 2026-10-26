package com.meiday.app;

import android.content.ContentResolver;
import android.content.ContentValues;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.MediaStore;
import android.util.Base64;

import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import java.io.File;
import java.io.FileOutputStream;
import java.io.OutputStream;

/**
 * 把前端生成的 Blob（base64）保存到系统「下载」目录，解决 WebView 里 <a download> 不落盘的问题：
 * - Android 10+（API 29+）：MediaStore.Downloads 集合，relative_path = Download/MeiDay/，
 *   无需任何运行时权限，文件可被系统「下载 / 文件」应用看到；
 * - Android 9-（API ≤28）：写入 getExternalStoragePublicDirectory(DOWNLOADS)/MeiDay/，
 *   需要 WRITE_EXTERNAL_STORAGE 运行时权限（manifest 中已限 maxSdkVersion=28）。
 * 同名文件自动去重（追加 " (1)"、" (2)"），避免覆盖或混淆。
 *
 * 入参：{ base64, fileName, mime? }
 * 返回：{ path } —— 展示路径，如 下载/MeiDay/日记导出-2026-10.zip
 */
@CapacitorPlugin(
        name = "SaveToDownloads",
        permissions = {
                @Permission(strings = { android.Manifest.permission.WRITE_EXTERNAL_STORAGE }, alias = "legacyStorage", maxSdkVersion = 28)
        }
)
public class SaveToDownloadsPlugin extends Plugin {

    /** 下载目录下的子文件夹，保持导出文件整洁 */
    private static final String SUB_DIR = "MeiDay";

    @PluginMethod
    public void save(PluginCall call) {
        String base64 = call.getString("base64");
        String fileName = call.getString("fileName");
        String mime = call.getString("mime");

        if (base64 == null || base64.isEmpty()) {
            call.reject("base64 内容为空");
            return;
        }
        if (fileName == null || fileName.isEmpty()) {
            fileName = "meiday-export.bin";
        }

        // Android 9-：写入公共下载目录需要旧版存储权限，先确保已授权
        if (Build.VERSION.SDK_INT <= Build.VERSION_CODES.P) {
            if (getPermissionState("legacyStorage") != PermissionState.GRANTED) {
                requestPermissionForAlias("legacyStorage", call, "legacyPermCallback");
                return;
            }
        }

        try {
            byte[] data = Base64.decode(base64, Base64.DEFAULT);
            String path = writeToDownloads(data, fileName, mime);
            JSObject ret = new JSObject();
            ret.put("path", path);
            call.resolve(ret);
        } catch (Exception e) {
            call.reject("保存到下载目录失败：" + e.getMessage(), e);
        }
    }

    @PermissionCallback
    private void legacyPermCallback(PluginCall call) {
        if (getPermissionState("legacyStorage") != PermissionState.GRANTED) {
            call.reject("需要存储权限才能保存文件到下载目录");
            return;
        }
        save(call);
    }

    private String writeToDownloads(byte[] data, String fileName, String mime) throws Exception {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            return writeViaMediaStore(data, fileName, mime);
        }
        return writeLegacy(data, fileName);
    }

    /** Android 10+：MediaStore Downloads 集合（无权限要求） */
    private String writeViaMediaStore(byte[] data, String fileName, String mime) throws Exception {
        ContentResolver cr = getContext().getContentResolver();
        String displayName = uniqueDisplayName(cr, fileName);

        ContentValues values = new ContentValues();
        values.put(MediaStore.Downloads.DISPLAY_NAME, displayName);
        values.put(MediaStore.Downloads.MIME_TYPE, (mime != null && !mime.isEmpty()) ? mime : "application/octet-stream");
        values.put(MediaStore.Downloads.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS + "/" + SUB_DIR);
        values.put(MediaStore.Downloads.IS_PENDING, 1);

        Uri collection = MediaStore.Downloads.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY);
        Uri item = cr.insert(collection, values);
        if (item == null) throw new IllegalStateException("下载目录不可用（MediaStore 插入失败）");

        try (OutputStream os = cr.openOutputStream(item)) {
            if (os == null) throw new IllegalStateException("无法打开输出流");
            os.write(data);
        }

        values.clear();
        values.put(MediaStore.Downloads.IS_PENDING, 0);
        cr.update(item, values, null, null);

        return "下载/" + SUB_DIR + "/" + displayName;
    }

    /** Android 9-：直接写公共下载目录 */
    private String writeLegacy(byte[] data, String fileName) throws Exception {
        File dir = new File(
                Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS), SUB_DIR);
        if (!dir.exists() && !dir.mkdirs()) {
            throw new IllegalStateException("无法创建下载目录 " + dir.getAbsolutePath());
        }
        File file = new File(dir, uniqueLegacyName(dir, fileName));
        try (FileOutputStream fos = new FileOutputStream(file)) {
            fos.write(data);
        }
        return "下载/" + SUB_DIR + "/" + file.getName();
    }

    /** MediaStore 查询去重；查询失败（无权限/异常）时不去重，直接使用原名 */
    private String uniqueDisplayName(ContentResolver cr, String fileName) {
        String candidate = fileName;
        int i = 1;
        while (existsInMediaStore(cr, candidate)) {
            candidate = bumpName(fileName, i);
            i++;
        }
        return candidate;
    }

    private boolean existsInMediaStore(ContentResolver cr, String displayName) {
        try {
            String relativePath = Environment.DIRECTORY_DOWNLOADS + "/" + SUB_DIR;
            Uri collection = MediaStore.Downloads.getContentUri(MediaStore.VOLUME_EXTERNAL);
            String[] projection = { MediaStore.Downloads._ID };
            String selection = MediaStore.Downloads.DISPLAY_NAME + " = ? AND "
                    + MediaStore.Downloads.RELATIVE_PATH + " = ?";
            String[] args = { displayName, relativePath };
            try (Cursor c = cr.query(collection, projection, selection, args, null)) {
                return c != null && c.getCount() > 0;
            }
        } catch (Exception e) {
            return false;
        }
    }

    private String uniqueLegacyName(File dir, String fileName) {
        String candidate = fileName;
        int i = 1;
        while (new File(dir, candidate).exists()) {
            candidate = bumpName(fileName, i);
            i++;
        }
        return candidate;
    }

    /** "a.zip" + i=1 → "a (1).zip"；无扩展名 → "a (1)" */
    private String bumpName(String fileName, int i) {
        int dot = fileName.lastIndexOf('.');
        if (dot > 0) {
            return fileName.substring(0, dot) + " (" + i + ")" + fileName.substring(dot);
        }
        return fileName + " (" + i + ")";
    }
}
