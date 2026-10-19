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
 *   保证控件点击/勾选不受影响；整卡拖拽还排除子任务拖拽手柄（.sub-drag-handle），
 *   抓住手柄拖动的是子任务，而不是整张卡。
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
/** 子任务拖拽手柄：整卡拖拽时应排除（抓住手柄是拖动子任务，不是拖整张卡） */
const SUBTASK_HANDLE_FILTER = '.sub-drag-handle'

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
    // 交互控件不参与整卡拖拽，点击/勾选不受影响；整卡拖拽还排除子任务拖拽手柄
    filter: opts.wholeCard ? `${DRAG_FILTER}, ${SUBTASK_HANDLE_FILTER}` : DRAG_FILTER,
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

/* ---- 拖拽成子任务：落点判定与目标卡高亮 ----
 * 整卡拖拽时区分两种意图：
 *  - 拖到另一张任务卡的「卡片主体区域」（中部）→ 把被拖任务变成该卡任务的子任务；
 *  - 拖到卡片边缘/列表空隙/末尾 → 仍是排序。
 * 实现：依托 Sortable 的 move 事件（CustomEvent，携带 related=指针下悬停的卡片元素、
 * originalEvent=原生坐标）。move 事件在 桌面原生拖拽(dragover) 与 触屏 fallback(touchmove)
 * 两种模式下都持续触发，故以此为准；窗口级监听仅作指针坐标兜底（子任务拖出卡片判定用）。 */

/** 拖拽过程中最后记录的指针位置（桌面原生拖拽时 mousemove 不可靠，用 dragover/pointermove 兜底） */
let lastPointer = { x: 0, y: 0 }
/** 是否正在追踪指针位置（整卡落点判定与子任务拖出卡片判定共用） */
let pointerTracking = false

function trackPointer(e: DragEvent | MouseEvent | TouchEvent | null | undefined) {
  if (!e) return
  const src = (e as TouchEvent).touches?.[0] ?? (e as TouchEvent).changedTouches?.[0]
  if (src) {
    lastPointer = { x: src.clientX, y: src.clientY }
  } else {
    const me = e as MouseEvent
    lastPointer = { x: me.clientX, y: me.clientY }
  }
}

function onPointerMove(e: Event) {
  // 仅记录指针坐标（子任务拖出卡片判定用）；目标卡判定完全交由 @move 事件（updateSubtaskDrop）
  trackPointer(e as DragEvent)
}

/** 开始追踪指针位置（不触发目标卡高亮）；整卡落点判定与子任务拖出判定共用 */
export function startPointerTrack() {
  if (pointerTracking) return
  pointerTracking = true
  window.addEventListener('pointermove', onPointerMove)
  window.addEventListener('dragover', onPointerMove)
  window.addEventListener('mousemove', onPointerMove)
}

/** 停止追踪指针位置 */
export function stopPointerTrack() {
  if (!pointerTracking) return
  pointerTracking = false
  window.removeEventListener('pointermove', onPointerMove)
  window.removeEventListener('dragover', onPointerMove)
  window.removeEventListener('mousemove', onPointerMove)
}

/**
 * 子任务拖出卡片判定用：由 TaskCard 子任务 VueDraggable 的 @move 调用，
 * 记录指针位置（native 拖拽下 pointermove 不一定触发，move 事件的 originalEvent 更可靠）。
 */
export function trackDropPointer(evt?: { originalEvent?: DragEvent | MouseEvent | TouchEvent | null }) {
  trackPointer(evt?.originalEvent ?? null)
}

/**
 * 取最近一次记录的指针位置（子任务拖出卡片判定用：松手位置是否已离开父卡片边界）。
 */
export function lastDropPointer(): { x: number; y: number } {
  return { ...lastPointer }
}

/** 当前是否正处在“可能落成子任务”的整卡拖拽中（由视图 onDragStart/onDragEnd 维护） */
let subtaskDragActive = false
/** 被拖任务的 id（用于排除自身，避免把自己高亮/设为自己的子任务） */
let subtaskDragSourceId: string | null = null
/** 被拖元素（整卡拖拽：即被拖的任务卡；end 时临时隐藏以穿透命中目标卡） */
let subtaskDragEl: HTMLElement | null = null
/** 拖拽过程中的目标卡元素（用于高亮与落点判定） */
let subtaskTargetEl: HTMLElement | null = null
/** 拖拽过程中命中的目标任务 id（松手时读取；null 表示落到空隙） */
let subtaskTargetId: string | null = null

/** 目标卡高亮（用内联样式而非 class：拖拽中列表重渲染会覆盖 :class 绑定的类） */
const TARGET_HIGHLIGHT = {
  borderColor: 'rgba(69, 87, 201, 0.65)',
  boxShadow: '0 0 0 3px rgba(69, 87, 201, 0.28), 0 12px 32px -8px rgba(69, 87, 201, 0.35)',
}

function applyTargetHighlight(el: HTMLElement | null) {
  if (el) {
    el.style.borderColor = TARGET_HIGHLIGHT.borderColor
    el.style.boxShadow = TARGET_HIGHLIGHT.boxShadow
  }
}

function clearTargetHighlight(el: HTMLElement | null) {
  if (!el) return
  el.style.borderColor = ''
  el.style.boxShadow = ''
}

