import type { CapacitorConfig } from '@capacitor/cli'

const config: CapacitorConfig = {
  appId: 'com.meiday.app',
  appName: 'MeiDay',
  webDir: 'dist',
  server: {
    androidScheme: 'https',
  },
}

export default config
