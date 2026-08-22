/**
 * vue-draggable-plus 公共拖拽参数（让任务/项目拖动更丝滑）
 *
 * - 桌面端保留原生 HTML5 拖拽（更跟手）；触屏端强制 fallback 拖拽：
 *   被拖元素克隆跟随手指、原位置占位，避免与页面滚动手势冲突导致的卡顿/不跟手。
 * - touchStartThreshold 忽略过小的位移，避免轻微触碰就误触发拖拽。
 * - ghost/chosen/drag 类名提供拖拽过程中的视觉反馈（样式见 style.css）。
 */
export function getDragOptions() {
  const isTouch =
    typeof window !== 'undefined' &&
    ('ontouchstart' in window || (navigator.maxTouchPoints ?? 0) > 0)
  return {
    animation: 180,
    ghostClass: 'drag-ghost',
    chosenClass: 'drag-chosen',
    dragClass: 'drag-active',
    forceFallback: isTouch,
    fallbackOnBody: isTouch,
    fallbackTolerance: 0,
    touchStartThreshold: 6,
  }
}
