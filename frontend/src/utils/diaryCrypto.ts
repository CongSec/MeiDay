import { bytesToB64, b64ToBytes, decoder, encoder, encryptBytes, decryptBytes } from './crypto'
import { nowIso } from './time'

/** 隐私日记：信封加密（envelope encryption）。
 *  - 随机 DEK（AES-256-GCM）加密全部日记内容；
 *  - 用户密码经 PBKDF2 派生 KEK，KEK 仅用于包装 DEK（_meta.json）。
 *  密码不改动日记内容、只重包装 DEK；忘记密码 = 无法解开 DEK = 数据永久不可恢复。
 *  纯客户端执行，密码与 DEK 只存在于内存，不经服务器、不落盘。 */

export const DIARY_KEK_ITERATIONS = 210000

/** _meta.json 内容：salt/iv/wrapped 均为 base64 */
export interface DiaryMeta {
  v: 1
  /** PBKDF2 salt（16 字节随机） */
  salt: string
  /** 包装 DEK 用的 IV（12 字节） */
  iv: string
  /** 用 KEK 加密 DEK 后的密文 */
  wrapped: string
  createdAt: string
  updatedAt: string
}

async function importAesKey(raw: Uint8Array, usages: KeyUsage[]): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', raw as BufferSource, { name: 'AES-GCM', length: 256 }, false, usages)
}

async function deriveDiaryKek(password: string, salt: Uint8Array): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey(
    'raw',
    encoder.encode(password) as BufferSource,
    'PBKDF2',
    false,
    ['deriveKey'],
  )
  return crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt: salt as BufferSource,
      iterations: DIARY_KEK_ITERATIONS,
      hash: 'SHA-256',
    },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  )
}

/** 首次进入：生成 DEK 并用密码包装，返回 DEK（内存）与 _meta.json（可落 OSS） */
export async function createDiaryMeta(
  password: string,
): Promise<{ meta: DiaryMeta; dek: Uint8Array }> {
  const salt = crypto.getRandomValues(new Uint8Array(16))
  const dek = crypto.getRandomValues(new Uint8Array(32))
  const kek = await deriveDiaryKek(password, salt)
  const wrapIv = crypto.getRandomValues(new Uint8Array(12))
  const wrapped = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: wrapIv }, kek, dek as BufferSource)
  return {
    dek,
    meta: {
      v: 1,
      salt: bytesToB64(salt),
      iv: bytesToB64(wrapIv),
      wrapped: bytesToB64(new Uint8Array(wrapped)),
      createdAt: nowIso(),
      updatedAt: nowIso(),
    },
  }
}

/** 进入：用密码解开 _meta.json 中的 DEK；密码错误返回 null */
export async function unwrapDiary(meta: DiaryMeta, password: string): Promise<Uint8Array | null> {
  try {
    const salt = b64ToBytes(meta.salt)
    const kek = await deriveDiaryKek(password, salt)
    const iv = b64ToBytes(meta.iv)
    const wrapped = b64ToBytes(meta.wrapped)
    const dekBuf = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: iv as BufferSource }, kek, wrapped as BufferSource)
    if (dekBuf.byteLength !== 32) return null
    return new Uint8Array(dekBuf)
  } catch {
    return null
  }
}

/** 修改密码：用新密码重新包装同一个 DEK（数据本身不重加密） */
export async function rewrapDiaryMeta(
  meta: DiaryMeta,
  dek: Uint8Array,
  newPassword: string,
): Promise<DiaryMeta> {
  const salt = crypto.getRandomValues(new Uint8Array(16))
  const kek = await deriveDiaryKek(newPassword, salt)
  const wrapIv = crypto.getRandomValues(new Uint8Array(12))
  const wrapped = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: wrapIv }, kek, dek as BufferSource)
  return {
    ...meta,
    v: 1,
    salt: bytesToB64(salt),
    iv: bytesToB64(wrapIv),
    wrapped: bytesToB64(new Uint8Array(wrapped)),
    updatedAt: nowIso(),
  }
}

/** 导出 zip 内的密钥文件 dek.json 内容：salt/iv/wrapped 均为 base64。
 *  用「导出密码」独立包装源 DEK，与账号密码/登录无关；跨账号导入时用它解锁源 DEK。 */
export interface DiaryExportKey {
  v: 1
  salt: string
  iv: string
  wrapped: string
  createdAt: string
}

/** 用导出密码包装源 DEK，生成可写入导出 zip 的 dek.json 内容 */
export async function wrapDiaryDekForExport(password: string, dek: Uint8Array): Promise<DiaryExportKey> {
  const salt = crypto.getRandomValues(new Uint8Array(16))
  const kek = await deriveDiaryKek(password, salt)
  const wrapIv = crypto.getRandomValues(new Uint8Array(12))
  const wrapped = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: wrapIv }, kek, dek as BufferSource)
  return {
    v: 1,
    salt: bytesToB64(salt),
    iv: bytesToB64(wrapIv),
    wrapped: bytesToB64(new Uint8Array(wrapped)),
    createdAt: nowIso(),
  }
}

/** 用导出密码解开导出 zip 中的源 DEK；密码错误返回 null */
export async function unwrapDiaryDekForExport(
  payload: DiaryExportKey,
  password: string,
): Promise<Uint8Array | null> {
  try {
    const salt = b64ToBytes(payload.salt)
    const kek = await deriveDiaryKek(password, salt)
    const iv = b64ToBytes(payload.iv)
    const wrapped = b64ToBytes(payload.wrapped)
    const dekBuf = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: iv as BufferSource }, kek, wrapped as BufferSource)
    if (dekBuf.byteLength !== 32) return null
    return new Uint8Array(dekBuf)
  } catch {
    return null
  }
}

/** 把 WebCrypto 的原始解密错误（英文/无信息）翻译成用户能看懂的中文提示 */
export function friendlyDecryptError(): Error {
  return new Error('解密失败：日记密码不匹配或数据已损坏')
}

/** 加密某天日记（文本）→ base64(iv + ciphertext) */
export async function encryptDay(dek: Uint8Array, plain: string): Promise<string> {
  const key = await importAesKey(dek, ['encrypt'])
  return encryptBytes(key, encoder.encode(plain))
}

/** 解密某天日记密文（base64）→ 明文文本；密码不匹配或数据损坏时抛出可读中文错误 */
export async function decryptDay(dek: Uint8Array, cipherB64: string): Promise<string> {
  try {
    const key = await importAesKey(dek, ['decrypt'])
    return decoder.decode(await decryptBytes(key, cipherB64.trim()))
  } catch {
    throw friendlyDecryptError()
  }
}

/** 加密附件/音频字节 → 原始密文字节（iv 前置） */
export async function encryptFileBytes(dek: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  const key = await importAesKey(dek, ['encrypt'])
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const cipher = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, data as BufferSource)
  const out = new Uint8Array(iv.length + cipher.byteLength)
  out.set(iv, 0)
  out.set(new Uint8Array(cipher), iv.length)
  return out
}

/** 解密附件/音频密文字节（iv 前置）→ 原始字节；密码不匹配或数据损坏时抛出可读中文错误 */
export async function decryptFileBytes(dek: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  try {
    const key = await importAesKey(dek, ['decrypt'])
    const iv = data.slice(0, 12)
    const cipher = data.slice(12)
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: iv as BufferSource }, key, cipher as BufferSource)
    return new Uint8Array(plain)
  } catch {
    throw friendlyDecryptError()
  }
}
