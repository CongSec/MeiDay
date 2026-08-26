<script setup lang="ts">
import { computed, inject, onMounted, onUnmounted, reactive, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import { useUiStore } from '@/stores/ui'
import { useStatsStore } from '@/stores/stats'
import { api } from '@/api/client'
import type { NotifyPrefs } from '@/api/client'
import { logAudit, safeDetail } from '@/utils/audit'
import type { CredFields } from '@/types'

const auth = useAuthStore()
const ui = useUiStore()
const router = useRouter()
const statsStore = useStatsStore()

/** 使用 MeiDay 天数：从首次创建项目时间算起（今天算第 1 天）；未记录时显示 — */
const statsDays = computed(() => {
  const at = statsStore.firstProjectAt
  if (!at) return '—'
  const start = new Date(at).getTime()
  if (Number.isNaN(start)) return '—'
  return `${Math.floor((Date.now() - start) / 86400000) + 1} 天`
})

/** 累计完成任务数量：所有按天净增量之和（只读展示） */
const statsCompleted = computed(() => statsStore.completedCount)
const statsReady = computed(() => statsStore.loaded && !!statsStore.stats)

/** 安全邮件通知开关（登录成功 / 登录失败 / 查看密钥）。登录成功默认关闭，其余默认开启 */
const notifyPrefs = ref<NotifyPrefs>({ login_success: false, login_failed: true, key_view: true })
const notifySaving = ref(false)

async function loadNotifyPrefs() {
  try {
    notifyPrefs.value = await api.getNotifyPrefs()
  } catch {
    // 加载失败不阻塞设置页，保持默认（登录成功关闭，其余开启）
  }
}

async function setNotifyPref(key: 'login_success' | 'login_failed' | 'key_view', val: boolean) {
  notifySaving.value = true
  try {
    notifyPrefs.value = await api.setNotifyPrefs({ [key]: val })
    ui.toast('安全邮件通知设置已保存')
    logAudit('修改设置', safeDetail('更新安全邮件通知开关：' + key))
  } catch (e) {
    ui.toast((e as Error).message || '保存失败', 'error')
    try { notifyPrefs.value = await api.getNotifyPrefs() } catch { /* 回滚失败忽略 */ }
  } finally {
    notifySaving.value = false
  }
}

const mobileActions = inject<{ title: string } | null>('mobile-actions', null)

const FIELDS: { key: keyof CredFields; label: string; hint?: string }[] = [
  { key: 'ossAk', label: 'OSS AccessKey', hint: 'RAM 子账号 AccessKey' },
  { key: 'ossSk', label: 'OSS SecretKey', hint: 'RAM 子账号 SecretKey' },
  { key: 'bucket', label: 'OSS Bucket 名称' },
  { key: 'region', label: 'OSS Region', hint: '如 oss-cn-beijing' },
  { key: 'smtpUser', label: '发件邮箱 (QQ)' },
  { key: 'smtpPass', label: 'SMTP 授权码', hint: 'QQ 邮箱设置 → 账号 → 开启 SMTP 获取' },
  { key: 'notifyEmail', label: '收件邮箱', hint: '默认同发件邮箱，可独立填写' },
]

const form = reactive<Record<keyof CredFields, string>>({
  ossAk: '',
  ossSk: '',
  bucket: '',
  region: '',
  smtpUser: '',
  smtpPass: '',
  notifyEmail: '',
})

function fillFromCreds() {
  if (!auth.creds) return
  ;(Object.keys(form) as (keyof CredFields)[]).forEach((k) => {
    const v = auth.creds?.[k]
    form[k] = typeof v === 'string' ? v : ''
  })
}

// R2-BUG-2: 解锁后 auth.creds 才写入，若只在 setup 回填一次会导致设置页字段为空；
// 用 watcher 监听 creds 变化（登录/解锁/保存凭证）即时回填表单。
watch(
  () => auth.creds,
  () => fillFromCreds(),
  { immediate: true },
)

const visible = reactive<Record<string, boolean>>({})
const busy = ref(false)
const err = ref('')

function toggle(k: string) {
  const showing = !visible[k]
  visible[k] = showing
  const field = FIELDS.find((f) => f.key === k)
  // 只记录字段标签，绝不记录密钥/密码等明文值
  logAudit(showing ? '显示密钥' : '隐藏密钥', safeDetail(`字段：${field?.label ?? k}`))
}

const MOBILE_TITLE = '设置'
onMounted(() => {
  if (mobileActions) mobileActions.title = MOBILE_TITLE
  logAudit('打开设置')
  void loadNotifyPrefs()
  // 从 OSS 加载用户统计（使用天数 / 累计完成数）；失败不阻塞设置页
  void statsStore.load().catch(() => {})
})
onUnmounted(() => {
  if (mobileActions && mobileActions.title === MOBILE_TITLE) mobileActions.title = ''
})

const pwOld = ref('')
const pwNew = ref('')
const pwConfirm = ref('')
const pwErr = ref('')
const pwBusy = ref(false)

/** 修改密码：只发送 SHA-256 校验子（不可逆密文）；改密后自动用新密钥重新加密
 *  OSS 凭证与附件文件密钥，保证解密 / 提醒 / 附件预览等功能照常可用。 */
async function changePassword() {
  pwErr.value = ''
  if (!pwOld.value || !pwNew.value || !pwConfirm.value) {
    pwErr.value = '请填写原密码与新密码'
    return
  }
  if (pwNew.value !== pwConfirm.value) {
    pwErr.value = '两次输入的新密码不一致'
    return
  }
  if (pwNew.value.length < 8) {
    pwErr.value = '新密码至少 8 位'
    return
  }
  if (pwNew.value === pwOld.value) {
    pwErr.value = '新密码不能与原密码相同'
    return
  }
  pwBusy.value = true
  try {
    await auth.changePassword(pwOld.value, pwNew.value)
    ui.toast('密码已修改')
    pwOld.value = ''
    pwNew.value = ''
    pwConfirm.value = ''
  } catch (e) {
    pwErr.value = (e as Error).message || '修改失败'
  } finally {
    pwBusy.value = false
  }
}

async function save() {
  err.value = ''
  // 收件邮箱默认同发件邮箱：必须在必填校验之前，否则空 notifyEmail 会直接报必填错误，默认逻辑永不执行（BUG-14）
  if (!form.notifyEmail) form.notifyEmail = form.smtpUser
  const missing = FIELDS.filter((f) => !form[f.key].trim())
  if (missing.length) {
    err.value = `请填写：${missing.map((f) => f.label).join('、')}`
    return
  }
  // 兼容误填完整 OSS 域名：自动去掉 .aliyuncs.com 后缀，ali-oss SDK 只接受区域 ID
  let region = form.region.trim().replace(/\.aliyuncs\.com$/, '')
  if (!/^[a-zA-Z0-9\-_]+$/.test(region)) {
    err.value = 'OSS Region 格式不正确，请输入如 oss-cn-beijing 的区域 ID'
    return
  }
  busy.value = true
  const oldCreds = auth.creds
  try {
    await auth.saveCredentials({
      ossAk: form.ossAk.trim(),
      ossSk: form.ossSk.trim(),
      bucket: form.bucket.trim(),
      region,
      smtpUser: form.smtpUser.trim(),
      smtpPass: form.smtpPass.trim(),
      notifyEmail: form.notifyEmail.trim(),
    })
    ui.toast('凭证已加密保存')
    const changed = FIELDS.filter((f) => form[f.key].trim() !== (oldCreds?.[f.key] ?? '')).map((f) => f.label)
    // 只记录变更的字段标签，不记录任何值
    logAudit('修改设置', safeDetail(`更新存储与邮箱设置字段：${changed.length ? changed.join('、') : '无字段变化'}`))
    router.push('/today')
  } catch (e) {
    err.value = (e as Error).message || '保存失败'
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div class="p-4 sm:p-6 max-w-2xl mx-auto">
    <h1 class="hidden lg:block text-xl font-bold text-slate-800">⚙️ 设置</h1>
    <div class="text-xs text-slate-400 mt-0.5">凭证在浏览器本地用你的密码派生密钥 AES-GCM 加密后上传</div>

    <div class="mt-4 bg-white rounded-xl shadow-sm border border-slate-100 p-4">
      <div class="text-sm font-semibold text-slate-800">📊 我的统计</div>
      <div class="text-[11px] text-slate-400 mt-0.5">数据仅存于你的 OSS 存储桶，服务器不可修改</div>
      <div class="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div class="rounded-lg bg-slate-50 border border-slate-100 p-3">
          <div class="text-xs text-slate-400">使用 MeiDay 天数</div>
          <div class="text-2xl font-bold text-slate-800 mt-1">
            {{ statsReady ? statsDays : '—' }}
          </div>
        </div>
        <div class="rounded-lg bg-slate-50 border border-slate-100 p-3">
          <div class="text-xs text-slate-400">累计完成任务</div>
          <div class="text-2xl font-bold text-slate-800 mt-1">
            {{ statsReady ? statsCompleted : '—' }}
          </div>
        </div>
      </div>
    </div>



    <div class="mt-4 bg-white rounded-xl shadow-sm border border-slate-100 p-4">
      <div class="space-y-4">
        <div v-for="f in FIELDS" :key="f.key">
          <label class="text-xs text-slate-500 block mb-1">
            {{ f.label }}
            <span v-if="f.hint" class="text-slate-300">（{{ f.hint }}）</span>
          </label>
          <div class="flex gap-2">
            <input
              :type="visible[f.key] ? 'text' : 'password'"
              v-model="form[f.key]"
              :name="`settings_${f.key}`"
              autocomplete="off"
              class="flex-1 border rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-brand/50 font-mono"
            />
            <button
              type="button"
              class="px-3 py-2 rounded-lg text-xs text-slate-500 border hover:bg-slate-50 shrink-0"
              @click="toggle(f.key)"
            >
              {{ visible[f.key] ? '隐藏' : '显示' }}
            </button>
          </div>
        </div>

        <div v-if="err" class="text-sm text-red-500">{{ err }}</div>
        <div class="text-[11px] text-slate-400 leading-relaxed">
          保存后 OSS AK/SK/Bucket/Region 仅以密文存于服务器，永不可被服务器解密；SMTP 授权码与收件邮箱将明文发送给后端用于后端离线提醒（服务器沦陷仅影响邮箱，不影响 OSS 数据）。
        </div>

        <button
          class="w-full py-2.5 rounded-lg bg-brand text-white text-sm font-medium hover:bg-brand-dark disabled:opacity-60"
          :disabled="busy"
          @click="save"
        >
          {{ busy ? '加密保存中…' : '加密保存' }}
        </button>
      </div>
    </div>

    <div class="mt-4 bg-white rounded-xl shadow-sm border border-slate-100 p-4">
      <div class="text-sm font-semibold text-slate-800">📧 安全邮件通知</div>
      <div class="text-[11px] text-slate-400 mt-0.5">
        登录成功 / 登录失败 / 查看密钥时通过邮件提醒（发往上方配置的收件邮箱）。邮件发送失败不影响使用。
      </div>
      <div class="mt-3 space-y-3">
        <label class="flex items-center justify-between gap-3 px-1">
          <div class="min-w-0">
            <div class="text-sm text-slate-700">登录成功</div>
            <div class="text-[11px] text-slate-400">如「[IP] 登录了你的账号」</div>
          </div>
          <button
            type="button"
            role="switch"
            :aria-checked="notifyPrefs.login_success"
            :disabled="notifySaving"
            class="relative w-11 h-6 rounded-full transition-colors shrink-0 disabled:opacity-50"
            :class="notifyPrefs.login_success ? 'bg-brand' : 'bg-slate-300'"
            @click="setNotifyPref('login_success', !notifyPrefs.login_success)"
          >
            <span
              class="absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform"
              :class="notifyPrefs.login_success ? 'translate-x-5' : ''"
            />
          </button>
        </label>

        <label class="flex items-center justify-between gap-3 px-1">
          <div class="min-w-0">
            <div class="text-sm text-slate-700">登录失败</div>
            <div class="text-[11px] text-slate-400">如「[IP] 尝试爆破你的账号，请注意修改密码」</div>
          </div>
          <button
            type="button"
            role="switch"
            :aria-checked="notifyPrefs.login_failed"
            :disabled="notifySaving"
            class="relative w-11 h-6 rounded-full transition-colors shrink-0 disabled:opacity-50"
            :class="notifyPrefs.login_failed ? 'bg-brand' : 'bg-slate-300'"
            @click="setNotifyPref('login_failed', !notifyPrefs.login_failed)"
          >
            <span
              class="absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform"
              :class="notifyPrefs.login_failed ? 'translate-x-5' : ''"
            />
          </button>
        </label>

        <label class="flex items-center justify-between gap-3 px-1">
          <div class="min-w-0">
            <div class="text-sm text-slate-700">查看密钥</div>
            <div class="text-[11px] text-slate-400">如「[IP] 尝试查看你的设置密钥」</div>
          </div>
          <button
            type="button"
            role="switch"
            :aria-checked="notifyPrefs.key_view"
            :disabled="notifySaving"
            class="relative w-11 h-6 rounded-full transition-colors shrink-0 disabled:opacity-50"
            :class="notifyPrefs.key_view ? 'bg-brand' : 'bg-slate-300'"
            @click="setNotifyPref('key_view', !notifyPrefs.key_view)"
          >
            <span
              class="absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform"
              :class="notifyPrefs.key_view ? 'translate-x-5' : ''"
            />
          </button>
        </label>
      </div>
    </div>
    <div class="mt-4 bg-white rounded-xl shadow-sm border border-slate-100 p-4 space-y-2">
      <div class="text-xs text-slate-400 px-1">回收站与操作日志入口</div>
      <button
        class="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm text-slate-700 hover:bg-slate-50 border border-slate-200 text-left"
        @click="router.push('/trash')"
      >
        <span>🗑</span> 回收站
        <span class="ml-auto text-slate-400 text-xs shrink-0">恢复被删除的任务与项目 →</span>
      </button>
      <button
        class="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm text-slate-700 hover:bg-slate-50 border border-slate-200 text-left"
        @click="router.push('/logs')"
      >
        <span>📋</span> 操作日志
        <span class="ml-auto text-slate-400 text-xs shrink-0">查看与清理操作记录 →</span>
      </button>
    </div>

    <div class="mt-4 bg-white rounded-xl shadow-sm border border-slate-100 p-4">
      <div class="text-sm font-semibold text-slate-800">🔑 修改密码</div>
      <div class="text-[11px] text-slate-400 mt-0.5">
        修改后 OSS 凭证与历史附件会改用新密码派生的密钥重新加密，解密、提醒、附件预览等功能不受影响。
      </div>
      <div class="mt-3 space-y-3">
        <div>
          <label class="text-xs text-slate-500 block mb-1">原密码</label>
          <input
            v-model="pwOld"
            type="password"
            autocomplete="current-password"
            class="w-full border rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-brand/50"
          />
        </div>
        <div>
          <label class="text-xs text-slate-500 block mb-1">新密码</label>
          <input
            v-model="pwNew"
            type="password"
            autocomplete="new-password"
            class="w-full border rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-brand/50"
          />
        </div>
        <div>
          <label class="text-xs text-slate-500 block mb-1">确认新密码</label>
          <input
            v-model="pwConfirm"
            type="password"
            autocomplete="new-password"
            class="w-full border rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-brand/50"
          />
        </div>
        <div v-if="pwErr" class="text-sm text-red-500">{{ pwErr }}</div>
        <button
          class="w-full py-2.5 rounded-lg bg-brand text-white text-sm font-medium hover:bg-brand-dark disabled:opacity-60"
          :disabled="pwBusy"
          @click="changePassword"
        >
          {{ pwBusy ? '修改中…' : '修改密码' }}
        </button>
      </div>
    </div>
  </div>
</template>

