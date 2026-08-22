<script setup lang="ts">
import { computed, inject, onMounted, onUnmounted, ref, watch } from 'vue'
import { useAuthStore } from '@/stores/auth'
import { useProjectsStore } from '@/stores/projects'
import { useTasksStore } from '@/stores/tasks'
import { useUiStore } from '@/stores/ui'
import ConfirmDialog from '@/components/ConfirmDialog.vue'
import { formatTodayTitle } from '@/utils/time'
import { logAudit } from '@/utils/audit'
import { UNCATEGORIZED, type DeletedProject, type Task } from '@/types'

const auth = useAuthStore()
const projects = useProjectsStore()
const tasks = useTasksStore()
const ui = useUiStore()

const mobileActions = inject<{ title: string } | null>('mobile-actions', null)

const deleteTarget = ref<Task | null>(null)
const scanning = ref(false)
/** 扫描前回收站不显示任何内容（文件未加载，内存中的已完成任务也不展示） */
const scanned = ref(false)
/** 扫描结果：存在回收站文件的项目 id（仅元数据，未下载文件内容） */
const scanIds = ref<string[]>([])
const scanHasUncategorized = ref(false)

/** 项目展开状态：默认全部折叠。按用户记忆到 localStorage（登出换账号互不干扰） */
const expandedKey = () => `trash_expanded:${auth.username}`
const expanded = ref<Record<string, boolean>>({})
function loadExpanded() {
  try {
    expanded.value = JSON.parse(localStorage.getItem(expandedKey()) ?? '{}')
  } catch {
    expanded.value = {}
  }
}
function isExpanded(key: string) {
  return !!expanded.value[key]
}

/** 展开后正在按需加载回收站文件的项目 id（加载失败可再次点击项目名重试） */
const loading = ref<Record<string, boolean>>({})
const loadError = ref<Record<string, boolean>>({})

/** 展开项目时只打开当前项目的数据包：仅加载该项目回收站文件，其余保持未加载 */
async function openGroup(key: string) {
  if (tasks.trashLoaded.includes(key) || loading.value[key]) return
  loading.value = { ...loading.value, [key]: true }
  loadError.value = { ...loadError.value, [key]: false }
  try {
    await tasks.loadTrash(key)
  } catch (e) {
    loadError.value = { ...loadError.value, [key]: true }
    ui.toast((e as Error).message || '回收站文件加载失败，请检查网络或 OSS 配置', 'error')
  } finally {
    loading.value = { ...loading.value, [key]: false }
  }
}

function toggleGroup(key: string) {
  const next = !isExpanded(key)
  expanded.value = { ...expanded.value, [key]: next }
  localStorage.setItem(expandedKey(), JSON.stringify(expanded.value))
  if (next) void openGroup(key)
}

/** 只读本地基础数据：档案（活跃/已删除项目），不预载任何回收站文件内容 */
async function loadTrashBase() {
  if (!projects.loaded) await projects.load()
}

const MOBILE_TITLE = '回收站'
onMounted(async () => {
  if (mobileActions) mobileActions.title = MOBILE_TITLE
  loadExpanded()
  await loadTrashBase()
  logAudit('打开回收站')
})
onUnmounted(() => {
  if (mobileActions && mobileActions.title === MOBILE_TITLE) mobileActions.title = ''
})

watch(
  () => auth.creds,
  async (c) => {
    // 切换账号/登出时清空上一账号的扫描结果，避免串数据
    scanned.value = false
    scanIds.value = []
    scanHasUncategorized.value = false
    if (c) {
      loadExpanded()
      await loadTrashBase()
    }
  },
)

/** 用户主动点击才扫描回收站：只枚举哪些项目存在回收站文件（元数据），不下载任何文件内容 */
async function scanTrash() {
  if (scanning.value) return
  scanning.value = true
  try {
    if (!projects.loaded) await projects.load()
    const res = await tasks.listTrashProjects()
    if (res.listed) {
      scanIds.value = res.ids
      scanHasUncategorized.value = res.hasUncategorized
    } else {
      // 无 list 权限：降级为全部已知项目（展开时仍按需加载，空项目展开显示为空）
      scanIds.value = projects.projects.map((p) => p.id)
      scanHasUncategorized.value = true
    }
    scanned.value = true
    ui.toast('回收站已扫描')
    logAudit('扫描回收站', `发现 ${scanIds.value.length} 个项目的回收站文件`)
  } catch (e) {
    ui.toast((e as Error).message || '回收站扫描失败，请检查网络或 OSS 配置', 'error')
  } finally {
    scanning.value = false
  }
}

