import { createRouter, createWebHashHistory } from 'vue-router'
import { getToken } from '@/api/client'

// 路由级按需加载：每个视图独立分包，首屏只加载当前页，减少首包体积与首屏解析耗时
const LoginView = () => import('@/views/LoginView.vue')
const LayoutView = () => import('@/views/LayoutView.vue')
const TodayView = () => import('@/views/TodayView.vue')
const ProjectView = () => import('@/views/ProjectView.vue')
const TrashView = () => import('@/views/TrashView.vue')
const SettingsView = () => import('@/views/SettingsView.vue')
const LogsView = () => import('@/views/LogsView.vue')

const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    { path: '/login', component: LoginView },
    {
      path: '/',
      component: LayoutView,
      children: [
        { path: '', redirect: '/today' },
        { path: 'today', component: TodayView },
        { path: 'project/:id', component: ProjectView },
        { path: 'trash', component: TrashView },
        { path: 'settings', component: SettingsView },
        { path: 'logs', component: LogsView },
      ],
    },
  ],
})

router.beforeEach((to) => {
  const hasToken = !!getToken()
  if (to.path !== '/login' && !hasToken) return '/login'
  if (to.path === '/login' && hasToken) return '/today'
})

export default router
