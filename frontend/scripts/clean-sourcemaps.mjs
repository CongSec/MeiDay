// 构建后兜底清理：即使某个依赖/插件在构建时意外产出 sourcemap，也强制移除。
// - 删除 dist 下所有 *.map 文件
// - 从 JS/CSS 中剥离 //# sourceMappingURL= 与 /*# sourceMappingURL= */ 注释
// 用法：node scripts/clean-sourcemaps.mjs [distDir]
import { readdir, readFile, unlink, writeFile } from 'node:fs/promises'
import { join, extname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const distDir = resolve(__dirname, '..', process.argv[2] || 'dist')

let removed = 0
let scrubbed = 0

function hasMapping(content) {
  return /[ \t]*\/\/[#@]\s*sourceMappingURL=[^\s]*/.test(content) ||
    /[ \t]*\/\*[#@]\s*sourceMappingURL=[^\s]*\s*\*\//.test(content)
}

function stripMapping(content) {
  return content
    .replace(/[ \t]*\/\/[#@]\s*sourceMappingURL=[^\s]*[ \t]*(\r?\n)?/g, '\n')
    .replace(/[ \t]*\/\*[#@]\s*sourceMappingURL=[^\s]*\s*\*\/[ \t]*(\r?\n)?/g, '\n')
}

async function walk(dir) {
  const entries = await readdir(dir, { withFileTypes: true })
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      await walk(full)
      continue
    }
    if (entry.name.endsWith('.map')) {
      await unlink(full)
      removed++
      console.log(`[clean-sourcemaps] removed ${full}`)
      continue
    }
    const ext = extname(entry.name)
    if (ext !== '.js' && ext !== '.css') continue
    const content = await readFile(full, 'utf8')
    if (!hasMapping(content)) continue
    await writeFile(full, stripMapping(content), 'utf8')
    scrubbed++
    console.log(`[clean-sourcemaps] scrubbed ${full}`)
  }
}

await walk(distDir)
console.log(`[clean-sourcemaps] done: removed ${removed} map file(s), scrubbed ${scrubbed} js/css file(s)`)
