<script setup lang="ts">
import { computed, ref } from 'vue'
import { useRouter } from 'vue-router'
import ClickCaptcha from '@/components/ClickCaptcha.vue'
import { useAuthStore } from '@/stores/auth'
import logo from '@/assets/logo.png'
import AppIcon from '@/components/AppIcon.vue'
import { useUiStore } from '@/stores/ui'
import {
  addServer,
  checkServerHealth,
  describeServerProblem,
  getActiveServer,
  getOfficialServer,
  getSavedServers,
  isMixedContentBlocked,
  normalizeServerUrl,
  removeServer,
  setActiveServer,
} from '@/utils/serverConfig'

const auth = useAuthStore()
const router = useRouter()

const mode = ref<'login' | 'register'>('login')
const username = ref('')
const password = ref('')
const confirm = ref('')
const remember = ref(true)
const err = ref('')
const busy = ref(false)

// 点击式验证码（仅注册时需要）：组件内部拉图并管理点击；提交时读取 captchaValue。
// 通过 key 强制重新挂载来“换新图”（验证码单次使用，失败/换模式后需要新图）。
const captchaKey = ref(0)
const captchaValue = ref<{ id: string | null; answer: number[] } | null>(null)

const ui = useUiStore()

/* ---- 服务器地址选择（登录/注册均可见） ---- */
const officialServer = getOfficialServer()
const servers = ref<string[]>(getSavedServers())
const activeServer = ref(getActiveServer())
const newServerUrl = ref('')
const serverBusy = ref(false)
const serverErr = ref('')

/** 官方地址固定置顶；自定义地址去重展示 */
const serverOptions = computed(() =>
  Array.from(new Set([officialServer, ...servers.value.filter((u) => u !== officialServer)])),
)

function refreshServers() {
  servers.value = getSavedServers()
  activeServer.value = getActiveServer()
}

async function onAddServer() {
  serverErr.value = ''
  const url = normalizeServerUrl(newServerUrl.value)
  if (!/^https?:\/\/.+/.test(url)) {
    serverErr.value = '服务器地址需以 http:// 或 https:// 开头'
    return
  }
  serverBusy.value = true
  try {
    // HTTPS 网页端访问 http:// 地址会被浏览器「混合内容」策略硬拦截，直接给出明确提示
    if (isMixedContentBlocked(url)) {
      if (!window.confirm('当前网页是 HTTPS，浏览器会拦截对 http:// 地址的请求（混合内容限制），该地址在网页端无法使用。建议给服务器启用 HTTPS，或在 APP / 桌面小组件 / 思源插件中使用。仍要保存吗？')) {
        return
      }
    } else {
      const health = await checkServerHealth(url)
      if (!health.ok && !window.confirm(`${describeServerProblem(health, url)} 仍要保存吗？`)) {
        return
      }
    }
    addServer(url)
    refreshServers()
    newServerUrl.value = ''
    ui.toast('服务器地址已保存')
  } finally {
    serverBusy.value = false
  }
}

function onRemoveServer(url: string) {
  removeServer(url)
  refreshServers()
}

async function onSelectServer(url: string) {
  if (url === activeServer.value) return
  serverErr.value = ''
  serverBusy.value = true
  try {
    // HTTPS 网页端访问 http:// 地址会被浏览器「混合内容」策略硬拦截，直接给出明确提示
    if (isMixedContentBlocked(url)) {
      if (!window.confirm('当前网页是 HTTPS，浏览器会拦截对 http:// 地址的请求（混合内容限制），该地址在网页端无法使用。仍要切换到该地址吗？')) {
        return
      }
    } else {
      const health = await checkServerHealth(url)
      if (!health.ok && !window.confirm(`${describeServerProblem(health, url)} 仍要切换吗？`)) {
        return
      }
    }
    setActiveServer(url)
    activeServer.value = url
    // 切换服务器必须清空旧服务器的登录态与记住的密码，避免发往新服务器
    auth.reset()
    ui.toast(`已切换到 ${url}，请重新登录`, 'error')
  } finally {
    serverBusy.value = false
  }
}

