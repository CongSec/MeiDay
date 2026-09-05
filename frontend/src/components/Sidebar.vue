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
import logo from '@/assets/logo.png'
import AppIcon from '@/components/AppIcon.vue'

const emit = defineEmits<{ 'new-project': []; 'open-project': [id: string]; 'open-import': [] }>()

const auth = useAuthStore()
const projects = useProjectsStore()
const tasks = useTasksStore()
const ui = useUiStore()
const route = useRoute()
const router = useRouter()

const navClass = (active: boolean) =>
  `relative flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm cursor-pointer transition ${
    active ? 'bg-brand/10 text-brand font-medium' : 'text-slate-600 hover:bg-slate-100'
  }`

// 导航高亮类改为 computed：仅在 route.path 变化时重算，避免每次渲染重复执行
const navTodayClass = computed(() => navClass(route.path === '/today'))
const navSettingsClass = computed(() => navClass(route.path === '/settings'))

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
    // 拷贝一份，避免拖拽组件直接共享 store 的响应式数组引用
    //（拖拽排序改到副本，结束后再由 setOrder 回写持久化）
    activeDrag.value = [...projects.projects]
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
        <img :src="logo" alt="MeiDay" class="h-7 w-7 rounded-lg object-cover" />
        <span class="text-lg font-bold text-slate-800">MeiDay</span>
      </div>
      <button class="lg:hidden w-8 h-8 flex items-center justify-center rounded-lg text-slate-400 hover:text-slate-600 hover:bg-slate-100" @click="ui.closeDrawer()"><AppIcon name="close" :size="18" /></button>
    </div>

    <div class="flex-1 overflow-y-auto px-3 py-3">
      <div class="mb-1 text-xs text-slate-400 px-3">视图</div>
      <router-link :to="'/today'" :class="navTodayClass" @click="ui.closeDrawer()">
        <span
          class="absolute left-0 top-1/2 -translate-y-1/2 w-[3px] h-4 rounded-r-full bg-brand transition-opacity"
          :class="route.path === '/today' ? 'opacity-100' : 'opacity-0'"
        />
        <AppIcon name="calendar" :size="17" class="shrink-0" />
        <span>今日任务</span>
        <span
          v-if="tasks.todayCount"
          class="ml-auto shrink-0 text-[11px] font-medium bg-slate-100 text-slate-500 rounded-full px-1.5 py-0.5"
        >
          {{ tasks.todayCount }}
        </span>
      </router-link>

      <div class="mt-5 mb-1 flex items-center justify-between px-3">
        <span class="text-xs text-slate-400">项目</span>
        <button
          v-if="canEditProjects"
          title="新建项目"
          class="w-6 h-6 flex items-center justify-center rounded-md text-slate-400 hover:text-brand hover:bg-slate-100"
          @click="$emit('new-project')"
        >
          <AppIcon name="plus" :size="15" />
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
          :class="route.params.id === p.id ? 'bg-brand/10 text-brand font-medium' : 'text-slate-600 hover:bg-slate-100'"
          @click="$emit('open-project', p.id)"
        >
          <span
            class="drag-handle text-slate-300 group-hover:text-slate-500 cursor-grab flex items-center select-none"
            title="拖动排序"
          ><AppIcon name="grip" :size="16" /></span>
          <span class="flex-1 truncate">{{ p.name }}</span>
          <span
            v-if="projects.countBy(p.id)"
            class="shrink-0 text-[11px] font-medium bg-slate-100 text-slate-500 rounded-full px-1.5 py-0.5"
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
        <AppIcon name="lock" :size="17" class="text-slate-400 shrink-0" /> <span>隐私日记模式</span>
      </button>
      <button
        class="flex items-center gap-2 px-3 py-2 rounded-lg text-sm text-slate-600 hover:bg-slate-200 w-full"
        title="批量导入"
        @click="ui.closeDrawer(); $emit('open-import')"
      >
        <AppIcon name="download" :size="17" class="text-slate-400 shrink-0" /> <span>批量导入</span>
      </button>
      <router-link :to="'/settings'" :class="navSettingsClass" @click="ui.closeDrawer()">
        <AppIcon name="gear" :size="17" class="text-slate-400 shrink-0" /> <span>设置</span>
      </router-link>
      <div class="flex items-center justify-between px-3 py-2 text-xs text-slate-400">
        <span class="truncate">{{ auth.username }}</span>
        <button class="hover:text-red-500 flex items-center gap-1" @click="onLogout"><AppIcon name="logout" :size="13" /> 退出</button>
      </div>
    </div>
  </div>

  <div
    v-if="ui.drawerOpen"
    class="fixed inset-0 z-30 bg-slate-900/25 backdrop-blur-sm lg:hidden"
    @click="ui.closeDrawer()"
  />
</template>
