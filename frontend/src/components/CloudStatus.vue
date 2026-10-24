<script setup lang="ts">
/**
 * CloudStatus — 云朵连接状态按钮（替代原「同步刷新」图标按钮）。
 *
 * 状态语义（持续状态，非瞬时）：
 * - 初始（尚无任何服务器请求结果）: 空白云朵,中性不表态；
 * - ok:   最近一次对中心服务器的请求拿到了响应（任意状态码,含 4xx/5xx/401）→ 云朵内勾号；
 * - fail: 最近一次请求网络层失败（超时/断连/拒绝）→ 云朵内感叹号（持续显示直到恢复）;
 * - 手动点击同步进行中: 云朵内标记变为转圈,同步完成后按结果落到勾/叹。
 *
 * 状态由全局 serverStatus（utils/serverStatus.ts）驱动,任何对中心服务器的请求都会更新它,
 * 因此本组件在三处（移动端顶部/今日页桌面/项目页桌面）共享同一状态,显示一致。
 * 点击 = 手动同步（syncNow,纯 OSS 操作）。
 */
import { computed } from 'vue'
import AppIcon from '@/components/AppIcon.vue'
import { serverStatus } from '@/utils/serverStatus'
import { useSync } from '@/composables/useSync'

const { syncing, syncNow } = useSync()

const statusClass = computed(() => {
  if (serverStatus.value === 'fail') return 'text-red-500'
  if (serverStatus.value === 'ok') return 'text-emerald-600'
  return 'text-slate-500 hover:bg-slate-100 active:bg-slate-200'
})

const title = computed(() => {
  if (syncing.value) return '同步中…'
  if (serverStatus.value === 'fail') return '服务器连接失败（正在自动重试）'
  if (serverStatus.value === 'ok') return '服务器连接正常'
  return '同步刷新'
})

function onClick() {
  if (syncing.value) return
  void syncNow()
}
</script>

<template>
  <button
    class="relative flex h-9 w-9 items-center justify-center rounded-lg transition disabled:opacity-60"
    :class="statusClass"
    :title="title"
    :disabled="syncing"
    @click="onClick"
  >
    <!-- 云朵轮廓 -->
    <svg
      class="h-[18px] w-[18px] shrink-0"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="1.5"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z" />
    </svg>
    <!-- 云朵内标记：居中叠放，稍偏下贴合云朵主体 -->
    <span class="pointer-events-none absolute left-1/2 top-[57%] -translate-x-1/2 -translate-y-1/2">
      <AppIcon v-if="syncing" name="refresh" :size="11" :stroke-width="2" class="animate-spin" />
      <AppIcon v-else-if="serverStatus === 'fail'" name="alert" :size="11" :stroke-width="2" />
      <AppIcon v-else-if="serverStatus === 'ok'" name="check" :size="12" :stroke-width="2.5" />
    </span>
  </button>
</template>
