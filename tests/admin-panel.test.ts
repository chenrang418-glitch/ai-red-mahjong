import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const source = readFileSync(new URL('../src/components/AdminPanel.vue', import.meta.url), 'utf8')

describe('双游戏管理员界面', () => {
  it('总览和房间筛选同时覆盖麻将与纸上三国', () => {
    expect(source).toContain('双游戏服务器管理')
    expect(source).toContain('roomGameFilter')
    expect(source).toContain('红中麻将')
    expect(source).toContain('纸上三国')
    expect(source).toContain('roomDetail(room)')
  })

  it('明确区分全站维护与麻将专属托管设置', () => {
    expect(source).toContain('全站维护模式')
    expect(source).toContain('麻将托管 AI 档位')
    expect(source).toContain('两款游戏共用维护开关')
  })
})
