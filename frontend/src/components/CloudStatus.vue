<script setup lang="ts">
/**
 * CloudStatus — 云朵连接状态按钮（替代原「同步刷新」图标按钮）。
 *
 * 状态语义（方案 B：瞬时反馈,严格反映最近一次可达性探测的结果）：
 * - 初始（尚无任何服务器请求结果）: 空白云朵,中性不表态；
 * - ok:   最近一次请求服务器应答了（2xx/3xx/4xx,含 401——服务器活着）→ 云朵内勾号；
 * - fail: 最近一次请求网络层失败（超时/断连/拒绝）,或返回 5xx（含前置代理/网关在
 *         后端死掉时返回的 502/503/504）→ 云朵内感叹号；
 * - 手动点击同步进行中: 云朵内标记变为转圈,完成后回到最近一次请求结果。
 *
 * 优化（保持 B 的「最近结果」语义,降低噪音）：
 * 1. 轮询周期内只由主探测请求（getSyncState）定状态,待发上报等请求 silent 不驱动,
 *    一个周期至多翻转一次,不会在 2 秒内来回闪；手动操作（登录/解锁/登出等）仍即时驱动；
 * 2. getSyncState 用 5s 短超时,半死服务器下更快变叹、更快进退避（业务请求仍 10s）;
 * 3. 勾/叹/转圈切换带淡入淡出过渡,视觉不硬切。
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
  if (serverStatus.value === 'fail') return '服务器连接失败，正在自动重试；点击可手动同步'
  if (serverStatus.value === 'ok') return '服务器连接正常；点击可手动同步'
  return '同步刷新'
})

function onClick() {
  if (syncing.value) return
  void syncNow()
}
</script>

<style scoped>
/* 勾/叹/转圈切换：淡入淡出 + 轻微缩放，避免图标硬切（B 语义下状态随最近请求变化，切换需平滑） */
.cloud-swap-enter-active,
.cloud-swap-leave-active {
  transition: opacity 0.16s ease, transform 0.16s ease;
}
.cloud-swap-enter-from {
  opacity: 0;
  transform: scale(0.6);
}
.cloud-swap-leave-to {
  opacity: 0;
  transform: scale(0.6);
}
</style>

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
    <!-- 云朵内标记：居中叠放，稍偏下贴合云朵主体；状态切换时淡入淡出 -->
    <span class="pointer-events-none absolute left-1/2 top-[57%] -translate-x-1/2 -translate-y-1/2">
      <Transition name="cloud-swap" mode="out-in">
        <AppIcon v-if="syncing" key="syncing" name="refresh" :size="11" :stroke-width="2" class="animate-spin" />
        <AppIcon v-else-if="serverStatus === 'fail'" key="fail" name="alert" :size="11" :stroke-width="2" />
        <AppIcon v-else-if="serverStatus === 'ok'" key="ok" name="check" :size="12" :stroke-width="2.5" />
        <span v-else key="empty" class="block" />
      </Transition>
    </span>
  </button>
</template>
