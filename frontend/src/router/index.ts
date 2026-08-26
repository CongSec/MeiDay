import { createRouter, createWebHashHistory } from 'vue-router'
import { getToken } from '@/api/client'
import { isDiaryUnlocked, isDiaryEntryIntent } from '@/utils/diarySession'

// 路由级按需加载：每个视图独立分包，首屏只加载当前页，减少首包体积与首屏解析耗时
const LoginView = () => import('@/views/LoginView.vue')
const LayoutView = () => import('@/views/LayoutView.vue')
const TodayView = () => import('@/views/TodayView.vue')
const ProjectView = () => import('@/views/ProjectView.vue')
const TrashView = () => import('@/views/TrashView.vue')
const SettingsView = () => import('@/views/SettingsView.vue')
const LogsView = () => import('@/views/LogsView.vue')
// 隐私日记：独立全屏子模块，懒加载独立 chunk，未进入不加载任何日记代码/数据
const DiaryView = () => import('@/views/DiaryView.vue')

const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    { path: '/login', component: LoginView },
    // 隐私日记模式：全屏独立界面（不挂载在任务系统布局下），未解锁/无进入意图自动跳回任务系统首页
    { path: '/diary', component: DiaryView },
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
  // 隐私日记：未解锁且无进入意图时，自动跳回任务系统首页（刷新/直接输地址也进不来）
  if (to.path === '/diary' && !isDiaryUnlocked() && !isDiaryEntryIntent()) return '/today'
})


export default router

