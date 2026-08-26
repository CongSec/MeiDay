import { fileURLToPath, URL } from 'node:url'
import { readFileSync } from 'node:fs'
import { defineConfig, loadEnv, type ServerOptions as ViteServerOptions } from 'vite'
import vue from '@vitejs/plugin-vue'
import basicSsl from '@vitejs/plugin-basic-ssl'
import { ensureCert } from './gen-cert.mjs'

// 局域网访问：使用覆盖当前局域网 IP 的自签名证书（gen-cert.mjs 会自动生成/更新）。
// 若证书生成失败（例如依赖未安装），回退到 basicSsl 的 localhost 证书，保证本地开发可用。
let https: ViteServerOptions['https']
let plugins = [vue(), basicSsl()]
try {
  const certFiles = await ensureCert()
  https = { key: readFileSync(certFiles.key), cert: readFileSync(certFiles.cert) }
  plugins = [vue()]
  console.log(`[meiday] 开发服务器使用自签名证书: ${certFiles.cert}`)
} catch (e) {
  // 证书生成失败时回退 basicSsl 的 localhost 证书，保证本地开发可用
  console.warn('[meiday] 自签名证书生成失败，回退 basicSsl:', e)
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  // 网页版可把静态资源放到 CDN，例如 https://static.example.com；留空则走原站相对路径。
  const cdnBase = (env.VITE_CDN_BASE ?? process.env.VITE_CDN_BASE ?? '').trim().replace(/\/+$/, '')

  return {
    base: cdnBase ? `${cdnBase}/` : '/',
    plugins,
    build: {
      // 生产构建不生成 .map，避免源码映射泄露
      sourcemap: false,
      // 1MB+ 大单包对弱网/低端机首屏不友好；开启手动分包，把体积大、更新频率低
      // 的第三方库拆成独立 chunk，走浏览器 HTTP 缓存，业务代码更新时不再整包失效。
      rollupOptions: {
        output: {
          manualChunks(id) {
            if (!id.includes('node_modules')) return undefined
            // ali-oss（SDK 体积大、只在同步/诊断时用到）单独分包，配合按需 import 可延迟加载
            if (id.includes('ali-oss')) return 'vendor-oss'
            if (id.includes('vue-draggable-plus')) return 'vendor-drag'
            if (id.includes('vue-virtual-scroller')) return 'vendor-scroll'
            // 框架核心：vue / pinia / vue-router 放一起，缓存命中率高
            if (
              /[\\/]node_modules[\\/](vue|@vue|pinia|vue-router|vue-demi|@vueuse)[\\/]/.test(id)
            ) {
              return 'vendor-core'
            }
            return 'vendor-other'
          },
        },
      },
    },
    resolve: {
      alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
    },
    server: {
      host: true,
      port: 5173,
      https,
      proxy: {
        '/api': {
          target: 'http://127.0.0.1:8000',
          changeOrigin: true,
          // 透传真实客户端 IP（X-Forwarded-For / X-Real-IP），否则后端只会看到本机 127.0.0.1
          xfwd: true,
        },
      },
    },
  }
})
