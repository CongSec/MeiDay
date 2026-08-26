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
      <!-- 顶栏（手机端：日历开关并入 header，按钮缩小防换行溢出） -->
      <header class="h-12 shrink-0 bg-white border-b border-slate-100 flex items-center gap-1 px-2 md:px-4 z-[60]">
        <!-- 手机端：日历抽屉开关（md 以上隐藏） -->
        <button
          class="md:hidden w-9 h-9 rounded-lg text-slate-500 hover:bg-slate-100 flex items-center justify-center text-lg shrink-0"
          title="打开日历"
          @click="calendarOpen = !calendarOpen"
        >📅</button>
        <div class="flex items-center gap-2 min-w-0">
          <span class="text-xl shrink-0">🔒</span>
          <span class="font-bold whitespace-nowrap text-slate-800">隐私日记</span>
          <span class="text-xs text-slate-400 truncate hidden sm:inline">@{{ diary.username }}</span>
        </div>
        <div class="flex-1" />
        <div class="flex items-center gap-1 shrink-0">
          <!-- 回顾：只读回看指定时间段的历史日记 -->
          <button
            class="px-2 md:px-2.5 py-1.5 rounded-lg text-xs md:text-sm text-slate-600 hover:bg-slate-100 whitespace-nowrap"
            title="回顾历史日记"
            @click="reviewOpen = true"
          >
            📅 回顾
          </button>
          <!-- 设置下拉：修改密码 / 导出 / 导入 / 删除 折叠于此 -->
          <div ref="settingsMenuEl" class="relative">
            <button
              class="px-2 md:px-2.5 py-1.5 rounded-lg text-xs md:text-sm text-slate-600 hover:bg-slate-100 whitespace-nowrap"
              @click="settingsOpen = !settingsOpen"
            >
              ⚙ 设置<span class="hidden sm:inline"> ▾</span>
            </button>
            <div
              v-if="settingsOpen"
              class="absolute right-0 top-full mt-1 w-44 rounded-xl bg-white shadow-xl ring-1 ring-black/10 py-1 z-50 overflow-hidden"
            >
              <button
                class="w-full flex items-center gap-2 px-3 py-2 text-left text-sm text-slate-700 hover:bg-slate-100 whitespace-nowrap"
                @click="openChangePassword"
              >
                <span class="text-base shrink-0">🔑</span>
                <span>修改密码</span>
              </button>
              <button
                class="w-full flex items-center gap-2 px-3 py-2 text-left text-sm text-slate-700 hover:bg-slate-100 whitespace-nowrap disabled:opacity-50"
                :disabled="diary.exporting"
                @click="exportOpen = true"
              >
                <span class="text-base shrink-0">📦</span>
                <span>{{ diary.exporting ? '导出中…' : '导出日记' }}</span>
              </button>
              <button
                class="w-full flex items-center gap-2 px-3 py-2 text-left text-sm text-slate-700 hover:bg-slate-100 whitespace-nowrap disabled:opacity-50"
                :disabled="diary.importing"
                @click="importInput?.click()"
              >
                <span class="text-base shrink-0">📥</span>
                <span>{{ diary.importing ? '导入中…' : '导入日记' }}</span>
              </button>
              <div class="h-px bg-slate-100 my-1" />
              <button
                class="w-full flex items-center gap-2 px-3 py-2 text-left text-sm text-red-600 hover:bg-red-50 whitespace-nowrap disabled:opacity-50"
                :disabled="diary.deleting"
                @click="deleteOpen = true"
              >
                <span class="text-base shrink-0">🗑️</span>
                <span>{{ diary.deleting ? '删除中…' : '删除日记' }}</span>
              </button>
            </div>
          </div>
          <button class="px-2 md:px-3 py-1.5 rounded-lg text-xs md:text-sm text-red-500 hover:bg-red-50 font-medium whitespace-nowrap" @click="onExit">
            退出<span class="hidden sm:inline">系统</span>
          </button>
        </div>
      </header>

      <!-- 主体：左日历 + 右聊天 -->
      <div class="flex flex-1 min-h-0">
        <!-- 日历侧边栏：md+ 常驻；小屏作为左侧抽屉 -->
        <aside
          class="w-64 shrink-0 border-r border-slate-100 bg-white p-3 overflow-y-auto fixed top-12 bottom-0 left-0 z-50 transition-transform md:translate-x-0 md:static"
          :class="calendarOpen ? 'translate-x-0 shadow-2xl' : '-translate-x-full'"
        >
          <DiaryCalendar @pick="calendarOpen = false" />
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

    <!-- 回顾视图（只读，覆盖整个日记界面；返回今天即退出） -->
    <DiaryReview v-if="reviewOpen" @close="onCloseReview" />

    <!-- 修改密码弹层 -->
    <div v-if="changeOpen && diary.unlocked" class="fixed inset-0 z-50 bg-slate-900/60 flex items-center justify-center px-4">
      <DiaryPasswordGate mode="enter" start-in-change @changed="changeOpen = false" @cancel="changeOpen = false" />
    </div>

    <!-- 导出弹层 -->
    <div v-if="exportOpen && diary.unlocked" class="fixed inset-0 z-50 bg-slate-900/60 flex items-center justify-center px-4" data-testid="diary-export-modal">
      <div class="bg-white rounded-xl shadow-xl p-6 w-full max-w-sm">
        <h3 class="text-base font-semibold text-slate-800 mb-3">导出日记</h3>
        <label class="block text-xs text-slate-500 mb-1">年份</label>
        <select v-model.number="exportYear" data-testid="diary-export-year" class="w-full border rounded-lg px-3 py-2 text-sm mb-3">
          <option v-for="y in yearOptions" :key="y" :value="y">{{ y }} 年</option>
        </select>
        <label class="block text-xs text-slate-500 mb-1">月份</label>
        <select v-model="exportMonth" data-testid="diary-export-month" class="w-full border rounded-lg px-3 py-2 text-sm mb-4">
          <option :value="null">全年</option>
          <option v-for="m in 12" :key="m" :value="m">{{ m }} 月</option>
        </select>
        <label class="block text-xs text-slate-500 mb-1">导出密码（用于其它账号导入，请妥善保存）</label>
        <input v-model="exportPw" type="password" class="w-full border rounded-lg px-3 py-2 text-sm mb-2" placeholder="设置导出密码" data-testid="diary-export-password" />
        <input v-model="exportPw2" type="password" class="w-full border rounded-lg px-3 py-2 text-sm mb-3" placeholder="再次确认导出密码" data-testid="diary-export-password-confirm" />
        <p v-if="exportError" class="text-xs text-red-500 mb-2">{{ exportError }}</p>
        <div class="flex justify-end gap-2">
          <button class="px-3 py-2 rounded-lg text-sm text-slate-500" @click="closeExport">取消</button>
          <button class="px-4 py-2 rounded-lg text-sm bg-brand text-white font-medium" :disabled="diary.exporting" data-testid="diary-export-submit" @click="doExport">
            {{ diary.exporting ? '正在导出…' : '开始导出' }}
          </button>
        </div>
        <p class="mt-2 text-[11px] text-slate-400">压缩包内容全部为密文；跨账号导入时需要输入本次设置的导出密码。</p>
      </div>
    </div>

    <!-- 跨账号导入密码弹层（压缩包含 dek.json 时弹出） -->
    <div v-if="importPromptOpen && diary.unlocked" class="fixed inset-0 z-50 bg-slate-900/60 flex items-center justify-center px-4" data-testid="diary-import-modal">
      <div class="bg-white rounded-xl shadow-xl p-6 w-full max-w-sm">
        <h3 class="text-base font-semibold text-slate-800 mb-3">导入日记</h3>
        <p class="text-xs text-slate-500 mb-3">该压缩包包含加密密钥，需要输入导出时设置的「导出密码」才能解密导入。</p>
        <p class="text-[11px] text-slate-400 mb-2 truncate">文件：{{ importFileName }}</p>
        <label class="block text-xs text-slate-500 mb-1">导出时的日记密码</label>
        <input v-model="importPw" type="password" class="w-full border rounded-lg px-3 py-2 text-sm mb-3" placeholder="请输入导出密码" data-testid="diary-import-password" />
        <p v-if="importError" class="text-xs text-red-500 mb-2">{{ importError }}</p>
        <div class="flex justify-end gap-2">
          <button class="px-3 py-2 rounded-lg text-sm text-slate-500" :disabled="diary.importing" @click="importPromptOpen = false">取消</button>
          <button class="px-4 py-2 rounded-lg text-sm bg-brand text-white font-medium" :disabled="diary.importing" data-testid="diary-import-submit" @click="confirmImport">
            {{ diary.importing ? '导入中…' : '确认导入' }}
          </button>
        </div>
      </div>
    </div>

    <!-- 删除日记弹层（按年 / 月 / 全年） -->
    <div v-if="deleteOpen && diary.unlocked" class="fixed inset-0 z-50 bg-slate-900/60 flex items-center justify-center px-4" data-testid="diary-delete-modal">
      <div class="bg-white rounded-xl shadow-xl p-6 w-full max-w-sm">
        <h3 class="text-base font-semibold text-red-600 mb-3">删除日记</h3>
        <label class="block text-xs text-slate-500 mb-1">年份</label>
        <select v-model.number="deleteYear" data-testid="diary-delete-year" class="w-full border rounded-lg px-3 py-2 text-sm mb-3">
          <option v-for="y in yearOptions" :key="y" :value="y">{{ y }} 年</option>
        </select>
        <label class="block text-xs text-slate-500 mb-1">月份</label>
        <select v-model="deleteMonth" data-testid="diary-delete-month" class="w-full border rounded-lg px-3 py-2 text-sm mb-3">
          <option :value="null">全年</option>
          <option v-for="m in 12" :key="m" :value="m">{{ m }} 月</option>
        </select>
        <p class="mb-4 text-[11px] text-red-400">删除后将从云端永久移除，且不可恢复！</p>
        <div class="flex justify-end gap-2">
          <button class="px-3 py-2 rounded-lg text-sm text-slate-500" @click="deleteOpen = false">取消</button>
          <button class="px-4 py-2 rounded-lg text-sm bg-red-500 text-white font-medium" :disabled="diary.deleting" @click="doDelete">
            {{ diary.deleting ? '删除中…' : '确认删除' }}
          </button>
        </div>
      </div>
    </div>

    <!-- 导出 / 导入 进行中提示 -->
    <Transition
      enter-active-class="transition duration-200 ease-out"
      enter-from-class="opacity-0"
      leave-active-class="transition duration-150 ease-in"
      leave-to-class="opacity-0"
    >
      <div
        v-if="diary.exporting || diary.importing"
        class="fixed inset-0 z-[80] bg-slate-900/40 flex items-center justify-center px-4"
        role="status"
      >
        <div class="bg-white rounded-2xl shadow-xl px-8 py-6 flex flex-col items-center gap-3">
          <span class="w-7 h-7 rounded-full border-[3px] border-brand/30 border-t-brand animate-spin shrink-0" aria-hidden="true" />
          <div class="text-sm font-medium text-slate-700">
            {{ diary.exporting ? '正在导出中…' : '正在导入中…' }}
          </div>
          <div class="text-xs text-slate-400">
            {{ diary.exporting ? '正在打包加密日记，请稍候' : '正在解密并写入日记，请稍候' }}
          </div>
        </div>
      </div>
    </Transition>

    <input ref="importInput" type="file" accept=".zip,application/zip" class="hidden" @change="onFileChosen" />
  </div>
