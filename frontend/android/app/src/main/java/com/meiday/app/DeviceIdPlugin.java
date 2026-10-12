package com.meiday.app;

import android.provider.Settings;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "DeviceId")
public class DeviceIdPlugin extends Plugin {

    @PluginMethod
    public void getAndroidId(PluginCall call) {
        try {
            String androidId = Settings.Secure.getString(
                    getContext().getContentResolver(),
                    Settings.Secure.ANDROID_ID);
            JSObject ret = new JSObject();
            ret.put("androidId", androidId != null ? androidId : "");
            call.resolve(ret);
        } catch (Exception e) {
            call.reject("read android id failed", e);
        }
    }
}
