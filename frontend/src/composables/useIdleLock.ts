import { ref } from 'vue'

/** 隐私日记：任务系统全局的 10 分钟空闲自动锁定（含普通任务页）。
 *  - 日记解锁后启动；任何交互（鼠标/键盘/触摸/滚轮/点击预警按钮）都重置计时；
 *  - 剩余 2 分钟 / 1 分钟 / 30 秒时弹预警（IdleLockBanner），点击「继续使用」续期；
 *  - 到期：清空日记内存密钥；若停留在日记页则跳回任务系统首页。
 *  本模块为叶子模块（只依赖 vue），可被启动代码安全引用，不会带入日记大包。 */
const LOCK_MS = 10 * 60 * 1000
const WARNING_MS = [2 * 60 * 1000, 60 * 1000, 30 * 1000]

export const idleLockActive = ref(false)
/** 距锁定剩余毫秒 */
export const idleLockRemainingMs = ref(LOCK_MS)
/** 当前应显示的预警剩余毫秒（命中 2min/1min/30s 阈值时），否则 null */
export const idleLockWarningMs = ref<number | null>(null)

let timer: number | undefined
let lastActivity = 0
let lastWarn = Infinity
let expireHandler: (() => void) | null = null
/** 核心清钥回调：由日记 store 注册，到期后无论是否停留在日记页都执行（销毁内存密钥/解密态） */
let clearHandler: (() => void) | null = null

function update() {
  if (!idleLockActive.value) return
  const remain = Math.max(0, LOCK_MS - (Date.now() - lastActivity))
  idleLockRemainingMs.value = remain
  if (remain <= 0) {
    stopIdleLock()
    clearHandler?.()
    expireHandler?.()
    return
  }
  const hit = WARNING_MS.find((w) => remain <= w && w < lastWarn)
  if (hit !== undefined) {
    lastWarn = hit
    idleLockWarningMs.value = hit
  }
}

function onActivity() {
  if (!idleLockActive.value) return
  lastActivity = Date.now()
  lastWarn = Infinity
  idleLockWarningMs.value = null
  idleLockRemainingMs.value = LOCK_MS
}

/** 注册到期回调（由日记视图设置；模块级保存，离开日记页后仍生效） */
export function setIdleLockExpireHandler(fn: (() => void) | null): void {
  expireHandler = fn
}
/** 注册核心清钥回调（日记解锁时设置；锁定时清除） */
export function setDiaryIdleClearHandler(fn: (() => void) | null): void {
  clearHandler = fn
}


export function startIdleLock(): void {
  if (idleLockActive.value) {
    onActivity()
    return
  }
  idleLockActive.value = true
  lastActivity = Date.now()
  lastWarn = Infinity
  idleLockWarningMs.value = null
  idleLockRemainingMs.value = LOCK_MS
  window.addEventListener('pointerdown', onActivity, { passive: true })
  window.addEventListener('keydown', onActivity, { passive: true })
  window.addEventListener('touchstart', onActivity, { passive: true })
  window.addEventListener('wheel', onActivity, { passive: true })
  timer = window.setInterval(update, 1000)
}

export function stopIdleLock(): void {
  if (timer !== undefined) window.clearInterval(timer)
  timer = undefined
  idleLockActive.value = false
  idleLockWarningMs.value = null
  idleLockRemainingMs.value = LOCK_MS
  window.removeEventListener('pointerdown', onActivity)
  window.removeEventListener('keydown', onActivity)
  window.removeEventListener('touchstart', onActivity)
  window.removeEventListener('wheel', onActivity)
}

export function keepIdleLockAlive(): void {
  onActivity()
}

/** 秒转 "X分Y秒" / "Y秒" 提示文案 */
export function formatLockRemain(ms: number): string {
  const total = Math.ceil(ms / 1000)
  if (total >= 60) return `${Math.floor(total / 60)}分${total % 60 ? `${total % 60}秒` : ''}`
  return `${total}秒`
}
