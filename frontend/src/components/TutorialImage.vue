<script setup lang="ts">
/**
 * TutorialImage — 教程图片（点击放大查看）
 * 委托给 ZoomableImage（同一套全屏 Lightbox：缩放 / 平移 / 双击 / Esc 关闭）。
 * 缩略图样式使用 ZoomableImage 默认值，行为与旧版完全一致。
 */
import ZoomableImage from '@/components/ZoomableImage.vue'

defineOptions({ name: 'TutorialImage' })

const props = defineProps<{ src: string; alt: string }>()
</script>

<template>
  <ZoomableImage :src="props.src" :alt="props.alt" />
</template>
