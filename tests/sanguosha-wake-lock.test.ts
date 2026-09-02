import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

describe('三国杀对局防息屏', () => {
  it('单机和联机界面启用 Screen Wake Lock', () => {
    const app = readFileSync('src/sanguosha/SanguoshaApp.vue', 'utf8')
    expect(app).toContain("screen.value === 'playing' || screen.value === 'online'")
    expect(app).toContain('useScreenWakeLock')
  })

  it('回到前台和再次触摸时重试，退出界面时释放', () => {
    const source = readFileSync('src/sanguosha/composables/useScreenWakeLock.ts', 'utf8')
    expect(source).toContain("wakeLock.request('screen')")
    expect(source).toContain("document.addEventListener('visibilitychange'")
    expect(source).toContain("document.addEventListener('pointerdown'")
    expect(source).toContain('if (enabled) void acquire(); else void release()')
    expect(source).toContain('await current.release()')
  })
})
