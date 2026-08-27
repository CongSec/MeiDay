<template>
  <div
    class="diary-del-root z-10"
    :class="
      floating
        ? 'absolute -left-9 top-1/2 -translate-y-1/2 z-20'
        : position === 'left'
          ? 'absolute top-1.5 left-1.5'
          : 'absolute top-1.5 right-1.5'
    "
  >
    <button
      v-if="!open"
      class="w-[22px] h-[22px] rounded-full bg-white border border-slate-200 shadow-md text-slate-400 hover:text-red-500 hover:border-red-200 hover:bg-red-50 flex items-center justify-center text-[13px] leading-none opacity-0 group-hover:opacity-100 pointer-events-none group-hover:pointer-events-auto transition"
      title="删除这条消息"
      @click.stop="open = true"
    >×</button>

    <div v-if="open" class="fixed inset-0 z-[60] flex items-center justify-center bg-slate-900/30 px-4" @click.stop>
      <div class="diary-del-root rounded-2xl bg-white shadow-2xl p-4 w-64">
        <p class="text-sm text-slate-700 text-center">删除这条消息？</p>
        <p class="mt-0.5 text-[11px] text-slate-400 text-center">删除后将从云端永久移除</p>
        <div class="mt-3 grid grid-cols-2 gap-2">
          <button class="py-2 rounded-lg text-sm text-slate-600 bg-slate-100 hover:bg-slate-200" @click="open = false">取消</button>
          <button class="py-2 rounded-lg text-sm text-white bg-red-500 hover:bg-red-600 font-medium" data-testid="diary-msg-delete-confirm" @click="onConfirm">删除</button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'

const props = defineProps<{ position?: 'left' | 'right'; floating?: boolean }>()
const emit = defineEmits<{ confirm: [] }>()
const open = ref(false)

function onConfirm(): void {
  open.value = false
  emit('confirm')
}

/** 点击弹层外部任意处关闭确认框 */
function onDocPointerDown(e: Event): void {
  const target = e.target as HTMLElement
  if (!target.closest('.diary-del-root')) open.value = false
}

onMounted(() => document.addEventListener('pointerdown', onDocPointerDown))
onBeforeUnmount(() => document.removeEventListener('pointerdown', onDocPointerDown))
</script>
