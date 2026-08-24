<script setup lang="ts">
import { computed, onMounted, onUnmounted, provide, reactive, ref } from 'vue'
import Sidebar from '@/components/Sidebar.vue'
import ProjectModal from '@/components/ProjectModal.vue'
import UploadIndicator from '@/components/UploadIndicator.vue'
import ImportModal from '@/components/ImportModal.vue'
import { useAuthStore } from '@/stores/auth'
import { useProjectsStore } from '@/stores/projects'
import { useTasksStore } from '@/stores/tasks'
import { useUiStore } from '@/stores/ui'
import { useRouter } from 'vue-router'
import { isDragging } from '@/utils/drag'
import { useSync } from '@/composables/useSync'
import { startSyncPoll, stopSyncPoll } from '@/composables/useSyncPoll'
import { ensureLegalCalendar } from '@/utils/legalWorkday'
import { UNCATEGORIZED, type Task } from '@/types'

const auth = useAuthStore()
const projects = useProjectsStore()
const tasks = useTasksStore()
const ui = useUiStore()
const router = useRouter()
const { syncing, syncNow } = useSync()

const needsUnlock = ref(false)
const unlockPw = ref('')
const rememberPw = ref(true)
const unlockErr = ref('')
const unlocking = ref(false)
const projectModalOpen = ref(false)
const importModalOpen = ref(false)

/** 手机端头部「新建任务/导入」动作：由当前子视图（今日/项目）注册；设置/回收站等页不显示 */
const mobileActions = reactive({
  newTask: null as (() => void) | null,
  /** 手机端头部标题：当前视图/项目名称（替代固定的 EasyTask 图标与名称） */
  title: '',
})
provide('mobile-actions', mobileActions)

/** ---- 手机右滑手势：全局任意位置向右轻滑打开侧栏，抽屉打开时在右侧遮罩左滑关闭 ---- */
/** ---- 下拉刷新：页面滚动到顶部后向下拉动触发同步 ---- */
let touchStartX = 0
let touchStartY = 0
let touchStartAt = 0
let swipeOpen = false
let pullTracking = false
let pullY = 0

/** 打开侧栏的最小横向滑动距离（“轻滑”即可触发） */
const SWIPE_OPEN_DIST = 28
/** 判定为横向手势（区别于纵向滚动）的 dx 下限：超过即 preventDefault 阻断浏览器手势 */
const SWIPE_HORIZONTAL_DIST = 20
/** 允许的最大滑动时长（ms）：超过则视为慢拖，不触发开侧栏 */
const SWIPE_MAX_DURATION = 800
/** 下拉刷新的“开始接管”最小下拉距离(px)：小于它不拦截滚动，避免向下滚动列表时轻微抖动误触发刷新 */
const PULL_ENGAGE_DIST = 10
/** 下拉刷新只接管“快速下拉”：触摸后 300ms 内开始下移才算滚动；长按任务(≥300ms)后拖动属于拖拽排序，不触发刷新 */
const PULL_ENGAGE_MS = 300

/** 下拉刷新指示状态 */
const refreshState = ref<'idle' | 'pulling' | 'ready' | 'refreshing'>('idle')
const pullDist = ref(0)
const mainPull = computed(() => (refreshState.value === 'idle' ? 0 : pullDist.value))
/** 主滚动容器；transform 仅在拉动/刷新期间生效，避免影响弹窗 fixed 定位 */
const mainStyle = computed(() =>
  refreshState.value === 'idle' ? {} : { transform: `translateY(${mainPull.value}px)` },
)
const mainEl = ref<HTMLElement | null>(null)

/** 触摸点是否落在拖拽手柄等由 JS 全权控制的手势区 */
function isGestureHandle(el: EventTarget | null): boolean {
  return !!el && el instanceof HTMLElement && !!el.closest('.drag-handle')
}

/** 触摸点是否在弹窗内（任务编辑/项目/导入/附件预览等 fixed inset-0 z-50 遮罩）：
 *  弹窗内不允许下拉刷新或边缘滑动手势，避免编辑滚动时误触同步/侧栏。 */
