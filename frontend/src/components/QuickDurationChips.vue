<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { api } from '@/api/client'
import { useUiStore } from '@/stores/ui'
import ConfirmDialog from './ConfirmDialog.vue'

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
/** 待删除的快捷时长（分钟）：非 null 时弹出确认框；× 很窄，避免误触直接删掉清单 */
const pendingRemove = ref<number | null>(null)

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

/** 点 × 只记录待删项并弹确认框，不立即发请求（防误触） */
function askRemoveDuration(mins: number) {
  if (saving.value) return
  pendingRemove.value = mins
}

function cancelRemove() {
  pendingRemove.value = null
}

/** 确认删除：写入账号快捷清单（服务器，多端同步）；失败提示并保持原清单 */
async function confirmRemove() {
  const mins = pendingRemove.value
  if (saving.value || mins === null) return
  const next = durations.value.filter((m) => m !== mins)
  saving.value = true
  try {
    await api.setQuickDurations(next)
    durations.value = next
    // 删除失败时保留待删项与弹窗，用户可直接重试或取消
    pendingRemove.value = null
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

/** 校验输入并换算成分钟；不合法时写 addErr 并返回 null。
 *  v-model 在 type=number 输入框上会把值自动转成 number，这里兼容 string/number 两种形态，
 *  不能用 value.trim()（数字没有 trim 方法，会抛 TypeError 导致点击无反应） */
function parseMins(): number | null {
  const raw = Number(addValue.value)
  if (!addValue.value || !Number.isFinite(raw) || !Number.isInteger(raw) || raw <= 0) {
    addErr.value = '请输入大于 0 的整数'
    return null
  }
  const mins = addUnit.value === 'hour' ? raw * 60 : raw
  if (mins < 1 || mins > MAX_MINUTES) {
    addErr.value = '时长需在 1 分钟 ~ 24 小时之间'
    return null
  }
  return mins
}

/** 确认：不存库，直接把「当前时刻 + 输入时长」填为提醒时间（emit apply）并关闭表单 */
function applyAdd() {
  const mins = parseMins()
  if (mins === null) return
  emit('apply', fmtApplied(mins))
  adding.value = false
  addErr.value = ''
}

/** 保存：完整校验（含已存在/条数上限）后写入账号快捷清单（服务器，多端同步），成功关闭表单 */
async function saveAdd() {
  if (saving.value) return
  const mins = parseMins()
  if (mins === null) return
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
          title="删除该快捷时长（会先确认）"
          @click.stop="askRemoveDuration(m)"
        >×</span>
      </button>

      <!-- ＋添加 / 添加表单：确认＝即用（当前时刻＋时长，不存库）；保存＝写入账号快捷清单 -->
      <div v-if="adding" class="inline-flex items-center gap-1">
        <input
          v-model="addValue"
          type="number"
          min="1"
          max="1440"
          placeholder="时长"
          class="w-16 border rounded-md px-1.5 py-0.5 text-[11px] outline-none focus:ring-2 focus:ring-brand/50"
          @keydown.enter.prevent="applyAdd"
        />
        <select v-model="addUnit" class="border rounded-md px-1 py-0.5 text-[11px] bg-white">
          <option value="min">分钟</option>
          <option value="hour">小时</option>
        </select>
        <button
          type="button"
          class="text-[11px] text-brand font-medium hover:underline disabled:opacity-50"
          title="当前时刻 + 输入时长，直接设为提醒时间"
          :disabled="saving"
          @click="applyAdd"
        >确认</button>
        <button
          type="button"
          class="text-[11px] text-slate-400 hover:text-slate-600 disabled:opacity-50"
          title="保存到快捷时长清单（下次可直接点标签使用）"
          :disabled="saving"
          @click="saveAdd"
        >保存</button>
      </div>
      <button
        v-else
        type="button"
        class="text-[11px] text-brand font-medium hover:underline disabled:opacity-50"
        :disabled="saving"
        title="添加自定义提醒时长"
        @click="openAdd"
      >＋添加</button>

      <span v-if="!durations.length && !adding" class="text-[11px] text-slate-400">无快捷时长</span>
    </div>
    <p v-if="adding && addErr" class="mt-0.5 text-[11px] text-red-500">{{ addErr }}</p>

    <!-- 删除确认：挂在任务编辑弹窗（同为 z-50）内部，需更高的层级才不会被父遮罩压住 -->
    <ConfirmDialog
      :open="pendingRemove !== null"
      z-index="z-[60]"
      title="删除快捷时长"
      :message="`确定删除「${pendingRemove === null ? '' : label(pendingRemove)}」这条快捷时长？\n删除后需重新添加，不影响已设置的提醒时间。`"
      confirm-text="删除"
      danger
      :disabled="saving"
      @confirm="confirmRemove"
      @cancel="cancelRemove"
    />
  </div>
</template>
