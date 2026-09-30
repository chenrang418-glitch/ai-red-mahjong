import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { dirname, resolve } from 'path'
import { fileURLToPath } from 'url'

const configDirectory = dirname(fileURLToPath(import.meta.url))

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: {
      '@': resolve(configDirectory, 'src'),
    },
  },

  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: false,
  },
  build: {
    target: 'es2022',
    minify: 'esbuild',
    rollupOptions: {
      output: {
        manualChunks(moduleId) {
          const id = moduleId.replaceAll('\\', '/')
          // 武将定义会向引擎注入技能运行时，两边天然互相引用；放进同一核心块
          // 可以避免人为拆成两个循环 chunk，同时把入口界面本身稳定压到 400 kB 以下。
          if (id.includes('/src/sanguosha/data/characters/') || id.includes('/src/sanguosha/engine/')) return 'sgs-core'
          return undefined
        },
      },
    },
  },
  clearScreen: false,
})
