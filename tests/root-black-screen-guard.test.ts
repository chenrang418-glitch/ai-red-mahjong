import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LatestGameLoader } from '@/portal/gameLoader'
afterEach(() => vi.useRealTimers())

describe('全站黑屏防护', () => {
  it('Vue 挂载前空根节点也显示启动提示', () => {
    const css = readFileSync('src/styles/root.css', 'utf8')
    expect(css).toContain('#app:empty::before')
    expect(css).toContain('正在启动游戏')
  })

  it('入口挂载失败时显示不依赖 Vue 的恢复按钮', () => {
    const source = readFileSync('src/main.ts', 'utf8')
    expect(source).toContain('renderBootFailure')
    expect(source).toContain("reload.textContent = '重新加载'")
    expect(source).toContain("portal.textContent = '返回游戏中心'")
    expect(source).toMatch(/try \{[\s\S]*app\.mount\('#app'\)[\s\S]*\} catch/)
  })

  it('旧加载完成不会清除新加载的超时保护', async () => {
    vi.useFakeTimers()
    const loader = new LatestGameLoader<string>(100)
    let finishA!: (value: string) => void
    const a = loader.load(() => new Promise((resolve) => { finishA = resolve }))
    const b = loader.load(() => new Promise(() => undefined))
    finishA('A')
    await expect(a).resolves.toEqual({ status: 'stale' })
    await vi.advanceTimersByTimeAsync(100)
    await expect(b).resolves.toMatchObject({ status: 'error', error: expect.objectContaining({ message: '游戏资源加载超时' }) })
  })

  it('超时后重试可以成功，快速切换只接纳最后一次结果', async () => {
    vi.useFakeTimers()
    const loader = new LatestGameLoader<string>(50)
    const timedOut = loader.load(() => new Promise(() => undefined))
    await vi.advanceTimersByTimeAsync(50)
    await expect(timedOut).resolves.toMatchObject({ status: 'error' })
    await expect(loader.load(async () => 'retry-ok')).resolves.toEqual({ status: 'success', value: 'retry-ok' })

    let finishOld!: (value: string) => void
    const old = loader.load(() => new Promise((resolve) => { finishOld = resolve }))
    const latest = loader.load(async () => 'latest')
    finishOld('old')
    await expect(old).resolves.toEqual({ status: 'stale' })
    await expect(latest).resolves.toEqual({ status: 'success', value: 'latest' })
  })

  it('动态加载拒绝时返回可恢复错误而不是空白页', async () => {
    const loader = new LatestGameLoader<string>()
    await expect(loader.load(async () => { throw new Error('chunk failed') }))
      .resolves.toMatchObject({ status: 'error', error: expect.objectContaining({ message: 'chunk failed' }) })
  })

  it('卸载会让在途加载失效并清理 timer', async () => {
    vi.useFakeTimers()
    const loader = new LatestGameLoader<string>(50)
    let finish!: (value: string) => void
    const pending = loader.load(() => new Promise((resolve) => { finish = resolve }))
    loader.dispose()
    finish('late')
    await expect(pending).resolves.toEqual({ status: 'stale' })
    expect(vi.getTimerCount()).toBe(0)
  })
})
