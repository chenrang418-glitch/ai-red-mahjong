import { defineConfig } from 'vitest/config'
import vue from '@vitejs/plugin-vue'
import { dirname, resolve } from 'path'
import { fileURLToPath } from 'url'

const configDirectory = dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  plugins: [vue()],
  test: {
    environment: 'node',
    globals: true,
    include: ['tests/**/*.test.ts'],
    globalSetup: ['./tests/build-worker.globalSetup.ts'],
  },
  resolve: {
    alias: {
      '@': resolve(configDirectory, 'src'),
    },
  },
})
