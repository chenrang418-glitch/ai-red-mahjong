import { describe, expect, it } from 'vitest'
import { ROOM_RECONNECT_GRACE_MS, RoomCoordinator } from '../server/room-core'
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

  it('等待页意外断线会保留座位60秒，期间重连可回到原座位', () => {
    const room = RoomCoordinator.create('ABC234', { userId: 'u1', nickname: '房主' }, settings, 1000)
    room.connect({ userId: 'u2', nickname: '玩家二' }, 1100)
    room.disconnect('u2', 2000)

    expect(room.view('u1').seats[1]).toMatchObject({ kind: 'human', connected: false, name: '玩家二' })
    room.runDueJobs(61_999)
    expect(room.view('u1').seats[1].kind).toBe('human')

    expect(room.connect({ userId: 'u2', nickname: '玩家二' }, 62_000)).toBe(1)
    room.runDueJobs(100_000)
    expect(room.view('u1').seats[1]).toMatchObject({ kind: 'human', connected: true, name: '玩家二' })
  })

  it('等待页断线超过60秒才释放座位并移交房主', () => {
    const room = RoomCoordinator.create('ABC234', { userId: 'u1', nickname: '房主' }, settings, 1000)
    room.connect({ userId: 'u2', nickname: '玩家二' }, 1100)
    room.disconnect('u1', 2000)

    room.runDueJobs(61_999)
    expect(room.view('u2').hostUserId).toBe('u1')
    room.runDueJobs(62_000)

    const view = room.view('u2')
    expect(view.hostUserId).toBe('u2')
    expect(view.seats[0].kind).toBe('empty')
    expect(view.seats[1].isHost).toBe(true)
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

  it('所有真人明确退出进行中牌局后立即请求删除房间', () => {
    const room = RoomCoordinator.create('ABC234', { userId: 'u1', nickname: '房主' }, settings, 1000)
    room.connect({ userId: 'u2', nickname: '玩家二' }, 1100)
    room.handle('u2', { type: 'ready', ready: true }, 1200)
    room.handle('u1', { type: 'start-game' }, 1300)

    room.leave('u1', 2000)
    expect(room.shouldDeleteRoom()).toBe(false)
    room.leave('u2', 2100)
    expect(room.shouldDeleteRoom()).toBe(true)
  })

  it('所有真人异常掉线会保留五分钟，期间重连会取消删除', () => {
    const room = RoomCoordinator.create('ABC234', { userId: 'u1', nickname: '房主' }, settings, 1000)
    room.connect({ userId: 'u2', nickname: '玩家二' }, 1100)
    room.disconnect('u1', 2000)
    room.disconnect('u2', 3000)
    room.state.jobs = room.state.jobs.filter((job) => job.kind === 'all-offline-expire')

    room.runDueJobs(3000 + ROOM_RECONNECT_GRACE_MS - 1)
    expect(room.shouldDeleteRoom()).toBe(false)
    room.connect({ userId: 'u1', nickname: '房主' }, 3000 + ROOM_RECONNECT_GRACE_MS - 1)
    room.runDueJobs(3000 + ROOM_RECONNECT_GRACE_MS + 10_000)
    expect(room.shouldDeleteRoom()).toBe(false)
  })

  it('所有真人异常掉线满五分钟后请求删除房间', () => {
    const room = RoomCoordinator.create('ABC234', { userId: 'u1', nickname: '房主' }, settings, 1000)
    room.disconnect('u1', 2000)
    room.state.jobs = room.state.jobs.filter((job) => job.kind === 'all-offline-expire')

    room.runDueJobs(2000 + ROOM_RECONNECT_GRACE_MS - 1)
    expect(room.shouldDeleteRoom()).toBe(false)
    room.runDueJobs(2000 + ROOM_RECONNECT_GRACE_MS)
    expect(room.shouldDeleteRoom()).toBe(true)
  })

  it('旧版本遗留的离线房间恢复时按最后更新时间补建清理任务', () => {
    const original = RoomCoordinator.create('ABC234', { userId: 'u1', nickname: '房主' }, settings, 1000)
    original.disconnect('u1', 2000)
    const stored = original.snapshot()
    stored.jobs = []
    stored.updatedAt = 2000
    const restored = new RoomCoordinator(stored)

    expect(restored.ensureOfflineExpiry(2000 + ROOM_RECONNECT_GRACE_MS - 1)).toBe(true)
    expect(restored.shouldDeleteRoom()).toBe(false)
    restored.state.jobs = []
    expect(restored.ensureOfflineExpiry(2000 + ROOM_RECONNECT_GRACE_MS)).toBe(true)
    expect(restored.shouldDeleteRoom()).toBe(true)
  })

  it('牌局进行时向所有玩家公开当前行动座位的倒计时', () => {
    const room = RoomCoordinator.create('ABC234', { userId: 'u1', nickname: '房主' }, settings, 1000)
    room.handle('u1', { type: 'start-game' }, 1200)
    const view = room.view('u1')

    expect(view.turnTimer?.seatId).toBe(view.game?.currentPlayer)
    expect(view.turnTimer?.deadlineAt).toBeGreaterThan(view.turnTimer?.startedAt ?? 0)
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
