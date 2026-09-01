<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useProjectsStore } from '@/stores/projects'
import { buildTasksFromImport, parseMarkdownImport } from '@/utils/markdownImport'
import type { Task } from '@/types'

const props = defineProps<{
  open: boolean
  /** 未显式指定项目的任务默认归入的项目 */
  projectId?: string
}>()
const emit = defineEmits<{
  'update:open': [boolean]
  imported: [Task[]]
}>()

const projects = useProjectsStore()
const md = ref('')
const targetProjectId = ref('')

function buildSample(): string {
  // 示例日期随今天动态生成，保证填入示例后能在「今日」视图看到
  const today = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  const d = `${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}`
  return `# 模板示例说明

# ============================================================

# 批量导入任务示例文件
#
# 本文件用于向任务管理系统批量导入任务、子任务及提醒。
# “#” 开头的行为注释，导入时会被自动忽略。
#
# ---- 基本结构说明 ----
# 1. 任务层级
# - “##” 开头表示一条主任务（或日历事件）
# - “###” 开头表示主任务下的子任务，可独立设置时间
#
# 2. 字段格式
# 使用“- 字段名：值”的形式描述任务属性，注意以下HH范围在0-23，支持的字段包括：
# - 开始：任务开始时间，格式 YYYY-MM-DD HH:MM
# - 截止：任务截止时间，格式 YYYY-MM-DD HH:MM
# - 提醒：提醒时间，格式 YYYY-MM-DD HH:MM
# - 项目：所属项目或分类名称
#
# 3. 子任务（勾选框）
# - 使用“- [ ] 内容”表示未完成的子任务
# - 使用“- [x] 内容”表示已完成的子任务
#
# 4. 备注与补充内容
# - 字段和勾选框之后、下一个标题之前的纯文本，
# 会作为该任务或子任务的描述/备注内容保留。
# - 支持多行文字和编号列表（如 1. 2. 3.）。
#
# ---- 示例阅读提示 ----
# 下方示例包含两条主任务：
# - “晨间开发”：带开始/截止/提醒时间、项目归属、子任务及嵌套子任务
# - “下午会议”：仅带提醒时间，备注中包含会议准备清单
# 你可以参照示例的结构增删自己的任务，保存后执行导入即可。
# ============================================================

## 晨间开发
- 开始：${d} 09:00
- 截止：${d} 12:00
- 提醒：${d} 08:30
- 项目：工作
- [ ] 写技术方案
- [x] 提交 PR
### 补充用例
- 开始：${d} 10:00
- 截止：${d} 11:30
补充的描述文字

## 下午会议
- 提醒：${d} 13:50
准备周会材料，逐条列出：
1. 同步项目进度
2. 确认下个迭代范围

# ============================================================

# 以上是我的批量导入任务的示例模板和模板解释，请你帮我写一个批量导入任务的文本，以下是我的需求：

`
}

watch(
  () => props.open,
  (v) => {
    if (!v) return
    md.value = ''
    targetProjectId.value = props.projectId ?? projects.projects[0]?.id ?? ''
  },
)

const preview = computed(() => {
  const result = parseMarkdownImport(md.value)
  const subtaskCount = result.tasks.reduce((n, t) => n + t.subtasks.length, 0)
  return { ...result, subtaskCount }
})

/** 默认项目的名称（预览时展示未指定项目的任务归属） */
const defaultProjectName = computed(
  () => projects.projects.find((p) => p.id === targetProjectId.value)?.name ?? '',
)

