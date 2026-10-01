package com.meiday.app;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/**
 * 开机 / APP 更新后恢复常驻通知（读取本地快照重新 post）。
 * 注：Android 3.1+ 安装后未首次启动的 APP 收不到开机广播，首次打开过即可正常收到。
 */
public class BootReceiver extends BroadcastReceiver {

    @Override
    public void onReceive(Context context, Intent intent) {
        String action = intent == null ? "" : intent.getAction();
        if (Intent.ACTION_BOOT_COMPLETED.equals(action)
                || Intent.ACTION_MY_PACKAGE_REPLACED.equals(action)) {
            NotificationHelper.update(context, TaskSnapshotStore.getNames(context));
        }
    }
}
