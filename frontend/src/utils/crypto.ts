import type { CredFields } from '@/types'

export const encoder = new TextEncoder()
export const decoder = new TextDecoder()

export async function deriveUserKey(password: string, username: string): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey(
    'raw',
    encoder.encode(password),
    'PBKDF2',
    false,
    ['deriveKey'],
  )
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: encoder.encode(username), iterations: 100000, hash: 'SHA-256' },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  )
}

export function bytesToB64(bytes: Uint8Array): string {
  let bin = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  return btoa(bin)
}

export function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return bytes
}

/** 登录/注册使用的不可逆校验子：SHA-256(password) 的 base64。
 *  客户端只发送该密文到服务器，不发送明文密码；服务端对校验子再做 argon2 慢哈希存储。 */
export async function passwordVerifier(password: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(password))
  return bytesToB64(new Uint8Array(digest))
}

/** AES-GCM 加密任意字节（IV 前置），返回 base64(iv + ciphertext) */
export async function encryptBytes(key: CryptoKey, data: Uint8Array): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const cipher = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, data)
  const payload = new Uint8Array(iv.length + cipher.byteLength)
  payload.set(iv, 0)
  payload.set(new Uint8Array(cipher), iv.length)
  return bytesToB64(payload)
}

/** AES-GCM 解密字节（与 encryptBytes 配对） */
export async function decryptBytes(key: CryptoKey, payloadB64: string): Promise<Uint8Array> {
  const raw = b64ToBytes(payloadB64)
  const iv = raw.slice(0, 12)
  const data = raw.slice(12)
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, data)
  return new Uint8Array(plain)
}

async function encryptField(key: CryptoKey, plain: string): Promise<string> {
  return encryptBytes(key, encoder.encode(plain))
}

async function decryptField(key: CryptoKey, payloadB64: string): Promise<string> {
  return decoder.decode(await decryptBytes(key, payloadB64))
}

const FIELD_ORDER: (keyof CredFields)[] = [
  'ossAk',
  'ossSk',
  'bucket',
  'region',
  'smtpUser',
  'smtpPass',
  'notifyEmail',
]

export async function encryptCreds(userKey: CryptoKey, fields: CredFields): Promise<string> {
  const ciphers = await Promise.all(FIELD_ORDER.map((k) => encryptField(userKey, fields[k])))
  return JSON.stringify({ v: 1, fields: ciphers })
}

export async function decryptCreds(userKey: CryptoKey, payload: string): Promise<CredFields> {
  const { fields } = JSON.parse(payload) as { v: number; fields: string[] }
  const plains = await Promise.all(fields.map((f) => decryptField(userKey, f)))
  const out = {} as CredFields
  FIELD_ORDER.forEach((k, i) => {
    out[k] = plains[i]
  })
  return out
}