function isInsideModal(el: EventTarget | null): boolean {
  return !!el && el instanceof HTMLElement && !!el.closest('.fixed.inset-0.z-50')
}

/** 是否移动端布局（<1024px）：桌面端侧栏常驻，不参与边缘滑动手势 */
function isMobileLayout(): boolean {
  return window.matchMedia('(max-width: 1023px)').matches
}

/** 触摸点是否落在可交互控件上（按钮/链接/输入框等）：
 *  这些区域不做 touchstart 拦截，保证汉堡按钮等点击正常。 */
function isInteractive(el: EventTarget | null): boolean {
  if (!el || !(el instanceof HTMLElement)) return false
  return !!el.closest(
    'button, a, input, select, textarea, label, [role="button"], [contenteditable]',
  )
}

/** 是否允许“全局右滑开侧栏”：移动端、抽屉关闭、任意位置、非拖拽手柄/非同步中/非弹窗内 */
function canSwipeOpen(e: TouchEvent): boolean {
  return (
    isMobileLayout() &&
    !ui.drawerOpen &&
    !syncing.value &&
    !isGestureHandle(e.target) &&
    !isInsideModal(e.target)
  )
}

/** 浏览器原生“返回/前进/退出网页”手势区：这一窄条直接拦截 touchstart，
 *  抢在浏览器把滑动当成返回手势之前声明由页面处理，Chrome 就不会导航走。 */
const EDGE_BACK_ZONE = 24

function onDrawerTouchStart(e: TouchEvent) {
  const t = e.touches[0]
  if (!t) return
  touchStartX = t.clientX
  touchStartY = t.clientY
  touchStartAt = Date.now()
  const onHandle = isGestureHandle(e.target)
  const inModal = isInsideModal(e.target)
  // 全局右滑开侧栏：抽屉关闭、移动端、任意位置、非拖拽手柄/非同步中/非弹窗内
  swipeOpen = canSwipeOpen(e)
  // 关键：在浏览器“返回/前进”的原生手势窄条内（非交互控件上）提前拦截 touchstart，
  // 主动声明“这块区域由页面处理”，避免浏览器在咱们 touchend 开侧栏之前就把页面导航走。
  if (swipeOpen && t.clientX < EDGE_BACK_ZONE && !isInteractive(e.target)) {
    if (e.cancelable) e.preventDefault()
  }
  pullY = mainEl.value?.scrollTop ?? 0
  // 下拉刷新：抽屉关闭、页面滚动到顶部、非拖拽手柄/非同步中/非弹窗内
  pullTracking =
    !ui.drawerOpen &&
    refreshState.value !== 'refreshing' &&
    !syncing.value &&
    !!mainEl.value &&
    mainEl.value.scrollTop <= 0 &&
    !onHandle &&
    !inModal
}

function onDrawerTouchMove(e: TouchEvent) {
  const t = e.touches[0]
  if (!t) return
  const dx = t.clientX - touchStartX
  const dy = t.clientY - touchStartY
  // 全局右滑：一旦出现明确横向意图（dx>阈值且横向占优）就阻止浏览器返回/前进手势。
  // 阈值不宜过小，避免纵向滚动时的横向抖动把页面滚动打断。
  if (swipeOpen && dx > SWIPE_HORIZONTAL_DIST && Math.abs(dx) > Math.abs(dy)) {
    if (e.cancelable) e.preventDefault()
  }
  // 左滑关闭：抽屉打开时，一旦出现明确向左意图（dx<-阈值且横向占优）同样阻止浏览器默认手势，
  // 保证左滑关闭流畅，也不会误触浏览器返回/前进手势。
  if (ui.drawerOpen && dx < -SWIPE_HORIZONTAL_DIST && Math.abs(dx) > Math.abs(dy)) {
    if (e.cancelable) e.preventDefault()
  }
  // 下拉刷新：页面顶部向下拉动（仅接管触摸后 300ms 内的“快速下拉”，
  // 长按任务 ≥300ms 再拖动属于拖拽排序，不再触发刷新）
  if (
    !isDragging() &&
    pullTracking &&
    Date.now() - touchStartAt < PULL_ENGAGE_MS &&
    dy > PULL_ENGAGE_DIST &&
    Math.abs(dy) > Math.abs(dx) &&
    (mainEl.value?.scrollTop ?? pullY) <= pullY
  ) {
    if (e.cancelable) e.preventDefault()
    const dist = Math.min(dy * 0.45, 90)
    pullDist.value = dist
    refreshState.value = dist >= 60 ? 'ready' : 'pulling'
  }
}

