import { Capacitor, registerPlugin } from '@capacitor/core'

/**
 * 原生「保存到系统下载目录」插件（Android 自研插件 SaveToDownloadsPlugin.java，见
 * frontend/android/app/src/main/java/com/meiday/app/SaveToDownloadsPlugin.java）。
 * 仅在 Capacitor 原生平台使用；Web / 思源插件端不会调用（走浏览器下载回退）。
 */
export interface SaveToDownloadsPlugin {
  save(options: { base64: string; fileName: string; mime?: string }): Promise<{ path: string }>
}

const SaveToDownloads = registerPlugin<SaveToDownloadsPlugin>('SaveToDownloads')

/** 是否为 Capacitor 原生平台（Android/iOS APK 内）；Web / 思源插件端返回 false */
export function isNativeRuntime(): boolean {
  return (
    typeof Capacitor !== 'undefined' &&
    typeof Capacitor.isNativePlatform === 'function' &&
    Capacitor.isNativePlatform()
  )
}

export interface SaveResult {
  /** native = 已写入系统下载目录；web = 浏览器下载（用户看浏览器下载栏） */
  mode: 'native' | 'web'
  /** native 模式下的展示路径（如 下载/MeiDay/日记导出-2026-10.zip） */
  path?: string
  fileName: string
}

/** Blob → base64（FileReader 内部流式读取，避免大文件一次性 String.fromCharCode 卡顿/栈溢出） */
function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(reader.error ?? new Error('读取文件失败'))
    reader.onload = () => {
      const dataUrl = reader.result as string
      resolve(dataUrl.slice(dataUrl.indexOf(',') + 1))
    }
    reader.readAsDataURL(blob)
  })
}

/**
 * 保存 Blob 到设备：
 * - 原生平台（Android App）：写入系统下载目录（Download/MeiDay/），返回展示路径；
 * - Web / 思源插件端：沿用浏览器 <a download> 下载，保持原有行为。
 * 调用方根据返回结果 toast：native 时提示完整路径，web 时维持原文案。
 */
export async function saveBlobToDevice(blob: Blob, fileName: string, mime?: string): Promise<SaveResult> {
  if (isNativeRuntime()) {
    const base64 = await blobToBase64(blob)
    const { path } = await SaveToDownloads.save({
      base64,
      fileName,
      mime: mime || blob.type || undefined,
    })
    return { mode: 'native', path, fileName }
  }
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = fileName
  document.body.appendChild(a)
  a.click()
  a.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 5000)
  return { mode: 'web', fileName }
}

/** 生成保存成功后的 toast 文案：native 追加「已保存到 <路径>」，web 保持原文案 */
export function saveToastText(save: SaveResult, base: string): string {
  return save.mode === 'native' && save.path ? `${base}，已保存到 ${save.path}` : base
}
