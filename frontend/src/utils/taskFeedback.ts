/**
 * 完成任务反馈：提示音 + App 端震动。
 *
 * - 提示音：用 Web Audio 实时合成（不依赖任何音频资源文件），Web / 思源插件(单文件 HTML) /
 *   APK WebView 三端都能播放，且不增加构建体积；首次调用发生在「点击勾选」的用户手势内，
 *   可绕过浏览器自动播放限制。
 * - 震动：走 @capacitor/haptics 原生插件（比 navigator.vibrate 在 Capacitor WebView 里可靠），
 *   仅在原生 Android（APK）生效，Web / 插件端自动跳过。
 */

import { Capacitor } from '@capacitor/core'
import { Haptics, ImpactStyle, NotificationType } from '@capacitor/haptics'

let audioCtx: AudioContext | null = null
let masterGain: GainNode | null = null

/** 原生 App 端（Android APK）才执行震动；Web / 插件端直接跳过 */
function isNativeAndroid(): boolean {
  return Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android'
}

/** 懒创建并复用 AudioContext（拿到的是处于用户手势内创建的实例，resume 一般不会失败） */
function ensureAudio(): AudioContext | null {
  if (typeof window === 'undefined') return null
  const Ctor =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
  if (!Ctor) return null
  try {
    if (!audioCtx) {
      audioCtx = new Ctor()
      masterGain = audioCtx.createGain()
      // 总音量留有余量，避免双音叠加削波
      masterGain.gain.value = 0.5
      masterGain.connect(audioCtx.destination)
    }
    // 页面可能因自动播放策略处于 suspended，手势内恢复
    if (audioCtx.state === 'suspended') void audioCtx.resume()
    return audioCtx
  } catch {
    return null
  }
}

/** 播放一个「铃音」音符：基频 + 轻微二次泛音 + 指数衰减，听感清脆不刺耳 */
function playNote(
  ctx: AudioContext,
  dest: AudioNode,
  freq: number,
  start: number,
  duration: number,
  peak: number,
) {
  const osc = ctx.createOscillator()
  const gain = ctx.createGain()
  osc.type = 'sine'
  osc.frequency.value = freq

  const osc2 = ctx.createOscillator()
  osc2.type = 'sine'
  osc2.frequency.value = freq * 2
  const gain2 = ctx.createGain()
  gain2.gain.value = peak * 0.22

  // 起音快速爬升避免爆音，结尾指数衰减成自然余音
  gain.gain.setValueAtTime(0.0001, start)
  gain.gain.exponentialRampToValueAtTime(peak, start + 0.015)
  gain.gain.exponentialRampToValueAtTime(0.0001, start + duration)

  osc.connect(gain)
  osc2.connect(gain2)
  gain2.connect(gain)
  gain.connect(dest)

  osc.start(start)
  osc2.start(start)
  osc.stop(start + duration + 0.06)
  osc2.stop(start + duration + 0.06)
}

/** 完成任务提示音：轻快上行双音（G5 → C6），约 0.5s，有“完成/确认”的正反馈感 */
export function playTaskCompleteSound() {
  const ctx = ensureAudio()
  if (!ctx || !masterGain) return
  try {
    const t0 = ctx.currentTime + 0.01
    playNote(ctx, masterGain, 783.99, t0, 0.16, 0.26) // G5
    playNote(ctx, masterGain, 1046.5, t0 + 0.1, 0.3, 0.28) // C6
  } catch {
    /* 音频失败静默忽略，不影响任务保存 */
  }
}

/** 主任务完成震动：成功提示级反馈（Android 上为双短震） */
export async function vibrateComplete() {
  if (!isNativeAndroid()) return
  try {
    await Haptics.notification({ type: NotificationType.Success })
  } catch {
    /* 不支持/未授予权限时静默忽略 */
  }
}

/** 子任务完成震动：轻量单次点触，与主任务完成的“成功反馈”区分开 */
export async function vibrateSubtaskComplete() {
  if (!isNativeAndroid()) return
  try {
    await Haptics.impact({ style: ImpactStyle.Light })
  } catch {
    /* 不支持/未授予权限时静默忽略 */
  }
}

/** 完成任务整体反馈：提示音 + App 震动 */
export function taskCompleteFeedback() {
  playTaskCompleteSound()
  void vibrateComplete()
}
