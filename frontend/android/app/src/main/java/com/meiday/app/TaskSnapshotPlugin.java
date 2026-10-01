package com.meiday.app;

import android.Manifest;
import android.content.Context;
import android.content.pm.PackageManager;
import android.os.Build;

import androidx.core.content.ContextCompat;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.PermissionState;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import org.json.JSONArray;

/**
 * 今日任务快照插件：
 *  - updateSnapshot(names)：前端计算好今日未完成任务名称后写入本地快照，并刷新小组件 + 常驻通知；
 *  - requestNotificationPermission()：Android 13+ 请求通知权限；
 *  - getLaunchToday()：消费「从小组件/通知点进来」标记，前端据此跳转今日任务页。
 */
@CapacitorPlugin(
        name = "TaskSnapshot",
        permissions = {
                @Permission(strings = { Manifest.permission.POST_NOTIFICATIONS }, alias = "notifications")
        }
)
public class TaskSnapshotPlugin extends Plugin {

    @PluginMethod
    public void updateSnapshot(PluginCall call) {
        JSArray names = call.getArray("names");
        JSONArray arr = (names == null) ? new JSONArray() : names;
        Context ctx = getContext();
        TaskSnapshotStore.set(ctx, arr);
        MeiDayWidgetProvider.updateWidget(ctx);
        NotificationHelper.update(ctx, TaskSnapshotStore.getNames(ctx));
        call.resolve();
    }

    @PluginMethod
    public void requestNotificationPermission(PluginCall call) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            if (getPermissionState("notifications") != PermissionState.GRANTED) {
                requestPermissionForAlias("notifications", call, "notifPermCallback");
                return;
            }
        }
        JSObject ret = new JSObject();
        ret.put("granted", true);
        call.resolve(ret);
    }

    @PermissionCallback
    private void notifPermCallback(PluginCall call) {
        JSObject ret = new JSObject();
        boolean granted = Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU
                || ContextCompat.checkSelfPermission(getContext(),
                        Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED;
        ret.put("granted", granted);
        call.resolve(ret);
    }

    @PluginMethod
    public void getLaunchToday(PluginCall call) {
        boolean open = LaunchIntentHelper.consumeOpenToday();
        if (open) {
            notifyListeners("openToday", new JSObject());
        }
        JSObject ret = new JSObject();
        ret.put("open", open);
        call.resolve(ret);
    }
}
