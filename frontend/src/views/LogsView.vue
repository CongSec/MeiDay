<script setup lang="ts">
import { computed, inject, onMounted, onUnmounted, ref, watch } from 'vue'
import { api, type AuditLog } from '@/api/client'
import ConfirmDialog from '@/components/ConfirmDialog.vue'

const mobileActions = inject<{ title: string } | null>('mobile-actions', null)

const items = ref<AuditLog[]>([])
const total = ref(0)
const loading = ref(false)
const actions = ref<{ action: string; count: number }[]>([])
const ips = ref<{ ip: string; count: number }[]>([])

const action = ref('')
const ip = ref('')
/** 高危筛选：''=全部，'1'=仅高危，'0'=仅非高危 */
const highRisk = ref<'' | '0' | '1'>('')
const limit = ref(100)
const offset = ref(0)
const autoRefresh = ref(false)
const retentionDays = ref(30)
const savingRetention = ref(false)
const cleaning = ref(false)
const clearAllOpen = ref(false)
const cleanMsg = ref('')

let timer: number | undefined

const page = computed(() => (limit.value ? Math.floor(offset.value / limit.value) : 0))
const pageCount = computed(() => (limit.value ? Math.max(1, Math.ceil(total.value / limit.value)) : 1))

function statusClass(s: number | null): string {
  if (s === null) return 'bg-slate-100 text-slate-500'
  if (s < 300) return 'bg-emerald-50 text-emerald-600'
  if (s < 400) return 'bg-amber-50 text-amber-600'
  return 'bg-red-50 text-red-600'
}

function fmtTime(t: string): string {
  return t ? t.replace('T', ' ').slice(0, 19) : '-'
}

async function load() {
  loading.value = true
  try {
    const r = await api.getLogs({
      action: action.value,
      ip: ip.value,
      highRisk: highRisk.value,
      limit: limit.value,
      offset: offset.value,
    })
    items.value = r.items
    total.value = r.total
  } finally {
    loading.value = false
  }
  // 同步刷新“全部行为 / IP”下拉计数，避免清空/刷新后括号里的数字对不上
  await Promise.all([refreshActions(), refreshIps()])
}

async function refreshActions() {
  try {
    const r = await api.getLogActions()
    actions.value = r.items
  } catch {
    /* ignore */
  }
}

async function refreshIps() {
  try {
    const r = await api.getLogIps()
    ips.value = r.items
  } catch {
    /* ignore */
  }
}

async function loadRetention() {
  try {
    const r = await api.getLogRetention()
    retentionDays.value = r.days
  } catch {
    /* ignore */
  }
}

async function saveRetention() {
  if (savingRetention.value) return
  savingRetention.value = true
  try {
    const days = Math.max(1, Math.min(365, Math.floor(Number(retentionDays.value) || 30)))
    retentionDays.value = days
    await api.setLogRetention(days)
    cleanMsg.value = `日志保留天数已调整为 ${days} 天（自动清理按此保留）`
    await load()
  } finally {
    savingRetention.value = false
  }
}

async function confirmClearAll() {
  clearAllOpen.value = false
  if (cleaning.value) return
  cleaning.value = true
  try {
    const r = await api.deleteAllLogs()
    cleanMsg.value = `已清空自己的日志（${r.deleted} 条）`
    await load()
  } finally {
    cleaning.value = false
  }
}

function applyFilter() {
  offset.value = 0
  void load()
}

function gotoPage(p: number) {
  if (p < 0 || p >= pageCount.value) return
  offset.value = p * limit.value
  void load()
}

function nextPage() {
  gotoPage(page.value + 1)
}

function prevPage() {
  gotoPage(page.value - 1)
}

watch(autoRefresh, (on) => {
  if (timer) {
    window.clearInterval(timer)
    timer = undefined
  }
  if (on) timer = window.setInterval(() => void load(), 5000)
})

onMounted(async () => {
  if (mobileActions) mobileActions.title = '操作日志'
  void loadRetention()
  await load()
})

onUnmounted(() => {
  if (timer) window.clearInterval(timer)
  if (mobileActions && mobileActions.title === '操作日志') mobileActions.title = ''
})
</script>

