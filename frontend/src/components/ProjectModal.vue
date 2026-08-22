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

watch(
  () => props.open,
  (v) => {
    if (!v) return
    editingId.value = props.projectId ?? null
    const p = props.projectId ? projects.byId(props.projectId) : undefined
    name.value = p?.name ?? ''
    err.value = ''
  },
)

function close() {
  emit('update:open', false)
}

function submit() {
  if (!name.value.trim()) {
    err.value = '请输入项目名称'
    return
  }
  if (name.value.trim().length > 50) {
    err.value = '项目名称不能超过 50 个字符'
    return
  }
  if (editingId.value) {
    projects.renameProject(editingId.value, name.value.trim())
    ui.toast('项目已重命名')
  } else {
    const p = projects.addProject(name.value.trim())
    ui.toast('项目已创建')
    close()
    router.push(`/project/${p.id}`)
    return
  }
  close()
}

function askDelete() {
  confirmDeleteOpen.value = true
}

function confirmDelete() {
  if (!editingId.value) return
  projects.deleteProject(editingId.value)
  confirmDeleteOpen.value = false
  close()
  ui.toast('项目已删除，任务进入回收站')
  router.push('/today')
}
</script>

<template>
  <div v-if="open" class="fixed inset-0 z-50 bg-slate-900/50 flex items-center justify-center px-4">
    <div class="bg-white rounded-xl shadow-xl p-6 w-full max-w-sm">
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
          <button type="button" class="px-4 py-2 rounded-lg text-sm text-slate-600 hover:bg-slate-100" @click="close">
            取消
          </button>
          <button
            v-if="editingId"
            type="button"
            class="px-4 py-2 rounded-lg text-sm text-red-500 hover:bg-red-50"
            @click="askDelete"
          >
            删除
          </button>
          <button type="submit" class="px-4 py-2 rounded-lg text-sm text-white bg-brand hover:bg-brand-dark font-medium">
            保存
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
    @confirm="confirmDelete"
    @cancel="confirmDeleteOpen = false"
  />
</template>
