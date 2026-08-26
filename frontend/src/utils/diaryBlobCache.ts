/** 隐私日记：解密文件的 Blob URL 缓存（内存态）。
 *  退出系统 / 空闲锁定 / 登出 时统一 release，避免 objectURL 泄漏内存。 */
const blobUrls = new Map<string, string>()

export function cacheDiaryBlobUrl(fileId: string, url: string): void {
  releaseDiaryFileUrl(fileId)
  blobUrls.set(fileId, url)
}

export function getCachedDiaryBlobUrl(fileId: string): string | undefined {
  return blobUrls.get(fileId)
}

export function releaseDiaryFileUrl(fileId: string): void {
  const url = blobUrls.get(fileId)
  if (url) {
    URL.revokeObjectURL(url)
    blobUrls.delete(fileId)
  }
}

export function releaseAllDiaryFileUrls(): void {
  for (const url of blobUrls.values()) URL.revokeObjectURL(url)
  blobUrls.clear()
}
