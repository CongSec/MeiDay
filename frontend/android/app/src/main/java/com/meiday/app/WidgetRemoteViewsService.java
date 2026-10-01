package com.meiday.app;

import android.content.Context;
import android.content.Intent;
import android.widget.RemoteViews;
import android.widget.RemoteViewsService;

/**
 * 小组件 ListView 数据源：读取本地快照，一行一个任务名，支持滚动显示全部。
 */
public class WidgetRemoteViewsService extends RemoteViewsService {

    @Override
    public RemoteViewsFactory onGetViewFactory(Intent intent) {
        return new Factory(getApplicationContext());
    }

    private static class Factory implements RemoteViewsService.RemoteViewsFactory {
        private final Context context;
        private String[] names = new String[0];

        Factory(Context c) {
            context = c;
        }

        @Override
        public void onCreate() {
        }

        @Override
        public void onDestroy() {
        }

        @Override
        public int getCount() {
            return names.length;
        }

        @Override
        public RemoteViews getViewAt(int position) {
            RemoteViews v = new RemoteViews(context.getPackageName(), R.layout.widget_item);
            String name = (position >= 0 && position < names.length) ? names[position] : "";
            v.setTextViewText(R.id.widget_item_text, name);
            return v;
        }

        @Override
        public RemoteViews getLoadingView() {
            return null;
        }

        @Override
        public int getViewTypeCount() {
            return 1;
        }

        @Override
        public long getItemId(int position) {
            return position;
        }

        @Override
        public boolean hasStableIds() {
            return true;
        }

        @Override
        public void onDataSetChanged() {
            names = TaskSnapshotStore.getNames(context);
        }
    }
}
