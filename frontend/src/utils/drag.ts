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

/* ---- 拖拽成子任务：整卡落点 + 插入线（方向1：关闭实时重排） ----
 * 整卡拖拽时区分两种意图：
 *  - 拖到另一张任务卡的「卡片主体区域」（中部）→ 把被拖任务变成该卡任务的子任务；
 *  - 拖到卡片边缘/列表空隙/末尾 → 仍是排序（用蓝色插入线指示落点）。
 * 实现：Sortable 的 move 事件（onMove）在卡片内中区静默不触发（K===0 直接 return !1），
 * 只在越过 50% 交换边界时才触发——若把检测挂在 move 事件上，指针停在卡片主体时
 * 检测不会运行，且实时重排会在每个边界把卡片互相推开（“排斥”）。
 * 因此这里改为：
 *  - @move（即 Sortable onMove）永远返回 false → 关闭实时重排，列表保持静止；
 *  - 窗口级 dragover/pointermove 监听持续跟踪指针并驱动「子任务落点判定 + 插入线」，两者解耦；
 *  - 松手时：已激活子任务落点 → 设为子任务；否则按插入线位置手动重排（视图写入）。 */

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
  trackPointer(e as DragEvent)
  // 整卡拖拽中：实时驱动子任务落点判定 + 插入线（与 Sortable move 事件解耦）
  if (subtaskDragActive) {
    refreshSubtaskTarget({})
    updateDropLine()
  }
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
/** 拖拽过程中的目标卡元素（用于高亮与落点判定；激活后才赋值） */
let subtaskTargetEl: HTMLElement | null = null
/** 拖拽过程中命中的目标任务 id（松手时读取；null 表示落到空隙） */
let subtaskTargetId: string | null = null
/** 「成为子任务」悬停等待时长（ms）：快速路过卡片中部不误触，稳定停留才激活 */
const ARM_DELAY_MS = 300
/** 悬停延迟：当前待激活的目标卡（尚未满足停留时长） */
let pendingCard: HTMLElement | null = null
/** 悬停延迟计时器（计时到点仍停留在同一候选卡则激活） */
let pendingTimer: number | null = null
/** 激活时注入目标卡的徽标元素（移除目标高亮时一并清理） */
let subtaskBadgeEl: HTMLElement | null = null
/** 激活前目标卡原有的 position（还原用） */
let subtaskTargetPrevPos: string | null = null

