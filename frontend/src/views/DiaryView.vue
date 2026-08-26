<template>
  <div class="fixed inset-0 z-40 bg-slate-100">
    <!-- 未解锁：全屏密码门（首次设置 / 再次进入） -->
    <DiaryPasswordGate
      v-if="!diary.unlocked"
      :mode="gateMode"
      @unlocked="onUnlocked"
    />

    <!-- 已解锁：隐私日记主界面（左右两栏） -->
    <div v-else class="flex flex-col h-full">
      <!-- 顶栏 -->
      <header class="h-14 shrink-0 bg-slate-900 text-white flex items-center justify-between px-4 shadow">
        <div class="flex items-center gap-2">
          <span class="text-xl">🔒</span>
          <span class="font-bold">隐私日记</span>
          <span class="text-xs text-slate-400 ml-1">@{{ diary.username }}</span>
        </div>
        <div class="flex items-center gap-1.5">
          <button class="px-2.5 py-1.5 rounded-lg text-sm text-slate-200 hover:bg-white/10" @click="openChangePassword">
            修改密码
          </button>
          <button class="px-2.5 py-1.5 rounded-lg text-sm text-slate-200 hover:bg-white/10" :disabled="diary.exporting" @click="exportOpen = true">
            {{ diary.exporting ? '导出中…' : '导出' }}
          </button>
          <button class="px-2.5 py-1.5 rounded-lg text-sm text-slate-200 hover:bg-white/10" :disabled="diary.importing" @click="importInput?.click()">
            {{ diary.importing ? '导入中…' : '导入' }}
          </button>
          <button class="ml-2 px-3 py-1.5 rounded-lg text-sm bg-red-500/90 hover:bg-red-500 font-medium" @click="onExit">
            退出系统
          </button>
        </div>
      </header>

      <!-- 主体：左日历 + 右聊天 -->
      <div class="flex flex-1 min-h-0">
        <!-- 手机端：日历抽屉开关（md 以上隐藏） -->
        <button
          class="md:hidden absolute left-3 top-3 z-[45] flex items-center gap-1 rounded-lg bg-white border border-slate-200 px-2.5 py-1.5 text-xs text-slate-600 shadow"
          @click="calendarOpen = !calendarOpen"
        >
          📅 日历
        </button>

        <!-- 日历侧边栏：md+ 常驻；小屏作为左侧抽屉 -->
        <aside
          class="w-64 shrink-0 border-r border-slate-200 bg-white p-3 overflow-y-auto fixed top-14 bottom-0 left-0 z-50 transition-transform md:translate-x-0 md:static"
          :class="calendarOpen ? 'translate-x-0 shadow-2xl' : '-translate-x-full'"
        >
          <DiaryCalendar />
        </aside>

        <!-- 小屏抽屉遮罩 -->
        <div
          v-if="calendarOpen"
          class="fixed inset-0 z-40 bg-slate-900/40 md:hidden"
          @click="calendarOpen = false"
        />

        <main class="flex-1 min-w-0">
          <DiaryChat />
        </main>
      </div>
    </div>

    <!-- 修改密码弹层 -->
    <div v-if="changeOpen && diary.unlocked" class="fixed inset-0 z-50 bg-slate-900/60 flex items-center justify-center px-4">
      <DiaryPasswordGate mode="enter" start-in-change @changed="changeOpen = false" @cancel="changeOpen = false" />
    </div>

    <!-- 导出弹层 -->
    <div v-if="exportOpen && diary.unlocked" class="fixed inset-0 z-50 bg-slate-900/60 flex items-center justify-center px-4">
      <div class="bg-white rounded-2xl shadow-xl p-5 w-full max-w-xs">
        <h3 class="text-base font-semibold text-slate-800 mb-3">导出日记</h3>
        <label class="block text-xs text-slate-500 mb-1">年份</label>
        <select v-model.number="exportYear" class="w-full border rounded-lg px-3 py-2 text-sm mb-3">
          <option v-for="y in yearOptions" :key="y" :value="y">{{ y }} 年</option>
        </select>
        <label class="block text-xs text-slate-500 mb-1">月份</label>
        <select v-model="exportMonth" class="w-full border rounded-lg px-3 py-2 text-sm mb-4">
          <option :value="null">全年</option>
          <option v-for="m in 12" :key="m" :value="m">{{ m }} 月</option>
        </select>
        <div class="flex justify-end gap-2">
          <button class="px-3 py-2 rounded-lg text-sm text-slate-500" @click="exportOpen = false">取消</button>
          <button class="px-4 py-2 rounded-lg text-sm bg-brand text-white font-medium" :disabled="diary.exporting" @click="doExport">
            开始导出
          </button>
        </div>
        <p class="mt-2 text-[11px] text-slate-400">导出的压缩包内容全部为密文，需使用同一日记密码才能导入。</p>
      </div>
    </div>

    <input ref="importInput" type="file" accept=".zip,application/zip" class="hidden" @change="onImport" />
  </div>
