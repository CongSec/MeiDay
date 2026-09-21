package com.meiday.app;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // 注册本地原生插件：读取相册最近新增图片（截图/照片，新建/编辑任务时提示是否作为附件上传）
        registerPlugin(RecentImagesPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
