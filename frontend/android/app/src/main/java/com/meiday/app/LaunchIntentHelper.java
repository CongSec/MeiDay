package com.meiday.app;

import android.content.Intent;

/**
 * 「打开今日任务页」启动标记：
 * 桌面小组件/通知栏点击时在 Intent 里带上 EXTRA_OPEN_TODAY；
 * MainActivity 收到后记录，前端通过 TaskSnapshotPlugin.getLaunchToday() 消费并跳转。
 */
public final class LaunchIntentHelper {
    private static final String EXTRA_OPEN_TODAY = "meiday_open_today";
    private static volatile boolean pendingOpenToday = false;

    private LaunchIntentHelper() {
    }

    public static Intent withOpenToday(Intent intent) {
        intent.putExtra(EXTRA_OPEN_TODAY, true);
        return intent;
    }

    public static void handleIntent(Intent intent) {
        if (intent != null && intent.getBooleanExtra(EXTRA_OPEN_TODAY, false)) {
            pendingOpenToday = true;
        }
    }

    public static boolean consumeOpenToday() {
        boolean v = pendingOpenToday;
        pendingOpenToday = false;
        return v;
    }
}
