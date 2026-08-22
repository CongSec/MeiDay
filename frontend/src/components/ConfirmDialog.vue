<script setup lang="ts">
withDefaults(
  defineProps<{
    open: boolean
    title: string
    message: string
    confirmText?: string
    danger?: boolean
  }>(),
  { confirmText: '确认', danger: false },
)
const emit = defineEmits<{ confirm: []; cancel: [] }>()
</script>

<template>
  <div
    v-if="open"
    class="fixed inset-0 z-50 bg-slate-900/50 flex items-center justify-center px-4"
  >
    <div class="bg-white rounded-xl shadow-xl p-6 w-full max-w-sm">
      <div class="text-base font-semibold">{{ title }}</div>
      <div class="mt-2 text-sm text-slate-600 whitespace-pre-wrap">{{ message }}</div>
      <div class="mt-5 flex justify-end gap-2">
        <button
          class="px-4 py-2 rounded-lg text-sm text-slate-600 hover:bg-slate-100"
          @click="emit('cancel')"
        >
          取消
        </button>
        <button
          class="px-4 py-2 rounded-lg text-sm text-white font-medium"
          :class="danger ? 'bg-red-500 hover:bg-red-600' : 'bg-brand hover:bg-brand-dark'"
          @click="emit('confirm')"
        >
          {{ confirmText }}
        </button>
      </div>
    </div>
  </div>
</template>
