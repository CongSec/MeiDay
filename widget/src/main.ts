import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'
import { useAuthStore } from '@/stores/auth'
import { useTasksStore } from '@/stores/tasks'
import { useProjectsStore } from '@/stores/projects'
import { useStatsStore } from '@/stores/stats'
import { idbClearUserCache } from '@/utils/idb'
import { startSyncPoll, stopSyncPoll } from '@/composables/useSyncPoll'

const app = createApp(App)
app.use(createPinia())
app.mount('#app')

const auth = useAuthStore()

async function boot() {
  // 恢复记住的用户名 + 注册 401 自动恢复钩子
  auth.restoreUser()
  auth.registerRestoreHook()
  if (!auth.isLoggedIn) return
  // 有登录态：用浏览器保存的密码（7 天内）静默重新解锁 OSS 凭证，成功后启动同步
  const unlocked = await auth.tryAutoUnlock()
  if (unlocked && auth.isLoggedIn) startSyncPoll()
}

// 会话失效（401 / token 过期）：停止轮询、清空内存与本地缓存，回到登录界面
window.addEventListener('st:unauthorized', async () => {
  const username = auth.username
  stopSyncPoll()
  auth.reset()
  useTasksStore().resetAll()
  useProjectsStore().resetAll()
  useStatsStore().resetAll()
  if (username) await idbClearUserCache(username)
})

void boot()
