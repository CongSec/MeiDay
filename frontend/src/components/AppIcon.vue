<script setup lang="ts">
/**
 * AppIcon — 全站统一线性图标（stroke 1.5, currentColor）
 * 用法：<AppIcon name="calendar" :size="18" class="text-slate-400" />
 */
import { computed } from 'vue'

const props = withDefaults(
  defineProps<{
    name: string
    size?: number | string
    strokeWidth?: number
  }>(),
  { size: 20, strokeWidth: 1.5 },
)

/** 每个图标是 24x24 viewBox 内的 svg 内部标记（stroke 属性由外层 svg 统一提供） */
const ICONS: Record<string, string> = {
  // 导航 / 通用
  calendar: '<rect x="3" y="4.5" width="18" height="16" rx="2.5"/><path d="M8 2.8v3.4M16 2.8v3.4M3 9.5h18"/>',
  calendarFuture: '<rect x="3" y="4.5" width="18" height="16" rx="2.5"/><path d="M8 2.8v3.4M16 2.8v3.4M3 9.5h18"/><path d="M12 12.5v3l2 1.2"/>',
  box: '<path d="M3.5 7.5 12 3l8.5 4.5v9L12 21l-8.5-4.5z"/><path d="M3.5 7.5 12 12l8.5-4.5M12 12v9"/>',
  bell: '<path d="M18 9.5a6 6 0 0 0-12 0c0 5-2 6-2 6h16s-2-1-2-6"/><path d="M10.3 19a2 2 0 0 0 3.4 0"/>',
  repeat: '<path d="M4 9V6.5A2.5 2.5 0 0 1 6.5 4H18"/><path d="M18 4l-2.5 2.5L18 9"/><path d="M20 15v2.5a2.5 2.5 0 0 1-2.5 2.5H6"/><path d="M6 20l2.5-2.5L6 15"/>',
  paperclip: '<path d="M9.5 12.5 15 7a3.2 3.2 0 0 1 4.5 4.5l-6.4 6.4a5 5 0 0 1-7-7l6.6-6.6"/>',
  trash: '<path d="M4.5 6.5h15M9.5 6.5V5a1.5 1.5 0 0 1 1.5-1.5h2A1.5 1.5 0 0 1 14.5 5v1.5"/><path d="M6.5 6.5l.8 12a2 2 0 0 0 2 1.9h5.4a2 2 0 0 0 2-1.9l.8-12"/><path d="M10 10.5v5M14 10.5v5"/>',
  gear: '<circle cx="12" cy="12" r="3.2"/><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1 1.55V21a2 2 0 1 1-4 0v-.09a1.7 1.7 0 0 0-1-1.55 1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.7 1.7 0 0 0 .34-1.87 1.7 1.7 0 0 0-1.55-1H3a2 2 0 1 1 0-4h.09a1.7 1.7 0 0 0 1.55-1 1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.7 1.7 0 0 0 1.87.34h.09a1.7 1.7 0 0 0 1-1.55V3a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 1 1.55 1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.87v.09a1.7 1.7 0 0 0 1.55 1H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.51 1z"/>',
  lock: '<rect x="5" y="10.5" width="14" height="9.5" rx="2.5"/><path d="M8 10.5V7.8a4 4 0 0 1 8 0v2.7"/><path d="M12 14.2v2.6"/>',
  key: '<circle cx="8" cy="14.5" r="4.2"/><path d="m11 11.5 8.5-8.5M16.5 6l2.5 2.5M14 8.5 16 10.5"/>',
  download: '<path d="M12 3.5v11M8 11l4 3.5 4-3.5"/><path d="M4.5 16.5v2a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2v-2"/>',
  inbox: '<path d="M4 4.5h16v15H4z"/><path d="M4 13.5h4.5l1.5 2.5h4l1.5-2.5H20"/>',
  upload: '<path d="M12 14.5v-11M8 7.5l4-4 4 4"/><path d="M4.5 16.5v2a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2v-2"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="m16 16 4.5 4.5"/>',
  book: '<path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H20v15.5H6.5A2.5 2.5 0 0 0 4 21z"/><path d="M4 18.5A2.5 2.5 0 0 1 6.5 16H20"/><path d="M8.5 7h7M8.5 10.5h7"/>',
  mic: '<rect x="9" y="3.5" width="6" height="11" rx="3"/><path d="M5.5 11.5a6.5 6.5 0 0 0 13 0M12 18v3"/>',
  document: '<path d="M6 3.5h8l4.5 4.5V20.5H6z"/><path d="M14 3.5V8h4.5"/><path d="M9 13h6M9 16.5h6"/>',
  image: '<rect x="3.5" y="4.5" width="17" height="15" rx="2.5"/><circle cx="9" cy="10" r="1.6"/><path d="m5 18 4.5-4.5 3 3L16 13l3.5 3.5"/>',
  folder: '<path d="M3.5 6.5A1.5 1.5 0 0 1 5 5h4l2 2.5h8A1.5 1.5 0 0 1 20.5 9v8.5A1.5 1.5 0 0 1 19 19H5a1.5 1.5 0 0 1-1.5-1.5z"/>',
  clipboard: '<rect x="5" y="4" width="14" height="17" rx="2.5"/><path d="M9 4a2 2 0 0 1 2-1.5h2A2 2 0 0 1 15 4v.5H9z"/><path d="M8.5 9.5h7M8.5 13.5h7M8.5 17.5h4.5"/>',
  mail: '<rect x="3" y="5.5" width="18" height="13" rx="2.5"/><path d="m4 7 8 6 8-6"/>',
  chart: '<path d="M4.5 20.5h15"/><path d="M7 16.5v-5M12 16.5v-9M17 16.5v-3"/>',
  alert: '<path d="M12 3.5 2.8 19.5h18.4z"/><path d="M12 9.5v4"/><path d="M12 16.8v.2"/>',
  warning: '<circle cx="12" cy="12" r="9"/><path d="M12 7.5v5.5"/><path d="M12 16.2v.1"/>',
  check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
  'check-circle': '<circle cx="12" cy="12" r="9"/><path d="m8 12.5 2.8 2.8L16.5 9.5"/>',
  edit: '<path d="M4 20h4.5L19.5 9a2.1 2.1 0 0 0-3-3L5.5 17z"/><path d="M13.5 7.5l3 3"/>',
  close: '<path d="m6 6 12 12M18 6 6 18"/>',
  'chevron-down': '<path d="m6.5 9.5 5.5 5 5.5-5"/>',
  'chevron-up': '<path d="m6.5 14.5 5.5-5 5.5 5"/>',
  'chevron-right': '<path d="m9.5 6 5 5.5-5 5.5"/>',
  'chevron-left': '<path d="m14.5 6-5 5.5 5 5.5"/>',
  'chevron-left-double': '<path d="m11.5 7-4 5 4 5"/><path d="m17 7-4 5 4 5"/>',
  'chevron-right-double': '<path d="m6.5 7 4 5-4 5"/><path d="m12 7 4 5-4 5"/>',
  grip: '<circle cx="9" cy="5.5" r="1.2" fill="currentColor" stroke="none"/><circle cx="15" cy="5.5" r="1.2" fill="currentColor" stroke="none"/><circle cx="9" cy="12" r="1.2" fill="currentColor" stroke="none"/><circle cx="15" cy="12" r="1.2" fill="currentColor" stroke="none"/><circle cx="9" cy="18.5" r="1.2" fill="currentColor" stroke="none"/><circle cx="15" cy="18.5" r="1.2" fill="currentColor" stroke="none"/>',
  menu: '<path d="M4 6.5h16M4 12h16M4 17.5h16"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  refresh: '<path d="M20 12a8 8 0 1 1-2.34-5.66"/><path d="M20 4v4h-4"/>',
  logout: '<path d="M14 4.5H6.5A1.5 1.5 0 0 0 5 6v12a1.5 1.5 0 0 0 1.5 1.5H14"/><path d="m10 12 10 0M16.5 8.5 20 12l-3.5 3.5"/>',
  eye: '<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="3"/>',
  'eye-off': '<path d="M4 4l16 16"/><path d="M10.6 6.2A9.8 9.8 0 0 1 12 6c6 0 9.5 6 9.5 6a15.4 15.4 0 0 1-3 3.9M6.3 8.6A13.7 13.7 0 0 0 2.5 12S6 18 12 18a9.4 9.4 0 0 0 3.3-.6"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/>',
  send: '<path d="M4 12 20 4l-4.5 16-4-6.5z"/><path d="M11.5 13.5 20 4"/>',
  play: '<path d="M7 4.5 19 12 7 19.5z"/>',
  sparkle: '<path d="M12 3.5 13.8 9l5.5 1.8-5.5 1.8L12 18.5l-1.8-5.9-5.5-1.8L10.2 9z"/>',
  shield: '<path d="M12 3 5 6v5.5c0 4.6 3 8 7 9.5 4-1.5 7-4.9 7-9.5V6z"/><path d="m9 11.8 2.2 2.2L15.5 9.8"/>',
  user: '<circle cx="12" cy="8" r="3.8"/><path d="M5 20a7 7 0 0 1 14 0"/>',
  more: '<circle cx="5.5" cy="12" r="1.2" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.2" fill="currentColor" stroke="none"/><circle cx="18.5" cy="12" r="1.2" fill="currentColor" stroke="none"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3.5 2"/>',
  target: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="4.5"/><circle cx="12" cy="12" r="0.8" fill="currentColor" stroke="none"/>',
  flame: '<path d="M12 3.5c1.5 2.5 4.5 4.2 4.5 7.2a4.5 4.5 0 0 1-9 0c0-1.5.6-2.6 1.4-3.7.3 1 1 1.8 2 2.3-.3-2 .4-4 1.1-5.8z"/>',
  history: '<path d="M4 12a8 8 0 1 1 2.5 5.9"/><path d="M4 20v-4h4"/><path d="M12 8v4l2.8 1.6"/>',
  link: '<path d="M10 14a4.2 4.2 0 0 0 5.9 0l3-3a4.2 4.2 0 0 0-5.9-5.9l-1.5 1.5"/><path d="M14 10a4.2 4.2 0 0 0-5.9 0l-3 3a4.2 4.2 0 0 0 5.9 5.9l1.5-1.5"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5.5"/><path d="M12 7.5v.1"/>',
  'arrow-left': '<path d="M19 12H5M11 6l-6 6 6 6"/>',
  'arrow-right': '<path d="M5 12h14M13 6l6 6-6 6"/>',
  'arrow-up': '<path d="M12 19V5M6 11l6-6 6 6"/>',
  'arrow-down': '<path d="M12 5v14M6 13l6 6 6-6"/>',
  star: '<path d="m12 4 2.2 4.8 5.3.6-4 3.7 1.1 5.2L12 15.9 7.4 18.3l1.1-5.2-4-3.7 5.3-.6z"/>',
  'file-text': '<path d="M6 3.5h8l4.5 4.5V20.5H6z"/><path d="M14 3.5V8h4.5"/><path d="M9.5 12.5h5M9.5 16h5"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2M12 19.5v2M4.6 4.6l1.4 1.4M18 18l1.4 1.4M2.5 12h2M19.5 12h2M4.6 19.4 6 18M18 6l1.4-1.4"/>',
  moon: '<path d="M20 13.5A8 8 0 1 1 10.5 4a6.5 6.5 0 0 0 9.5 9.5z"/>',
  grid: '<rect x="4" y="4" width="7" height="7" rx="1.5"/><rect x="13" y="4" width="7" height="7" rx="1.5"/><rect x="4" y="13" width="7" height="7" rx="1.5"/><rect x="13" y="13" width="7" height="7" rx="1.5"/>',
  home: '<path d="m4 11 8-7 8 7"/><path d="M6 9.5V20h12V9.5"/>',
  zap: '<path d="M13 3 5 13.5h6L11 21l8-10.5h-6z"/>',
  database: '<ellipse cx="12" cy="5.5" rx="7.5" ry="3"/><path d="M4.5 5.5v13c0 1.66 3.36 3 7.5 3s7.5-1.34 7.5-3v-13"/><path d="M4.5 12c0 1.66 3.36 3 7.5 3s7.5-1.34 7.5-3"/>',
  copy: '<rect x="8.5" y="8.5" width="12" height="12" rx="2"/><path d="M15.5 5.5V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v8.5a2 2 0 0 0 2 2h.5"/>',
  'external-link': '<path d="M14 4.5h5.5V10"/><path d="M19.5 4.5 11 13"/><path d="M19 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h4"/>',
  filter: '<path d="M4 5.5h16l-6.5 7.5v5.5l-3 2v-7.5z"/>',
  tag: '<path d="M3.5 12 12 3.5h7.5V11L12 19.5z"/><circle cx="16" cy="8" r="1.3"/>',
  xCircle: '<circle cx="12" cy="12" r="9"/><path d="m9 9 6 6M15 9l-6 6"/>',
  stop: '<rect x="7" y="7" width="10" height="10" rx="2"/>',
  minus: '<path d="M5 12h14"/>',
  'rotate-ccw': '<path d="M3 12a9 9 0 1 0 2.8-6.5"/><path d="M3 4v4.5h4.5"/>',
  chat: '<path d="M21 12a8.5 8.5 0 0 1-13 7.2L4 21l1.8-4.2A8.5 8.5 0 1 1 21 12z"/>',
}

const inner = computed(() => ICONS[props.name] ?? '')
</script>

<template>
  <svg
    :width="size"
    :height="size"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    :stroke-width="strokeWidth"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
    v-html="inner"
  />
</template>
