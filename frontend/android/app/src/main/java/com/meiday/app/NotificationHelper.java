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
 * 折叠态用自定义内容视图（RemoteViews）紧凑展示今日未完成任务名
 * （全角分号「；」连续拼接、自然换行填满，行数上限与现有卡片高度一致），
 * 解决部分国产 ROM（如 iQOO OriginOS）折叠态只显示一行 contentText 的问题；
 * 总任务数在通知标题行「今日任务（共 N 项）」展示；
 * 展开态用 BigTextStyle 完整展示全部任务（一行一个）。
 * 不依赖前台服务——通知由系统托管，进程被杀后仍保留；重启后由 BootReceiver 恢复。
 */
public final class NotificationHelper {

    public static final String CHANNEL_ID = "meiday_today_tasks";
    public static final int NOTIF_ID = 1001;

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

        // 折叠态：自定义内容视图，直接紧凑展示任务名（系统仍会自动在卡片底部显示应用名）
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
        String contentText = collapsedText(names);
        Notification notification = b
                .setSmallIcon(R.drawable.ic_notification)
                .setContentTitle(names.length == 0 ? "今日任务" : "今日任务（共 " + names.length + " 项）")
                .setContentText(contentText)
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

    /** 折叠态任务文本：任务名用全角分号「；」连续拼接（不换行），由 TextView 自然换行
     *  填满每一行；行数上限由布局 maxLines 约束，溢出部分以省略号截断；
     *  总任务数在标题行「今日任务（共 N 项）」展示。 */
    private static String collapsedText(String[] names) {
        if (names.length == 0) return "今日无任务";
        StringBuilder sb = new StringBuilder();
        for (String n : names) {
            if (n == null) continue;
            if (sb.length() > 0) sb.append('；');
            sb.append(n);
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