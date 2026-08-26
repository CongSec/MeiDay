<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { VueDraggable } from 'vue-draggable-plus'
import { getDragOptions } from '@/utils/drag'
import { useAuthStore } from '@/stores/auth'
import { useProjectsStore } from '@/stores/projects'
import { useTasksStore } from '@/stores/tasks'
import { useUiStore } from '@/stores/ui'
import { setDiaryEntryIntent } from '@/utils/diarySession'
import type { Project } from '@/types'

const emit = defineEmits<{ 'new-project': []; 'open-project': [id: string]; 'open-import': [] }>()

const auth = useAuthStore()
const projects = useProjectsStore()
const tasks = useTasksStore()
const ui = useUiStore()
const route = useRoute()
const router = useRouter()

const navClass = (active: boolean) =>
  `flex items-center gap-2 px-3 py-2 rounded-lg text-sm cursor-pointer transition ${
    active ? 'bg-brand/10 text-brand font-medium' : 'text-slate-600 hover:bg-slate-200'
  }`

async function onLogout() {
  await auth.logout()
  ui.closeDrawer()
  router.push('/login')
}

/** 隐私日记模式入口：未配置 OSS 凭证时提示并停留；否则置进入意图后进入独立路由。
 *  刷新后自动解锁是异步的，若用户立即点击本按钮而凭证尚未恢复，先等自动解锁完成，
 *  避免误报“请先在设置中配置 OSS 存储”。 */
async function goDiary() {
  // 有 token 但会话密钥未派生（自动解锁尚未完成）：尝试补齐解锁，失败则按未配置凭证处理
  if (auth.token && !auth.userKey) {
    try {
      if (!auth.username) await auth.fetchMe()
      await auth.tryAutoUnlock()
    } catch {
      /* 解锁失败不阻塞：下面统一按凭证缺失提示 */
    }
  }
  if (!auth.creds) {
    ui.toast('请先在设置中配置 OSS 存储', 'error')
    ui.closeDrawer()
    return
  }
  setDiaryEntryIntent(true)
  ui.closeDrawer()
  router.push('/diary')
}

const canEditProjects = computed(() => !!auth.username)

/** 项目拖拽列表（全部项目均可拖动排序） */
const activeDrag = ref<Project[]>([])

/** 统一拖拽参数（触屏 fallback 拖拽更丝滑） */
const dragOptions = getDragOptions()
watch(
  () => projects.projects,
  () => {
    activeDrag.value = projects.projects
  },
  { immediate: true },
)
function onActiveDragEnd() {
  projects.setOrder([...activeDrag.value])
}
</script>

<template>
  <div
    class="fixed inset-y-0 left-0 z-40 w-64 bg-white shadow-lg flex flex-col transition-transform duration-200 lg:translate-x-0"
    :class="ui.drawerOpen ? 'translate-x-0' : '-translate-x-full'"
  >
    <div class="px-5 py-4 flex items-center justify-between border-b border-slate-100">
      <div class="flex items-center gap-2">
        <img src="/logo.png" alt="EasyTask" class="h-7 w-7 rounded-lg object-cover" />
        <span class="text-lg font-bold text-slate-800">EasyTask</span>
      </div>
      <button class="lg:hidden text-slate-400 hover:text-slate-600" @click="ui.closeDrawer()">✕</button>
    </div>

    <div class="flex-1 overflow-y-auto px-3 py-3">
      <div class="mb-1 text-xs text-slate-400 px-3">视图</div>
      <router-link :to="'/today'" :class="navClass(route.path === '/today')" @click="ui.closeDrawer()">
        <span>📅</span> 今日任务
        <span
          v-if="tasks.todayCount"
          class="ml-auto shrink-0 text-[11px] bg-brand text-white rounded-full px-1.5 py-0.5"
        >
          {{ tasks.todayCount }}
        </span>
      </router-link>

      <div class="mt-5 mb-1 flex items-center justify-between px-3">
        <span class="text-xs text-slate-400">项目</span>
        <button
          v-if="canEditProjects"
          title="新建项目"
          class="text-slate-400 hover:text-brand text-sm px-1"
          @click="$emit('new-project')"
        >
          ＋
        </button>
      </div>
      <VueDraggable
        v-model="activeDrag"
        v-bind="dragOptions"
        handle=".drag-handle"
        class="space-y-0.5"
        @end="onActiveDragEnd"
      >
        <div
          v-for="p in activeDrag"
          :key="p.id"
          class="group flex items-center gap-2 px-3 py-2 rounded-lg cursor-pointer text-sm"
          :class="route.params.id === p.id ? 'bg-brand/10 text-brand font-medium' : 'text-slate-600 hover:bg-slate-200'"
          @click="$emit('open-project', p.id)"
        >
          <span
            class="drag-handle text-slate-300 group-hover:text-slate-500 cursor-grab text-sm leading-none select-none"
            title="拖动排序"
          >☰</span>
          <span class="flex-1 truncate">{{ p.name }}</span>
          <span
            v-if="projects.countBy(p.id)"
            class="shrink-0 text-[11px] bg-brand text-white rounded-full px-1.5 py-0.5"
          >
            {{ projects.countBy(p.id) }}
          </span>
        </div>
      </VueDraggable>

      <div v-if="!projects.projects.length" class="px-3 py-2 text-xs text-slate-400">暂无项目</div>
    </div>

    <div class="border-t border-slate-100 px-3 py-2 space-y-0.5">
      <button
        class="flex items-center gap-2 px-3 py-2 rounded-lg text-sm text-slate-600 hover:bg-slate-200 w-full"
        title="隐私日记模式"
        @click="goDiary"
      >
        <span>🔒</span> 隐私日记模式
      </button>
      <button
        class="flex items-center gap-2 px-3 py-2 rounded-lg text-sm text-slate-600 hover:bg-slate-200 w-full"
        title="批量导入"
        @click="ui.closeDrawer(); $emit('open-import')"
      >
        <span>📥</span> 批量导入
      </button>
      <router-link :to="'/settings'" :class="navClass(route.path === '/settings')" @click="ui.closeDrawer()">
        <span>⚙️</span> 设置
      </router-link>
      <div class="flex items-center justify-between px-3 py-2 text-xs text-slate-400">
        <span class="truncate">{{ auth.username }}</span>
        <button class="hover:text-red-500" @click="onLogout">↩ 退出</button>
      </div>
    </div>
  </div>

  <div
    v-if="ui.drawerOpen"
    class="fixed inset-0 z-30 bg-black/30 lg:hidden"
    @click="ui.closeDrawer()"
  />
</template>
