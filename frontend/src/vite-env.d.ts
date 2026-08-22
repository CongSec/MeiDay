/// <reference types="vite/client" />

declare module 'vue-virtual-scroller' {
  import type { DefineComponent } from 'vue'
  export const RecycleScroller: DefineComponent<Record<string, unknown>>
  export default {}
}
