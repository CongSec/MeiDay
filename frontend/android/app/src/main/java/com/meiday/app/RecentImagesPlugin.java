package com.meiday.app;

import android.content.ContentResolver;
import android.content.ContentUris;

import android.database.Cursor;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.net.Uri;
import android.os.Build;
import android.provider.MediaStore;
import android.util.Base64;

import androidx.annotation.NonNull;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;


import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.util.ArrayList;
import java.util.List;

/**
 * 读取相册里「最近新增的图片」（截图 + 相机照片 + 其它），用于新建/编辑任务时提示是否作为附件上传。
 *
 * 查询 MediaStore 中所有新增时间在 maxAgeSeconds 之内的图片（不限定目录/命名），按新增时间倒序，
 * 最多返回 limit 张，每张以 base64 返回给前端。
 *
 * 权限：
 *  - Android 13+（API 33+）：READ_MEDIA_IMAGES
 *  - Android 12 及以下：READ_EXTERNAL_STORAGE（manifest 中已限 maxSdkVersion=32）
 *
 * 返回（JSObject）：
 *  - permissionDenied:  true 时表示权限被拒绝（前端据此不再反复申请并提示一次）
 *  - items: [{ mime, size, base64, name, dateAdded }]（dateAdded 为 epoch 秒，供前端去重）
 *  - 超过 3MB 的大图会先降采样重编码，避免超大 base64 在 WebView 桥接时卡顿
 */
@CapacitorPlugin(
        name = "RecentImages",
        permissions = {
                @Permission(strings = { android.Manifest.permission.READ_MEDIA_IMAGES }, alias = "mediaImages"),
                @Permission(strings = { android.Manifest.permission.READ_EXTERNAL_STORAGE }, alias = "storage")
        }
)
public class RecentImagesPlugin extends Plugin {

    /** 超过该字节数即降采样重编码（手机相机原图通常较大，重编码后更小） */
    private static final long MAX_RAW_BYTES = 3L * 1024 * 1024;
    /** 降采样后图片最长边 */
    private static final int MAX_EDGE = 2048;
    private static final int JPEG_QUALITY = 88;
    private static final int DEFAULT_MAX_AGE_SECONDS = 180;
    /** 单次最多返回张数（前端还会进一步过滤已作为附件/只展示前几张） */
    private static final int DEFAULT_LIMIT = 12;

    @PluginMethod
    public void listRecentImages(PluginCall call) {
        int maxAge = call.getInt("maxAgeSeconds", DEFAULT_MAX_AGE_SECONDS);
        int limit = call.getInt("limit", DEFAULT_LIMIT);
        if (getPermissionState(permissionAlias()) != PermissionState.GRANTED) {
            requestPermissionForAlias(permissionAlias(), call, "permCallback");
            return;
        }
        doList(call, maxAge, limit);
    }

    @PermissionCallback
    private void permCallback(PluginCall call) {
        if (getPermissionState(permissionAlias()) != PermissionState.GRANTED) {
            JSObject denied = new JSObject();
            denied.put("permissionDenied", true);
            call.resolve(denied);
            return;
        }
        doList(call, call.getInt("maxAgeSeconds", DEFAULT_MAX_AGE_SECONDS), call.getInt("limit", DEFAULT_LIMIT));
    }

    /** 按系统版本选择读取媒体所需的权限别名 */
    private String permissionAlias() {
        return Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU ? "mediaImages" : "storage";
    }

    private void doList(PluginCall call, int maxAgeSeconds, int limit) {
        try {
            JSObject result = findRecentImages(maxAgeSeconds, limit);
            call.resolve(result);
        } catch (Exception e) {
            // 读不到就当没有新图片，不打扰用户
            call.resolve(new JSObject());
        }
    }

    private JSObject findRecentImages(int maxAgeSeconds, int limit) throws Exception {
        ContentResolver cr = getContext().getContentResolver();

        Uri collection;
        String selection;
        String[] selectionArgs;
        long nowSec = System.currentTimeMillis() / 1000;
        long minDate = nowSec - maxAgeSeconds;

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            collection = MediaStore.Images.Media.getContentUri(MediaStore.VOLUME_EXTERNAL);
            selection = MediaStore.Images.Media.DATE_ADDED + " > ? AND "
                    + MediaStore.Images.Media.IS_PENDING + " = 0";
            selectionArgs = new String[]{String.valueOf(minDate)};
        } else {
            collection = MediaStore.Images.Media.EXTERNAL_CONTENT_URI;
            selection = MediaStore.Images.Media.DATE_ADDED + " > ?";
            selectionArgs = new String[]{String.valueOf(minDate)};
        }

