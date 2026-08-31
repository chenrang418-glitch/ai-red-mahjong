import { defineConfig, devices } from '@playwright/test'

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 30_000,
  retries: 0,
  workers: 1,
  projects: [
    // 主力覆盖跑 Chromium
    { name: 'chromium', use: { ...devices['Desktop Chrome'] }, testIgnore: /webkit-smoke\.spec\.ts/ },
    // WebKit 只跑一小撮关键路径：iOS Safari 的布局差异（dvh、safe-area、backdrop-filter）
    // 值得单独盯一眼，但把整套用例复制一遍会让 CI 时间翻倍。
    { name: 'webkit', use: { ...devices['Desktop Safari'] }, testMatch: /webkit-smoke\.spec\.ts/ },
  ],
  use: {
    baseURL: 'http://127.0.0.1:4173',
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'npm run dev -- --host 127.0.0.1 --port 4173',
    url: 'http://127.0.0.1:4173',
    reuseExistingServer: true,
  },
})