<template>
  <div class="p-4 sm:p-6 max-w-5xl mx-auto">
    <div class="flex items-center justify-between">
      <div>
        <h1 class="hidden lg:block text-xl font-bold text-slate-800">📋 操作日志</h1>
        <div class="text-xs text-slate-400 mt-0.5">
          记录所有用户操作与邮件行为（时间 / 用户 / IP / 行为 / 状态）
        </div>
      </div>
      <div class="flex items-center gap-2">
        <label class="flex items-center gap-1.5 text-xs text-slate-500 select-none cursor-pointer">
          <input type="checkbox" v-model="autoRefresh" class="accent-brand" />
          自动刷新(5s)
        </label>
        <button
          class="px-3 py-2 rounded-lg bg-brand text-white text-sm font-medium hover:bg-brand-dark"
          :disabled="loading"
          @click="load"
        >
          {{ loading ? '加载中…' : '刷新' }}
        </button>
      </div>
    </div>

    <div class="mt-4 grid gap-3 md:grid-cols-2">
      <div class="bg-white rounded-xl shadow-sm border border-slate-100 p-4">
        <div class="text-xs text-slate-500 mb-1">日志保留天数（自动清理按此保留）</div>
        <div class="flex gap-2">
          <input
            v-model.number="retentionDays"
            type="number"
            min="1"
            max="365"
            class="flex-1 w-24 border rounded-lg px-2.5 py-1.5 text-sm outline-none focus:ring-2 focus:ring-brand/50"
          />
          <button
            class="px-3 py-1.5 rounded-lg text-xs text-white bg-brand hover:bg-brand-dark disabled:opacity-60"
            :disabled="savingRetention"
            @click="saveRetention"
          >
            {{ savingRetention ? '保存中…' : '保存' }}
          </button>
        </div>
        <div class="mt-1 text-[11px] text-slate-400">默认 30 天（1-365），后台每 6 小时自动清理过期日志，清理前先归档备份</div>
      </div>
      <div class="bg-white rounded-xl shadow-sm border border-slate-100 p-4">
        <div class="text-xs text-slate-500 mb-1">清空我的日志记录</div>
        <button
          class="px-3 py-1.5 rounded-lg text-xs text-red-500 border border-red-200 hover:bg-red-50 disabled:opacity-60"
          :disabled="cleaning"
          @click="clearAllOpen = true"
        >
          {{ cleaning ? '操作中…' : '🗑 清空我的日志' }}
        </button>
        <div class="mt-1 text-[11px] text-slate-400">仅清空当前登录账号自己的日志，不影响其他用户；清空前的记录会归档备份</div>
      </div>
    </div>
    <div v-if="cleanMsg" class="mt-3 text-sm text-slate-600 bg-slate-50 border border-slate-100 rounded-lg px-3 py-2">{{ cleanMsg }}</div>

    <div class="mt-4 flex flex-wrap items-end gap-2">
      <div>
        <label class="text-[11px] text-slate-400 block mb-1">行为</label>
        <select v-model="action" class="w-48 border rounded-lg px-2.5 py-1.5 text-sm bg-white" @change="applyFilter">
          <option value="">全部行为</option>
          <option v-for="a in actions" :key="a.action" :value="a.action">
            {{ a.action }}（{{ a.count }}）
          </option>
        </select>
      </div>
      <div>
        <label class="text-[11px] text-slate-400 block mb-1">IP</label>
        <select v-model="ip" class="w-44 border rounded-lg px-2.5 py-1.5 text-sm bg-white" @change="applyFilter">
          <option value="">全部IP</option>
          <option v-for="i in ips" :key="i.ip" :value="i.ip">
            {{ i.ip }}（{{ i.count }}）
          </option>
        </select>
      </div>
      <div>
        <label class="text-[11px] text-slate-400 block mb-1">高危</label>
        <select
          v-model="highRisk"
          class="w-28 border rounded-lg px-2.5 py-1.5 text-sm bg-white"
          @change="applyFilter"
        >
          <option value="">全部</option>
          <option value="1">🚨 仅高危</option>
          <option value="0">仅非高危</option>
        </select>
      </div>
      <div>
        <label class="text-[11px] text-slate-400 block mb-1">每页</label>
        <select v-model="limit" class="w-24 border rounded-lg px-2.5 py-1.5 text-sm bg-white" @change="applyFilter">
          <option :value="50">50</option>
          <option :value="100">100</option>
          <option :value="200">200</option>
          <option :value="500">500</option>
        </select>
      </div>
      <button
        class="px-3 py-1.5 rounded-lg border border-slate-200 text-sm text-slate-600 hover:bg-slate-50"
        @click="applyFilter"
      >
        筛选
      </button>
    </div>

    <div class="mt-4 bg-white rounded-xl shadow-sm border border-slate-100 overflow-hidden">
      <table class="w-full text-sm">
        <thead>
          <tr class="text-left text-[11px] text-slate-400 border-b border-slate-100 bg-slate-50/60">
            <th class="px-3 py-2 font-medium whitespace-nowrap">时间</th>
            <th class="px-3 py-2 font-medium">用户</th>
            <th class="px-3 py-2 font-medium">行为</th>
            <th class="px-3 py-2 font-medium hidden md:table-cell">方式</th>
            <th class="px-3 py-2 font-medium hidden md:table-cell">路径</th>
            <th class="px-3 py-2 font-medium">状态</th>
            <th class="px-3 py-2 font-medium hidden sm:table-cell">IP</th>
            <th class="px-3 py-2 font-medium hidden lg:table-cell">耗时</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="log in items" :key="log.id" class="border-b border-slate-50 align-top">
            <td class="px-3 py-2 text-xs text-slate-500 whitespace-nowrap">{{ fmtTime(log.created_at) }}</td>
            <td class="px-3 py-2 text-xs font-medium text-slate-700">{{ log.username || '-' }}</td>
            <td class="px-3 py-2 text-xs text-slate-700">
              <div class="flex items-center gap-1.5">
                <span
                  v-if="log.is_high_risk === 1"
                  class="inline-block px-1.5 py-0.5 rounded text-[11px] font-bold bg-red-600 text-white border border-red-700 shrink-0"
                >🚨 高危</span>
                <span
                  v-else-if="log.is_security === 1"
                  class="inline-block px-1.5 py-0.5 rounded text-[11px] font-bold bg-red-50 text-red-500 border border-red-200 shrink-0"
                >🚨 安全</span>
                <span>{{ log.action }}</span>
              </div>
              <div v-if="log.detail" class="mt-0.5 text-[11px] text-slate-400 break-all">{{ log.detail }}</div>
            </td>
            <td class="px-3 py-2 text-xs text-slate-400 hidden md:table-cell">{{ log.method || '-' }}</td>
            <td class="px-3 py-2 text-xs text-slate-400 break-all hidden md:table-cell">{{ log.path || '-' }}</td>
            <td class="px-3 py-2">
              <span
                class="inline-block px-1.5 py-0.5 rounded text-[11px] font-medium"
                :class="statusClass(log.status)"
              >
                {{ log.status ?? '-' }}
              </span>
            </td>
            <td class="px-3 py-2 text-xs text-slate-400 hidden sm:table-cell">{{ log.ip || '-' }}</td>
            <td class="px-3 py-2 text-xs text-slate-400 hidden lg:table-cell">
              {{ log.duration_ms !== null ? `${log.duration_ms}ms` : '-' }}
            </td>
          </tr>
          <tr v-if="!loading && !items.length">
            <td colspan="8" class="px-3 py-12 text-center text-sm text-slate-400">暂无日志记录</td>
          </tr>
        </tbody>
      </table>
    </div>

    <div class="mt-3 flex items-center justify-between text-xs text-slate-400">
      <span>共 {{ total }} 条</span>
      <div class="flex items-center gap-1">
        <button
          class="px-2.5 py-1 rounded border border-slate-200 hover:bg-slate-50 disabled:opacity-40"
          :disabled="page === 0"
          @click="prevPage"
        >
          上一页
        </button>
        <span class="px-2">{{ page + 1 }} / {{ pageCount }}</span>
        <button
          class="px-2.5 py-1 rounded border border-slate-200 hover:bg-slate-50 disabled:opacity-40"
          :disabled="page + 1 >= pageCount"
          @click="nextPage"
        >
          下一页
        </button>
      </div>
    </div>

    <ConfirmDialog
      :open="clearAllOpen"
      title="清空我的日志"
      message="将删除你当前账号的全部操作日志记录（不影响其他用户），删除前会自动归档备份。确定继续吗？"
      confirm-text="清空"
      :danger="true"
      @confirm="confirmClearAll"
      @cancel="clearAllOpen = false"
    />
  </div>
</template>
