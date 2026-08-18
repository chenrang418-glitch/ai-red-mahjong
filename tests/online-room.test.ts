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

  it('他人切换托管不会重置当前玩家的回合倒计时', () => {
    const room = RoomCoordinator.create('ABC234', { userId: 'u1', nickname: '小陈' }, settings, 1000)
    room.connect({ userId: 'u2', nickname: '小李' }, 1100)
    room.handle('u2', { type: 'ready', ready: true }, 1300)
    room.handle('u1', { type: 'start-game' }, 1400)

    const before = room.view('u1').turnTimer
    expect(before).not.toBeNull()
    // 选一个不是当前行动玩家的真人去开托管
    const actor = before!.seatId === 0 ? 'u2' : 'u1'
    room.handle(actor, { type: 'trustee', enabled: true }, 11_400)

    const after = room.view('u1').turnTimer
    expect(after?.seatId).toBe(before!.seatId)
    expect(after?.startedAt).toBe(before!.startedAt)
    expect(after?.deadlineAt).toBe(before!.deadlineAt)
  })

  it('他人切换托管不会清空抢牌响应，也不会延长抢牌窗口', () => {
    const room = RoomCoordinator.create('ABC234', { userId: 'u1', nickname: '小陈' }, settings, 1000)
    room.connect({ userId: 'u2', nickname: '小李' }, 1100)
    room.handle('u2', { type: 'ready', ready: true }, 1300)
    room.handle('u1', { type: 'start-game' }, 1400)

    // 构造抢牌阶段：只让真人 seat0 有碰的选项
    room.state.game!.phase = 'claiming'
    room.state.game!.claimOptions = [{ playerId: 0, actions: ['peng'] }]
    ;(room as unknown as { reschedule: (now: number) => void }).reschedule(20_000)
    const openedAt = room.state.jobs.find((job) => job.kind === 'claim-deadline')?.dueAt
    expect(openedAt).toBe(20_000 + settings.claimWindowMs)

    // 窗口过半后，另一名玩家开托管
    room.state.claimResponses = { '2': 'pass' }
    room.handle('u2', { type: 'trustee', enabled: true }, 22_000)

    expect(room.state.claimResponses).toEqual({ '2': 'pass' })
    expect(room.state.jobs.find((job) => job.kind === 'claim-deadline')?.dueAt).toBe(openedAt)
    expect(room.view('u1').deadlineAt).toBe(openedAt)
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

  it('对局中房主退出后，房主身份交给还在线的真人', () => {
    const room = RoomCoordinator.create('ABC234', { userId: 'u1', nickname: '房主' }, settings, 1000)
    room.connect({ userId: 'u2', nickname: '玩家二' }, 1100)
    room.handle('u2', { type: 'ready', ready: true }, 1200)
    room.handle('u1', { type: 'start-game' }, 1300)

    room.leave('u1', 2000)

    expect(room.view('u2').hostUserId).toBe('u2')
    room.state.game!.phase = 'settlement'
    room.state.game!.result = { type: 'draw', maTiles: [], maCount: 0, detail: '流局' }
    expect(room.view('u2').legal.canNextRound).toBe(true)
    expect(() => room.handle('u2', { type: 'next-round' }, 2100)).not.toThrow()
  })

  it('对局中房主掉线转托管后，房主身份也会交出去', () => {
    const room = RoomCoordinator.create('ABC234', { userId: 'u1', nickname: '房主' }, settings, 1000)
    room.connect({ userId: 'u2', nickname: '玩家二' }, 1100)
    room.handle('u2', { type: 'ready', ready: true }, 1200)
    room.handle('u1', { type: 'start-game' }, 1300)

    room.disconnect('u1', 2000)
    room.state.jobs = room.state.jobs.filter((job) => job.kind === 'disconnect-trustee')
    room.runDueJobs(31_999)
    expect(room.view('u2').hostUserId).toBe('u1')
    room.runDueJobs(32_000)
    expect(room.view('u2').hostUserId).toBe('u2')
  })

  it('聊天、进出房间这些变化不会让手上的操作过期', () => {
    const room = RoomCoordinator.create('ABC234', { userId: 'u1', nickname: '小陈' }, settings, 1000)
    room.connect({ userId: 'u2', nickname: '小李' }, 1100)
    room.handle('u2', { type: 'ready', ready: true }, 1200)
    room.handle('u1', { type: 'start-game' }, 1300)

    const version = room.view('u1').version
    room.handle('u2', { type: 'chat', text: '快点', quick: true }, 1400)
    room.disconnect('u2', 1500)
    room.connect({ userId: 'u2', nickname: '小李' }, 1600)
    expect(room.view('u1').version).toBe(version)

    const seatId = room.state.game!.currentPlayer
    const actor = seatId === 0 ? 'u1' : seatId === 1 ? 'u2' : null
    if (!actor) return
    const tileId = room.state.game!.players[seatId].hand[0].id
    expect(() => room.handle(actor, { type: 'discard', tileId, actionId: 'a1', version }, 1700)).not.toThrow()
    // 牌局真的往前走了之后，旧版本号才应该被拒绝。
    expect(() => room.handle(actor, { type: 'discard', tileId, actionId: 'a2', version }, 1800)).toThrow('请按最新牌面重新操作')
  })

  it('自己反复切换托管不会把回合倒计时刷回满格', () => {
    const room = RoomCoordinator.create('ABC234', { userId: 'u1', nickname: '小陈' }, settings, 1000)
    room.connect({ userId: 'u2', nickname: '小李' }, 1100)
    room.handle('u2', { type: 'ready', ready: true }, 1200)
    room.handle('u1', { type: 'start-game' }, 1300)

    const seatId = room.state.game!.currentPlayer
    const actor = seatId === 0 ? 'u1' : seatId === 1 ? 'u2' : null
    if (!actor) return
    const before = room.view(actor).deadlineAt
    room.handle(actor, { type: 'trustee', enabled: true }, 20_000)
    room.handle(actor, { type: 'trustee', enabled: false }, 20_100)
    expect(room.view(actor).deadlineAt).toBe(before)
  })

  it('别人的暗杠只公开「暗杠了」，不公开杠的是什么牌', () => {
    const room = RoomCoordinator.create('ABC234', { userId: 'u1', nickname: '小陈' }, settings, 1000)
    room.connect({ userId: 'u2', nickname: '小李' }, 1100)
    room.handle('u2', { type: 'ready', ready: true }, 1200)
    room.handle('u1', { type: 'start-game' }, 1300)

    const game = room.state.game!
    const tiles = game.players[1].hand.slice(0, 4)
    game.players[1].melds.push({ id: 'meld-an', type: 'an-gang', tiles })
    game.players[1].hand = game.players[1].hand.slice(4)
    game.events.push({ id: 'e-an', round: game.round, type: 'an-gang', playerId: 1, tile: tiles[0], detail: `小李暗杠${tiles[0].suit}`, at: 1400 })

    const otherView = room.view('u1').game!
    expect(otherView.players[1].melds[0].tiles.every((tile) => tile.id.startsWith('hidden-'))).toBe(true)
    const event = otherView.events.find((candidate) => candidate.id === 'e-an')
    expect(event?.tile).toBeUndefined()
    expect(event?.detail).toBe('小李暗杠')

    // 自己看自己的暗杠仍然是明的
    const selfView = room.view('u2').game!
    expect(selfView.players[1].melds[0].tiles.map((tile) => tile.id)).toEqual(tiles.map((tile) => tile.id))
  })

  it('AI 决策失败时打出一张牌兜底，不让房间卡住', () => {
    const room = RoomCoordinator.create('ABC234', { userId: 'u1', nickname: '小陈' }, settings, 1000)
    room.handle('u1', { type: 'start-game' }, 1200)
    const game = room.state.game!
    // 把当前行动的座位换成 AI，并制造一个会让决策抛错的状态（手牌为空的观察）
    const before = game.events.length
    room.state.seats[game.currentPlayer].kind = 'ai'
    room.state.seats[game.currentPlayer].ai = { difficulty: 'standard' }
    room.runDueJobs(1_000_000)
    expect(room.state.game!.events.length).toBeGreaterThan(before)
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
    // 同一个 actionId 重复到达（比如网络重发）只能生效一次
    room.handle('u1', command, 1400)
    const eventCount = room.snapshot().game!.events.length
    room.handle('u1', command, 1500)
    expect(room.snapshot().game!.events).toHaveLength(eventCount)
  })
})
