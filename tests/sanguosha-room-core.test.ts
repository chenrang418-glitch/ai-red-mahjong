import { describe, expect, it } from 'vitest'
import {
  InvalidSgsCommandError,
  SanguoshaRoomCoordinator,
  normalizeSettings,
  type SgsRoomUser,
} from '../server/sanguosha-room-core'

/**
 * 联机房间核心。
 *
 * 重点验证三条硬约束：
 * 1. 服务端权威——客户端的非法意图必须被拒绝，而不是照单执行。
 * 2. 每个连接只看得到自己的视图，完整 GameState 不下发。
 * 3. 所有等待都是可序列化的，Durable Object 休眠再醒来能接上。
 */

const HOST: SgsRoomUser = { userId: 'u-host', nickname: '房主' }
const GUEST: SgsRoomUser = { userId: 'u-guest', nickname: '客人' }

function lobby(now = 1_000): SanguoshaRoomCoordinator {
  return SanguoshaRoomCoordinator.create('ABC234', HOST, normalizeSettings({ playerCount: 5 }), now)
}

/** 开一局：房主 + 一个真人 + 三个 AI。 */
function started(now = 1_000): SanguoshaRoomCoordinator {
  const room = lobby(now)
  room.connect(GUEST, now)
  room.handle(HOST.userId, { type: 'toggle-ready' }, now)
  room.handle(GUEST.userId, { type: 'toggle-ready' }, now)
  for (let index = 0; index < 3; index += 1) room.handle(HOST.userId, { type: 'add-ai' }, now)
  room.handle(HOST.userId, { type: 'start-game' }, now)
  return room
}

describe('联机房间：大厅', () => {
  it('房主自动落座，人满前可以继续加人', () => {
    const room = lobby()
    expect(room.view(HOST.userId).seats.filter((seat) => seat.kind === 'human')).toHaveLength(1)
    room.connect(GUEST)
    expect(room.view(HOST.userId).seats.filter((seat) => seat.kind === 'human')).toHaveLength(2)
  })

  it('只有房主能加电脑和开局', () => {
    const room = lobby()
    room.connect(GUEST)
    expect(() => room.handle(GUEST.userId, { type: 'add-ai' })).toThrow(InvalidSgsCommandError)
    expect(() => room.handle(GUEST.userId, { type: 'start-game' })).toThrow(InvalidSgsCommandError)
  })

  it('座位没坐满不许开局', () => {
    const room = lobby()
    room.handle(HOST.userId, { type: 'toggle-ready' })
    expect(() => room.handle(HOST.userId, { type: 'start-game' })).toThrow(/空位/)
  })

  it('大厅里断线直接腾出座位，牌局中则保留', () => {
    const room = lobby()
    room.connect(GUEST)
    room.disconnect(GUEST.userId)
    expect(room.view(HOST.userId).seats.filter((seat) => seat.kind === 'human')).toHaveLength(1)

    const playing = started()
    playing.disconnect(GUEST.userId)
    expect(playing.view(HOST.userId).seats.filter((seat) => seat.kind === 'human')).toHaveLength(2)
  })
})

describe('联机房间：服务端权威', () => {
  it('不能替别人回应请求', () => {
    const room = started()
    const state = room.snapshot().game!
    const request = state.pendingRequests[0]
    expect(request).toBeTruthy()
    const owner = room.view(HOST.userId).seats.find((seat) => seat.isSelf)!
    const notOwner = request.playerId !== `seat-${owner.seatId}` ? HOST.userId : GUEST.userId
    expect(() => room.handle(notOwner, { type: 'respond', requestId: request.id, payload: { characterId: 'guanyu' } }))
      .toThrow(InvalidSgsCommandError)
  })

  it('非法 payload 被引擎拒绝，房间状态不受影响', () => {
    const room = started()
    const before = room.snapshot().game!.seq
    const request = room.snapshot().game!.pendingRequests[0]
    const seatId = Number(request.playerId.slice('seat-'.length))
    const seat = room.snapshot().seats[seatId]
    const userId = seat.kind === 'human' ? (seatId === 0 ? HOST.userId : GUEST.userId) : null
    if (!userId) return
    expect(() => room.handle(userId, { type: 'respond', requestId: request.id, payload: { characterId: '不存在的武将' } })).toThrow()
    expect(room.snapshot().game!.seq).toBe(before)
  })

  it('轮不到你就不能行动', () => {
    const room = started()
    expect(() => room.handle(GUEST.userId, { type: 'act', actionId: 'whatever' })).toThrow(InvalidSgsCommandError)
  })

  it('不在房间里的人什么都做不了', () => {
    const room = started()
    expect(() => room.handle('u-stranger', { type: 'chat', text: 'hi' })).toThrow(/不在这个房间/)
  })
})