        String[] projection = {
                MediaStore.Images.Media._ID,
                MediaStore.Images.Media.DISPLAY_NAME,
                MediaStore.Images.Media.DATE_ADDED,
                MediaStore.Images.Media.MIME_TYPE,
                MediaStore.Images.Media.SIZE
        };
        String sortOrder = MediaStore.Images.Media.DATE_ADDED + " DESC";

        List<JSObject> items = new ArrayList<>();
        try (Cursor cursor = cr.query(collection, projection, selection, selectionArgs, sortOrder)) {
            if (cursor == null) return emptyResult();

            int idIdx = cursor.getColumnIndexOrThrow(MediaStore.Images.Media._ID);
            int nameIdx = cursor.getColumnIndexOrThrow(MediaStore.Images.Media.DISPLAY_NAME);
            int dateIdx = cursor.getColumnIndexOrThrow(MediaStore.Images.Media.DATE_ADDED);
            int mimeIdx = cursor.getColumnIndexOrThrow(MediaStore.Images.Media.MIME_TYPE);
            int sizeIdx = cursor.getColumnIndexOrThrow(MediaStore.Images.Media.SIZE);

            while (cursor.moveToNext() && items.size() < limit) {
                String name = cursor.getString(nameIdx);
                String mime = cursor.getString(mimeIdx);
                if (mime == null || !mime.startsWith("image/")) continue;
                long dateAdded = cursor.getLong(dateIdx);
                long size = cursor.getLong(sizeIdx);

                long id = cursor.getLong(idIdx);
                Uri contentUri = ContentUris.withAppendedId(collection, id);
                byte[] data = readUriBytes(cr, contentUri);
                if (data == null || data.length == 0) continue;

                String outMime = mime;
                if (data.length > MAX_RAW_BYTES) {
                    byte[] reencoded = downscaleReencode(data);
                    if (reencoded != null && reencoded.length < data.length) {
                        data = reencoded;
                        outMime = "image/jpeg";
                    }
                }

                JSObject item = new JSObject();
                item.put("mime", outMime);
                item.put("size", data.length);
                item.put("base64", Base64.encodeToString(data, Base64.NO_WRAP));
                item.put("name", name);
                item.put("dateAdded", dateAdded);
                items.add(item);
            }
        }

        if (items.isEmpty()) return emptyResult();

        JSObject ret = new JSObject();
        ret.put("items", new JSArray(items));
        return ret;
    }

    private JSObject emptyResult() {
        return new JSObject();
    }

    private byte[] readUriBytes(ContentResolver cr, @NonNull Uri uri) throws Exception {
        try (InputStream in = cr.openInputStream(uri);
             ByteArrayOutputStream out = new ByteArrayOutputStream()) {
            if (in == null) return null;
            byte[] buf = new byte[8192];
            int n;
            while ((n = in.read(buf)) != -1) out.write(buf, 0, n);
            return out.toByteArray();
        }
    }

    /** 把大图解码后缩到 MAX_EDGE 内并重编码为 JPEG */
    private byte[] downscaleReencode(byte[] data) {
        BitmapFactory.Options bounds = new BitmapFactory.Options();
        bounds.inJustDecodeBounds = true;
        BitmapFactory.decodeByteArray(data, 0, data.length, bounds);
        if (bounds.outWidth <= 0 || bounds.outHeight <= 0) return null;

        int sample = 1;
        int longEdge = Math.max(bounds.outWidth, bounds.outHeight);
        while (longEdge / (sample * 2) >= MAX_EDGE) sample *= 2;

        BitmapFactory.Options decodeOpts = new BitmapFactory.Options();
        decodeOpts.inSampleSize = sample;
        Bitmap bmp = BitmapFactory.decodeByteArray(data, 0, data.length, decodeOpts);
        if (bmp == null) return null;

        Bitmap scaled = bmp;
        if (Math.max(bmp.getWidth(), bmp.getHeight()) > MAX_EDGE) {
            float ratio = (float) MAX_EDGE / Math.max(bmp.getWidth(), bmp.getHeight());
            scaled = Bitmap.createScaledBitmap(
                    bmp,
                    Math.max(1, Math.round(bmp.getWidth() * ratio)),
                    Math.max(1, Math.round(bmp.getHeight() * ratio)),
                    true);
            if (scaled != bmp) bmp.recycle();
        }

        ByteArrayOutputStream out = new ByteArrayOutputStream();
        scaled.compress(Bitmap.CompressFormat.JPEG, JPEG_QUALITY, out);
        byte[] result = out.toByteArray();
        scaled.recycle();
        return result;
    }
}
