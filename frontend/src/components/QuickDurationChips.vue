<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { api } from '@/api/client'
import { useUiStore } from '@/stores/ui'

/**
 * 提醒时间「快捷时长」小标签组：
 * - 点击某个时长 → 按「点击时刻的当前时间 + 时长」算出提醒时间并 emit apply；
 * - 每条可删除（×），行尾「＋添加」可自定义时长（分钟/小时）；
 * - 列表按账号存服务器（settings 表），多端同步。
 * 挂在提醒时间输入框下方；mode 决定算出的值填完整 datetime 还是仅时分（重复任务）。
 */
const props = defineProps<{
  /** 输出格式：'datetime' 填 YYYY-MM-DDTHH:MM（普通任务/子任务）；'time' 只填 HH:MM（重复任务） */
  mode: 'datetime' | 'time'
}>()
const emit = defineEmits<{
  /** 点击快捷时长后算出的提醒时间（已按当前时刻 + 时长计算、按分钟取整） */
  apply: [value: string]
}>()

const ui = useUiStore()

/** 服务器未设置时的内置默认清单（与后端 DEFAULT_QUICK_DURATIONS 一致） */
const DEFAULT_DURATIONS = [10, 30, 60]
const MAX_DURATIONS = 10
/** 快捷时长上限：24 小时（分钟） */
const MAX_MINUTES = 1440

const durations = ref<number[]>([])
const adding = ref(false)
const addValue = ref('')
const addUnit = ref<'min' | 'hour'>('min')
const addErr = ref('')
const saving = ref(false)

onMounted(() => {
  void load()
})

/** 拉取当前账号的快捷时长；接口异常（老版本后端/网络问题）静默回退内置默认，不阻塞新建任务 */
async function load() {
  try {
    const res = await api.getQuickDurations()
    durations.value = Array.isArray(res.durations) ? res.durations : []
  } catch {
    durations.value = [...DEFAULT_DURATIONS]
  }
}

const pad = (n: number) => String(n).padStart(2, '0')

/** 当前时刻 + N 分钟，按分钟取整（去秒），再按 mode 格式化 */
function fmtApplied(mins: number): string {
  const t = new Date(Date.now() + mins * 60_000)
  t.setSeconds(0, 0)
  const hm = `${pad(t.getHours())}:${pad(t.getMinutes())}`
  if (props.mode === 'time') return hm
  return `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())}T${hm}`
}

/** 标签文案：<60 分钟显示「N分」；整小时显示「N小时」；否则「N小时M分」 */
function label(mins: number): string {
  if (mins < 60) return `${mins}分`
  if (mins % 60 === 0) return `${mins / 60}小时`
  return `${Math.floor(mins / 60)}小时${mins % 60}分`
}

function applyDuration(mins: number) {
  emit('apply', fmtApplied(mins))
}

async function removeDuration(mins: number) {
  if (saving.value) return
  const next = durations.value.filter((m) => m !== mins)
  saving.value = true
  try {
    await api.setQuickDurations(next)
    durations.value = next
  } catch {
    ui.toast('快捷时长删除失败，请重试', 'error')
  } finally {
    saving.value = false
  }
}

function openAdd() {
  adding.value = true
  addValue.value = ''
  addUnit.value = 'min'
  addErr.value = ''
}

function cancelAdd() {
  adding.value = false
  addErr.value = ''
}

async function confirmAdd() {
  if (saving.value) return
  const raw = Number(addValue.value)
  if (!addValue.value.trim() || !Number.isInteger(raw) || raw <= 0) {
    addErr.value = '请输入大于 0 的整数'
    return
  }
  const mins = addUnit.value === 'hour' ? raw * 60 : raw
  if (mins < 1 || mins > MAX_MINUTES) {
    addErr.value = '时长需在 1 分钟 ~ 24 小时之间'
    return
  }
  if (durations.value.includes(mins)) {
    addErr.value = '该时长已存在'
    return
  }
  if (durations.value.length >= MAX_DURATIONS) {
    addErr.value = `最多 ${MAX_DURATIONS} 条快捷时长`
    return
  }
  const next = [...durations.value, mins].sort((a, b) => a - b)
  saving.value = true
  try {
    await api.setQuickDurations(next)
    durations.value = next
    adding.value = false
    addErr.value = ''
  } catch {
    ui.toast('快捷时长保存失败，请重试', 'error')
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <div class="mt-1">
    <div class="flex flex-wrap items-center gap-1">
      <!-- 快捷时长标签：点击即按「当前时刻 + 时长」填入提醒时间；× 删除（触屏也可点，无需 hover） -->
      <button
        v-for="m in durations"
        :key="m"
        type="button"
        class="group inline-flex items-center gap-0.5 rounded-full border border-slate-200 bg-slate-50 px-2 py-0.5 text-[11px] leading-4 text-slate-600 hover:border-brand/40 hover:text-brand disabled:opacity-50"
        :disabled="saving"
        :title="`提醒时间设为 ${label(m)}后（当前时刻 + ${label(m)}）`"
        @click="applyDuration(m)"
      >
        {{ label(m) }}
        <span
          class="inline-flex h-3.5 w-3.5 items-center justify-center rounded-full text-slate-400 hover:bg-red-100 hover:text-red-500"
          title="删除该快捷时长"
          @click.stop="removeDuration(m)"
        >×</span>
      </button>

      <!-- ＋添加 / 添加表单 -->
      <div v-if="adding" class="inline-flex items-center gap-1">
        <input
          v-model="addValue"
          type="number"
          min="1"
          max="1440"
          placeholder="时长"
          class="w-16 border rounded-md px-1.5 py-0.5 text-[11px] outline-none focus:ring-2 focus:ring-brand/50"
          @keydown.enter.prevent="confirmAdd"
        />
        <select v-model="addUnit" class="border rounded-md px-1 py-0.5 text-[11px] bg-white">
          <option value="min">分钟</option>
          <option value="hour">小时</option>
        </select>
        <button
          type="button"
          class="text-[11px] text-brand font-medium hover:underline disabled:opacity-50"
          :disabled="saving"
          @click="confirmAdd"
        >确定</button>
        <button type="button" class="text-[11px] text-slate-400 hover:text-slate-600" @click="cancelAdd">取消</button>
      </div>
      <button
        v-else
        type="button"
        class="text-[11px] text-brand font-medium hover:underline disabled:opacity-50"
        :disabled="saving || durations.length >= MAX_DURATIONS"
        :title="durations.length >= MAX_DURATIONS ? `最多 ${MAX_DURATIONS} 条` : '添加自定义提醒时长'"
        @click="openAdd"
      >＋添加</button>

      <span v-if="!durations.length && !adding" class="text-[11px] text-slate-400">无快捷时长</span>
    </div>
    <p v-if="adding && addErr" class="mt-0.5 text-[11px] text-red-500">{{ addErr }}</p>
  </div>
</template>
