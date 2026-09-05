<template>
  <div class="min-h-full flex items-center justify-center px-4 bg-app">
    <div class="w-full max-w-sm bg-white rounded-2xl shadow-xl p-6">
      <div class="flex flex-col items-center mb-5">
        <div class="w-12 h-12 rounded-full bg-brand/10 text-brand flex items-center justify-center">
          <AppIcon name="lock" :size="24" />
        </div>
        <h1 class="mt-3 text-lg font-bold text-slate-800">隐私日记</h1>
        <p class="mt-1 text-xs text-slate-500 text-center leading-relaxed">
          {{ mode === 'setup' ? '首次使用，请设置一个专属日记密码。' : '请输入日记密码以进入。' }}<br />
          密码以密文形式保存在内存中，不上传后端。
        </p>
      </div>

      <form v-if="!changing" @submit.prevent="onSubmit">
        <template v-if="mode === 'setup'">
          <input
            v-model="password"
            type="password"
            autocomplete="new-password"
            placeholder="设置日记密码（至少 6 位）"
            class="w-full border rounded-lg px-3 py-2.5 text-sm outline-none focus:ring-2 focus:ring-brand/50"
          />
          <input
            v-model="password2"
            type="password"
            autocomplete="new-password"
            placeholder="再次输入确认"
            class="mt-3 w-full border rounded-lg px-3 py-2.5 text-sm outline-none focus:ring-2 focus:ring-brand/50"
          />
        </template>
        <template v-else>
          <input
            v-model="password"
            type="password"
            autocomplete="current-password"
            placeholder="日记密码"
            class="w-full border rounded-lg px-3 py-2.5 text-sm outline-none focus:ring-2 focus:ring-brand/50"
          />
        </template>

        <div v-if="error" class="mt-2 text-sm text-red-500">{{ error }}</div>
        <button
          type="submit"
          :disabled="busy"
          class="mt-4 w-full bg-brand text-white rounded-lg py-2.5 text-sm font-medium disabled:opacity-60 hover:bg-brand-dark"
        >
          {{ busy ? (mode === 'setup' ? '正在创建…' : '正在解锁…') : (mode === 'setup' ? '创建并进入' : '进入') }}
        </button>
        <button
          type="button"
          class="mt-2 w-full text-slate-500 text-sm py-1 hover:text-slate-700"
          @click="router.push('/today')"
        >
          <AppIcon name="arrow-left" :size="14" class="shrink-0" />
          返回任务管理系统
        </button>
      </form>

      <!-- 修改密码 -->
      <form v-else @submit.prevent="onChange">
        <input
          v-model="oldPassword"
          type="password"
          autocomplete="current-password"
          placeholder="当前日记密码"
          class="w-full border rounded-lg px-3 py-2.5 text-sm outline-none focus:ring-2 focus:ring-brand/50"
        />
        <input
          v-model="newPassword"
          type="password"
          autocomplete="new-password"
          placeholder="新日记密码（至少 6 位）"
          class="mt-3 w-full border rounded-lg px-3 py-2.5 text-sm outline-none focus:ring-2 focus:ring-brand/50"
        />
        <input
          v-model="newPassword2"
          type="password"
          autocomplete="new-password"
          placeholder="再次输入新密码"
          class="mt-3 w-full border rounded-lg px-3 py-2.5 text-sm outline-none focus:ring-2 focus:ring-brand/50"
        />
        <div v-if="error" class="mt-2 text-sm text-red-500">{{ error }}</div>
        <button
          type="submit"
          :disabled="busy"
          class="mt-4 w-full bg-brand text-white rounded-lg py-2.5 text-sm font-medium disabled:opacity-60 hover:bg-brand-dark"
        >
          {{ busy ? '正在修改…' : '确认修改' }}
        </button>
        <button
          type="button"
          class="mt-2 w-full text-slate-500 text-sm py-1"
          @click="closeChange"
        >
          取消
        </button>
      </form>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import AppIcon from '@/components/AppIcon.vue'
import { useDiaryStore } from '@/stores/diary'
import { useUiStore } from '@/stores/ui'

const props = defineProps<{ mode: 'setup' | 'enter'; startInChange?: boolean }>()
const emit = defineEmits<{ unlocked: []; changed: []; cancel: [] }>()

const diary = useDiaryStore()
const ui = useUiStore()
const router = useRouter()

const password = ref('')
const password2 = ref('')
const oldPassword = ref('')
const newPassword = ref('')
const newPassword2 = ref('')
const busy = ref(false)
const error = ref('')
const changing = ref(!!props.startInChange)

/** 由 DiaryView 顶栏「修改密码」打开 */
function openChange(): void {
  error.value = ''
  oldPassword.value = newPassword.value = newPassword2.value = ''
  changing.value = true
}
function closeChange(): void {
  changing.value = false
  error.value = ''
  emit('cancel')
}
defineExpose({ openChange })

async function onSubmit(): Promise<void> {
  error.value = ''
  if (props.mode === 'setup') {
    if (password.value.length < 6) {
      error.value = '密码至少需要 6 位'
      return
    }
    if (password.value !== password2.value) {
      error.value = '两次输入的密码不一致'
      return
    }
  } else if (!password.value) {
    error.value = '请输入日记密码'
    return
  }
  busy.value = true
  try {
    if (props.mode === 'setup') {
      await diary.setupPassword(password.value)
    } else {
      const ok = await diary.enterPassword(password.value)
      if (!ok) {
        error.value = '解密失败'
        return
      }
    }
    password.value = password2.value = ''
    emit('unlocked')
  } catch (e) {
    error.value = e instanceof Error ? e.message : '操作失败'
  } finally {
    busy.value = false
  }
}

async function onChange(): Promise<void> {
  error.value = ''
  if (!oldPassword.value) {
    error.value = '请输入当前日记密码'
    return
  }
  if (newPassword.value.length < 6) {
    error.value = '新密码至少需要 6 位'
    return
  }
  if (newPassword.value !== newPassword2.value) {
    error.value = '两次输入的新密码不一致'
    return
  }
  busy.value = true
  try {
    await diary.changePassword(oldPassword.value, newPassword.value)
    ui.toast('日记密码已修改')
    oldPassword.value = newPassword.value = newPassword2.value = ''
    changing.value = false
    emit('changed')
  } catch (e) {
    error.value = e instanceof Error ? e.message : '修改失败'
  } finally {
    busy.value = false
  }
}
</script>
