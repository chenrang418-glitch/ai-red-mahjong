import { describe, expect, it } from 'vitest'
import { RoomCoordinator } from '../server/room-core'
import type { OnlineRoomSettings } from '@/online/types'

const settings: OnlineRoomSettings = {
  mode: 'finite',
  initialPoints: 30,
  claimWindowMs: 4000,
  turnWindowMs: 30000,
}

describe('联机房间协调器', () => {
  it('创建房间、真人准备并用AI补满空位后开始', () => {
    const room = RoomCoordinator.create('ABC234', { userId: 'u1', nickname: '小陈' }, settings, 1000)
    expect(room.view('u1').seats.map((seat) => seat.kind)).toEqual(['human', 'empty', 'empty', 'empty'])

    room.connect({ userId: 'u2', nickname: '小李' }, 1100)
    expect(() => room.handle('u1', { type: 'start-game' }, 1200)).toThrow('还有玩家未准备')
    room.handle('u2', { type: 'ready', ready: true }, 1300)
    room.handle('u1', { type: 'start-game' }, 1400)

    const view = room.view('u1')
    expect(view.game).not.toBeNull()
    expect(view.seats.map((seat) => seat.kind)).toEqual(['human', 'human', 'ai', 'ai'])
    expect(view.game?.players).toHaveLength(4)
  })

  it('等待页离开会释放座位，房主离开时自动移交房主', () => {
    const room = RoomCoordinator.create('ABC234', { userId: 'u1', nickname: '房主' }, settings, 1000)
    room.connect({ userId: 'u2', nickname: '玩家二' }, 1100)
    room.removeLobbyUser('u1', 1200)

    const view = room.view('u2')
    expect(view.hostUserId).toBe('u2')
    expect(view.seats[0].kind).toBe('empty')
    expect(view.seats[1].isHost).toBe(true)
    expect(view.seats[1].ready).toBe(true)
  })

  it('仅向玩家发送自己的真实手牌，其他暗牌使用占位牌', () => {
    const room = RoomCoordinator.create('ABC234', { userId: 'u1', nickname: '小陈' }, settings, 1000)
    room.handle('u1', { type: 'start-game' }, 1200)
    const stored = room.snapshot().game!
    const view = room.view('u1').game!

    expect(view.players[0].hand).toEqual(stored.players[0].hand)
    expect(view.players[1].hand).toHaveLength(stored.players[1].hand.length)
    expect(view.players[1].hand.every((tile) => tile.id.startsWith('hidden-seat-1'))).toBe(true)
    expect(view.wall.every((tile) => tile.id.startsWith('hidden-wall'))).toBe(true)
    expect(view.rngState).toBe(0)
  })

  it('断线30秒后启用真人波动型凡人猴急托管', () => {
    const room = RoomCoordinator.create('ABC234', { userId: 'u1', nickname: '小陈' }, settings, 1000)
    room.handle('u1', { type: 'start-game' }, 1200)
    room.disconnect('u1', 2000)
    room.state.jobs = room.state.jobs.filter((job) => job.kind === 'disconnect-trustee')
    room.runDueJobs(31_999)
    expect(room.view('u1').seats[0].trustee).toBe(false)
    room.runDueJobs(32_000)
    expect(room.view('u1').seats[0].trustee).toBe(true)
  })

  it('聊天只保留最近30条且不推进牌局版本', () => {
    const room = RoomCoordinator.create('ABC234', { userId: 'u1', nickname: '小陈' }, settings, 1000)
    const version = room.view('u1').version
    for (let index = 0; index < 35; index += 1) {
      room.handle('u1', { type: 'chat', text: `消息${index}`, quick: false }, 2000 + index)
    }
    const view = room.view('u1')
    expect(view.chat).toHaveLength(30)
    expect(view.chat[0].text).toBe('消息5')
    expect(view.version).toBe(version)
  })

  it('同一个动作编号重复到达时只执行一次', () => {
    const room = RoomCoordinator.create('ABC234', { userId: 'u1', nickname: '小陈' }, settings, 1000)
    room.handle('u1', { type: 'start-game' }, 1200)
    const game = room.view('u1').game!
    if (game.currentPlayer !== 0) {
      room.handle('u1', { type: 'trustee', enabled: true }, 1300)
      expect(room.view('u1').seats[0].trustee).toBe(true)
      return
    }
    const tileId = game.players[0].hand[0].id
    const command = { type: 'discard' as const, tileId, actionId: 'same-action', version: room.view('u1').version }
    room.handle('u1', command, 1400)
    const eventCount = room.snapshot().game!.events.length
    room.handle('u1', command, 1500)
    expect(room.snapshot().game!.events).toHaveLength(eventCount)
  })
})
