import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { createScreenWakeLockController } from '@/sanguosha/composables/useScreenWakeLock'

class FakeDocument extends EventTarget {
  visibilityState: DocumentVisibilityState = 'visible'
}

class FakeSentinel extends EventTarget {
  released = false
  release = vi.fn(async () => { this.released = true; this.dispatchEvent(new Event('release')) })
}

describe('三国杀对局防息屏', () => {
  it('单机和联机界面启用 Screen Wake Lock', () => {
    const app = readFileSync('src/sanguosha/SanguoshaApp.vue', 'utf8')
    expect(app).toContain("screen.value === 'playing' || screen.value === 'online'")
    expect(app).toContain('useScreenWakeLock')
  })

  it('进入对局申请、退回首页释放，隐藏后释放且可见时重新申请', async () => {
    const document = new FakeDocument()
    const first = new FakeSentinel(), second = new FakeSentinel()
    const request = vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(second)
    let active = true
    const controller = createScreenWakeLockController(() => active, {
      document: document as unknown as Document,
      wakeLock: { request: request as never },
    })
    controller.start()
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1))

    document.visibilityState = 'hidden'
    document.dispatchEvent(new Event('visibilitychange'))
    await vi.waitFor(() => expect(first.release).toHaveBeenCalled())
    document.visibilityState = 'visible'
    document.dispatchEvent(new Event('visibilitychange'))
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2))

    active = false
    controller.sync()
    await vi.waitFor(() => expect(second.release).toHaveBeenCalled())
    controller.stop()
  })

  it('不支持或申请被拒绝时安静降级', async () => {
    const document = new FakeDocument()
    const unsupported = createScreenWakeLockController(() => true, { document: document as unknown as Document })
    expect(() => unsupported.start()).not.toThrow()
    unsupported.stop()

    const request = vi.fn().mockRejectedValue(new Error('denied'))
    const rejected = createScreenWakeLockController(() => true, {
      document: document as unknown as Document,
      wakeLock: { request: request as never },
    })
    rejected.start()
    await vi.waitFor(() => expect(request).toHaveBeenCalled())
    rejected.stop()
  })
})
