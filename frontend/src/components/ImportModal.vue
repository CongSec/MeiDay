<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useProjectsStore } from '@/stores/projects'
import { buildTasksFromImport, parseMarkdownImport } from '@/utils/markdownImport'
import type { Task } from '@/types'
import AppIcon from '@/components/AppIcon.vue'

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

function todayStr(): string {
  // 今天的日期 YYYY-MM-DD，保证填入示例后能在「今日」视图看到
  const today = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}`
}

function buildSample(): string {
  // 标准导入示例：可直接导入，`#` 开头为注释会被忽略
  const d = todayStr()
  return `# 批量导入示例（本行 # 标题会被忽略）

## 晨间开发

- 开始：${d} 09:00
- 截止：${d} 12:00
- 提醒：${d} 08:30
- 项目：工作

### 写技术方案

- 截止：${d} 11:00
  先调研现有方案，再输出初稿

### 提交 PR

- 截止：${d} 11:30
  自测通过后提交代码评审

## 下午会议

- 提醒：${d} 13:50
  准备周会材料，逐条列出：

1. 同步项目进度
2. 确认下个迭代范围
`
}

function buildAiPrompt(): string {
  // AI 提示词模板：复制到 AI 生成批量导入文本（含可替换的 {{用户需求描述}} 占位）
  const d = todayStr()
  return `# 任务：生成任务管理系统批量导入文本

## 角色设定

你是一个“任务管理系统导入助手”，专门负责将用户的自然语言需求，精准转化为系统支持的批量导入文本。你必须严格遵守下方的模板规则，不能有任何偏差,请你在回答前先向我提问，要求一次只问一个问题，请根据我的回答继续追问,直到你有95%的信心,完全理解我的真实需求和目标,再给出最终文本。

## 核心规则（最高优先级，必须死记）

在生成内容前，请先自检以下规则：

1. **层级限制**：仅支持“主任务（##）”和“子任务（###）”的二级结构。子任务只能用三级标题（###）创建，严禁使用 \`- [ ]\` 勾选框创建任务或子任务，严禁出现三级结构（子任务下不能再有子任务）。
2. **子任务数量逻辑**：
   - 主任务下若要创建子任务，数量必须 ≥ 2。
3. **字段规范**：
   - 支持的字段：开始、截止、提醒、项目。时间格式必须为 \`YYYY-MM-DD HH:MM\`（HH为0-23）。
   - **项目字段**：除非用户明确提到“项目”或分类名称，否则绝对不要填写该字段。
4. **重复任务**：多个同类型的重复任务，应合并到一个子任务中，不要拆分成多个。
5. **备注处理**：字段之后、下一个标题之前的纯文本，自动视为描述/备注，支持多行和编号列表。

## 标准模板示例

以下是格式参考，你的输出必须与其保持一致：

## 晨间开发

- 开始：${d} 09:00
- 截止：${d} 12:00
- 提醒：${d} 08:30
- 项目：工作

### 写技术方案

- 截止：${d} 11:00
  先调研现有方案，再输出初稿

### 提交 PR

- 截止：${d} 11:30
  自测通过后提交代码评审

## 下午会议

- 提醒：${d} 13:50
  准备周会材料，逐条列出：

1. 同步项目进度
2. 确认下个迭代范围

## 用户输入

请根据以上规则和示例，为以下需求生成批量导入文本。
**要求：仅输出最终的导入文本，不要包含任何解释、问候，最终输出前请仔细检查下核心规则再返回，最终输出请放入Markdown代码块标签。**
{{用户需求描述}}
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

function fillAiPrompt() {
  md.value = buildAiPrompt()
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
  <div v-if="open" class="fixed inset-0 z-50 bg-slate-900/55 backdrop-blur-sm flex items-center justify-center px-4">
    <div class="modal-panel rounded-2xl p-6 w-full max-w-2xl max-h-[90vh] overflow-y-auto animate-modal-pop">
      <div class="flex items-center justify-between">
        <div class="text-base font-semibold flex items-center gap-2"><span class="w-7 h-7 rounded-lg bg-brand/10 text-brand flex items-center justify-center"><AppIcon name="download" :size="15" /></span>批量导入任务（Markdown）</div>
        <div class="flex items-center gap-2">
          <button class="text-xs text-slate-400 hover:text-brand" @click="fillAiPrompt">填入AI提示词</button>
          <button class="text-xs text-slate-400 hover:text-brand" @click="fillSample">填入示例</button>
        </div>
      </div>

      <div class="mt-3 text-xs text-slate-500 space-y-1">
        <p>• <code class="text-slate-700 bg-slate-100 px-1 rounded">## 任务名</code> 开始一个新任务</p>
        <p>• 任务下用 <code class="text-slate-700 bg-slate-100 px-1 rounded">- 开始：2026-08-18 09:00</code> 设置开始 / 截止 / 提醒 / 项目</p>
        <p>• <code class="text-slate-700 bg-slate-100 px-1 rounded">### 子任务名</code> 开始带时间/描述的子任务（子任务只能通过三级标题创建）</p>
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
        <div v-for="(w, i) in preview.warnings" :key="i" class="inline-flex items-start gap-1"><AppIcon name="warning" :size="13" class="mt-0.5 shrink-0" />{{ w }}</div>
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
