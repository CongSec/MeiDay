package com.meiday.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.os.Build;
import android.widget.RemoteViews;

/**
 * 常驻通知：不可滑动清除（ongoing）。
 * 折叠态用自定义内容视图（RemoteViews）直接多行展示今日未完成任务名（一行一个），
 * 解决部分国产 ROM（如 iQOO OriginOS）折叠态只显示一行 contentText 的问题；
 * 展开态用 BigTextStyle 完整展示全部任务。
 * 不依赖前台服务——通知由系统托管，进程被杀后仍保留；重启后由 BootReceiver 恢复。
 */
public final class NotificationHelper {

    public static final String CHANNEL_ID = "meiday_today_tasks";
    public static final int NOTIF_ID = 1001;

    /** 折叠态最多直接展示的任务行数（通知栏单卡高度有限，超出进展开态完整查看） */
    private static final int COLLAPSED_MAX_LINES = 5;

    private NotificationHelper() {
    }

    public static void update(Context ctx, String[] names) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            if (ctx.checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS)
                    != PackageManager.PERMISSION_GRANTED) {
                return;
            }
        }
        ensureChannel(ctx);
        NotificationManager nm = ctx.getSystemService(NotificationManager.class);

        Intent open = new Intent(ctx, MainActivity.class);
        open.setAction(Intent.ACTION_MAIN);
        open.addCategory(Intent.CATEGORY_LAUNCHER);
        LaunchIntentHelper.withOpenToday(open);
        open.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK
                | Intent.FLAG_ACTIVITY_CLEAR_TOP
                | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent pi = PendingIntent.getActivity(ctx, 2, open,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);

        // 折叠态：自定义内容视图，直接多行展示任务名（系统仍会自动在卡片底部显示应用名）
        RemoteViews collapsed = new RemoteViews(ctx.getPackageName(), R.layout.notification_content);
        collapsed.setTextViewText(R.id.notif_tasks, collapsedText(names));

        // 展开态：BigText 完整展示全部任务（一行一个）
        StringBuilder big = new StringBuilder();
        if (names.length == 0) {
            big.append("今日无任务");
        } else {
            for (String n : names) {
                if (n == null) continue;
                big.append(n).append('\n');
            }
            // 去掉末尾换行
            if (big.length() > 0) big.setLength(big.length() - 1);
        }

        Notification.Builder b;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            b = new Notification.Builder(ctx, CHANNEL_ID);
        } else {
            b = new Notification.Builder(ctx);
        }
        Notification notification = b
                .setSmallIcon(R.drawable.ic_notification)
                .setContentTitle("今日任务")
                .setContentText(names.length == 0 ? "今日无任务" : names[0])
                .setCustomContentView(collapsed)
                .setContentIntent(pi)
                .setOngoing(true)
                .setOnlyAlertOnce(true)
                .setShowWhen(false)
                .setAutoCancel(false)
                .setStyle(new Notification.BigTextStyle().bigText(big.toString()))
                .build();

        nm.notify(NOTIF_ID, notification);
    }

    /** 折叠态任务文本：一行一个；不超过 COLLAPSED_MAX_LINES 行直接全列，
     *  超出则展示前 COLLAPSED_MAX_LINES-1 条并在末行附「… 等 N 项」提示。 */
    private static String collapsedText(String[] names) {
        if (names.length == 0) return "今日无任务";
        StringBuilder sb = new StringBuilder();
        int shown = names.length <= COLLAPSED_MAX_LINES ? names.length : COLLAPSED_MAX_LINES - 1;
        for (int i = 0; i < shown; i++) {
            if (names[i] == null) continue;
            if (sb.length() > 0) sb.append('\n');
            sb.append(names[i]);
        }
        if (names.length > COLLAPSED_MAX_LINES) {
            sb.append('\n').append("… 等 ").append(names.length - shown).append(" 项");
        }
        return sb.toString();
    }

    private static void ensureChannel(Context ctx) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager nm = ctx.getSystemService(NotificationManager.class);
        NotificationChannel ch = new NotificationChannel(
                CHANNEL_ID, "今日任务", NotificationManager.IMPORTANCE_DEFAULT);
        ch.setShowBadge(false);
        ch.setDescription("常驻显示今日未完成任务");
        nm.createNotificationChannel(ch);
    }
}