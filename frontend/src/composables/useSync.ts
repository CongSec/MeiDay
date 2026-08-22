import { ref } from 'vue'
import { useProjectsStore } from '@/stores/projects'
import { useTasksStore } from '@/stores/tasks'
import { useStatsStore } from '@/stores/stats'
import { useUiStore } from '@/stores/ui'
import { UNCATEGORIZED } from '@/types'

/** 全局唯一同步锁：刷新按钮、下拉刷新同时触发时只执行一次 */
const syncing = ref(false)

/**
 * 手动/下拉刷新同步：
 * 1) 先落盘本地未保存的项目变更，避免被远端覆盖；
 * 2) 重拉项目列表（远端权威）；
 * 3) 重拉全部任务并与本地按 updatedAt 合并（避免多端冲突），有改动写回。
 */
export function useSync() {
  const projects = useProjectsStore()
  const tasks = useTasksStore()
  const stats = useStatsStore()
  const ui = useUiStore()

  async function syncNow(): Promise<boolean> {
    if (syncing.value) return false
    syncing.value = true
    try {
      await projects.flushProfile()
      await projects.load()
      // 统计文件一并从 OSS 同步（只读展示，不参与任务合并）
      await stats.load()
      const projectIds = [...projects.projects.map((p) => p.id), UNCATEGORIZED]
      const failed = await tasks.syncAll(projectIds)
      if (failed > 0) {
        ui.toast(`同步完成，${failed} 个项目同步失败`, 'error')
      } else {
        ui.toast('同步完成')
      }
      return failed === 0
    } catch (e) {
      ui.toast((e as Error).message || '同步失败，请检查网络或 OSS 配置', 'error')
      return false
    } finally {
      syncing.value = false
    }
  }

  return { syncing, syncNow }
}
