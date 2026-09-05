<script setup lang="ts">
import { ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import ConfirmDialog from '@/components/ConfirmDialog.vue'
import { useProjectsStore } from '@/stores/projects'
import { useUiStore } from '@/stores/ui'

const props = defineProps<{ open: boolean; projectId?: string }>()
const emit = defineEmits<{ 'update:open': [boolean] }>()

const projects = useProjectsStore()
const ui = useUiStore()
const router = useRouter()

const editingId = ref<string | null>(null)
const name = ref('')
const err = ref('')
const confirmDeleteOpen = ref(false)
/** 保存已提交（后台写 OSS 中）：仅用于防重复提交，弹窗已立即关闭 */
const saving = ref(false)

watch(
  () => props.open,
  (v) => {
    if (!v) return
    editingId.value = props.projectId ?? null
    const p = props.projectId ? projects.byId(props.projectId) : undefined
    name.value = p?.name ?? ''
    err.value = ''
    saving.value = false
  },
)

function close() {
  emit('update:open', false)
}

async function submit() {
  // 确认式保存进行中，禁止重复提交
  if (saving.value) return
  if (!name.value.trim()) {
    err.value = '请输入项目名称'
    return
  }
  if (name.value.trim().length > 50) {
    err.value = '项目名称不能超过 50 个字符'
    return
  }
  // 点保存立即关闭弹窗；提示由回显后的 toast 负责（成功才提示，失败回滚并弹错误提示）
  saving.value = true
  emit('update:open', false)
  try {
    if (editingId.value) {
      // 确认式重命名：OSS 落盘成功才提示
      const ok = await projects.renameProjectConfirmed(editingId.value, name.value.trim())
      if (!ok) {
        // store 已弹错误提示
        return
      }
      ui.toast('项目已重命名')
    } else {
      // 确认式新建：OSS 落盘成功才提示并跳转
      const p = await projects.addProjectConfirmed(name.value.trim())
      if (!p) {
        // store 已弹错误提示
        return
      }
      ui.toast('项目已创建')
      router.push(`/project/${p.id}`)
    }
  } finally {
    saving.value = false
  }
}

function askDelete() {
  if (saving.value) return
  confirmDeleteOpen.value = true
}

async function confirmDelete() {
  if (!editingId.value) return
  const pid = editingId.value
  // 确认按钮前端立即生效：关删除框 + 关闭编辑框并跳转；保存结果由回显后的 toast 提示
  confirmDeleteOpen.value = false
  close()
  router.push('/today')
  const ok = await projects.deleteProject(pid)
  if (ok) ui.toast('项目已删除，任务进入回收站')
}
</script>

<template>
  <div v-if="open" class="fixed inset-0 z-50 bg-slate-900/55 backdrop-blur-sm flex items-center justify-center px-4">
    <div class="modal-panel rounded-2xl p-6 w-full max-w-sm animate-modal-pop">
      <div class="text-base font-semibold">{{ editingId ? '重命名项目' : '新建项目' }}</div>
      <form @submit.prevent="submit">
        <input
          v-model="name"
          maxlength="50"
          placeholder="项目名称"
          autofocus
          class="mt-3 w-full border rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-brand/50"
        />
        <div v-if="err" class="mt-2 text-sm text-red-500">{{ err }}</div>
        <div class="mt-5 flex justify-end gap-2">
          <button type="button" class="px-4 py-2 rounded-lg text-sm text-slate-600 hover:bg-slate-100 disabled:opacity-50" :disabled="saving" @click="close">
            取消
          </button>
          <button
            v-if="editingId"
            type="button"
            class="px-4 py-2 rounded-lg text-sm text-red-500 hover:bg-red-50 disabled:opacity-50"
            :disabled="saving"
            @click="askDelete"
          >
            删除
          </button>
          <button type="submit" class="px-4 py-2 rounded-lg text-sm text-white bg-brand hover:bg-brand-dark font-medium disabled:opacity-60" :disabled="saving">
            {{ saving ? '保存中…' : '保存' }}
          </button>
        </div>
      </form>
    </div>
  </div>

  <ConfirmDialog
    :open="confirmDeleteOpen"
    title="删除项目"
    message="项目及其下所有任务将移入回收站，可在回收站「恢复整个项目」（重名时自动合并）。确定删除吗？"
    confirm-text="删除"
    :danger="true"
    :disabled="saving"
    @confirm="confirmDelete"
    @cancel="confirmDeleteOpen = false"
  />
</template>
