import { writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import os from 'node:os'
import selfsigned from 'selfsigned'

const CERT_DIR = join(dirname(fileURLToPath(import.meta.url)), 'certs')
const META = join(CERT_DIR, 'meta.json')
const KEY = join(CERT_DIR, 'key.pem')
const CERT = join(CERT_DIR, 'cert.pem')

/** 收集本机所有局域网 IPv4（不含回环），保证自签名证书覆盖手机可访问的地址 */
function lanIps() {
  const ips = new Set(['127.0.0.1'])
  for (const list of Object.values(os.networkInterfaces())) {
    for (const ni of list ?? []) {
      if (ni.family === 'IPv4' && !ni.internal && ni.address) ips.add(ni.address)
    }
  }
  return [...ips].sort()
}

/** 确保开发证书存在且覆盖当前局域网 IP；IP 变化时自动重新生成。
 *  返回 { key, cert } PEM 文件路径。 */
export async function ensureCert({ force = false } = {}) {
  const ips = lanIps()
  let need = force || !existsSync(KEY) || !existsSync(CERT)
  if (!need && existsSync(META)) {
    try {
      const prev = JSON.parse(readFileSync(META, 'utf8'))
      if (JSON.stringify(prev.ips ?? []) !== JSON.stringify(ips)) need = true
    } catch {
      need = true
    }
  }
  if (!need) return { key: KEY, cert: CERT }

  mkdirSync(CERT_DIR, { recursive: true })
  const pems = await selfsigned.generate(
    [{ name: 'commonName', value: 'MeiDay Dev (self-signed)' }],
    {
      days: 365,
      keySize: 2048,
      algorithm: 'sha256',
      extensions: [
        { name: 'basicConstraints', cA: false },
        { name: 'keyUsage', digitalSignature: true, keyEncipherment: true },
        { name: 'extKeyUsage', serverAuth: true, clientAuth: true },
        {
          name: 'subjectAltName',
          altNames: [
            { type: 2, value: 'localhost' },
            ...ips.map((ip) => ({ type: 7, ip })),
          ],
        },
      ],
    },
  )
  writeFileSync(KEY, pems.private)
  writeFileSync(CERT, pems.cert)
  writeFileSync(META, JSON.stringify({ ips }, null, 2))
  console.log('[meiday-cert] 开发证书已生成/更新，覆盖地址: ' + ips.join(', '))
  return { key: KEY, cert: CERT }
}

// 支持命令行直接运行：node gen-cert.mjs
if (process.argv[1] && process.argv[1].replaceAll('\\', '/').endsWith('/gen-cert.mjs')) {
  ensureCert({ force: true })
}