async function onDrawerTouchEnd(e: TouchEvent) {
  const t = e.changedTouches[0]
  if (!t) return
  const dx = t.clientX - touchStartX
  const dy = t.clientY - touchStartY
  const dt = Date.now() - touchStartAt
  const horizontal = Math.abs(dx) >= Math.abs(dy)
  // 长按拖拽中（任务整卡拖动）不触发开侧栏/下拉刷新，交给 vue-draggable-plus 处理
  const dragging = isDragging()

  if (!dragging) {
    // 全局右滑开侧栏（任意位置向右轻滑即开）/ 抽屉打开时左滑关闭（侧栏内或遮罩上均可）
    if (swipeOpen && horizontal && dx > SWIPE_OPEN_DIST && dt <= SWIPE_MAX_DURATION) {
      ui.openDrawer()
    } else if (ui.drawerOpen && horizontal && dx < 0 && dt <= SWIPE_MAX_DURATION) {
      ui.closeDrawer()
    }

    // 下拉刷新：松手时达到阈值即触发同步
    if (pullTracking) {
      if (refreshState.value === 'ready' && !syncing.value) {
        refreshState.value = 'refreshing'
        pullDist.value = 44
        void doRefresh()
      } else {
        refreshState.value = 'idle'
        pullDist.value = 0
      }
    }
  }

  pullTracking = false
  swipeOpen = false
}

/** 下拉刷新触发同步：同步结束后收起指示器 */
async function doRefresh() {
  await syncNow()
  refreshState.value = 'idle'
  pullDist.value = 0
}

onUnmounted(() => {
  document.removeEventListener('touchstart', onDrawerTouchStart)
  document.removeEventListener('touchmove', onDrawerTouchMove)
  document.removeEventListener('touchend', onDrawerTouchEnd)
  // 离开主界面（登出/跳登录）即停止同步轮询
  stopSyncPoll()
})

onMounted(async () => {
  document.addEventListener('touchstart', onDrawerTouchStart, { passive: false })
  document.addEventListener('touchmove', onDrawerTouchMove, { passive: false })
  document.addEventListener('touchend', onDrawerTouchEnd, { passive: true })
  if (auth.token && !auth.userKey) {
    try {
      const me = await auth.fetchMe()
      if (me.hasCreds) {
        const unlocked = await auth.tryAutoUnlock()
        needsUnlock.value = !unlocked
        if (needsUnlock.value) return
      }
    } catch {
      return
    }
  }
  await bootstrap()
})

async function bootstrap() {
  await projects.load()
  // 未分类任务（today.json）一并恢复缓存，侧栏角标/今日计数在进入今日视图前也准确
  await tasks.loadFromIdb([...projects.projects.map((p) => p.id), UNCATEGORIZED])
  // 今日任务跨项目顺序表：先从本地缓存恢复（不访问 OSS），再交由同步轮询刷新
  await tasks.loadTodayOrder()
  // 登录/自动解锁完成后启动同步协调轮询（幂等）
  startSyncPoll()
  // 预取今年/明年的法定节假日安排（重复任务「每个法定工作日」用），失败静默走内置兜底
  void ensureLegalCalendar(new Date().getFullYear())
  void ensureLegalCalendar(new Date().getFullYear() + 1)
}