describe('联机房间：视图隔离', () => {
  it('每个人只拿到自己的 PlayerView，看不到别人的手牌', () => {
    const room = started()
    // 先把选将走完，手牌才发下来
    runToPlaying(room)

    const hostView = room.view(HOST.userId).playerView!
    const guestView = room.view(GUEST.userId).playerView!
    expect(hostView.viewerId).not.toBe(guestView.viewerId)

    for (const view of [hostView, guestView]) {
      for (const player of view.players) {
        if (player.id === view.viewerId) expect(player.hand).not.toBeNull()
        else expect(player.hand).toBeNull()
      }
    }
  })

  it('战报按玩家过滤，别人摸的牌名不出现在我的战报里', () => {
    const room = started()
    runToPlaying(room)
    const hostLog = room.view(HOST.userId).log.join('\n')
    const stored = room.snapshot().game!
    const hostSeat = room.snapshot().seats.find((seat) => seat.userId === HOST.userId)!
    for (const player of stored.players) {
      if (player.id === `seat-${hostSeat.seatId}`) continue
      for (const cardId of player.zones.hand) expect(hostLog).not.toContain(cardId)
    }
  })
})

describe('联机房间：休眠与恢复', () => {
  it('整个房间状态能过 JSON，重建后接着走', () => {
    const room = started()
    runToPlaying(room)

    const text = JSON.stringify(room.snapshot())
    const revived = new SanguoshaRoomCoordinator(JSON.parse(text))
    expect(revived.view(HOST.userId).phase).toBe('playing')

    // 恢复之后 AI 还能继续推进——技能触发器和事件订阅都要重新挂上
    const before = revived.snapshot().game!.seq
    revived.runDueJobs(Date.now() + 60_000)
    expect(revived.snapshot().game!.seq).toBeGreaterThan(before)
  })

  it('局面变了之后，旧的超时任务不会误伤', () => {
    const room = started()
    const alarm = room.nextAlarmAt()
    expect(alarm).toBeGreaterThan(0)
    // 先正常推进，让 stageKey 变掉
    room.runDueJobs(alarm! + 1)
    const staleAlarm = alarm!
    // 用一个早就过期的时间点再跑一次，不该重复执行同一步
    const seqBefore = room.snapshot().game!.seq
    room.runDueJobs(staleAlarm)
    expect(room.snapshot().game!.seq).toBe(seqBefore)
  })

  it('掉线一段时间后自动转托管，AI 接着替他打', () => {
    const now = 1_000
    const room = started(now)
    room.disconnect(GUEST.userId, now)
    const guestSeatBefore = room.snapshot().seats.find((seat) => seat.userId === GUEST.userId)!
    expect(guestSeatBefore.trustee).toBe(false)

    room.runDueJobs(now + 60_000)
    const guestSeat = room.snapshot().seats.find((seat) => seat.userId === GUEST.userId)!
    expect(guestSeat.trustee).toBe(true)
  })

  it('重连回来自动取消托管', () => {
    const now = 1_000
    const room = started(now)
    room.disconnect(GUEST.userId, now)
    room.runDueJobs(now + 60_000)
    room.connect(GUEST, now + 61_000)
    const seat = room.snapshot().seats.find((candidate) => candidate.userId === GUEST.userId)!
    expect(seat.trustee).toBe(false)
    expect(seat.connected).toBe(true)
  })
})

describe('联机房间：牌局能打完', () => {
  it('全部交给 AI 推进，牌局能正常结束', () => {
    const room = started()
    // 两个真人都托管，等于全 AI 局
    room.handle(HOST.userId, { type: 'trustee', enabled: true })
    room.handle(GUEST.userId, { type: 'trustee', enabled: true })

    let now = 10_000
    for (let step = 0; step < 4_000; step += 1) {
      // 选将阶段的 status 也不是 playing，这里要等的是「打完」
      if (room.snapshot().game!.status === 'game-over') break
      const alarm = room.nextAlarmAt()
      if (alarm === null) throw new Error('牌局停住了，但没有安排任何任务')
      now = Math.max(now, alarm)
      room.runDueJobs(now)
    }
    expect(room.snapshot().game!.status).toBe('game-over')
    expect(room.view(HOST.userId).phase).toBe('finished')
  })
})

/** 把选将阶段走完，进入正式对局。 */
function runToPlaying(room: SanguoshaRoomCoordinator): void {
  let now = 5_000
  for (let guard = 0; guard < 200; guard += 1) {
    const state = room.snapshot().game!
    if (state.status === 'playing' && state.players.every((player) => player.zones.hand.length > 0)) return
    const request = state.pendingRequests[0]
    if (request?.kind === 'choose-general') {
      const seatId = Number(request.playerId.slice('seat-'.length))
      const seat = room.snapshot().seats[seatId]
      if (seat.kind === 'human') {
        const userId = seat.userId!
        room.handle(userId, { type: 'respond', requestId: request.id, payload: { characterId: request.candidates[0] } }, now)
        continue
      }
    }
    const alarm = room.nextAlarmAt()
    if (alarm === null) throw new Error('选将卡住了')
    now = Math.max(now + 1, alarm)
    room.runDueJobs(now)
  }
  throw new Error('没能进入对局')
}
