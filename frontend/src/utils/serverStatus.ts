import { ref } from 'vue'

/**
 * 中心服务器连接状态（全局共享,模块级响应式,供云朵按钮等组件展示）。
 *
 * - unknown: 尚无任何请求结果（初始状态,云朵空白）；
 * - ok:      最近一次请求服务器应答了（2xx/3xx/4xx,含 401——服务器活着、在应答）;
 * - fail:    最近一次请求网络层失败（超时/断连/拒绝/DNS）,或服务器返回 5xx
 *            （500/502/503/504——后端自身故障,或前置代理/网关应答但后端不可达,
 *            vite dev 代理、/__api/ 桥接、nginx 反代在后端死掉时都会返回 502）。
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