</template>

<script setup lang="ts">
import { onMounted, onUnmounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import DiaryPasswordGate from '@/components/diary/DiaryPasswordGate.vue'
import DiaryCalendar from '@/components/diary/DiaryCalendar.vue'
import DiaryChat from '@/components/diary/DiaryChat.vue'
import { useDiaryStore } from '@/stores/diary'
import { useUiStore } from '@/stores/ui'
import { setIdleLockExpireHandler } from '@/composables/useIdleLock'
import { todayKey } from '@/utils/time'

const diary = useDiaryStore()
const ui = useUiStore()
const router = useRouter()

const gateMode = ref<'setup' | 'enter'>('enter')
const calendarOpen = ref(false)
const changeOpen = ref(false)
const exportOpen = ref(false)
const exportYear = ref(Number(todayKey().slice(0, 4)))
const exportMonth = ref<number | null>(null)
const importInput = ref<HTMLInputElement | null>(null)

const yearOptions: number[] = []
for (let y = Number(todayKey().slice(0, 4)); y >= 2020; y--) yearOptions.push(y)

function openChangePassword(): void {
  changeOpen.value = true
}

function onUnlocked(): void {
  // 解锁成功后进入主界面；给聊天一个空状态即可
}

/** 空闲到期：清空内存密钥并跳回任务系统首页 */
function onIdleExpire(): void {
  diary.lock()
  if (router.currentRoute.value.path === '/diary') router.push('/today')
}

function onExit(): void {
  diary.lock()
  router.push('/today')
}

async function doExport(): Promise<void> {
  try {
    const r = await diary.exportPeriod(exportYear.value, exportMonth.value ?? undefined)
    ui.toast(`已导出 ${r.count} 个加密文件`)
  } catch (e) {
    ui.toast(e instanceof Error ? e.message : '导出失败', 'error')
  } finally {
    exportOpen.value = false
  }
}

async function onImport(e: Event): Promise<void> {
  const input = e.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file) return
  try {
    const count = await diary.importPeriod(file)
    ui.toast(`导入成功，共 ${count} 条密文记录`)
  } catch (err) {
    ui.toast(err instanceof Error ? err.message : '导入失败（密码不匹配或文件损坏）', 'error')
  }
}

// 小屏选中某天后收起日历抽屉
watch(
  () => diary.selectedDate,
  () => {
    if (calendarOpen.value) calendarOpen.value = false
  },
)

onMounted(async () => {
  // 空闲到期回调（视图级：跳回首页）
  setIdleLockExpireHandler(onIdleExpire)
  try {
    const mode = await diary.initSession()
    if (mode === 'setup') gateMode.value = 'setup'
    else if (mode === 'enter') gateMode.value = 'enter'
    // unlocked：直接进入主界面（diary.unlocked 已为 true）
  } catch (e) {
    ui.toast(e instanceof Error ? e.message : '进入日记失败', 'error')
    router.push('/today')
  }
})

onUnmounted(() => {
  setIdleLockExpireHandler(null)
})
</script>