interface TrashGroup {
  key: string
  label: string
  deleted: boolean
  /** 已删除项目元数据（供「恢复整个项目」使用） */
  deletedProject: DeletedProject | null
  tasks: Task[]
  /** 该项目的回收站文件是否已加载 */
  loaded: boolean
}

/** 回收站按项目分组：展开时才加载该项目文件；活跃项目（有回收站）在前，已删除项目（可整项目恢复）其次，未分类/孤儿归入末尾 */
const projectGroups = computed<TrashGroup[]>(() => {
  if (!scanned.value) return []
  const seen = new Set<string>()
  const groups: TrashGroup[] = []
  const push = (key: string, label: string, deleted: boolean, deletedProject: DeletedProject | null) => {
    if (seen.has(key)) return
    seen.add(key)
    const arr = (tasks.trash[key] ?? []).slice().sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    groups.push({ key, label, deleted, deletedProject, tasks: arr, loaded: tasks.trashLoaded.includes(key) })
  }
  // 活跃项目：仅在扫描发现有回收站文件、或本地已加载过其回收站数据时展示
  for (const p of projects.projects) {
    if (scanIds.value.includes(p.id) || (tasks.trash[p.id]?.length ?? 0) > 0) {
      push(p.id, p.name, false, null)
    }
  }
  // 已删除项目：始终展示（支持整项目恢复），即使回收站文件为空
  const deletedList = [...(projects.deletedProjects ?? [])].sort((a, b) => b.deletedAt.localeCompare(a.deletedAt))
  for (const dp of deletedList) push(dp.id, dp.name, true, dp)
  // 未分类回收站（today_trash.json）
  if (scanHasUncategorized.value || (tasks.trash[UNCATEGORIZED]?.length ?? 0) > 0) {
    push(UNCATEGORIZED, '无分类', false, null)
  }
  // 扫描发现但不在档案中的历史项目（孤儿回收站）
  for (const pid of scanIds.value) {
    if (projects.byId(pid)) continue
    if ((projects.deletedProjects ?? []).some((x) => x.id === pid)) continue
    push(pid, `未知项目（${pid.slice(0, 8)}…）`, false, null)
  }
  return groups
})

const projectOf = (id: string) => (id ? projects.byId(id) : undefined)

function restore(t: Task) {
  let toProjectId: string | undefined
  // 若任务的原项目已被删除（孤儿任务），恢复时必须归入现有项目，
  // 否则会写入已删除项目的 tasks.json，刷新后任何视图都读不到。
  if (t.projectId && !projects.byId(t.projectId)) {
    const fallback = projects.projects[0]
    if (fallback) {
      toProjectId = fallback.id
    } else {
      const p = projects.addProject('恢复的任务')
      toProjectId = p.id
    }
  }
  tasks.restore(t.id, toProjectId)
  ui.toast('已恢复')
}

/** 恢复整个项目：无重名时还原为独立项目，重名时并入同名项目 */
async function restoreProjectGroup(g: TrashGroup) {
  if (!g.deletedProject) return
  const target = await projects.restoreProject(g.deletedProject.id)
  if (target) ui.toast('项目已恢复')
  else ui.toast('项目恢复失败', 'error')
}

function askDelete(t: Task) {
  deleteTarget.value = t
}

function confirmDelete() {
  if (!deleteTarget.value) return
  tasks.permanentDelete(deleteTarget.value.projectId, deleteTarget.value.id)
  deleteTarget.value = null
  ui.toast('已永久删除')
}
</script>