</template>

<script setup lang="ts">
import { onMounted, onUnmounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import DiaryPasswordGate from '@/components/diary/DiaryPasswordGate.vue'
import DiaryCalendar from '@/components/diary/DiaryCalendar.vue'
import DiaryChat from '@/components/diary/DiaryChat.vue'
import DiaryReview from '@/components/diary/DiaryReview.vue'
import { useDiaryStore } from '@/stores/diary'
import { useUiStore } from '@/stores/ui'
import { setIdleLockExpireHandler } from '@/composables/useIdleLock'
import { todayKey } from '@/utils/time'
import { describeDiaryError, peekDiaryZipHasDek } from '@/utils/diaryStorage'

const diary = useDiaryStore()
const ui = useUiStore()
const router = useRouter()

const gateMode = ref<'setup' | 'enter'>('enter')
const calendarOpen = ref(false)
const changeOpen = ref(false)
const reviewOpen = ref(false)
const settingsOpen = ref(false)
const settingsMenuEl = ref<HTMLElement | null>(null)
const exportOpen = ref(false)
const exportYear = ref(Number(todayKey().slice(0, 4)))
const exportMonth = ref<number | null>(null)
const exportPw = ref('')
const exportPw2 = ref('')
const exportError = ref('')
const deleteOpen = ref(false)
const deleteYear = ref(Number(todayKey().slice(0, 4)))
const deleteMonth = ref<number | null>(null)
const importInput = ref<HTMLInputElement | null>(null)
const importPromptOpen = ref(false)
const importFileName = ref('')
const importPw = ref('')
const importError = ref('')
const importFile = ref<File | null>(null)

const yearOptions: number[] = []
for (let y = Number(todayKey().slice(0, 4)); y >= 2020; y--) yearOptions.push(y)

function openChangePassword(): void {
  settingsOpen.value = false
  changeOpen.value = true
}

/** 关闭导出弹窗并清空密码输入（避免下次打开残留） */
function closeExport(): void {
  exportOpen.value = false
  exportPw.value = ''
  exportPw2.value = ''
  exportError.value = ''
}

/** 点击设置菜单外部时收起下拉 */
function onDocPointerdown(e: PointerEvent): void {
  const el = settingsMenuEl.value
  if (settingsOpen.value && el && !el.contains(e.target as Node)) {
    settingsOpen.value = false
  }
}

function onUnlocked(): void {
  // 解锁成功后进入主界面；给聊天一个空状态即可
}

/** 退出回顾：关闭视图并释放回顾期间下载的附件 URL */
function onCloseReview(): void {
  reviewOpen.value = false
  void diary.closeReview()
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
  exportError.value = ''
  const pw = exportPw.value
  if (!pw) {
    exportError.value = '请先设置导出密码'
    return
  }
  if (pw !== exportPw2.value) {
    exportError.value = '两次输入的导出密码不一致'
    return
  }
  try {
    const r = await diary.exportPeriod(exportYear.value, exportMonth.value ?? undefined, pw)
    ui.toast(`已导出 ${r.count} 个加密文件`)
    exportOpen.value = false
    exportPw.value = ''
    exportPw2.value = ''
  } catch (e) {
    exportError.value = describeDiaryError(e, '导出失败')
    ui.toast(exportError.value, 'error')
  }
}

async function doDelete(): Promise<void> {
  try {
    const r = await diary.deletePeriod(deleteYear.value, deleteMonth.value ?? undefined)
    ui.toast(`已删除 ${r.days} 天日记（含 ${r.files} 个附件）`)
  } catch (e) {
    ui.toast(e instanceof Error ? e.message : '删除失败', 'error')
  } finally {
    deleteOpen.value = false
  }
}

async function onFileChosen(e: Event): Promise<void> {
  const input = e.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file) return
  // 含 dek.json 说明是带密钥的导出包（同账号或跨账号），先让用户确认导出密码
  const hasDek = await peekDiaryZipHasDek(file)
  if (hasDek) {
    importFile.value = file
    importFileName.value = file.name
    importPw.value = ''
    importError.value = ''
    importPromptOpen.value = true
    return
  }
  await runImport(file)
}

async function runImport(file: File, exportPassword?: string): Promise<void> {
  try {
    const count = await diary.importPeriod(file, exportPassword)
    ui.toast(`导入成功，共 ${count} 条密文记录`)
  } catch (err) {
    const msg = describeDiaryError(err, '导入失败（密码不匹配或文件损坏）')
    if (exportPassword !== undefined) importError.value = msg
    ui.toast(msg, 'error')
  }
}

async function confirmImport(): Promise<void> {
  if (!importFile.value) return
  importError.value = ''
  await runImport(importFile.value, importPw.value)
  if (!importError.value) {
    importPromptOpen.value = false
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
  document.addEventListener('pointerdown', onDocPointerdown)
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
  document.removeEventListener('pointerdown', onDocPointerdown)
  setIdleLockExpireHandler(null)
})
</script>
