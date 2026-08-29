import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'
import router from './router'
import './style.css'
import { seedFromParentRestore } from '@/api/client'
import { useAuthStore } from '@/stores/auth'

// 思源插件 srcdoc 双保险：把插件保存在 plugin.storage 的登录态灌回 localStorage
// （思源端口变化 / localStorage 被清时仍保持登录）。Web / APK 下无该全局，自动跳过。
// 必须在 pinia store 首次创建之前执行，否则 auth 初始 token 读不到。
seedFromParentRestore()

const pinia = createPinia()
const app = createApp(App)
app.use(pinia)
app.use(router)

// 持久化用户名恢复内存态：刷新/重启后自动解锁、401 自动恢复都依赖 username
useAuthStore(pinia).restoreUser()
// 注册 401 自动恢复：记住密码的 7 天窗口内，会话过期/被挤下线时静默恢复而不是强制重新登录
useAuthStore(pinia).registerRestoreHook()

app.mount('#app')
