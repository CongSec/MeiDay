package com.meiday.app;

import android.app.PendingIntent;
import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.widget.RemoteViews;

/**
 * 桌面小组件：仅显示今日未完成任务名称（可滚动），固定白色背景、无标题。
 * 点击整卡 → 打开 APP 的「今日任务」页。数据源为本地快照（TaskSnapshotStore）。
 */
public class MeiDayWidgetProvider extends AppWidgetProvider {

    public static final String ACTION_UPDATE = "com.meiday.app.action.WIDGET_UPDATE";

    @Override
    public void onUpdate(Context context, AppWidgetManager appWidgetManager, int[] appWidgetIds) {
        for (int id : appWidgetIds) {
            appWidgetManager.updateAppWidget(id, buildViews(context, id));
        }
    }

    @Override
    public void onReceive(Context context, Intent intent) {
        super.onReceive(context, intent);
        if (ACTION_UPDATE.equals(intent != null ? intent.getAction() : null)) {
            AppWidgetManager mgr = AppWidgetManager.getInstance(context);
            int[] ids = mgr.getAppWidgetIds(new ComponentName(context, MeiDayWidgetProvider.class));
            onUpdate(context, mgr, ids);
        }
    }

    private static RemoteViews buildViews(Context context, int appWidgetId) {
        RemoteViews views = new RemoteViews(context.getPackageName(), R.layout.widget_meiday);

        Intent open = new Intent(context, MainActivity.class);
        open.setAction(Intent.ACTION_MAIN);
        open.addCategory(Intent.CATEGORY_LAUNCHER);
        LaunchIntentHelper.withOpenToday(open);
        open.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK
                | Intent.FLAG_ACTIVITY_CLEAR_TOP
                | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent pi = PendingIntent.getActivity(context, 0, open,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        views.setOnClickPendingIntent(R.id.widget_root, pi);

        Intent svc = new Intent(context, WidgetRemoteViewsService.class);
        svc.putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, appWidgetId);
        svc.setData(Uri.parse(svc.toUri(Intent.URI_INTENT_SCHEME)));
        views.setRemoteAdapter(R.id.widget_list, svc);
        views.setEmptyView(R.id.widget_list, R.id.widget_empty);
        views.setTextViewText(R.id.widget_empty, "今日无任务");

        return views;
    }

    /** 由 TaskSnapshotPlugin 在快照更新后调用：刷新所有小组件实例的布局与列表数据。
     *  仅重新 updateAppWidget 不保证集合数据刷新（系统对相同适配器 Intent 有缓存），
     *  必须再调 notifyAppWidgetViewDataChanged 触发 RemoteViewsService.onDataSetChanged()。 */
    public static void updateWidget(Context context) {
        AppWidgetManager mgr = AppWidgetManager.getInstance(context);
        int[] ids = mgr.getAppWidgetIds(new ComponentName(context, MeiDayWidgetProvider.class));
        for (int id : ids) {
            mgr.updateAppWidget(id, buildViews(context, id));
        }
        if (ids.length > 0) {
            mgr.notifyAppWidgetViewDataChanged(ids, R.id.widget_list);
        }
    }
}
