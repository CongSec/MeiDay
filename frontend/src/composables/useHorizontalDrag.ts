/**
 * 横向拖拽滚动（供时间胶囊图表等容器复用）。
 *
 * 全局样式 html/body { touch-action: pan-y } 禁用了移动端原生横向 pan（否则会与
 * 右滑开侧栏 / 下拉刷新冲突），因此横向滚动容器需要用 Pointer Events 手动接管：
 * - 横向占优：滚动 scrollLeft（拖动跟手，且不会误触浏览器返回手势）；
 * - 纵向占优：放行给页面滚动 / 下拉刷新，互不干扰；
 * - 容器未溢出（桌面宽屏）时不进入拖拽，保留原生选择/滚动；
 * - 横向拖动结束会吞掉紧随其后的 click，避免从可点击小块上起手拖动时误触编辑。
 *
 * 注意：指针捕获只能在「确认横向拖动」之后设置，不能在 pointerdown 时立即设置。
 * 一旦 pointerdown 就 setPointerCapture，后续的兼容鼠标事件（mousedown/mouseup/click）
 * 会被重定向到滚动容器本身，容器内任务小块（button）的普通点击永远收不到 click，
 * 表现为「日历图里的任务点不动」（网页端日历容器常年处于溢出态，必现）。
 */
import { ref } from 'vue'

export function useHorizontalDrag() {
  /** 绑定到可横向滚动的容器（同时加 .h-scroll 样式类） */
  const scrollEl = ref<HTMLElement | null>(null)
  /** 是否处于拖拽状态（可加 .dragging 禁用文字选择等） */
  const dragging = ref(false)

  let dragStartX = 0
  let dragStartY = 0
  let dragStartScroll = 0
  let dragAxis: 'h' | 'v' | null = null
  /** 是否已捕获指针（仅横向拖动确认后为 true） */
  let captured = false
  /** 横向拖动发生过：吞掉紧随其后的 click，防止误触内部可点击元素 */
  let suppressClick = false

  function onPointerDown(e: PointerEvent) {
    const el = scrollEl.value
    if (!el || e.button !== 0) return
    // 容器未溢出（桌面宽屏）时保持原生选择/滚动，不进入拖拽
    if (el.scrollWidth <= el.clientWidth + 1) return
    dragStartX = e.clientX
    dragStartY = e.clientY
    dragStartScroll = el.scrollLeft
    dragAxis = null
    suppressClick = false
    captured = false
    dragging.value = true
    el.classList.add('dragging')
    // 这里不能 setPointerCapture：会把普通点击重定向到容器，导致内部可点击元素点不动。
    // 等到 pointermove 确认横向拖动后再捕获（见 onPointerMove）。
  }

  function onPointerMove(e: PointerEvent) {
    const el = scrollEl.value
    if (!el || !dragging.value) return
    const dx = e.clientX - dragStartX
    const dy = e.clientY - dragStartY
    if (!dragAxis) {
      // 先判定方向：横向占优才接管，纵向放行页面滚动/下拉刷新
      if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return
      dragAxis = Math.abs(dx) >= Math.abs(dy) ? 'h' : 'v'
      if (dragAxis === 'v') {
        dragging.value = false
        el.classList.remove('dragging')
        return
      }
      // 确认横向拖动后才捕获指针：拖动期间即使指针移出容器也能持续收到 move
      try {
        el.setPointerCapture(e.pointerId)
        captured = true
      } catch {
        captured = false
      }
    }
    if (dragAxis === 'h') {
      if (e.cancelable) e.preventDefault()
      suppressClick = true
      el.scrollLeft = dragStartScroll - dx
    }
  }

  function onPointerEnd(e: PointerEvent) {
    const el = scrollEl.value
    dragging.value = false
    dragAxis = null
    if (el) {
      el.classList.remove('dragging')
      if (captured) {
        captured = false
        try {
          el.releasePointerCapture(e.pointerId)
        } catch {
          /* ignore */
        }
      }
    }
  }

  /** 绑定到同一容器的 @click.capture：横向拖动结束时吞掉紧随其后的 click */
  function onClickCapture(e: MouseEvent) {
    if (!suppressClick) return
    suppressClick = false
    e.preventDefault()
    e.stopPropagation()
  }

  return { scrollEl, dragging, onPointerDown, onPointerMove, onPointerEnd, onClickCapture }
}
