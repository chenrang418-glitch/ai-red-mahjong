import { describe, expect, it } from 'vitest'
import { buildGameUrl, buildPortalUrl, resolveAppRoute } from '@/portal/navigation'

describe('CRPlay 顶层 URL 路由', () => {
  it('根路径进入游戏中心', () => {
    expect(resolveAppRoute(new URL('https://crplay.cn/'))).toEqual({ kind: 'portal' })
  })

  it('显式 game 参数进入对应游戏', () => {
    expect(resolveAppRoute(new URL('https://crplay.cn/?game=mahjong'))).toEqual({ kind: 'game', gameId: 'mahjong' })
    expect(resolveAppRoute(new URL('https://crplay.cn/?game=sanguosha'))).toEqual({ kind: 'game', gameId: 'sanguosha' })
  })

  it('旧 room 分享链接仍自动进入麻将', () => {
    expect(resolveAppRoute(new URL('https://crplay.cn/?room=ABC234'))).toEqual({ kind: 'game', gameId: 'mahjong' })
  })

  it('三国杀 room 链接归属三国杀', () => {
    expect(resolveAppRoute(new URL('https://crplay.cn/?game=sanguosha&room=ABC234'))).toEqual({ kind: 'game', gameId: 'sanguosha' })
  })

  it('#admin 始终优先进入现有麻将管理员入口', () => {
    expect(resolveAppRoute(new URL('https://crplay.cn/#admin'))).toEqual({ kind: 'game', gameId: 'mahjong' })
    expect(resolveAppRoute(new URL('https://crplay.cn/?game=sanguosha#admin'))).toEqual({ kind: 'game', gameId: 'mahjong' })
  })

  it('生成游戏和门户 URL 时只清理顶层导航字段', () => {
    const current = new URL('https://crplay.cn/?source=friend&room=ABC234#admin')
    expect(buildGameUrl(current, 'sanguosha').href).toBe('https://crplay.cn/?source=friend&game=sanguosha')
    expect(buildPortalUrl(new URL('https://crplay.cn/?source=friend&game=mahjong&room=ABC234#admin')).href)
      .toBe('https://crplay.cn/?source=friend')
  })
})
