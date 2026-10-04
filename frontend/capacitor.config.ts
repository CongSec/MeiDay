import type { CapacitorConfig } from '@capacitor/cli'

const config: CapacitorConfig = {
  appId: 'com.meiday.app',
  appName: 'MeiDay',
  webDir: 'dist',
  server: {
    androidScheme: 'https',
  },
  plugins: {
    // 原生 HTTP：让 APP 的 fetch/XHR 走系统网络栈，绕过 WebView 的 CORS 与「混合内容」限制，
    // 从而支持用户自定义的 http:// 局域网服务器（如 http://172.18.40.184:8000）
    CapacitorHttp: {
      enabled: true,
    },
  },
  android: {
    // 兜底：允许 WebView 内嵌资源访问 http://（混合内容），与上方原生 HTTP 双保险
    allowMixedContent: true,
  },
}

export default config
