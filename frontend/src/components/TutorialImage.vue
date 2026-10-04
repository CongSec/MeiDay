<script setup lang="ts">
/**
 * TutorialImage — 教程图片（点击放大查看）
 * 点击图片弹出全屏 Lightbox：
 *  - 点击遮罩 / 按 Esc / 点右上角 ✕ 关闭；
 *  - 手机：双指缩放、单指拖动平移、双击切换 1x / 2x；
 *  - 桌面：鼠标滚轮缩放、按住拖动平移，底部 +/-/重置 按钮。
 * 用 Teleport 到 body，避免被父级 overflow / z-index 截断。
 */
import { computed, onUnmounted, ref, watch } from 'vue'

defineOptions({ name: 'TutorialImage' })

const props = defineProps<{ src: string; alt: string }>()

const open = ref(false)
const scale = ref(1)
const tx = ref(0)
const ty = ref(0)
const dragging = ref(false)
const MIN_SCALE = 1
const MAX_SCALE = 4

function clampPan() {
  // 平移范围随缩放比例增大，避免把图片拖出屏幕太多
  const limit = (scale.value - 1) * 160
  tx.value = Math.max(-limit, Math.min(limit, tx.value))
  ty.value = Math.max(-limit, Math.min(limit, ty.value))
}
function resetView() {
  scale.value = 1
  tx.value = 0
  ty.value = 0
}
function zoomBy(delta: number) {
  scale.value = Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale.value + delta))
  clampPan()
}
function openPreview() {
  resetView()
  open.value = true
}
function close() {
  open.value = false
}

/* 按 Esc 关闭；打开期间锁定背景滚动 */
function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape') close()
}
watch(open, (v) => {
  if (v) {
    window.addEventListener('keydown', onKeydown)
    document.body.style.overflow = 'hidden'
  } else {
    window.removeEventListener('keydown', onKeydown)
    document.body.style.overflow = ''
  }
})
onUnmounted(() => {
  window.removeEventListener('keydown', onKeydown)
  document.body.style.overflow = ''
})

/* 指针交互：单指拖动平移 / 双指缩放 / 双击切换 */
const pointers = new Map<number, { x: number; y: number }>()
let pinchStartDist = 0
let pinchStartScale = 1
let panStart: { x: number; y: number; tx: number; ty: number } | null = null
let lastTapAt = 0

function onPointerDown(e: PointerEvent) {
  ;(e.currentTarget as HTMLElement | null)?.setPointerCapture?.(e.pointerId)
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY })
  if (pointers.size === 1) {
    panStart = { x: e.clientX, y: e.clientY, tx: tx.value, ty: ty.value }
    dragging.value = scale.value > 1
  } else if (pointers.size === 2) {
    panStart = null
    const [a, b] = [...pointers.values()]
    pinchStartDist = Math.hypot(a.x - b.x, a.y - b.y)
    pinchStartScale = scale.value
  }
}
function onPointerMove(e: PointerEvent) {
  if (!pointers.has(e.pointerId)) return
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY })
  if (pointers.size === 1 && panStart) {
    tx.value = panStart.tx + (e.clientX - panStart.x)
    ty.value = panStart.ty + (e.clientY - panStart.y)
  } else if (pointers.size === 2) {
    const [a, b] = [...pointers.values()]
    const dist = Math.hypot(a.x - b.x, a.y - b.y)
    if (pinchStartDist > 0) {
      scale.value = Math.min(MAX_SCALE, Math.max(MIN_SCALE, pinchStartScale * (dist / pinchStartDist)))
      clampPan()
    }
  }
}
function onPointerUp(e: PointerEvent) {
  if (pointers.size === 1 && panStart) {
    const moved = Math.hypot(e.clientX - panStart.x, e.clientY - panStart.y)
    if (moved < 8) {
      // 双击：放大 / 还原
      const now = Date.now()
      if (now - lastTapAt < 300) {
        if (scale.value > 1) resetView()
        else scale.value = 2
        lastTapAt = 0
      } else {
        lastTapAt = now
      }
    }
  }
  pointers.delete(e.pointerId)
  panStart = null
  dragging.value = false
  clampPan()
}
function onWheel(e: WheelEvent) {
  e.preventDefault()
  zoomBy(e.deltaY < 0 ? 0.25 : -0.25)
}

const imgStyle = computed(() => ({
  transform: `translate(${tx.value}px, ${ty.value}px) scale(${scale.value})`,
  transition: dragging.value ? 'none' : 'transform 0.15s ease-out',
}))
</script>

<template>
  <div>
    <img
      :src="props.src"
      :alt="props.alt"
      loading="lazy"
      class="rounded-lg border border-slate-200 w-full cursor-zoom-in"
      @click="openPreview"
    />

    <Teleport to="body">
      <div
        v-if="open"
        class="fixed inset-0 z-[80] bg-slate-900/85 backdrop-blur-sm flex items-center justify-center animate-fade-in"
        role="dialog"
        aria-modal="true"
        :aria-label="`${props.alt} 放大预览（点击遮罩或按 Esc 关闭）`"
        @click.self="close"
      >
        <img
          :src="props.src"
          :alt="props.alt"
          draggable="false"
          class="max-w-[90vw] max-h-[85vh] object-contain rounded-lg shadow-2xl select-none"
          style="touch-action: none"
          :style="imgStyle"
          @pointerdown.stop="onPointerDown"
          @pointermove.stop="onPointerMove"
          @pointerup.stop="onPointerUp"
          @pointercancel.stop="onPointerUp"
          @wheel.stop="onWheel"
          @contextmenu.prevent
        />

        <!-- 顶部提示 + 关闭 -->
        <div class="fixed top-0 inset-x-0 z-10 flex items-center justify-between px-4 py-3 pointer-events-none">
          <span class="text-xs text-white/75 select-none drop-shadow">
            滚轮 / 双指缩放 · 拖动平移 · Esc 关闭
          </span>
          <button
            type="button"
            class="pointer-events-auto p-2 rounded-lg bg-white/10 text-white hover:bg-white/25 active:bg-white/20"
            aria-label="关闭大图"
            @click.stop="close"
          >
            <svg viewBox="0 0 16 16" width="18" height="18" aria-hidden="true">
              <path d="M4 4l8 8M12 4l-8 8" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" />
            </svg>
          </button>
        </div>

        <!-- 底部缩放按钮 -->
        <div class="fixed bottom-4 inset-x-0 z-10 flex items-center justify-center gap-2">
          <button
            type="button"
            class="px-3 py-1.5 rounded-lg bg-white/10 text-white text-sm hover:bg-white/25 active:bg-white/20"
            aria-label="缩小"
            @click.stop="zoomBy(-0.5)"
          >−</button>
          <button
            type="button"
            class="px-3 py-1.5 rounded-lg bg-white/10 text-white text-sm hover:bg-white/25 active:bg-white/20"
            @click.stop="resetView"
          >重置</button>
          <button
            type="button"
            class="px-3 py-1.5 rounded-lg bg-white/10 text-white text-sm hover:bg-white/25 active:bg-white/20"
            aria-label="放大"
            @click.stop="zoomBy(0.5)"
          >＋</button>
        </div>
      </div>
    </Teleport>
  </div>
</template>
