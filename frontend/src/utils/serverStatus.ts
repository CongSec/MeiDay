import { ref } from 'vue'

/**
 * 中心服务器连接状态（全局共享,模块级响应式,供云朵按钮等组件展示）。
 *
 * - unknown: 尚无任何请求结果（初始状态,云朵空白）；
 * - ok:      最近一次请求拿到了 HTTP 响应（任意状态码,含 4xx/5xx/401,只要服务器应答了）;
 * - fail:    最近一次请求网络层失败（超时/断连/拒绝/DNS 失败）。
 *
 * 与 pinia 解耦:client.ts 在 pinia 创建前就可能被引用,直接暴露 ref 避免循环依赖。
 * OSS 请求不走这里:那是另一条链路,OSS 故障有自己的错误弹窗,不误报"服务器连接失败"。
 */
export type ServerStatus = 'unknown' | 'ok' | 'fail'

export const serverStatus = ref<ServerStatus>('unknown')

export function markServerOk(): void {
  serverStatus.value = 'ok'
}

export function markServerFail(): void {
  serverStatus.value = 'fail'
}
