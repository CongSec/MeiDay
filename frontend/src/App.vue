<script setup lang="ts">
import { onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import { useUiStore } from '@/stores/ui'
import IdleLockBanner from '@/components/diary/IdleLockBanner.vue'
import { idbClearUserCache } from '@/utils/idb'
import { stopSyncPoll } from '@/composables/useSyncPoll'

const auth = useAuthStore()
const ui = useUiStore()
const router = useRouter()

onMounted(() => {
  window.addEventListener('st:unauthorized', async () => {
    const username = auth.username
    stopSyncPoll()
    auth.reset()
    // 401 时同样清理项目/任务内存，避免残留其它账号数据
    const { useTasksStore } = await import('@/stores/tasks')
    const { useProjectsStore } = await import('@/stores/projects')
    const { useStatsStore } = await import('@/stores/stats')
    useTasksStore().resetAll()
    useProjectsStore().resetAll()
    useStatsStore().resetAll()
    // 会话失效同样销毁隐私日记内存密钥与空闲锁
    const { useDiaryStore } = await import('@/stores/diary')
    useDiaryStore().lock()
    // 会话失效后清除该用户的本地缓存，避免旧数据残留导致下次登录展示过期数据或同步冲突
    if (username) await idbClearUserCache(username)
    if (router.currentRoute.value.path !== '/login') router.push('/login')
  })
})
</script>

<template>
  <router-view />
  <!-- 隐私日记空闲锁定预警（全局：任务系统普通页也提示） -->
  <IdleLockBanner />
  <!-- 全局 Toast（隐私日记为独立全屏路由，须在 App 层渲染才可见） -->
  <div class="fixed top-4 right-4 z-[70] space-y-2">
    <div
      v-for="t in ui.toasts"
      :key="t.id"
      class="px-4 py-2 rounded-lg shadow-lg text-sm text-white cursor-pointer"
      :class="t.type === 'ok' ? 'bg-slate-800' : 'bg-red-500'"
      title="点击关闭"
      @click="ui.dismiss(t.id)"
    >
      {{ t.text }}
    </div>
  </div>
</template>