<template>
  <div class="p-4 sm:p-6 max-w-3xl mx-auto">
    <h1 class="hidden lg:block text-xl font-bold text-slate-800">🗑 回收站</h1>
    <div class="mt-0.5 flex items-center justify-between gap-3">
      <div class="text-xs text-slate-400">被删除的任务与项目，永不自动清理。扫描只列出有回收站文件的项目，展开项目时才加载对应文件</div>
      <button
        class="shrink-0 px-3 py-1.5 rounded-lg text-xs border border-slate-200 hover:bg-slate-50 disabled:opacity-60"
        :disabled="scanning"
        @click="scanTrash"
      >
        {{ scanning ? '扫描中…' : '📥 扫描回收站文件' }}
      </button>
    </div>

    <div v-if="!projectGroups.length" class="mt-4 py-16 text-center text-sm text-slate-400">
      {{ scanned ? '未发现回收站文件' : '回收站未扫描，点击右上角「扫描回收站文件」后可见历史任务' }}
    </div>
    <div v-for="g in projectGroups" :key="g.key" class="mt-4">
      <div class="flex items-center gap-2 mb-2">
        <button
          class="flex items-center gap-2 flex-1 min-w-0 px-0.5 py-1 rounded-lg hover:bg-slate-50 text-left"
          :title="isExpanded(g.key) ? '点击折叠' : '点击展开并加载该项目回收站'"
          @click="toggleGroup(g.key)"
        >
          <span class="w-4 text-center text-slate-400 text-xs shrink-0">{{ isExpanded(g.key) ? '▾' : '▸' }}</span>
          <span class="text-sm font-medium text-slate-600 truncate">{{ g.label }}</span>
          <span v-if="g.deleted" class="shrink-0 text-[11px] text-slate-400">已删除项目</span>
          <span class="shrink-0 text-[11px] text-slate-400">
            <template v-if="g.loaded">（{{ g.tasks.length }}）</template>
            <template v-else-if="loading[g.key]">加载中…</template>
            <template v-else>（…）</template>
          </span>
        </button>
        <button
          v-if="g.deleted"
          class="shrink-0 px-3 py-1 rounded-lg text-xs text-brand border border-brand/30 hover:bg-brand/5"
          title="恢复整个项目（重名时自动合并进同名项目）"
          @click="restoreProjectGroup(g)"
        >
          ↺ 恢复整个项目
        </button>
      </div>
      <div v-if="isExpanded(g.key)" class="space-y-2">
        <div v-if="loading[g.key]" class="px-0.5 py-2 text-xs text-slate-400">正在加载该项目的回收站文件…</div>
        <template v-else>
          <div v-if="loadError[g.key]" class="px-0.5 py-2 text-xs text-red-500">加载失败，点击项目名可重试</div>
          <div
            v-for="t in g.tasks"
            :key="t.id"
            class="bg-white rounded-xl shadow-sm border border-slate-100 p-4 flex items-center gap-3"
          >
            <div class="flex-1 min-w-0">
              <div class="flex items-center gap-2">
                <span class="text-sm font-medium text-slate-700 truncate">{{ t.name }}</span>
                <span
                  class="text-[11px] px-1.5 py-0.5 rounded-full shrink-0"
                  :class="t.status === 'deleted' ? 'bg-red-50 text-red-500' : 'bg-slate-100 text-slate-500'"
                >
                  {{ t.status === 'deleted' ? '已删除' : '已完成' }}
                </span>
              </div>
              <div class="mt-1 flex flex-wrap gap-x-4 text-[11px] text-slate-400">
                <span>{{ t.projectId ? (projectOf(t.projectId)?.name ?? '未知项目') : '无分类' }}</span>
                <span>{{ formatTodayTitle(t.updatedAt) }}</span>
              </div>
            </div>
            <button
              class="px-3 py-1.5 rounded-lg text-xs text-brand border border-brand/30 hover:bg-brand/5 shrink-0"
              @click="restore(t)"
            >
              恢复
            </button>
            <button
              class="px-3 py-1.5 rounded-lg text-xs text-red-500 border border-red-200 hover:bg-red-50 shrink-0"
              @click="askDelete(t)"
            >
              永久删除
            </button>
          </div>
          <div v-if="!loadError[g.key] && !g.tasks.length" class="text-xs text-slate-400 px-0.5">
            {{ g.deleted ? '该项目没有任务' : '该项目回收站为空' }}
          </div>
        </template>
      </div>
    </div>

    <ConfirmDialog
      :open="!!deleteTarget"
      title="永久删除"
      message="永久删除后无法恢复，确定继续吗？"
      confirm-text="永久删除"
      :danger="true"
      @confirm="confirmDelete"
      @cancel="deleteTarget = null"
    />
  </div>
</template>
