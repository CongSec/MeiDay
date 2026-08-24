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
      // 今日任务跨项目顺序表随手动刷新一并同步
      await tasks.loadTodayOrder()
      const projectIds = [...projects.projects.map((p) => p.id), UNCATEGORIZED]
      // 本地缓存不完整（全新设备/首登）时无法判断哪些项目今日有任务：全量同步所有项目，
      // 否则手动刷新也拉不到未打开项目的任务（今日视图/项目列表一直为空）。
      // 已有完整缓存时只刷「今日相关」项目 + 当前视图聚焦的项目：今日任务常驻保证今日
      // 视图/侧栏角标正确，当前项目保证在项目页刷新时正在看的项目也更新；未分类(today.json)
      // 是今日视图的权威文件，每次刷新都会拉取（单文件，条件 GET 命中 304 时零下载）。
      // 其余项目打开时由 loadProject 按需从 OSS 拉取，避免手动刷新全量下载几百个项目的
      // tasks/trash/repeats 数据包（OSS 请求风暴 + 内存膨胀）。
      const cachedIds = await tasks.loadFromIdb(projectIds)
      const fullyCached = projectIds.every((id) => cachedIds.includes(id))
      const todayIds = tasks.todayRelevantProjectIds(projectIds)
      const viewIds = tasks.viewPinnedProjectIds
      const target = fullyCached
        ? [...new Set([UNCATEGORIZED, ...todayIds, ...viewIds])]
        : projectIds
      const failed = await tasks.syncAll(target)
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