import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LatestGameLoader } from '@/portal/gameLoader'
import { mountWithFallback } from '@/bootstrap'
import type { App } from 'vue'
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
    expect(source).toContain("mountWithFallback(app, '#app', renderBootFailure)")
  })

  it('启动阶段失败直接显示 fallback', () => {
    const calls: string[] = []
    const app = {
      config: {},
      mount: () => { throw new Error('boot failed') },
      unmount: () => calls.push('unmount'),
    } as unknown as App
    mountWithFallback(app, '#app', () => calls.push('fallback'))
    expect(calls).toEqual(['fallback'])
  })

  it('运行时错误先卸载 Vue，再显示静态错误页', () => {
    const calls: string[] = []
    const app = {
      config: {},
      mount: () => calls.push('mount'),
      unmount: () => calls.push('unmount'),
    } as unknown as App
    mountWithFallback(app, '#app', () => calls.push('fallback'))
    app.config.errorHandler?.(new Error('runtime failed'), null, 'render')
    expect(calls).toEqual(['mount', 'unmount', 'fallback'])
  })

  it('mount 内由 Vue errorHandler 报错时清理半挂载应用再显示 fallback', () => {
    const calls: string[] = []
    const app = {
      config: {},
      mount() {
        calls.push('mount')
        this.config.errorHandler?.(new Error('initial render failed'), null, 'render')
      },
      unmount: () => calls.push('unmount'),
    } as unknown as App
    mountWithFallback(app, '#app', () => calls.push('fallback'))
    expect(calls).toEqual(['mount', 'unmount', 'fallback'])
  })

  it('错误页或卸载自身出错时不会递归触发 handler', () => {
    let fallbackCalls = 0
    const app = {
      config: {},
      mount: () => undefined,
      unmount() {
        this.config.errorHandler?.(new Error('nested'), null, 'unmount')
        throw new Error('unmount failed')
      },
    } as unknown as App
    mountWithFallback(app, '#app', () => { fallbackCalls += 1; throw new Error('fallback failed') })
    expect(() => app.config.errorHandler?.(new Error('runtime'), null, 'render')).not.toThrow()
    expect(fallbackCalls).toBe(1)
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

  it('切换游戏时清除上一个游戏捕获的运行时错误', () => {
    const source = readFileSync('src/RootApp.vue', 'utf8')
    const loadActiveGame = source.slice(source.indexOf('async function loadActiveGame'), source.indexOf('function retryLoad'))
    expect(loadActiveGame).toContain("fatalRuntimeError.value = ''")
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

  it('卸载会让永不结束的加载 Promise 立即返回 stale', async () => {
    vi.useFakeTimers()
    const loader = new LatestGameLoader<string>(50)
    const pending = loader.load(() => new Promise(() => undefined))
    loader.dispose()
    await expect(pending).resolves.toEqual({ status: 'stale' })
    expect(vi.getTimerCount()).toBe(0)
  })

  it('A 永久 pending 时开始 B，A 结束且 B 正常成功', async () => {
    const loader = new LatestGameLoader<string>(100)
    const a = loader.load(() => new Promise(() => undefined))
    const b = loader.load(async () => 'B')
    await expect(a).resolves.toEqual({ status: 'stale' })
    await expect(b).resolves.toEqual({ status: 'success', value: 'B' })
  })
})
