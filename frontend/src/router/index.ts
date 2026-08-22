import { createRouter, createWebHashHistory } from 'vue-router'
import { getToken } from '@/api/client'
import LoginView from '@/views/LoginView.vue'
import LayoutView from '@/views/LayoutView.vue'
import TodayView from '@/views/TodayView.vue'
import ProjectView from '@/views/ProjectView.vue'
import TrashView from '@/views/TrashView.vue'
import SettingsView from '@/views/SettingsView.vue'
import LogsView from '@/views/LogsView.vue'

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
