import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'
import { useAuthStore } from '@/stores/auth'
import { useTasksStore } from '@/stores/tasks'
import { useProjectsStore } from '@/stores/projects'
import { useStatsStore } from '@/stores/stats'
import { useWidgetStore } from '@/stores/widget'
import { idbClearUserCache } from '@/utils/idb'
import { startSyncPoll, stopSyncPoll } from '@/composables/useSyncPoll'
import { clearSessionInConfig, seedSessionFromConfig } from '@/utils/config'

/**
 * 401 恢复钩子：必须在 Pinia 创建之后注册（useXxxStore 依赖激活的 Pinia 实例）。
 * 会话失效时停止轮询、清空内存与本地缓存、清空 config.json 会话，回到设置面板。
 */
function registerUnauthorizedHandler() {
  window.addEventListener('st:unauthorized', async () => {
    const auth = useAuthStore()
    const username = auth.username
    stopSyncPoll()
    auth.reset()
    useTasksStore().resetAll()
    useProjectsStore().resetAll()
    useStatsStore().resetAll()
    await clearSessionInConfig()
    useWidgetStore().setMode('settings')
    if (username) await idbClearUserCache(username)
  })
}

async function bootstrap() {
  // 先把 config.json 里的登录态灌回 localStorage（auth store 创建时同步读取），
  // 否则“记住登录”在重启后失效。
  await seedSessionFromConfig()

  const app = createApp(App)
  app.use(createPinia())
  app.mount('#app')

  // 401 监听器注册放在 Pinia 就绪之后，避免早触发时 useStore() 报错。
  registerUnauthorizedHandler()

  const auth = useAuthStore()
  // 恢复记住的用户名 + 注册 401 自动恢复钩子
  auth.restoreUser()
  auth.registerRestoreHook()
  if (!auth.isLoggedIn) return
  // 有登录态：用保存的密码（7 天内）静默重新解锁 OSS 凭证，成功后启动同步
  const unlocked = await auth.tryAutoUnlock()
  if (unlocked && auth.isLoggedIn) {
    startSyncPoll()
  } else {
    // 自动解锁失败（密码过期 / 未记住密码）：打开设置让用户重新登录
    useWidgetStore().setMode('settings')
  }
}

void bootstrap()
