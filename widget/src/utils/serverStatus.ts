import { ref } from 'vue'

/**
 * 中心服务器连接状态（全局共享,模块级响应式）。
 * 与网页端 utils/serverStatus.ts 语义一致,供后续状态指示使用;widget 当前只做逻辑、
 * 不做界面展示,但请求层的超时/状态更新与网页端保持同一套。
 * 仅由对中心服务器的 HTTP 请求驱动:拿到任何响应 → ok;网络层失败(超时/断连/拒绝) → fail。
 */
export type ServerStatus = 'unknown' | 'ok' | 'fail'

export const serverStatus = ref<ServerStatus>('unknown')

export function markServerOk(): void {
  serverStatus.value = 'ok'
}

export function markServerFail(): void {
  serverStatus.value = 'fail'
}
