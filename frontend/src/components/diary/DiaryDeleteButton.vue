<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import AppIcon from '@/components/AppIcon.vue'

const props = defineProps<{ position?: 'left' | 'right'; floating?: boolean }>()
const emit = defineEmits<{ confirm: [] }>()

/** 确认弹窗显隐；弹窗本体 Teleport 到 body（原因见模板注释） */
const open = ref(false)
/** 触发器与「取消」按钮：用于打开/关闭后正确归位焦点（危险操作默认焦点给取消） */
const triggerEl = ref<HTMLButtonElement | null>(null)
const cancelEl = ref<HTMLButtonElement | null>(null)

/** 触发器定位：消息气泡左侧（floating）/ 缩略图左上或右上，与原实现保持一致 */
const rootClass = computed(() => {
  if (props.floating) return 'absolute -left-9 top-1/2 -translate-y-1/2 z-20'
  return props.position === 'left' ? 'absolute top-1.5 left-1.5' : 'absolute top-1.5 right-1.5'
})

function closeDialog(): void {
  open.value = false
}

function onConfirm(): void {
  open.value = false
  emit('confirm')
}

/** Esc 关闭：用捕获阶段监听 document —— 弹窗这时在 body 上、焦点可能在弹窗或输入框里，
 *  只靠元素上的 @keydown 不可靠；捕获 + stopPropagation 保证 Esc 优先被本弹窗消费。 */
function onDocKeydown(e: KeyboardEvent): void {
  if (e.key !== 'Escape') return
  e.stopPropagation()
  closeDialog()
}

watch(open, async (isOpen) => {
  if (isOpen) {
    document.addEventListener('keydown', onDocKeydown, true)
    await nextTick()
    cancelEl.value?.focus()
  } else {
    document.removeEventListener('keydown', onDocKeydown, true)
    await nextTick()
    // 触发器是 v-if 重建的，等 DOM 更新完再归位焦点
    triggerEl.value?.focus()
  }
})

onBeforeUnmount(() => document.removeEventListener('keydown', onDocKeydown, true))
</script>

<template>
  <!-- 触发按钮：留在气泡/缩略图内（悬停显示），只负责打开确认弹窗 -->
  <div class="z-10" :class="rootClass">
    <button
      v-if="!open"
      ref="triggerEl"
      type="button"
      data-testid="diary-msg-delete"
      class="w-[22px] h-[22px] rounded-full bg-white border border-line shadow-card text-slate-400 hover:text-red-500 hover:border-red-200 hover:bg-red-50 flex items-center justify-center opacity-0 group-hover:opacity-100 focus-visible:opacity-100 pointer-events-none group-hover:pointer-events-auto focus-visible:pointer-events-auto transition btn-press"
      title="删除这条消息"
      @click.stop="open = true"
    >
      <AppIcon name="close" :size="11" />
    </button>
  </div>

  <!-- 确认弹窗：Teleport 到 body。
       原实现把它渲染在气泡内部，而 floating 触发器的祖先带 transform（-translate-y-1/2），
       按 CSS 规范它会成为 position:fixed 的包含块 → 全屏遮罩被压成气泡旁的一小块，
       同时被顶栏（z-[60]）等祖先的层叠顺序压住，各端（网页/安卓/桌面/思源插件 iframe）表现还不一致。
       传送到 body 后彻底摆脱 transform / overflow / z-index 的影响，四处表现统一。 -->
  <Teleport to="body">
    <div
      v-if="open"
      class="fixed inset-0 z-[70] bg-slate-900/55 backdrop-blur-sm flex items-center justify-center px-4 py-6 animate-fade-in"
      role="dialog"
      aria-modal="true"
      aria-label="删除这条消息？"
      @click.self="closeDialog"
    >
      <div
        class="modal-panel rounded-2xl w-full max-w-xs sm:max-w-sm p-5 animate-modal-pop"
        data-testid="diary-msg-delete-dialog"
      >
        <div class="flex items-start gap-3">
          <span class="shrink-0 w-9 h-9 rounded-full bg-red-50 text-red-500 flex items-center justify-center">
            <AppIcon name="trash" :size="17" />
          </span>
          <div class="min-w-0">
            <p class="text-[15px] font-semibold text-slate-800">删除这条消息？</p>
            <p class="mt-1 text-xs leading-relaxed text-slate-500">删除后将从云端永久移除，无法恢复。</p>
          </div>
        </div>
        <div class="mt-5 grid grid-cols-2 gap-2.5">
          <button
            ref="cancelEl"
            type="button"
            class="h-10 rounded-xl text-sm font-medium text-slate-600 bg-slate-100 hover:bg-slate-200 btn-press focus:outline-none focus-visible:ring-2 focus-visible:ring-brand/40"
            @click="closeDialog"
          >
            取消
          </button>
          <button
            type="button"
            data-testid="diary-msg-delete-confirm"
            class="h-10 rounded-xl text-sm font-medium text-white bg-red-500 hover:bg-red-600 shadow-sm btn-press focus:outline-none focus-visible:ring-2 focus-visible:ring-red-300"
            @click="onConfirm"
          >
            删除
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>
