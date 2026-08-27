/** 隐私日记：发送前对超大图片自动压缩（有损），显著减小上传体积，
 *  尤其对移动端（相机原图 3~10MB → 数百 KB）上传速度提升明显。 */

/** 压缩阈值：边长超过或文件超过该体积才压缩 */
const MAX_DIM = 1920
const MAX_BYTES = 1.5 * 1024 * 1024
const JPEG_QUALITY = 0.85

/** 不参与压缩的格式（透明/矢量/不可解码） */
const SKIP_TYPES = new Set(['image/gif', 'image/svg+xml', 'image/heic', 'image/heif'])

/**
 * 若图片过大则压缩为 JPEG 返回新 File；否则原样返回。
 * 任何解码失败都会回退原文件，绝不阻塞发送。
 */
export async function maybeCompressImage(file: File): Promise<File> {
  if (!file.type.startsWith('image/') || SKIP_TYPES.has(file.type)) return file
  if (file.size < MAX_BYTES) return file

  let canvas: HTMLCanvasElement | null = null
  try {
    // 优先 createImageBitmap（自动处理 EXIF 方向），旧浏览器回退 <img> 解码
    if (typeof createImageBitmap === 'function') {
      const bmp = await createImageBitmap(file)
      canvas = drawFromBitmap(bmp)
      bmp.close()
    } else {
      const url = URL.createObjectURL(file)
      try {
        const img = new Image()
        await new Promise<void>((resolve, reject) => {
          img.onload = () => resolve()
          img.onerror = () => reject(new Error('decode failed'))
          img.src = url
        })
        canvas = drawFromImage(img)
      } finally {
        URL.revokeObjectURL(url)
      }
    }
  } catch {
    return file
  }

  if (!canvas) return file

  const blob = await new Promise<Blob | null>((resolve) => {
    // 白底填充，避免透明 PNG 转 JPEG 后变黑
    const ctx = canvas.getContext('2d')
    if (ctx) {
      ctx.globalCompositeOperation = 'destination-over'
      ctx.fillStyle = '#ffffff'
      ctx.fillRect(0, 0, canvas.width, canvas.height)
    }
    canvas.toBlob(resolve, 'image/jpeg', JPEG_QUALITY)
  })
  if (!blob || blob.size >= file.size) return file

  const name = file.name.replace(/\.[^.]+$/, '') + '.jpg'
  return new File([blob], name, { type: 'image/jpeg' })
}

function drawFromBitmap(bmp: ImageBitmap): HTMLCanvasElement | null {
  const scale = Math.min(1, MAX_DIM / Math.max(bmp.width, bmp.height))
  if (scale >= 1) return null
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(bmp.width * scale))
  canvas.height = Math.max(1, Math.round(bmp.height * scale))
  const ctx = canvas.getContext('2d')
  if (!ctx) return null
  ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height)
  return canvas
}

function drawFromImage(img: HTMLImageElement): HTMLCanvasElement | null {
  const scale = Math.min(1, MAX_DIM / Math.max(img.naturalWidth, img.naturalHeight))
  if (scale >= 1) return null
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(img.naturalWidth * scale))
  canvas.height = Math.max(1, Math.round(img.naturalHeight * scale))
  const ctx = canvas.getContext('2d')
  if (!ctx) return null
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
  return canvas
}
