<script setup lang="ts">
/**
 * TutorialModal — 设置页内嵌图文教程弹窗（OSS 配置 / 邮箱通知）
 * 内容为写死在前端代码里的静态资源，图片引用 OSS 公网地址。
 */
import AppIcon from '@/components/AppIcon.vue'
import TutorialImage from '@/components/TutorialImage.vue'

withDefaults(
  defineProps<{
    open: boolean
    /** 教程类型：'oss' 或 'email' */
    kind: 'oss' | 'email'
  }>(),
  { open: false, kind: 'oss' },
)
const emit = defineEmits<{ close: [] }>()

/** 教程内统一放置代码块的样式辅助 */
function codeLine() {
  return 'rounded-md bg-slate-900 text-slate-100 px-3 py-1.5 text-xs font-mono overflow-x-auto whitespace-pre'
}
</script>

<template>
  <div
    v-if="open"
    class="fixed inset-0 z-50 bg-slate-900/55 backdrop-blur-sm flex items-end sm:items-center justify-center sm:px-4"
    @click.self="emit('close')"
  >
    <div class="modal-panel rounded-t-2xl sm:rounded-2xl w-full sm:max-w-2xl max-h-[90dvh] flex flex-col animate-modal-pop">
      <!-- 头部 -->
      <div class="flex items-center justify-between px-5 pt-4 pb-3 border-b border-slate-100 shrink-0">
        <div class="flex items-center gap-2 text-base font-semibold text-slate-800">
          <AppIcon name="book" :size="18" class="text-brand" />
          {{ kind === 'oss' ? 'OSS 配置教程' : '微信消息通知配置教程' }}
        </div>
        <button
          type="button"
          class="p-1.5 rounded-lg text-slate-400 hover:bg-slate-100 hover:text-slate-600"
          aria-label="关闭教程"
          @click="emit('close')"
        >
          <AppIcon name="close" :size="18" />
        </button>
      </div>

      <!-- 内容区（可滚动） -->
      <div class="px-5 py-4 overflow-y-auto space-y-4 text-sm text-slate-700 leading-relaxed">
        <!-- ==================== OSS 教程 ==================== -->
        <template v-if="kind === 'oss'">
          <h2 class="text-lg font-bold text-slate-800">配置阿里云存储桶</h2>

          <section class="space-y-3">
            <h3 class="font-semibold text-slate-800">1. 开通 OSS</h3>
            <p>
              将鼠标移至「产品」，找到并单击「对象存储 OSS」，打开 OSS 产品详情页面。在 OSS 产品详情页中单击「立即开通」。
            </p>
            <TutorialImage src="https://congsec.oss-cn-beijing.aliyuncs.com/tuhcuanchajian/image-20260825025624-slvn5uo.png" alt="开通 OSS 步骤 1" />
            <TutorialImage src="https://congsec.oss-cn-beijing.aliyuncs.com/tuhcuanchajian/image-20260825025636-mmfpdje.png" alt="开通 OSS 步骤 2" />
            <TutorialImage src="https://congsec.oss-cn-beijing.aliyuncs.com/tuhcuanchajian/image-20260825025701-r8coxg6.png" alt="开通 OSS 步骤 3" />
          </section>

          <section class="space-y-3">
            <h3 class="font-semibold text-slate-800">2. 购买并支付</h3>
            <p>点击「购买」，然后直接支付（不需要钱）。</p>
            <TutorialImage src="https://congsec.oss-cn-beijing.aliyuncs.com/tuhcuanchajian/image-20260825025710-slrma8t.png" alt="购买 OSS 步骤 1" />
            <TutorialImage src="https://congsec.oss-cn-beijing.aliyuncs.com/tuhcuanchajian/image-20260825025754-jj2i4ew.png" alt="购买 OSS 步骤 2" />
          </section>

          <section class="space-y-3">
            <h3 class="font-semibold text-slate-800">3. 创建 Bucket</h3>
            <p>
              按照以下指示创建 bucket 并进入 bucket 中，请记住将 Bucket 和 Endpoint 记下来，于是我们得到了：
            </p>
            <div class="space-y-1.5">
              <div :class="codeLine()">OSS Bucket: congsec2</div>
              <div :class="codeLine()">OSS Endpoint: oss-cn-beijing.aliyuncs.com</div>
            </div>
            <TutorialImage src="https://congsec.oss-cn-beijing.aliyuncs.com/tuhcuanchajian/image-20260825032031-r49rr6v.png" alt="创建 Bucket" />
          </section>

          <section class="space-y-3">
            <h3 class="font-semibold text-slate-800">4. 创建 AccessKey</h3>
            <p>头像处点击「AccessKey」，然后选择「使用 RAM 用户 AccessKey」。</p>
            <TutorialImage src="https://congsec.oss-cn-beijing.aliyuncs.com/tuhcuanchajian/image-20260825031746-t81w5i9.png" alt="进入 AccessKey" />
            <p>点击「用户」，创建用户，然后完成短信验证。</p>
            <TutorialImage src="https://congsec.oss-cn-beijing.aliyuncs.com/tuhcuanchajian/image-20260825031938-mitdz5i.png" alt="创建 RAM 用户" />
            <p>将 AccessKey ID 和 AccessKey Secret 复制出来，于是我们得到了：</p>
            <div class="space-y-1.5">
              <div :class="codeLine()">AccessKey ID: LTAI5t7UAgZjp3Yr7W19TvDN</div>
              <div :class="codeLine()">AccessKey Secret: 1tVfbvxGYDGrP9iPjkvRqiGZJiJyCo</div>
            </div>
            <TutorialImage src="https://congsec.oss-cn-beijing.aliyuncs.com/tuhcuanchajian/image-20260825032409-5o59u64.png" alt="AccessKey 信息" />
          </section>

          <section class="space-y-3">
            <h3 class="font-semibold text-slate-800">5. 给用户配置 OSS 权限</h3>
            <TutorialImage src="https://congsec.oss-cn-beijing.aliyuncs.com/tuhcuanchajian/image-20260825032538-sgpa9lq.png" alt="配置 OSS 权限" />
            <p>回到 OSS 存储桶界面中，给在存储桶中赋予用户权限。</p>
            <TutorialImage src="https://congsec.oss-cn-beijing.aliyuncs.com/tuhcuanchajian/image-20260825032648-ws40kp4.png" alt="存储桶授权" />
          </section>

          <section class="space-y-3">
            <h3 class="font-semibold text-slate-800">6. 设置存储桶跨域（CORS）</h3>
            <p>
              框框内分别填写
              <code class="rounded bg-slate-100 px-1 py-0.5 text-xs font-mono">https://task.congsec.cn</code>、
              <code class="rounded bg-slate-100 px-1 py-0.5 text-xs font-mono">https://localhost</code>、
              <code class="rounded bg-slate-100 px-1 py-0.5 text-xs font-mono">*</code>、
              <code class="rounded bg-slate-100 px-1 py-0.5 text-xs font-mono">Etag</code>
              这四个字段，再者记得勾选请求方式（也就是图中第四步）。
            </p>
            <TutorialImage src="https://congsec.oss-cn-beijing.aliyuncs.com/tuhcuanchajian/image-20260828073139-2ugq2xr.png" alt="设置跨域" />
          </section>

          <section class="space-y-3 rounded-xl bg-slate-50 border border-slate-100 p-4">
            <h3 class="font-semibold text-slate-800">7. 综上，我们得到了以下配置</h3>
            <div class="space-y-1.5">
              <div :class="codeLine()">AccessKey ID: LTAI5t7UAgZjp3Yr7W19TvDN</div>
              <div :class="codeLine()">AccessKey Secret: 1tVfbvxGYDGrP9iPjkvRqiGZJiJyCo</div>
              <div :class="codeLine()">bucket: congsec2</div>
              <div :class="codeLine()">Endpoint: oss-cn-beijing</div>
            </div>
          </section>
        </template>

        <!-- ==================== 邮箱教程 ==================== -->
        <template v-else>
          <h2 class="text-lg font-bold text-slate-800">配置微信邮箱通知</h2>

          <section class="space-y-3">
            <h3 class="font-semibold text-slate-800">1. 打开 QQ 邮箱设置</h3>
            <p>
              打开你的 QQ 邮箱（建议创建一个新号，以免被其他邮件打扰），进去之后找到「设置」。
            </p>
            <TutorialImage src="https://congsec.oss-cn-beijing.aliyuncs.com/tuhcuanchajian/image-20260825033337-j816xyd.png" alt="打开 QQ 邮箱设置" />
          </section>

          <section class="space-y-3">
            <h3 class="font-semibold text-slate-800">2. 进入账号与安全</h3>
            <p>点击「账号与安全」。</p>
            <TutorialImage src="https://congsec.oss-cn-beijing.aliyuncs.com/tuhcuanchajian/image-20260825033415-omo50fr.png" alt="账号与安全" />
          </section>

          <section class="space-y-3">
            <h3 class="font-semibold text-slate-800">3. 开启 SMTP 服务并获取授权码</h3>
            <p>
              找到「SMTP 服务」，开启它，并生成授权码，你就会得到
              <code class="rounded bg-slate-100 px-1 py-0.5 text-xs font-mono">SMTP 授权码</code>。
            </p>
            <TutorialImage src="https://congsec.oss-cn-beijing.aliyuncs.com/tuhcuanchajian/image-20260825033507-pw2l7eu.png" alt="开启 SMTP 服务" />
          </section>

          <section class="space-y-3">
            <h3 class="font-semibold text-slate-800">4. 设置微信提醒</h3>
            <p>
              在微信设置中直接搜索「邮箱」，然后进行绑定即可（PS：如果觉得重复提醒，可以把邮箱退出登录，只微信提醒也可以的哦）。
            </p>
            <TutorialImage src="https://congsec.oss-cn-beijing.aliyuncs.com/tuhcuanchajian/9fc594bf86e133d22f53452fb08ed224-20260825234948-lq9qad3.jpg" alt="微信绑定邮箱" />
          </section>

          <section class="space-y-3">
            <h3 class="font-semibold text-slate-800">5. 效果如下</h3>
            <TutorialImage src="https://congsec.oss-cn-beijing.aliyuncs.com/tuhcuanchajian/image-20260825234846-wfw4afb.png" alt="微信提醒效果" />
          </section>
        </template>
      </div>

      <!-- 底部关闭按钮 -->
      <div class="px-5 py-3 border-t border-slate-100 shrink-0">
        <button
          type="button"
          class="w-full py-2.5 rounded-lg bg-brand text-white text-sm font-medium hover:bg-brand-dark"
          @click="emit('close')"
        >
          关闭
        </button>
      </div>
    </div>
  </div>
</template>
