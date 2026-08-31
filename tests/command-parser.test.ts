import { describe, expect, it } from 'vitest'
import { InvalidRoomCommandError, parseRoomCommand } from '../server/command-parser'
import { RoomCoordinator } from '../server/room-core'
import type { OnlineRoomSettings } from '@/online/types'

const settings: OnlineRoomSettings = {
  mode: 'finite',
  initialPoints: 30,
  claimWindowMs: 4000,
  turnWindowMs: 30_000,
}

describe('合法指令原样通过', () => {
  const cases: Array<[string, unknown]> = [
    ['ready', { type: 'ready', ready: true }],
    ['ready false', { type: 'ready', ready: false }],
    ['start-game', { type: 'start-game' }],
    ['leave-room', { type: 'leave-room' }],
    ['next-round', { type: 'next-round' }],
    ['return-to-lobby', { type: 'return-to-lobby' }],
    ['trustee', { type: 'trustee', enabled: true }],
    ['chat', { type: 'chat', text: '快点啊', quick: false }],
    ['discard', { type: 'discard', tileId: 'wan-1-0', actionId: 'a1', version: 0 }],
    ['win', { type: 'win', actionId: 'a2', version: 3 }],
    ['pass-claim', { type: 'pass-claim', actionId: 'a3', version: 7 }],
    ['gang 暗杠', { type: 'gang', gangType: 'an-gang', face: 'wan-9', actionId: 'a4', version: 1 }],
    ['gang 补杠', { type: 'gang', gangType: 'bu-gang', face: 'bamboo-5', actionId: 'a5', version: 2 }],
    ['claim 碰', { type: 'claim', action: 'peng', actionId: 'a6', version: 1 }],
    ['claim 明杠', { type: 'claim', action: 'ming-gang', actionId: 'a7', version: 1 }],
  ]

  for (const [name, input] of cases) {
    it(name, () => {
      expect(parseRoomCommand(input)).toEqual(input)
    })
  }

  it('请求里多带的字段不会透传进房间状态', () => {
    const parsed = parseRoomCommand({ type: 'ready', ready: true, 恶意字段: 'x' })
    expect(parsed).toEqual({ type: 'ready', ready: true })
    expect(Object.keys(parsed)).toEqual(['type', 'ready'])
  })
})

describe('非法指令一律拒绝', () => {
  const cases: Array<[string, unknown]> = [
    ['null', null],
    ['undefined', undefined],
    ['数组', []],
    ['字符串', 'ready'],
    ['数字', 42],
    ['没有 type', { ready: true }],
    ['type 不是字符串', { type: 1 }],
    ['未知 type', { type: 'drop-table' }],
    ['ready 是字符串', { type: 'ready', ready: 'true' }],
    ['ready 缺失', { type: 'ready' }],
    ['trustee 是数字', { type: 'trustee', enabled: 1 }],
    ['trustee 是对象', { type: 'trustee', enabled: {} }],
    ['chat 正文不是字符串', { type: 'chat', text: 123, quick: false }],
    ['chat quick 不是布尔', { type: 'chat', text: 'hi', quick: 'no' }],
    ['chat 正文超长', { type: 'chat', text: 'x'.repeat(5000), quick: false }],
    ['version 是 NaN', { type: 'win', actionId: 'a', version: Number.NaN }],
    ['version 是字符串', { type: 'win', actionId: 'a', version: '1' }],
    ['version 是负数', { type: 'win', actionId: 'a', version: -1 }],
    ['version 是小数', { type: 'win', actionId: 'a', version: 1.5 }],
    ['actionId 不是字符串', { type: 'win', actionId: 7, version: 1 }],
    ['actionId 为空', { type: 'win', actionId: '', version: 1 }],
    ['actionId 超长', { type: 'win', actionId: 'x'.repeat(200), version: 1 }],
    ['tileId 不是字符串', { type: 'discard', tileId: {}, actionId: 'a', version: 0 }],
    ['gangType 非法', { type: 'gang', gangType: 'ming-gang', face: 'wan-1', actionId: 'a', version: 0 }],
    ['face 是红中', { type: 'gang', gangType: 'an-gang', face: 'zhong', actionId: 'a', version: 0 }],
    ['face 花色非法', { type: 'gang', gangType: 'an-gang', face: 'flower-1', actionId: 'a', version: 0 }],
    ['face 点数越界', { type: 'gang', gangType: 'an-gang', face: 'wan-10', actionId: 'a', version: 0 }],
    ['face 点数为零', { type: 'gang', gangType: 'an-gang', face: 'wan-0', actionId: 'a', version: 0 }],
    ['face 格式错乱', { type: 'gang', gangType: 'an-gang', face: 'wan-1-2', actionId: 'a', version: 0 }],
    ['claim 动作非法', { type: 'claim', action: 'pass', actionId: 'a', version: 0 }],
    ['claim 动作是胡', { type: 'claim', action: 'win', actionId: 'a', version: 0 }],
  ]

  for (const [name, input] of cases) {
    it(name, () => {
      expect(() => parseRoomCommand(input)).toThrow(InvalidRoomCommandError)
    })
  }

  it('对外只说格式不正确，不暴露具体哪个字段', () => {
    expect(() => parseRoomCommand({ type: 'trustee', enabled: {} })).toThrow('请求格式不正确')
  })
})

describe('非法输入不得改动房间状态', () => {
  it('被拒绝的指令不会写进 RoomCoordinator', () => {
    const room = RoomCoordinator.create('ABC234', { userId: 'u1', nickname: '房主' }, settings, 1000)
    room.connect({ userId: 'u2', nickname: '玩家二' }, 1100)
    const before = JSON.stringify(room.state)

    const attacks: unknown[] = [
      { type: 'ready', ready: 'true' },
      { type: 'trustee', enabled: {} },
      { type: 'discard', tileId: null, actionId: 'a', version: 0 },
      { type: 'gang', gangType: 'an-gang', face: 'zhong', actionId: 'a', version: 0 },
      { type: '不存在的指令' },
      [],
      null,
    ]
    for (const attack of attacks) {
      // 解析层直接挡下，根本走不到 handle
      expect(() => room.handle('u2', parseRoomCommand(attack), 1200)).toThrow()
    }
    expect(JSON.stringify(room.state)).toBe(before)
  })
})
