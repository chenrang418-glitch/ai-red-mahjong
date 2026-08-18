import { describe, expect, it } from 'vitest'
import { RoomCoordinator } from '../server/room-core'
import type { OnlineRoomSettings } from '@/online/types'

const settings: OnlineRoomSettings = {
  mode: 'finite',
  initialPoints: 30,
  claimWindowMs: 4000,
  turnWindowMs: 30000,
  aiDifficulty: 'expert',
}

// 开一局三个真人的牌，然后停在结算界面
function roomAtSettlement() {
  const room = RoomCoordinator.create('ABC234', { userId: 'u1', nickname: '房主' }, settings, 1000)
  room.connect({ userId: 'u2', nickname: '玩家二' }, 1100)
  room.connect({ userId: 'u3', nickname: '玩家三' }, 1150)
  room.handle('u2', { type: 'ready', ready: true }, 1200)
  room.handle('u3', { type: 'ready', ready: true }, 1250)
  room.handle('u1', { type: 'start-game' }, 1300)
  room.state.game!.phase = 'settlement'
  room.state.game!.result = { type: 'draw', maTiles: [], maCount: 0, detail: '流局' }
  return room
}

describe('下一局全员准备', () => {
  it('三个人都得自己点，人没齐就不开下一局', () => {
    const room = roomAtSettlement()
    // 房主不再是唯一能点的人
    expect(room.view('u1').legal.canNextRound).toBe(true)
    expect(room.view('u2').legal.canNextRound).toBe(true)
    expect(room.view('u3').legal.canNextRound).toBe(true)

    room.handle('u1', { type: 'next-round' }, 2000)
    expect(room.state.game!.phase).toBe('settlement')
    // 点过的人按钮收起来，并且能看到还差谁
    expect(room.view('u1').legal.canNextRound).toBe(false)
    expect(room.view('u1').legal.nextRoundWaiting).toEqual(['玩家二', '玩家三'])

    room.handle('u2', { type: 'next-round' }, 2100)
    expect(room.state.game!.phase).toBe('settlement')

    room.handle('u3', { type: 'next-round' }, 2200)
    expect(room.state.game!.phase).not.toBe('settlement')
    // 开了新一局，标记要清掉，否则下一次结算直接跳过等待
    expect(room.state.seats.every((seat) => !seat.nextRoundReady)).toBe(true)
  })

  it('托管和掉线的人不用等，剩下的人点完就开', () => {
    const room = roomAtSettlement()
    room.handle('u2', { type: 'trustee', enabled: true }, 1900)
    room.disconnect('u3', 1950)

    expect(room.view('u1').legal.nextRoundWaiting).toEqual(['房主'])
    room.handle('u1', { type: 'next-round' }, 2000)
    expect(room.state.game!.phase).not.toBe('settlement')
  })

  it('最后一个人掉线时，等待中的那局也能自己往下走', () => {
    const room = roomAtSettlement()
    room.handle('u1', { type: 'next-round' }, 2000)
    room.handle('u2', { type: 'next-round' }, 2050)
    expect(room.state.game!.phase).toBe('settlement')

    // 剩下的人一直不点，结果掉线了：不该把整桌永远卡在结算界面
    room.disconnect('u3', 2100)
    expect(room.state.game!.phase).not.toBe('settlement')
  })
})

describe('结算界面退出房间', () => {
  it('座位变成房主选的档位 AI，不是托管，并留下一条离开记录', () => {
    const room = roomAtSettlement()
    room.leave('u2', 2000)

    const seat = room.state.seats[1]
    expect(seat.kind).toBe('ai')
    expect(seat.userId).toBeNull()
    expect(seat.trustee).toBe(false)
    // 档位跟房主开局时选的走
    expect(seat.ai).toEqual({ difficulty: 'expert' })

    // 牌局里那个玩家也换成 AI 接着打
    const player = room.state.game!.players[1]
    expect(player.isHuman).toBe(false)
    expect(player.ai).toEqual({ difficulty: 'expert' })

    expect(room.state.game!.events.at(-1)).toMatchObject({
      type: 'ai-change',
      detail: '玩家二 离开房间，座位由 AI 接手',
    })
  })

  it('走掉的人不再算在等待名单里，剩下的人点完就能开下一局', () => {
    const room = roomAtSettlement()
    room.handle('u1', { type: 'next-round' }, 2000)
    room.handle('u3', { type: 'next-round' }, 2050)
    expect(room.state.game!.phase).toBe('settlement')

    room.leave('u2', 2100)
    expect(room.state.game!.phase).not.toBe('settlement')
  })
})
