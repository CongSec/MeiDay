import { fileURLToPath, URL } from 'node:url'
import { defineConfig, loadEnv } from 'vite'
import vue from '@vitejs/plugin-vue'
import { viteSingleFile } from 'vite-plugin-singlefile'

// 思源插件专用构建：把整个应用打包成单个自包含 HTML（所有 JS/CSS/资源内联），
// 由插件在 iframe(blob URL) 里加载。API 通过 VITE_API_BASE_URL 指向远端后端。
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const apiBase = (env.VITE_API_BASE_URL ?? process.env.VITE_API_BASE_URL ?? '')
    .trim()
    .replace(/\/+$/, '')
  if (!apiBase) {
    throw new Error('[meiday-plugin] 请设置 VITE_API_BASE_URL（例如 https://task.congsec.cn）')
  }
  return {
    base: './',
    plugins: [vue(), viteSingleFile()],
    resolve: {
      alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
    },
    build: {
      outDir: 'dist-plugin',
      sourcemap: false,
      copyPublicDir: false,
      rollupOptions: {
        output: {
          // 单文件模式：把所有动态 import 内联进同一个 chunk
          inlineDynamicImports: true,
          manualChunks: undefined,
        },
      },
    },
  }
})
