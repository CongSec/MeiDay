package com.meiday.app;

import android.content.Context;
import android.content.SharedPreferences;

import org.json.JSONArray;

/**
 * 今日任务快照（本地持久化）：仅存「今日未完成任务名称」列表。
 * 前端(WebView)在打开/同步/完成状态变化时计算好名称，通过 TaskSnapshotPlugin 写入；
 * 桌面小组件与通知栏只读这份快照，无网络、无 OSS 凭据。
 */
public final class TaskSnapshotStore {
    private static final String PREFS = "meiday_task_snapshot";
    private static final String KEY_NAMES = "today_names";

    private TaskSnapshotStore() {
    }

    public static void set(Context ctx, JSONArray names) {
        String raw = (names == null) ? "[]" : names.toString();
        ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                .edit()
                .putString(KEY_NAMES, raw)
                .apply();
    }

    public static String[] getNames(Context ctx) {
        SharedPreferences sp = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        String raw = sp.getString(KEY_NAMES, null);
        if (raw == null || raw.isEmpty()) return new String[0];
        try {
            JSONArray arr = new JSONArray(raw);
            String[] out = new String[arr.length()];
            for (int i = 0; i < arr.length(); i++) out[i] = arr.getString(i);
            return out;
        } catch (Exception e) {
            return new String[0];
        }
    }

    public static void clear(Context ctx) {
        ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().clear().apply();
    }
}