/** 目标卡高亮（用内联样式而非 class：拖拽中列表重渲染会覆盖 :class 绑定的类） */
const TARGET_HIGHLIGHT = {
  borderColor: 'rgba(69, 87, 201, 0.95)',
  boxShadow:
    '0 0 0 4px rgba(69, 87, 201, 0.35), 0 0 26px rgba(69, 87, 201, 0.45), 0 14px 36px -8px rgba(69, 87, 201, 0.5)',
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

/** 生成“设为其子任务”的徽标提示条（含分支图标与目标任务名），注入目标卡正中 */
function createSubtaskBadge(card: HTMLElement): HTMLElement {
  const badge = document.createElement('div')
  badge.className = 'subtask-drop-badge'
  const name = (card.dataset.taskName || '').trim()
  badge.innerHTML =
    '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M6 3v9"/><circle cx="18" cy="6.5" r="2.4"/><circle cx="6" cy="17.5" r="2.4"/><path d="M18 8.9a9.2 9.2 0 0 1-9.2 9.2"/></svg>' +
    `<span>设为${name ? `「${name}」的` : ''}子任务</span>`
  card.appendChild(badge)
  return badge
}

/** 激活目标落点：加粗高亮 + 徽标 + 记录原 position（供还原） */
function armTarget(card: HTMLElement) {
  disarmTarget()
  // 候选卡由轻提示升级为强高亮：清掉 pending 引用（强高亮会覆盖同一批内联样式）
  clearPendingHighlight(pendingHighlightEl)
  pendingHighlightEl = null
  subtaskTargetEl = card
  subtaskTargetId = card.dataset.taskId ?? null
  subtaskTargetPrevPos = card.style.position
  card.style.position = 'relative'
  applyTargetHighlight(card)
  subtaskBadgeEl = createSubtaskBadge(card)
}

/** 取消当前激活的落点：清除高亮、徽标并还原目标卡 */
function disarmTarget() {
  clearTargetHighlight(subtaskTargetEl)
  if (subtaskTargetEl) {
    subtaskTargetEl.style.position = subtaskTargetPrevPos || ''
  }
  subtaskTargetPrevPos = null
  if (subtaskBadgeEl) {
    subtaskBadgeEl.remove()
    subtaskBadgeEl = null
  }
  subtaskTargetEl = null
  subtaskTargetId = null
}

function clearPendingTimer() {
  if (pendingTimer != null) {
    window.clearTimeout(pendingTimer)
    pendingTimer = null
  }
}

/* ---- 方向1：待激活（pending）轻提示 + 插入线（dropline） ---- */

/** 待激活候选卡的轻提示（进入正中区但未满 300ms 时先给个浅描边反馈） */
const PENDING_HIGHLIGHT = {
  borderColor: 'rgba(69, 87, 201, 0.55)',
  boxShadow: '0 0 0 2px rgba(69, 87, 201, 0.18)',
}
/** 当前被轻提示的卡片元素（与 pendingCard 对应；换卡/取消时清除样式） */
let pendingHighlightEl: HTMLElement | null = null

function applyPendingHighlight(el: HTMLElement | null) {
  if (el) {
    el.style.borderColor = PENDING_HIGHLIGHT.borderColor
    el.style.boxShadow = PENDING_HIGHLIGHT.boxShadow
  }
}
function clearPendingHighlight(el: HTMLElement | null) {
  if (!el) return
  el.style.borderColor = ''
  el.style.boxShadow = ''
}

/** 蓝色插入线元素（排序落点指示；position:fixed 挂在 body） */
let dropLineEl: HTMLElement | null = null
/** 最近一次计算的插入位置（在 dragList 数组中的下标；松手时视图据此手动重排） */
let dropInsertIndex = -1

function hideDropLine() {
  if (dropLineEl) {
    dropLineEl.remove()
    dropLineEl = null
  }
}

/** 由指针坐标计算排序插入点并渲染蓝色插入线；子任务模式（待激活/已激活）下隐藏 */
function updateDropLine() {
  if (!subtaskDragActive) return
  // 子任务模式：隐藏插入线并清空插入点（松手落在卡片主体上若未激活即无事发生，
  // 不会用进入主体前的旧插入点做一次意外重排），避免与徽标/高亮双重信号冲突
  if (pendingCard || subtaskTargetEl) {
    hideDropLine()
    dropInsertIndex = -1
    return
  }
  // 只统计拖拽列表（视图给 VueDraggable 加了 drag-list 类）内的卡片：
  // 避免把已完成折叠区等非拖拽列表的卡片计入插入点下标
  const cards = Array.from(document.querySelectorAll<HTMLElement>('.drag-list .task-card[data-task-id]'))
  if (!cards.length) {
    hideDropLine()
    return
  }
  // 中点规则：指针越过某张卡的中心线即排到它后面（含被拖卡自身占位，松手时视图再扣除）
  let insertIdx = 0
  for (const card of cards) {
    const r = card.getBoundingClientRect()
    if (lastPointer.y > r.top + r.height / 2) insertIdx++
  }
  if (insertIdx < 0) insertIdx = 0
  if (insertIdx > cards.length) insertIdx = cards.length
  dropInsertIndex = insertIdx
  const first = cards[0].getBoundingClientRect()
  const y = insertIdx === 0 ? first.top : cards[insertIdx - 1].getBoundingClientRect().bottom
  if (!dropLineEl) {
    dropLineEl = document.createElement('div')
    dropLineEl.className = 'drop-line'
    document.body.appendChild(dropLineEl)
  }
  dropLineEl.style.left = `${first.left}px`
  dropLineEl.style.top = `${y - 1.5}px`
  dropLineEl.style.width = `${first.width}px`
}

/** 指针位置下最近的 .task-card（排除被拖卡自身、未来任务卡）；找不到返回 null */
function findTaskCardAt(x: number, y: number): HTMLElement | null {
  if (!subtaskDragSourceId) return null
  let el = document.elementFromPoint(x, y) as HTMLElement | null
  if (!el) return null
  // 触屏 fallback：克隆跟随手指，指针下先命中克隆本身；临时隐藏克隆才能看到下方卡片
  const fallback = el.closest?.('.sortable-fallback') as HTMLElement | null
  // 被拖卡自身（仍在原槽位，方向1关闭实时重排后不再随指针移动）：用 visibility 隐藏
  // —— 保留占位布局，坐标命中不会被下方卡片位移扭曲；不可命中即视为「悬停在自己身上」→ 非落点
  const dragEl = subtaskDragEl && subtaskDragEl.isConnected && subtaskDragEl !== fallback ? subtaskDragEl : null
  if (fallback || dragEl) {
    const prevF = fallback?.style.display
    const prevD = dragEl?.style.visibility
    if (fallback) fallback.style.display = 'none'
    if (dragEl) dragEl.style.visibility = 'hidden'
    el = document.elementFromPoint(x, y) as HTMLElement | null
    if (fallback) fallback.style.display = prevF ?? ''
    if (dragEl) dragEl.style.visibility = prevD ?? ''
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
 * 判定规则：目标卡（排除被拖卡自身、未来任务卡），且指针位于该卡垂直方向 20%–80%
 * 的「主体区域」（上下 20% 边缘带与列表空隙 → 返回 null，走插入线排序；方向1已关闭
 * 实时重排，列表静止，故触发区可放宽到中部 60%，更易命中）。
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
  // 指针须落在卡主体区域（避开上下边缘带），确保是「悬停在卡上」而非「插到空隙/边缘」
  const r = card.getBoundingClientRect()
  const band = r.height * 0.2
  if (lastPointer.y < r.top + band || lastPointer.y > r.bottom - band) return null
  return card
}

/**
 * 刷新“成为子任务”的候选落点，带悬停延迟：
 *  - 指针进入某卡主体区即记为候选并启动计时（候选卡先给浅色描边提示）；
 *  - 稳定停留 ARM_DELAY_MS 后才「激活」（加粗高亮 + 徽标，松手即设为子任务）；
 *  - 快速路过或中途移到别的卡/空隙 → 取消未激活的候选，不产生误触。
 */
function refreshSubtaskTarget(evt?: { related?: HTMLElement | null }): HTMLElement | null {
  if (!subtaskDragActive) return null
  const candidate = evt ? resolveTargetCard(evt) : null
  const candidateKey = candidate?.dataset.taskId ?? ''
  const armedKey = subtaskTargetEl?.dataset.taskId ?? ''
  if (candidateKey && candidateKey === armedKey) return candidate
  if (!candidateKey && !armedKey) return candidate
  // 仍停留在同一个待激活候选卡上（未激活）：不重置计时，等计时到点激活（同一卡内微移不打断）
  const pendingKey = pendingCard?.dataset.taskId ?? ''
  if (candidateKey && candidateKey === pendingKey) return candidate
  // 目标变化：取消已激活落点与待激活计时，轻提示换到新候选卡，按新候选重新计时
  disarmTarget()
  clearPendingTimer()
  clearPendingHighlight(pendingHighlightEl)
  pendingHighlightEl = candidate
  applyPendingHighlight(candidate)
  pendingCard = candidate
  if (candidate) {
    pendingTimer = window.setTimeout(() => {
      pendingTimer = null
      // 计时到点仍停留在同一候选卡上才激活（防快速路过 / 途中已移开）
      if (subtaskDragActive && pendingCard === candidate && resolveTargetCard({}) === candidate) {
        armTarget(candidate)
      } else {
        // 计时失效（指针已移开）：清空候选与轻提示，再次进入时重新计时
        pendingCard = null
        clearPendingHighlight(pendingHighlightEl)
        pendingHighlightEl = null
      }
    }, ARM_DELAY_MS)
  }
  return candidate
}

/**
 * 进入“可能落成子任务”的整卡拖拽：记录源任务 id 与被拖元素，开始跟踪指针并刷新目标卡高亮。
 * 视图在 VueDraggable @start 时调用（evt.item 即被拖元素，end 时临时隐藏以穿透命中）。
 */
export function beginSubtaskDrop(sourceId: string, itemEl?: HTMLElement | null) {
  disarmTarget()
  clearPendingTimer()
  clearPendingHighlight(pendingHighlightEl)
  pendingHighlightEl = null
  pendingCard = null
  dropInsertIndex = -1
  hideDropLine()
  subtaskDragActive = true
  subtaskDragSourceId = sourceId
  subtaskDragEl = itemEl ?? null
  startPointerTrack()
}

/**
 * 拖拽过程中由视图 VueDraggable @move 调用（即 Sortable 的 onMove）。
 * 永远返回 false → 关闭 Sortable 实时重排，列表保持静止（消除“卡片互相排斥”）。
 * 子任务落点判定与插入线渲染由窗口级 dragover/pointermove 监听驱动（见 onPointerMove），
 * 此处仅补充用 move 事件 originalEvent 更新坐标（onMove 只在越过卡片边界时触发，
 * 主体区内的检测不依赖它）。
 * move 事件对象：{ related, originalEvent, willInsertAfter, ... }
 */
export function updateSubtaskDrop(evt: {
  related?: HTMLElement | null
  originalEvent?: DragEvent | MouseEvent | TouchEvent | null
}): boolean {
  trackPointer(evt.originalEvent ?? null)
  refreshSubtaskTarget({})
  updateDropLine()
  return false
}

/**
 * 结束整卡拖拽：返回 { targetId: 已激活的子任务落点卡 id（null=落到空隙/边缘），
 * insertIndex: 排序插入点下标（在 dragList 数组中的位置，视图据此手动重排） }，
 * 并清理全部拖拽状态（高亮/徽标/插入线/监听）。视图在 VueDraggable @end 时调用。
 */
export function endSubtaskDrop(): { targetId: string | null; insertIndex: number } {
  const targetId = subtaskTargetId
  const insertIndex = dropInsertIndex
  disarmTarget()
  clearPendingTimer()
  clearPendingHighlight(pendingHighlightEl)
  pendingHighlightEl = null
  pendingCard = null
  hideDropLine()
  dropInsertIndex = -1
  subtaskDragActive = false
  subtaskDragSourceId = null
  subtaskDragEl = null
  stopPointerTrack()
  return { targetId, insertIndex }
}

/** 中止整卡拖拽（视图卸载/路由切换兜底）：清理全部拖拽状态与监听 */
export function cancelSubtaskDrop() {
  disarmTarget()
  clearPendingTimer()
  clearPendingHighlight(pendingHighlightEl)
  pendingHighlightEl = null
  pendingCard = null
  hideDropLine()
  dropInsertIndex = -1
  subtaskDragActive = false
  subtaskDragSourceId = null
  subtaskDragEl = null
  stopPointerTrack()
}