/** 指针位置下最近的 .task-card（排除被拖卡自身、未来任务卡）；找不到返回 null */
function findTaskCardAt(x: number, y: number): HTMLElement | null {
  if (!subtaskDragSourceId) return null
  let el = document.elementFromPoint(x, y) as HTMLElement | null
  if (!el) return null
  // 触屏 fallback：克隆跟随手指，指针下先命中克隆本身；临时隐藏克隆才能看到下方卡片
  const fallback = el.closest?.('.sortable-fallback') as HTMLElement | null
  // 桌面原生拖拽：被拖元素随插入点移动，可能遮挡指针下方的目标卡；同样临时隐藏
  const dragEl = subtaskDragEl && subtaskDragEl.isConnected && subtaskDragEl !== fallback ? subtaskDragEl : null
  if (fallback || dragEl) {
    const prevF = fallback?.style.display
    const prevD = dragEl?.style.display
    if (fallback) fallback.style.display = 'none'
    if (dragEl) dragEl.style.display = 'none'
    el = document.elementFromPoint(x, y) as HTMLElement | null
    if (fallback) fallback.style.display = prevF ?? ''
    if (dragEl) dragEl.style.display = prevD ?? ''
    if (!el) return null
  }
  const card = (el as HTMLElement).closest?.('.task-card') as HTMLElement | null
  if (!card) return null
  const id = card.dataset.taskId
  // 排除被拖卡自身；未来任务卡不作为落点（未来任务不支持子任务）
  if (!id || id === subtaskDragSourceId || card.dataset.future === '1') return null
  return card
}

/**
 * 从 Sortable move 事件解析「指针下悬停的目标任务卡」。
 * 优先用 related（Sortable 算好的悬停元素，桌面 native 拖拽时 elementFromPoint 会命中
 * ghost/被拖卡自身，不可靠）；若 related 是跟随手指的 fallback 克隆或命中了被拖卡自身，
 * 则回退到坐标命中（隐藏克隆后取下方真实卡）。
 * 判定规则：目标卡（排除被拖卡自身、未来任务卡），且指针位于该卡垂直方向 25%–75%
 * 的「主体区域」（落在上下边缘带/空隙 → 返回 null，走排序）。
 */
function resolveTargetCard(evt: { related?: HTMLElement | null }): HTMLElement | null {
  if (!subtaskDragSourceId) return null
  let card: HTMLElement | null = null
  const related = evt.related as HTMLElement | null | undefined
  if (related && related.closest) {
    const c = related.closest('.task-card') as HTMLElement | null
    if (c) {
      const id = c.dataset.taskId
      // 克隆（触屏）会被 related 命中：其 data-task-id 等于源 id，走坐标回退
      if (id && id !== subtaskDragSourceId && c.dataset.future !== '1') card = c
    }
  }
  if (!card) card = findTaskCardAt(lastPointer.x, lastPointer.y)
  if (!card) return null
  // 指针须落在卡中部区域（避开上下边缘带），确保是「悬停在卡上」而非「插到空隙/边缘」
  const r = card.getBoundingClientRect()
  const band = r.height * 0.25
  if (lastPointer.y < r.top + band || lastPointer.y > r.bottom - band) return null
  return card
}

function refreshSubtaskTarget(evt?: { related?: HTMLElement | null }) {
  if (!subtaskDragActive) return
  const target = evt ? resolveTargetCard(evt) : null
  if (target === subtaskTargetEl) return
  clearTargetHighlight(subtaskTargetEl)
  subtaskTargetEl = target
  applyTargetHighlight(subtaskTargetEl)
  subtaskTargetId = subtaskTargetEl?.dataset.taskId ?? null
}

/**
 * 进入“可能落成子任务”的整卡拖拽：记录源任务 id 与被拖元素，开始跟踪指针并刷新目标卡高亮。
 * 视图在 VueDraggable @start 时调用（evt.item 即被拖元素，end 时临时隐藏以穿透命中）。
 */
export function beginSubtaskDrop(sourceId: string, itemEl?: HTMLElement | null) {
  subtaskDragActive = true
  subtaskDragSourceId = sourceId
  subtaskDragEl = itemEl ?? null
  subtaskTargetEl = null
  subtaskTargetId = null
  startPointerTrack()
}

/**
 * 拖拽过程中由视图 VueDraggable @move 调用：更新指针坐标并判定目标卡。
 * move 事件对象：{ related, originalEvent, willInsertAfter, ... }
 */
export function updateSubtaskDrop(evt: { related?: HTMLElement | null; originalEvent?: DragEvent | MouseEvent | TouchEvent | null }) {
  trackPointer(evt.originalEvent ?? null)
  refreshSubtaskTarget(evt)
}

/**
 * 结束整卡拖拽：返回“落到的目标任务 id”（null 表示落到空隙/边缘，走原排序逻辑），
 * 并清理高亮与监听。视图在 VueDraggable @end 时调用。
 */
export function endSubtaskDrop(): string | null {
  const targetId = subtaskTargetId
  clearTargetHighlight(subtaskTargetEl)
  subtaskTargetEl = null
  subtaskTargetId = null
  subtaskDragActive = false
  subtaskDragSourceId = null
  subtaskDragEl = null
  stopPointerTrack()
  return targetId
}
