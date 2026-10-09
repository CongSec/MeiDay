<script setup lang="ts">
import AppIcon from '@/components/AppIcon.vue'

defineProps<{
  title: string
  content: string
}>()
const emit = defineEmits<{ read: [] }>()
</script>

<template>
  <div class="fixed inset-0 z-50 bg-slate-900/55 backdrop-blur-sm flex items-center justify-center px-4">
    <div class="modal-panel rounded-2xl p-6 w-full max-w-md animate-modal-pop">
      <div class="flex items-start gap-2">
        <span class="w-9 h-9 rounded-full bg-brand/10 text-brand flex items-center justify-center shrink-0">
          <AppIcon name="megaphone" :size="20" />
        </span>
        <div class="flex-1 min-w-0">
          <div class="text-base font-semibold break-words">{{ title }}</div>
          <div class="mt-1 text-xs text-slate-400">MeiDay 公告</div>
        </div>
      </div>
      <!-- 纯文本正文：保留换行，不做 Markdown 渲染 -->
      <div class="mt-3 max-h-72 overflow-y-auto rounded-lg border border-slate-100 bg-slate-50 p-3 text-sm text-slate-700 whitespace-pre-wrap break-words">
        {{ content }}
      </div>
      <div class="mt-5 flex justify-end">
        <button
          class="px-6 py-2 rounded-lg text-sm text-white bg-brand hover:bg-brand-dark font-medium"
          @click="emit('read')"
        >
          知道了
        </button>
      </div>
    </div>
  </div>
</template>
