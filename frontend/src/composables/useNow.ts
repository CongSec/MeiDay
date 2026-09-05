import { onUnmounted, ref } from 'vue'
import { todayKey } from '@/utils/time'

/**
 * 全局共享的“当前时间/今天日期”时钟：
 * - 单一 30s 定时器（懒启动、无订阅者自动停止），替代每个 TaskCard 各自创建 setInterval；
 * - `today` 为响应式 ref，跨天自动更新（TodayView 不再持有一次性 todayKey 常量）。
 */
const TICK_MS = 30_000

const now = ref(Date.now())
const today = ref(todayKey())
let timer: number | undefined
let subscribers = 0

function tick() {
  now.value = Date.now()
  today.value = todayKey()
}

function ensureRunning() {
  if (timer !== undefined) return
  tick()
  timer = window.setInterval(tick, TICK_MS)
}

function maybeStop() {
  if (subscribers === 0 && timer !== undefined) {
    window.clearInterval(timer)
    timer = undefined
  }
}

/** 组件挂载时订阅共享时钟，卸载时自动退订（最后一个订阅者退出后全局定时器停止）。 */
export function useNow() {
  subscribers++
  ensureRunning()
  onUnmounted(() => {
    subscribers--
    maybeStop()
  })
  return { now, today }
}