/** ISO -> "YYYY-MM-DD HH:mm"，空值显示占位符 */
function fmtTime(iso: string): string {
  if (!iso) return '—'
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)}`
}

function fillSample() {
  md.value = buildSample()
}

function close() {
  emit('update:open', false)
}

function confirmImport() {
  const { tasks } = buildTasksFromImport(preview.value, {
    projects: projects.projects,
    defaultProjectId: targetProjectId.value,
  })
  if (!tasks.length) return
  emit('imported', tasks)
  close()
}
</script>

<template>
  <div v-if="open" class="fixed inset-0 z-50 bg-slate-900/50 flex items-center justify-center px-4">
    <div class="bg-white rounded-xl shadow-xl p-6 w-full max-w-2xl max-h-[90vh] overflow-y-auto">
      <div class="flex items-center justify-between">
        <div class="text-base font-semibold">📥 批量导入任务（Markdown）</div>
        <button class="text-xs text-slate-400 hover:text-brand" @click="fillSample">填入示例</button>
      </div>

      <div class="mt-3 text-xs text-slate-500 space-y-1">
        <p>• <code class="text-slate-700 bg-slate-100 px-1 rounded">## 任务名</code> 开始一个新任务</p>
        <p>• 任务下用 <code class="text-slate-700 bg-slate-100 px-1 rounded">- 开始：2026-08-18 09:00</code> 设置开始 / 截止 / 提醒 / 项目（支持 <code class="text-slate-700 bg-slate-100 px-1 rounded">- [ ]</code> 或 <code class="text-slate-700 bg-slate-100 px-1 rounded">- [x]</code> 简单子任务）</p>
        <p>• <code class="text-slate-700 bg-slate-100 px-1 rounded">### 子任务名</code> 开始带时间/描述的子任务</p>
        <p>• 文档里没有 <code class="text-slate-700 bg-slate-100 px-1 rounded">##</code> 时，每行 <code class="text-slate-700 bg-slate-100 px-1 rounded">- [ ]</code> 视为一个顶层任务</p>
      </div>

      <div class="mt-3">
        <label class="text-xs text-slate-500 block mb-1">未指定项目时的默认项目</label>
        <select v-model="targetProjectId" class="w-full border rounded-lg px-3 py-2 text-sm bg-white">
          <option v-for="p in projects.projects" :key="p.id" :value="p.id">{{ p.name }}</option>
        </select>
      </div>

      <div class="mt-3">
        <label class="text-xs text-slate-500 block mb-1">Markdown 内容</label>
        <textarea
          v-model="md"
          rows="10"
          class="w-full border rounded-lg px-3 py-2 text-sm font-mono outline-none focus:ring-2 focus:ring-brand/50 resize-y"
          placeholder="粘贴 Markdown 任务清单…"
        />
      </div>

      <div class="mt-3 text-sm">
        <span v-if="preview.tasks.length" class="text-slate-700">
          解析到 <b class="text-brand">{{ preview.tasks.length }}</b> 个任务（含 {{ preview.subtaskCount }} 个子任务），请检查无误后再导入
        </span>
        <span v-else class="text-slate-400">等待输入内容…</span>
      </div>

      <div v-if="preview.tasks.length" class="mt-2 rounded-lg border border-slate-200 overflow-hidden">
        <div class="px-3 py-2 bg-slate-50 text-xs font-semibold text-slate-600 border-b border-slate-200">
          导入预览
        </div>
        <div class="max-h-56 overflow-y-auto divide-y divide-slate-100">
          <div v-for="(t, ti) in preview.tasks" :key="ti" class="px-3 py-2 text-xs">
            <div class="flex items-center gap-2">
              <span class="font-medium text-slate-800 truncate">{{ t.name }}</span>
              <span class="shrink-0 text-slate-400">{{ t.projectName || defaultProjectName }}</span>
            </div>
            <div class="mt-0.5 flex flex-wrap gap-x-3 gap-y-0.5 text-slate-500">
              <span>开始 {{ fmtTime(t.startTime) }}</span>
              <span>截止 {{ fmtTime(t.endTime) }}</span>
              <span v-if="t.reminderTime">提醒 {{ fmtTime(t.reminderTime) }}</span>
              <span v-if="t.subtasks.length">{{ t.subtasks.length }} 个子任务</span>
            </div>
          </div>
        </div>
      </div>

      <div v-if="preview.warnings.length" class="mt-2 text-xs text-amber-600 space-y-0.5 max-h-28 overflow-y-auto">
        <div v-for="(w, i) in preview.warnings" :key="i">⚠ {{ w }}</div>
      </div>

      <div class="flex justify-end gap-2 pt-4">
        <button type="button" class="px-4 py-2 rounded-lg text-sm text-slate-600 hover:bg-slate-100" @click="close">
          取消
        </button>
        <button
          type="button"
          class="px-4 py-2 rounded-lg text-sm text-white bg-brand hover:bg-brand-dark font-medium disabled:opacity-40"
          :disabled="!preview.tasks.length"
          @click="confirmImport"
        >
          导入 {{ preview.tasks.length || '' }} 个任务
        </button>
      </div>
    </div>
  </div>
</template>