function switchMode(m: 'login' | 'register') {
  mode.value = m
  err.value = ''
  // 每次进入注册都重新挂载验证码组件（拉一张新图，旧的可能已被校验作废）
  if (m === 'register') captchaKey.value++
}

async function submit() {
  err.value = ''
  if (!username.value.trim() || !password.value) {
    err.value = '请输入用户名和密码'
    return
  }
  if (mode.value === 'register') {
    if (password.value !== confirm.value) {
      err.value = '两次密码不一致'
      return
    }
    if (password.value.length < 8) {
      err.value = '密码至少 8 位'
      return
    }
  }
  busy.value = true
  try {
    if (mode.value === 'login') {
      await auth.login(username.value.trim(), password.value, remember.value)
    } else {
      const captcha = captchaValue.value
      if (!captcha || !captcha.id || captcha.answer.length === 0) {
        err.value = '请点击验证码中所有目标符号'
        return
      }
      await auth.register(
        {
          username: username.value.trim(),
          password: password.value,
          captchaId: captcha.id,
          captchaAnswer: captcha.answer,
        },
        remember.value,
      )
    }
    router.push('/today')
  } catch (e) {
    err.value = (e as Error).message || '操作失败'
    // 验证码单次使用：注册失败（验证码错/已过期/重名等）后重新挂载换一张新图
    if (mode.value === 'register') captchaKey.value++
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div class="min-h-full flex items-center justify-center px-4 bg-app">
    <div class="w-full max-w-sm bg-white rounded-2xl shadow-lift border border-line p-8">
      <div class="text-center">
        <div class="flex items-center justify-center gap-2">
          <img :src="logo" alt="MeiDay" class="h-10 w-10 rounded-xl object-cover" />
          <span class="text-2xl font-bold text-slate-800">MeiDay</span>
        </div>
        <div class="mt-1 text-xs text-slate-400">高安全的轻量任务管理</div>
      </div>

      <div class="mt-6 grid grid-cols-2 bg-surface-2 rounded-xl p-1 text-sm">
        <button
          class="py-1.5 rounded-md font-medium transition"
          :class="mode === 'login' ? 'bg-white text-brand shadow-sm' : 'text-slate-500'"
          @click="switchMode('login')"
        >
          登录
        </button>
        <button
          class="py-1.5 rounded-md font-medium transition"
          :class="mode === 'register' ? 'bg-white text-brand shadow-sm' : 'text-slate-500'"
          @click="switchMode('register')"
        >
          注册
        </button>
      </div>

      <!-- ===== 服务器地址选择（官方固定置顶；可添加/删除自定义地址） ===== -->
      <div class="mt-4 rounded-xl border border-line bg-surface-1/60 p-3">
        <div class="flex items-center justify-between gap-2">
          <span class="text-xs font-semibold text-slate-500">服务器</span>
          <span class="min-w-0 truncate text-[11px] text-slate-400">{{ activeServer }}</span>
        </div>
        <div class="mt-2 max-h-32 space-y-1 overflow-y-auto">
          <label
            v-for="s in serverOptions"
            :key="s"
            class="flex cursor-pointer select-none items-center gap-2 rounded-lg px-2 py-1.5 text-xs transition"
            :class="s === activeServer ? 'bg-brand/10 text-brand' : 'text-slate-600 hover:bg-surface-2'"
          >
            <input
              type="radio"
              name="server"
              class="accent-brand"
              :checked="s === activeServer"
              :disabled="serverBusy"
              @change="onSelectServer(s)"
            />
            <span class="min-w-0 flex-1 truncate">{{ s }}</span>
            <span v-if="s === officialServer" class="shrink-0 rounded bg-brand/10 px-1.5 py-0.5 text-[10px] text-brand">官方</span>
            <button
              v-else
              type="button"
              class="shrink-0 text-slate-400 hover:text-red-500"
              title="删除此服务器"
              @click.stop="onRemoveServer(s)"
            >
              ✕
            </button>
          </label>
        </div>
        <div class="mt-2 flex gap-2">
          <input
            v-model="newServerUrl"
            placeholder="https://你的服务器地址"
            :disabled="serverBusy"
            class="min-w-0 flex-1 border border-line rounded-lg bg-white px-2.5 py-1.5 text-xs outline-none focus:border-brand/50 focus:ring-2 focus:ring-brand/40"
            @keyup.enter="onAddServer"
          />
          <button
            type="button"
            class="shrink-0 rounded-lg bg-surface-2 px-3 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-200 disabled:opacity-60"
            :disabled="serverBusy"
            @click="onAddServer"
          >
            {{ serverBusy ? '检测中…' : '添加' }}
          </button>
        </div>
        <div v-if="serverErr" class="mt-1.5 text-xs text-red-500">{{ serverErr }}</div>
      </div>

      <form class="mt-5 space-y-3" @submit.prevent="submit">
        <div class="relative">
          <span class="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none">
            <AppIcon name="user" :size="16" />
          </span>
          <input
            v-model="username"
            name="username"
            placeholder="用户名"
            autocomplete="username"
            class="w-full border border-line rounded-lg pl-10 pr-3 py-2.5 text-sm outline-none bg-white focus:ring-2 focus:ring-brand/40 focus:border-brand/50"
          />
        </div>
        <div class="relative">
          <span class="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none">
            <AppIcon name="lock" :size="16" />
          </span>
          <input
            v-model="password"
            name="password"
            placeholder="密码"
            type="password"
            :autocomplete="mode === 'login' ? 'current-password' : 'new-password'"
            class="w-full border border-line rounded-lg pl-10 pr-3 py-2.5 text-sm outline-none bg-white focus:ring-2 focus:ring-brand/40 focus:border-brand/50"
          />
        </div>
        <div v-if="mode === 'register'" class="relative">
          <span class="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none">
            <AppIcon name="lock" :size="16" />
          </span>
          <input
            v-model="confirm"
            name="confirm_password"
            placeholder="确认密码"
            type="password"
            autocomplete="new-password"
            class="w-full border border-line rounded-lg pl-10 pr-3 py-2.5 text-sm outline-none bg-white focus:ring-2 focus:ring-brand/40 focus:border-brand/50"
          />
        </div>
        <ClickCaptcha
          v-if="mode === 'register'"
          :key="captchaKey"
          :disabled="busy"
          @change="captchaValue = $event"
        />
        <div v-if="err" class="text-sm text-red-500">{{ err }}</div>
        <label class="flex items-center gap-2 text-xs text-slate-500 select-none">
          <input type="checkbox" v-model="remember" class="accent-brand" />
          在浏览器中保存密码（7 天内刷新免重复输入）
        </label>
        <button
          type="submit"
          :disabled="busy"
          class="w-full bg-brand hover:bg-brand-dark text-white rounded-lg py-2.5 text-sm font-medium disabled:opacity-60 btn-press shadow-sm"
        >
          {{ busy ? '处理中…' : mode === 'login' ? '登录' : '注册' }}
        </button>
      </form>

      <p class="mt-5 text-[11px] leading-relaxed text-slate-400">
        所有加密数据均存储于您自主管理的 OSS 存储桶空间中。邮箱凭证通过您账号密码派生的密钥，在浏览器端经 AES-GCM 算法完成本地加密。服务器仅存储加密密文及操作日志，不持有任何可参与解密的密钥材料，无法获取明文数据。解密操作仅在您输入账号密码后于游览器本地执行。
      </p>
    </div>
  </div>
</template>
