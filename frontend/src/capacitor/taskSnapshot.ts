import { Capacitor, registerPlugin } from '@capacitor/core'

/** 与安卓原生 TaskSnapshotPlugin 对应的方法签名 */
interface TaskSnapshotPlugin {
  updateSnapshot(options: { names: string[] }): Promise<{ ok?: boolean }>
  requestNotificationPermission(): Promise<{ granted: boolean }>
  getLaunchToday(): Promise<{ open: boolean }>
}

const native = registerPlugin<TaskSnapshotPlugin>('TaskSnapshot')

/** 仅安卓（Capacitor）原生平台可用；Web / 思源插件端静默跳过 */
export const isTaskSnapshotSupported = (): boolean => Capacitor.isNativePlatform()

/** 把「今日未完成任务名称」快照写入安卓本地，并刷新桌面小组件 + 常驻通知 */
export async function pushTaskSnapshot(names: string[]): Promise<void> {
  if (!isTaskSnapshotSupported()) return
  try {
    await native.updateSnapshot({ names })
  } catch (e) {
    console.warn('[TaskSnapshot] 更新失败', e)
  }
}

/** Android 13+ 请求通知权限（首次进入时调用一次） */
export async function requestNotificationPermission(): Promise<boolean> {
  if (!isTaskSnapshotSupported()) return false
  try {
    const r = await native.requestNotificationPermission()
    return !!r.granted
  } catch {
    return false
  }
}

/** 消费「从小组件/通知点进来」的启动标记；true 表示应跳转今日任务页 */
export async function consumeLaunchToday(): Promise<boolean> {
  if (!isTaskSnapshotSupported()) return false
  try {
    const r = await native.getLaunchToday()
    return !!r.open
  } catch {
    return false
  }
}