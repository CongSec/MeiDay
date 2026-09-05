<script setup lang="ts">
import { onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import { useUiStore } from '@/stores/ui'
import IdleLockBanner from '@/components/diary/IdleLockBanner.vue'
import AppIcon from '@/components/AppIcon.vue'
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
  <div class="fixed top-4 inset-x-0 z-[70] flex flex-col items-center gap-2 pointer-events-none">
    <div
      v-for="t in ui.toasts"
      :key="t.id"
      class="pointer-events-auto flex items-center gap-2.5 rounded-full pl-3 pr-4 py-2.5 text-sm text-white shadow-lg cursor-pointer animate-toast-in"
      :class="t.type === 'ok' ? 'bg-slate-800/95' : 'bg-red-500/95'"
      title="点击关闭"
      @click="ui.dismiss(t.id)"
    >
      <span
        class="w-5 h-5 rounded-full flex items-center justify-center shrink-0"
        :class="t.type === 'ok' ? 'bg-white/15' : 'bg-white/20'"
      >
        <AppIcon :name="t.type === 'ok' ? 'check' : 'alert'" :size="12" :stroke-width="2.5" />
      </span>
      {{ t.text }}
    </div>
  </div>
</template>
