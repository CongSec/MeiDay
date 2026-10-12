import { Capacitor, registerPlugin } from '@capacitor/core'

interface DeviceIdPluginShape {
  getAndroidId(): Promise<{ androidId: string }>
}

const native = registerPlugin<DeviceIdPluginShape>('DeviceId')

export const isDeviceIdSupported = (): boolean => Capacitor.isNativePlatform()

let cachedFingerprint: string | null = null

async function hashAndroidId(androidId: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(androidId || 'unknown'))
  const bytes = new Uint8Array(digest)
  let hex = ''
  for (let i = 0; i < bytes.length; i++) hex += bytes[i].toString(16).padStart(2, '0')
  return hex.slice(0, 16)
}

export async function getOssUserAgent(): Promise<string> {
  if (cachedFingerprint) return cachedFingerprint
  let fp = 'unknown'
  if (isDeviceIdSupported()) {
    try {
      const { androidId } = await native.getAndroidId()
      fp = await hashAndroidId(androidId)
    } catch (e) {
      console.warn('[DeviceId] 读取 ANDROID_ID 失败，回退 unknown', e)
    }
  }
  cachedFingerprint = fp
  return `MeiDay/App/${fp}`
}
