import { defineConfig, devices } from '@playwright/test'

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 30_000,
  retries: 0,
  workers: 1,
  projects: [
    // 主力覆盖跑 Chromium
    { name: 'chromium', use: { ...devices['Desktop Chrome'] }, testIgnore: /webkit-smoke\.spec\.ts/ },
    // WebKit 只跑一小撮关键路径和自带字体检查：覆盖 iOS Safari 的布局与字体差异。
    // 值得单独盯一眼，但把整套用例复制一遍会让 CI 时间翻倍。
    { name: 'webkit', use: { ...devices['Desktop Safari'] }, testMatch: /(?:webkit-smoke|faction-font)\.spec\.ts/ },
  ],
  use: {
    baseURL: 'http://127.0.0.1:4183',
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
    // 全站门槛：没接受过「项目说明」就会先看到首次访问弹窗，挡住所有既有用例
    // 想直接断言的页面内容。这里统一预置成「已接受」，让旧用例不用逐个改。
    // project-notice.spec.ts 自己测门槛本身，会用 test.use() 把这项覆盖回空状态。
    storageState: {
      cookies: [],
      origins: [{ origin: 'http://127.0.0.1:4183', localStorage: [{ name: 'crplay_project_notice_v1', value: 'accepted' }] }],
    },
  },
  webServer: {
    command: 'npm run dev -- --host 127.0.0.1 --port 4183',
    url: 'http://127.0.0.1:4183',
    // 只复用本项目自己那台。端口和麻将主 checkout 错开（4183 vs 4173），
    // 否则两个副本同时开着时会连错服务器，测到的是另一份代码。
    reuseExistingServer: true,
  },
})
