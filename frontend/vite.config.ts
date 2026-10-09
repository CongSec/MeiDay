import { fileURLToPath, URL } from 'node:url'
import { readFileSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { defineConfig, loadEnv, type ServerOptions as ViteServerOptions, type Plugin } from 'vite'
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

/**
 * 开发环境「同源代理桥」：
 * 登录页/运行时可选的任意外部后端（http/https）在 dev 模式下会被 src/utils/serverConfig.ts 的
 * getApiBase() 改写为 /__api/<encodeURIComponent(base)> 的同源路径；本中间件在此把请求转发到真实目标。
 * 这样浏览器永远只发同源请求，绕开「HTTPS 页面请求 http:// 局域网」的混合内容硬拦截与跨域 CORS 限制，
 * 且与页面来源无关（localhost / 局域网 IP / 手机）。仅开发模式生效（configureServer 只在 dev server 运行）。
 */
function devApiBridge(): Plugin {
  const PREFIX = '/__api/'
  // 逐跳（hop-by-hop）头不能原样转发；h2 伪头（:method/:path/:authority…）也必须剔除
  const HOP_BY_HOP = new Set([
    'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
    'proxy-connection', 'te', 'trailer', 'transfer-encoding', 'upgrade',
  ])
  function sanitizeHeaders(headers: Record<string, string | string[] | undefined>) {
    const out: Record<string, string | string[]> = {}
    for (const [k, v] of Object.entries(headers)) {
      if (k.startsWith(':')) continue
      if (v === undefined) continue
      if (HOP_BY_HOP.has(k.toLowerCase())) continue
      out[k] = v
    }
    return out
  }
  return {
    name: 'meiday-dev-api-bridge',
    configureServer(server) {
      server.middlewares.use(PREFIX, (req, res) => {
        // 注意：Connect 以路径挂载中间件时会剥掉匹配前缀，因此 req.url 可能是
        // /__api/https%3A%2F%2Ftask.congsec.cn/api/health（未剥）或
        // /https%3A%2F%2Ftask.congsec.cn/api/health（已剥），这里兼容两种形态。
        let rest = req.url ?? ''
        if (rest.startsWith(PREFIX)) rest = rest.slice(PREFIX.length)
        rest = rest.replace(/^\/+/, '')
        const qIdx = rest.indexOf('?')
        const query = qIdx >= 0 ? rest.slice(qIdx) : ''
        const noQuery = qIdx >= 0 ? rest.slice(0, qIdx) : rest
        const slash = noQuery.indexOf('/')
        const encodedBase = slash >= 0 ? noQuery.slice(0, slash) : noQuery
        const path = slash >= 0 ? noQuery.slice(slash) : '/'
        let base = ''
        try {
          base = decodeURIComponent(encodedBase)
        } catch {
          /* 非法编码按坏地址处理 */
        }
        if (!/^https?:\/\//.test(base)) {
          res.statusCode = 400
          res.end('bad proxy base')
          return
        }
        const target = new URL(base + path + query)
        const doReq = target.protocol === 'https:' ? httpsRequest : httpRequest
        const clientIp = req.socket.remoteAddress ?? ''
        const upstream = doReq(
          target,
          {
            method: req.method,
            headers: {
              ...sanitizeHeaders(req.headers),
              host: target.host,
              'x-forwarded-for': clientIp,
              'x-real-ip': clientIp,
            },
          },
          (up) => {
            res.statusCode = up.statusCode ?? 502
            for (const [k, v] of Object.entries(up.headers)) {
              if (k.startsWith(':')) continue
              if (v !== undefined) res.setHeader(k, v)
            }
            up.pipe(res)
          },
        )
        upstream.on('error', () => {
          res.statusCode = 502
          res.end('upstream unreachable')
        })
        req.pipe(upstream)
      })
    },
  }
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  // 网页版可把静态资源放到 CDN，例如 https://static.example.com；留空则走原站相对路径。
  const cdnBase = (env.VITE_CDN_BASE ?? process.env.VITE_CDN_BASE ?? '').trim().replace(/\/+$/, '')

  return {
    base: cdnBase ? `${cdnBase}/` : '/',
    plugins: [...plugins, devApiBridge()],
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