async function onUnlock() {
  if (!unlockPw.value) return
  unlocking.value = true
  unlockErr.value = ''
  try {
    await auth.login(auth.username, unlockPw.value, rememberPw.value)
    unlockPw.value = ''
    needsUnlock.value = false
    await bootstrap()
  } catch (e) {
    unlockErr.value = (e as Error).message || '解锁失败'
  } finally {
    unlocking.value = false
  }
}

async function openProject(id: string) {
  ui.closeDrawer()
  await router.push(`/project/${id}`)
  try {
    await tasks.loadProject(id)
  } catch (e) {
    ui.toast((e as Error).message || "任务加载失败，请检查网络或 OSS 配置", "error")
  }
}

function newProject() {
  ui.closeDrawer()
  projectModalOpen.value = true
}

async function onImported(list: Task[]) {
  const subCount = list.reduce((n, t) => n + t.subtasks.length, 0)
  // 确认式导入：涉及项目的任务全部落盘成功才提示（失败时 store 已回滚并弹错误提示）
  const ok = await tasks.bulkAddConfirmed(list)
  if (ok) ui.toast(`已导入 ${list.length} 个任务${subCount ? `（含 ${subCount} 个子任务）` : ''}`)
}
</script>

<template>
  <div class="h-full">
    <Sidebar @new-project="newProject" @open-project="openProject" @open-import="importModalOpen = true" />

    <div class="lg:ml-64 h-full flex flex-col">
      <header class="h-12 px-2 sm:px-4 flex items-center gap-1 sm:gap-2 bg-white border-b border-slate-100 lg:hidden">
        <button class="w-8 h-8 sm:w-9 sm:h-9 flex items-center justify-center text-lg" @click="ui.openDrawer()">☰</button>
        <span class="font-semibold text-sm sm:text-base min-w-0 truncate">{{ mobileActions.title || 'EasyTask' }}</span>
        <div class="ml-auto flex items-center gap-1 sm:gap-1.5">
          <button
            v-if="mobileActions.newTask"
            class="w-8 h-8 flex items-center justify-center rounded-lg bg-brand text-white text-base leading-none font-medium active:bg-brand-dark"
            title="新建任务"
            @click="mobileActions.newTask?.()"
          >
            ＋
          </button>
          <button
            class="w-8 h-8 flex items-center justify-center rounded-lg text-slate-500 hover:bg-slate-100 active:bg-slate-200 disabled:opacity-50"
            title="同步刷新"
            :disabled="syncing"
            @click="syncNow"
          >
            <span class="text-base leading-none" :class="syncing ? 'inline-block animate-spin' : ''">⟳</span>
          </button>
        </div>
      </header>
      <main
        ref="mainEl"
        class="flex-1 overflow-y-auto"
        :class="refreshState === 'pulling' ? '' : 'transition-transform duration-200'"
        :style="mainStyle"
      >
        <router-view @new-project="newProject" />
      </main>
    </div>

    <!-- 下拉刷新指示器（fixed 且 pointer-events-none，不遮挡操作） -->
    <div
      class="fixed top-0 inset-x-0 z-[45] flex justify-center pointer-events-none"
      :style="{ transform: `translateY(${refreshState !== 'idle' ? 6 : -64}px)` }"
    >
      <div class="mt-1 px-4 py-1.5 rounded-full bg-slate-800/90 text-white text-xs flex items-center gap-2 shadow-lg">
        <span
          v-if="refreshState === 'refreshing'"
          class="inline-block w-3 h-3 border-2 border-white/30 border-t-white rounded-full animate-spin"
        />
        <span
          v-else
          class="inline-block text-sm leading-none transition-transform duration-150"
          :class="refreshState === 'ready' ? 'rotate-180' : ''"
        >↓</span>
        <span>
          {{ refreshState === 'refreshing' ? '正在同步…' : refreshState === 'ready' ? '松开立即同步' : '下拉刷新' }}
        </span>
      </div>
    </div>

    <div
      v-if="needsUnlock"
      class="fixed inset-0 z-50 bg-slate-900/60 flex items-center justify-center px-4"
    >
      <form
        class="bg-white rounded-xl shadow-xl p-6 w-full max-w-sm"
        @submit.prevent="onUnlock"
      >
        <div class="text-lg font-semibold mb-1">重新解锁</div>
        <div class="text-sm text-slate-500 mb-4">
          页面已刷新，安全凭证锁定。请再次输入密码以解密 OSS / 邮箱凭证（仅保存在内存中）。
        </div>
        <input
          v-model="unlockPw"
          type="password"
          name="password"
          autocomplete="current-password"
          placeholder="登录密码"
          class="w-full border rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-brand/50"
        />
        <label class="mt-2 flex items-center gap-2 text-xs text-slate-500 select-none">
          <input type="checkbox" v-model="rememberPw" class="accent-brand" />
          在浏览器中保存密码（7 天内刷新免重复输入）
        </label>
        <div v-if="unlockErr" class="mt-2 text-sm text-red-500">{{ unlockErr }}</div>
        <button
          type="submit"
          :disabled="unlocking"
          class="mt-4 w-full bg-brand text-white rounded-lg py-2 text-sm font-medium disabled:opacity-60"
        >
          {{ unlocking ? '解锁中…' : '解锁' }}
        </button>
      </form>
    </div>

    <ProjectModal v-model:open="projectModalOpen" />
    <ImportModal v-model:open="importModalOpen" @imported="onImported" />


    <div v-if="ui.ossError" class="fixed inset-0 z-50 bg-slate-900/60 flex items-center justify-center px-4">
      <div class="bg-white rounded-xl shadow-xl p-6 w-full max-w-md">
        <div class="flex items-start gap-2">
          <span class="text-xl">⚠️</span>
          <div class="flex-1">
            <div class="text-base font-semibold text-red-600">{{ ui.ossError.title }}</div>
            <div class="mt-1 text-sm text-slate-700">{{ ui.ossError.hint }}</div>
          </div>
        </div>

        <div class="mt-4 rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-slate-700">
          <div v-if="ui.ossError.bucket" class="pb-1">Bucket：<span class="font-mono text-amber-800">{{ ui.ossError.bucket }}</span>（Region：{{ ui.ossError.region }}）</div>
          <div v-if="ui.ossError.code" class="py-0.5">OSS 错误码：<span class="font-mono text-amber-800">{{ ui.ossError.code }}</span></div>
          <div v-if="ui.ossError.status" class="py-0.5">HTTP 状态：<span class="font-mono text-amber-800">{{ ui.ossError.status }}</span></div>
          <div v-if="ui.ossError.message" class="py-0.5 break-words">服务端说明：<span class="font-mono text-amber-800">{{ ui.ossError.message }}</span></div>
          <div v-if="ui.ossError.request_id" class="pt-1 text-[11px] text-amber-500">RequestId：{{ ui.ossError.request_id }}</div>
          <div v-if="ui.ossError.cors_configured === false" class="pt-1 text-amber-700">Bucket 已连通但未配置 CORS，请允许当前前端域名 https://localhost:5173。</div>
        </div>

        <div class="mt-5 flex justify-end">
          <button
            class="px-4 py-2 rounded-lg text-sm text-white bg-red-500 hover:bg-red-600 font-medium"
            @click="ui.closeOssError()"
          >知道了</button>
        </div>
      </div>
    </div>
    <div class="fixed top-4 right-4 z-50 space-y-2">
      <div
        v-for="t in ui.toasts"
        :key="t.id"
        class="px-4 py-2 rounded-lg shadow-lg text-sm text-white cursor-pointer"
        :class="t.type === 'ok' ? 'bg-slate-800' : 'bg-red-500'"
        title="点击关闭"
        @click="ui.dismiss(t.id)"
      >
        {{ t.text }}
      </div>
    </div>
    <UploadIndicator />
  </div>
</template>


