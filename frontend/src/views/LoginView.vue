<script setup lang="ts">
import { ref } from 'vue'
import { useRouter } from 'vue-router'
import ClickCaptcha from '@/components/ClickCaptcha.vue'
import { useAuthStore } from '@/stores/auth'

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
  <div class="min-h-full flex items-center justify-center px-4 bg-gradient-to-br from-indigo-50 to-slate-100">
    <div class="w-full max-w-sm bg-white rounded-2xl shadow-xl p-8">
      <div class="text-center">
        <div class="flex items-center justify-center gap-2">
          <img src="/logo.png" alt="EasyTask" class="h-10 w-10 rounded-xl object-cover" />
          <span class="text-2xl font-bold text-slate-800">EasyTask</span>
        </div>
        <div class="mt-1 text-xs text-slate-400">高安全的轻量任务管理</div>
      </div>

      <div class="mt-6 grid grid-cols-2 bg-slate-100 rounded-lg p-1 text-sm">
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

      <form class="mt-5 space-y-3" @submit.prevent="submit">
        <input
          v-model="username"
          name="username"
          placeholder="用户名"
          autocomplete="username"
          class="w-full border rounded-lg px-3 py-2.5 text-sm outline-none focus:ring-2 focus:ring-brand/50"
        />
        <input
          v-model="password"
          name="password"
          placeholder="密码"
          type="password"
          :autocomplete="mode === 'login' ? 'current-password' : 'new-password'"
          class="w-full border rounded-lg px-3 py-2.5 text-sm outline-none focus:ring-2 focus:ring-brand/50"
        />
        <input
          v-if="mode === 'register'"
          v-model="confirm"
          name="confirm_password"
          placeholder="确认密码"
          type="password"
          autocomplete="new-password"
          class="w-full border rounded-lg px-3 py-2.5 text-sm outline-none focus:ring-2 focus:ring-brand/50"
        />
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
          class="w-full bg-brand hover:bg-brand-dark text-white rounded-lg py-2.5 text-sm font-medium disabled:opacity-60 transition"
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
