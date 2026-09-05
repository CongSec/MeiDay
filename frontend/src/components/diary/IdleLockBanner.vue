<template>
  <div
    v-if="idleLockWarningMs !== null"
    class="fixed top-4 left-1/2 -translate-x-1/2 z-[60] flex items-center gap-3 rounded-full bg-slate-900/95 text-white text-sm px-4 py-2 shadow-xl"
  >
    <span class="inline-block w-2 h-2 rounded-full bg-amber-400 animate-pulse" />
    <span>
      距自动锁定还有 <b class="text-amber-300">{{ formatLockRemain(idleLockRemainingMs) }}</b>，之后将清空隐私数据
    </span>
    <button
      class="ml-1 rounded-full bg-brand px-3 py-1 text-xs font-medium text-white hover:bg-brand-dark"
      @click="keepIdleLockAlive()"
    >
      继续使用
    </button>
  </div>
</template>

<script setup lang="ts">
import { idleLockWarningMs, idleLockRemainingMs, keepIdleLockAlive, formatLockRemain } from '@/composables/useIdleLock'
</script>
