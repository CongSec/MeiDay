/**
 * 是否运行在思源插件内。
 * 思源插件把 MeiDay 前端内联在 srcdoc iframe 中（与思源同源），
 * 此时 window.location.reload() 会连带整个思源界面一起重载（表现为出现思源启动加载页），
 * 因此需要“软刷新”（重新拉取/物化数据）来代替整页刷新。
 * Web / APK 独立运行时是顶层窗口、无父框架，返回 false。
 */
export function isSiyuanPlugin(): boolean {
  if (typeof window === 'undefined') return false
  try {
    return window.parent !== window
  } catch {
    // 跨源/受限环境读取父窗口失败时按独立运行处理
    return false
  }
}