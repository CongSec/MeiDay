import { defineStore } from 'pinia'
import { pvApi, readConfig, writeWidget } from '@/utils/config'

/**
 * 小组件界面状态 store（view / settings / hidden 三模式 + 界面设置）。
 * 界面设置持久化到程序同级 config.json；模式由托盘或前端按钮驱动。
 *
 * 模式变化会同步通知 Python 壳（pvApi().set_mode）：
 *  - settings：取消鼠标穿透、窗口置前（可交互、可拖拽）；
 *  - view / hidden：开启鼠标穿透、窗口置底。
 */
export type WidgetMode = 'view' | 'settings' | 'hidden'

export const useWidgetStore = defineStore('widget', {
  state: () => ({
    mode: 'view' as WidgetMode,
    /** 小组件是否处于“可见”状态（hidden 为隐藏；settings 不改变该值） */
    shown: true,
    opacity: 0.6,
    width: 360,
    /** 屏幕位置（逻辑像素，可空：未拖动过则为 null，启动时贴右） */
    posX: null as number | null,
    posY: null as number | null,
    autoStart: false,
    ready: false,
  }),
  actions: {
    async init(): Promise<void> {
      const cfg = await readConfig()
      const w = cfg.widget
      this.opacity = typeof w.opacity === 'number' ? Math.min(1, Math.max(0.1, w.opacity)) : 0.6
      this.width = Math.min(520, Math.max(240, Number(w.width) || 360))
      this.posX = typeof w.posX === 'number' ? w.posX : null
      this.posY = typeof w.posY === 'number' ? w.posY : null
      this.autoStart = !!w.autoStart
      // 以系统注册表为准同步开机自启动状态（可能被外部改动）
      const api = pvApi()
      if (api?.get_auto_start) {
        try {
          this.autoStart = !!(await api.get_auto_start())
        } catch {
          /* 忽略 */
        }
      }
      this.ready = true
    },
    setMode(mode: WidgetMode): void {
      this.mode = mode
      if (mode === 'hidden') this.shown = false
      else if (mode === 'view') this.shown = true
      // 通知 Python 壳切换穿透 / 置前置底
      const api = pvApi()
      if (api?.set_mode) {
        try {
          api.set_mode(mode)
        } catch {
          /* 忽略 */
        }
      }
    },
    async persist(): Promise<void> {
      await writeWidget({
        opacity: this.opacity,
        width: this.width,
        posX: this.posX,
        posY: this.posY,
        autoStart: this.autoStart,
      })
    },
    async setAutoStart(value: boolean): Promise<void> {
      this.autoStart = value
      const api = pvApi()
      if (api?.set_auto_start) {
        try {
          await api.set_auto_start(value)
        } catch {
          /* 忽略 */
        }
      }
      await this.persist()
    },
  },
})
