import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

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

  it('动态游戏资源超过 15 秒会退出加载态并允许重试', () => {
    const source = readFileSync('src/RootApp.vue', 'utf8')
    expect(source).toContain("new Error('游戏资源加载超时')")
    expect(source).toContain('Promise.race([game.loadApp(), timeout])')
    expect(source).toContain('@click="retryLoad"')
  })
})
