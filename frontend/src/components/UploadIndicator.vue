<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue'
import {
  getGlobalUploadInfo,
  subscribeGlobal,
  type GlobalUploadInfo,
} from '@/utils/backgroundUpload'

const info = ref<GlobalUploadInfo>(getGlobalUploadInfo())
let unsub: (() => void) | null = null

onMounted(() => {
  unsub = subscribeGlobal((i) => {
    info.value = i
  })
})
onUnmounted(() => {
  unsub?.()
  unsub = null
})
</script>

<template>
  <Transition
    enter-active-class="transition duration-200 ease-out"
    enter-from-class="opacity-0 translate-y-2"
    leave-active-class="transition duration-150 ease-in"
    leave-to-class="opacity-0 translate-y-2"
  >
    <div
      v-if="info.active > 0"
      class="fixed bottom-4 left-1/2 -translate-x-1/2 sm:left-auto sm:right-4 sm:translate-x-0 z-[70] flex items-center gap-2.5 rounded-full bg-slate-800/95 text-white pl-3.5 pr-4 py-2.5 shadow-xl text-sm backdrop-blur"
      role="status"
    >
      <span
        class="w-4 h-4 rounded-full border-2 border-white/30 border-t-white animate-spin shrink-0"
        aria-hidden="true"
      />
      <div class="leading-tight">
        <div class="font-medium">附件后台上传中…</div>
        <div class="text-[11px] text-white/70 mt-0.5">
          <template v-if="info.currentName">正在上传：{{ info.currentName }}　</template>
          剩余 {{ info.active }} 个
        </div>
      </div>
    </div>
  </Transition>
</template>
