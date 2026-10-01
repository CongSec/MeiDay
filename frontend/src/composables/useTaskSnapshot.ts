import { onUnmounted, watch } from 'vue'
import { useRouter } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import { useTasksStore } from '@/stores/tasks'
import { todayKey } from '@/utils/time'
import { isTaskVisibleToday } from '@/utils/todayFilter'
import { debounce } from '@/utils/debounce'
import {
  consumeLaunchToday,
  isTaskSnapshotSupported,
  pushTaskSnapshot,
  requestNotificationPermission,
} from '@/capacitor/taskSnapshot'
import type { Task } from '@/types'

/**
 * 计算「今日任务页」里展示的未完成任务名称（与 TodayView 完全一致）：
 * 1) 今日可见（isTaskVisibleToday，含逾期/提醒已过/区间覆盖/重复命中/子任务拉回）+ 仅 pending；
 * 2) 排序：手动拖拽顺序 todayOrder → 兜底 sort/截止时间（过期任务不再自动置顶）。
 */
function computeTodayPendingNames(): string[] {
  const tasks = useTasksStore()
  const today = todayKey()
  const list = tasks.all.filter((t) => isTaskVisibleToday(t, today))
  const orderMap = new Map<string, number>()
  tasks.todayOrder.forEach((id, idx) => orderMap.set(id, idx))
  const byOrder = (a: Task, b: Task) => (orderMap.get(a.id) ?? 0) - (orderMap.get(b.id) ?? 0)
  const fallback = (a: Task, b: Task) => {
    const sa = a.sort ?? Number.MAX_SAFE_INTEGER
    const sb = b.sort ?? Number.MAX_SAFE_INTEGER
    if (sa !== sb) return sa - sb
    return (a.endTime || '').localeCompare(b.endTime || '')
  }
  const group = (arr: Task[]) => {
    const registered = arr.filter((t) => orderMap.has(t.id)).sort(byOrder)
    const unregistered = arr.filter((t) => !orderMap.has(t.id)).sort(fallback)
    return [...registered, ...unregistered]
  }
  const pending = group(list.filter((t) => t.status === 'pending'))
  return pending.map((t) => t.name)
}

/**
 * 桌面小组件 + 常驻通知的快照同步（全局唯一实例，App.vue 挂载时启用）：
 * - 任务/顺序/登录态变化 → 防抖写入安卓本地快照；
 * - APP 打开期间跨零点自动更新；
 * - 首次登录后请求通知权限；
 * - 监听「从小组件/通知点进来」的标记并跳转今日任务页。
 */
export function useTaskSnapshot() {
  const auth = useAuthStore()
  const router = useRouter()

  let permissionRequested = false
  const ensurePermission = () => {
    if (permissionRequested) return
    permissionRequested = true
    void requestNotificationPermission()
  }

  const write = debounce(() => {
    if (!isTaskSnapshotSupported()) return
    if (!auth.isLoggedIn) {
      // 登出/会话失效：清空快照，避免小组件/通知残留他人任务
      void pushTaskSnapshot([])
      return
    }
    ensurePermission()
    void pushTaskSnapshot(computeTodayPendingNames())
  }, 800)

  // 任务内容/完成状态/今日顺序/登录态变化 → 写快照
  watch(
    [() => useTasksStore().all, () => useTasksStore().todayOrder, () => auth.isLoggedIn],
    () => write(),
  )

  // APP 打开期间跨零点：今日任务会变，定时兜底刷新
  let lastDay = todayKey()
  const dayTimer = window.setInterval(() => {
    const d = todayKey()
    if (d !== lastDay) {
      lastDay = d
      write()
    }
  }, 60_000)

  // 从小组件/通知点进来 → 跳转今日任务页
  const maybeGoToday = async () => {
    if (!isTaskSnapshotSupported()) return
    try {
      const open = await consumeLaunchToday()
      if (open && router.currentRoute.value.path !== '/today') {
        router.push('/today')
      }
    } catch {
      /* 忽略 */
    }
  }
  const onVisibility = () => {
    if (document.visibilityState === 'hidden') {
      // 防抖窗口内切后台：定时器可能被系统挂起，立即落盘，保证小组件/通知及时更新
      write.flush()
      return
    }
    if (document.visibilityState === 'visible') void maybeGoToday()
  }
  document.addEventListener('visibilitychange', onVisibility)
  // 进程被系统回收/页面卸载前同样立即落盘
  const onPageHide = () => write.flush()
  window.addEventListener('pagehide', onPageHide)
  // 兜底轮询：APP 前台时点小组件/通知（onNewIntent）也能及时跳转
  const launchTimer = window.setInterval(() => void maybeGoToday(), 3000)

  onUnmounted(() => {
    write.cancel()
    window.clearInterval(dayTimer)
    window.clearInterval(launchTimer)
    document.removeEventListener('visibilitychange', onVisibility)
    window.removeEventListener('pagehide', onPageHide)
  })

  // 冷启动立即消费一次（从小组件/通知点击打开 APP 的场景）
  void maybeGoToday()
  // 初始写入一次：保证冷启动（已登录、纯读缓存、任务已就绪）也能落盘——watch 只在状态变化后触发
  write()
}