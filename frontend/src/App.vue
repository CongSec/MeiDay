<script setup lang="ts">
import { onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import { idbClearUserCache } from '@/utils/idb'
import { stopSyncPoll } from '@/composables/useSyncPoll'

const auth = useAuthStore()
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
    // 会话失效后清除该用户的本地缓存，避免旧数据残留导致下次登录展示过期数据或同步冲突
    if (username) await idbClearUserCache(username)
    if (router.currentRoute.value.path !== '/login') router.push('/login')
  })
})
</script>

<template>
  <router-view />
</template>
