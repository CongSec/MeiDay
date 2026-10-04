import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'
import { useAuthStore } from '@/stores/auth'
import { useTasksStore } from '@/stores/tasks'
import { useProjectsStore } from '@/stores/projects'
import { useStatsStore } from '@/stores/stats'
import { useWidgetStore } from '@/stores/widget'
import { idbClearUserCache } from '@/utils/idb'
import { getSavedPassword } from '@/api/client'
import { bootstrapLoad, startSyncPoll, stopSyncPoll, armRecoveryLoop, disarmRecovery } from '@/composables/useSyncPoll'
import { seedSessionFromConfig } from '@/utils/config'

/**
 * 401 恢复钩子：必须在 Pinia 创建之后注册（useXxxStore 依赖激活的 Pinia 实例）。
 * 会话失效时停止轮询、清空内存与本地缓存（config.json 里的登录态保留，供下次启动自动登录重试），回到设置面板。
 */
function registerUnauthorizedHandler() {
  window.addEventListener('st:unauthorized', async () => {
    const auth = useAuthStore()
    const username = auth.username
    stopSyncPoll()
    disarmRecovery() // 会话失效登出，同时解除“待网络恢复”重试
    auth.reset()
    useTasksStore().resetAll()
    useProjectsStore().resetAll()
    useStatsStore().resetAll()
    useWidgetStore().setMode('settings')
    if (username) await idbClearUserCache(username)
  })
}

/** 等待 pywebview JS 桥就绪：桥注入晚于页面脚本，直接读 config.json 会拿到空会话。 */
function whenBridgeReady(timeoutMs = 5000): Promise<boolean> {
  return new Promise((resolve) => {
    const t0 = Date.now()
    const check = () => {
      if ((window as any).pywebview?.api?.read_config) return resolve(true)
      if (Date.now() - t0 > timeoutMs) return resolve(false)
      setTimeout(check, 50)
    }
    check()
  })
}

async function bootstrap() {
  // 先等 pywebview 桥就绪，再读 config.json 并把登录态灌回 localStorage
  // （auth store 创建时同步读取），否则桥未注入时读到空会话，每次启动都要重新登录。
  await whenBridgeReady()
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
    // 与手动登录 bootAfterLogin() 一致：先引导加载今日任务再进入轮询，
    // 否则冷启动时 tasks 为空，今日视图永远空白（自动登录路径之前漏了这步）。
    await bootstrapLoad().catch(() => {})
    startSyncPoll()
  } else {
    // 自动解锁失败：打开设置让用户重新登录。若仍持有本地凭据（保存的密码未过期），
    // 则进入“待网络恢复”自动重试（如开机时还没网）——监听 online + 指数退避，
    // 网络恢复后自动重新解锁并回到今日视图，无需手动重启。
    useWidgetStore().setMode('settings')
    if (getSavedPassword()) armRecoveryLoop()
  }
}

void bootstrap()
