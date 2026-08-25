<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { api, type CaptchaResult } from '@/api/client'

const props = defineProps<{
  /** 提交中/已提交：禁止再点格子 */
  disabled?: boolean
}>()

const emit = defineEmits<{
  /** 验证码或选中格子变化时上报 { id, answer }；未加载成功时 id 为 null */
  (e: 'change', value: { id: string | null; answer: number[] }): void
}>()

const GRID = 3

const captcha = ref<CaptchaResult | null>(null)
const loading = ref(false)
const error = ref('')
const selected = ref<Set<number>>(new Set())

const selectedList = computed(() => [...selected.value].sort((a, b) => a - b))

function cellStyle(i: number) {
  const size = 100 / GRID
  return {
    left: `${(i % GRID) * size}%`,
    top: `${Math.floor(i / GRID) * size}%`,
    width: `${size}%`,
    height: `${size}%`,
  }
}

function cellClass(i: number) {
  return selected.value.has(i)
    ? 'bg-brand/25 ring-2 ring-brand'
    : 'hover:bg-black/5 active:bg-black/10'
}

function toggle(i: number) {
  if (props.disabled || !captcha.value) return
  const next = new Set(selected.value)
  if (next.has(i)) next.delete(i)
  else next.add(i)
  selected.value = next
  emitChange()
}

function emitChange() {
  emit('change', {
    id: captcha.value?.id ?? null,
    answer: selectedList.value,
  })
}

async function load() {
  if (loading.value) return
  loading.value = true
  error.value = ''
  try {
    captcha.value = await api.getCaptcha()
    selected.value = new Set()
    emitChange()
  } catch (e) {
    captcha.value = null
    error.value = (e as Error).message || '验证码获取失败，请稍后重试'
    emitChange()
  } finally {
    loading.value = false
  }
}

onMounted(load)
</script>

<template>
  <div class="space-y-2">
    <div class="flex items-start gap-3">
      <div
        class="relative select-none overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm"
        :class="disabled ? 'pointer-events-none opacity-60' : ''"
      >
        <img
          v-if="captcha"
          :src="captcha.image"
          :alt="`请点击所有 ${captcha.target}`"
          class="block w-40 h-40"
          draggable="false"
        />
        <template v-if="captcha">
          <button
            v-for="i in GRID * GRID"
            :key="i"
            type="button"
            class="absolute rounded-sm transition"
            :class="cellClass(i - 1)"
            :style="cellStyle(i - 1)"
            :aria-label="`第 ${i} 格`"
            :aria-pressed="selected.has(i - 1)"
            @click="toggle(i - 1)"
          ></button>
        </template>
        <div
          v-else
          class="w-40 h-40 flex items-center justify-center text-xs text-slate-400"
        >
          {{ loading ? '加载中…' : '加载失败' }}
        </div>
      </div>
      <button
        type="button"
        class="shrink-0 text-xs text-brand hover:text-brand-dark disabled:opacity-60 transition"
        :disabled="loading || disabled"
        @click="load"
      >
        {{ loading ? '加载中…' : '换一张' }}
      </button>
    </div>
    <p v-if="captcha" class="text-xs text-slate-500 leading-relaxed">
      请点击所有
      <b class="text-base align-middle px-0.5">{{ captcha.target }}</b>
      ，点中的格子会高亮，然后点「注册」
    </p>
    <p v-else-if="error" class="text-xs text-red-500 leading-relaxed">
      {{ error }}
      <button
        type="button"
        class="underline underline-offset-2 disabled:opacity-60"
        :disabled="loading"
        @click="load"
      >
        点击重试
      </button>
    </p>
  </div>
</template>
