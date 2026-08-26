/**
 * vue-draggable-plus 公共拖拽参数（让任务/项目拖动更丝滑）
 *
 * - 桌面端任务列表（wholeCard）：整卡原生 HTML5 拖拽，抓住卡片任意位置即可拖动，
 *   不会选中文字；触屏端整卡「长按(≥300ms)拖动」，轻点仍是点击。
 * - 触屏端强制 fallback 拖拽：被拖元素克隆跟随手指、原位置占位，
 *   避免与页面滚动手势冲突导致的卡顿/不跟手。
 * - swapThreshold 调小，让目标项“过半即让位”，实现实时“占位排斥”效果。
 * - touchStartThreshold 忽略过小的位移，避免轻微触碰就误触发拖拽；
 *   fallbackTolerance 让克隆贴手前先等手指真正移动，消除起步跳动。
 * - 交互控件(input/button/label…)用 filter 排除，避免误拖；preventOnFilter=false
 *   保证控件点击/勾选不受影响。
 * - ghost/chosen/drag 类名提供拖拽过程中的视觉反馈（样式见 style.css）。
 */

/** 是否以触摸为主要交互的设备（手机/平板）；触屏笔记本以鼠标为主，按桌面处理 */
function isTouchDevice(): boolean {
  if (typeof window === 'undefined') return false
  if (!('ontouchstart' in window) && (navigator.maxTouchPoints ?? 0) <= 0) return false
  try {
    return window.matchMedia('(pointer: coarse)').matches
  } catch {
    return true
  }
}

/** 交互控件：这些区域不触发整卡拖拽（但仍可正常点击/勾选） */
const DRAG_FILTER = 'input, button, a, select, textarea, label, [contenteditable]'

/** 当前是否有拖拽正在进行（供 LayoutView 识别“长按拖动”，避免误开侧栏） */
let dragging = false
export function setDragging(v: boolean) {
  dragging = v
  if (typeof document !== 'undefined') {
    // 拖拽期间给 <body> 加标记：全局禁用文字选择（含跟随手指的克隆、跨卡拖动）
    document.body.classList.toggle('meiday-dragging', v)
  }
}
export function isDragging() {
  return dragging
}

// 长按/拖拽期间禁止文本选择：目标落在任务卡内，或正处于拖拽中时，拦截 selectstart
if (typeof document !== 'undefined') {
  document.addEventListener('selectstart', (e: Event) => {
    const t = e.target as HTMLElement | null
    if (dragging || (t && typeof t.closest === 'function' && !!t.closest('.task-card'))) {
      e.preventDefault()
    }
  })
}

interface DragOptions {
  /** 整卡可拖动（任务列表 true；项目侧栏仅手柄拖动） */
  wholeCard?: boolean
}

export function getDragOptions(opts: DragOptions = {}) {
  const isTouch = isTouchDevice()
  const base = {
    animation: 180,
    ghostClass: 'drag-ghost',
    chosenClass: 'drag-chosen',
    dragClass: 'drag-active',
    fallbackTolerance: 2,
    touchStartThreshold: 6,
    // 目标项过半即让位，实现实时“占位排斥”
    swapThreshold: 0.5,
    // 交互控件不参与整卡拖拽，点击/勾选不受影响
    filter: DRAG_FILTER,
    preventOnFilter: false,
  }
  // 触屏整卡：轻点=点击，长按≥300ms 才进入拖拽
  if (isTouch && opts.wholeCard) {
    return {
      ...base,
      forceFallback: true,
      fallbackOnBody: true,
      delay: 300,
      delayOnTouchOnly: true,
    }
  }
  // 触屏手柄（项目侧栏）：fallback 跟手；handle 由组件属性提供
  if (isTouch) {
    return { ...base, forceFallback: true, fallbackOnBody: true }
  }
  // 桌面整卡：原生拖拽，抓任意位置即可拖动（不会选中文字）
  if (opts.wholeCard) {
    return { ...base, forceFallback: false }
  }
  // 桌面手柄（项目侧栏）：原生拖拽；handle 由组件属性提供
  return { ...base, forceFallback: false }
}
