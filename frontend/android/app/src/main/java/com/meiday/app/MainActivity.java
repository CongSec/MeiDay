package com.meiday.app;

import android.content.Intent;
import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // 注册本地原生插件：读取相册最近新增图片（截图/照片，新建/编辑任务时提示是否作为附件上传）
        registerPlugin(RecentImagesPlugin.class);
        // 今日任务快照：桌面小组件 + 常驻通知（写入快照 / 通知权限 / 启动跳转标记）
        registerPlugin(TaskSnapshotPlugin.class);
        // 从小组件/通知点进来时记录「打开今日任务页」标记
        LaunchIntentHelper.handleIntent(getIntent());
        super.onCreate(savedInstanceState);
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        // APP 已在运行（后台）时点小组件/通知，同样记录跳转标记，由前端在回到前台时消费
        LaunchIntentHelper.handleIntent(intent);
    }
}
