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
    expect(() => room.handle(GUEST.userId, { type: 'act', legalActionId: 'whatever' })).toThrow(InvalidSgsCommandError)
  })

  it('不在房间里的人什么都做不了', () => {
    const room = started()
    expect(() => room.handle('u-stranger', { type: 'chat', text: 'hi' })).toThrow(/不在这个房间/)
  })

  it('重复 actionId 不会执行两次', () => {
    const room = lobby()
    const baseSeq = room.snapshot().version
    room.handle(HOST.userId, { type: 'toggle-ready', actionId: 'ready-once', baseSeq })
    expect(room.snapshot().seats[0].ready).toBe(true)
    expect(() => room.handle(HOST.userId, { type: 'toggle-ready', actionId: 'ready-once', baseSeq: room.snapshot().version })).toThrow(/已经处理/)
    expect(room.snapshot().seats[0].ready).toBe(true)
  })

  it('稍旧的 baseSeq 仍然接受，但比服务端还新的要拒绝', () => {
    // version 在 AI 走子、聊天、别人准备时都会变。一律拒绝陈旧 baseSeq 的话，
    // 联机实战中玩家点一下几乎必然被驳回——真正的陈旧由引擎按 requestId /
    // legalActionId 挡住，挡得更准。
    const room = lobby()
    const stale = room.snapshot().version
    room.connect(GUEST)
    expect(room.snapshot().version).toBeGreaterThan(stale)

    room.handle(HOST.userId, { type: 'toggle-ready', actionId: 'older-base', baseSeq: stale })
    expect(room.snapshot().seats[0].ready).toBe(true)

    expect(() => room.handle(HOST.userId, { type: 'toggle-ready', actionId: 'from-future', baseSeq: 9_999 }))
      .toThrow(/不一致/)
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

describe('联机房间：超时', () => {
  it('真人不响应时，到点由 AI 代做一步', () => {
    const now = 1_000
    const room = started(now)
    // 找到当前该行动的真人，并确认他既没托管也没掉线
    const state = room.snapshot().game!
    const request = state.pendingRequests[0]
    expect(request).toBeTruthy()
    const seatId = Number(request.playerId.slice('seat-'.length))
    const seat = room.snapshot().seats[seatId]
    if (seat.kind !== 'human') return
    expect(seat.trustee).toBe(false)
    expect(seat.connected).toBe(true)

    // 真人的等待时限比 AI 的间隔长得多，两者不会混淆
    const deadline = room.view(HOST.userId, now).deadlineAt
    expect(deadline, '真人回合应当有一个可见的倒计时').toBeGreaterThan(now)

    // 用 decisions 而不是 seq 判断推进：选将这类响应不会 bump seq
    const decisionsBefore = state.decisions.length
    room.runDueJobs(deadline!)
    const after = room.snapshot().game!
    expect(after.decisions.length, '超时之后应当由 AI 代做一步').toBeGreaterThan(decisionsBefore)
    expect(after.pendingRequests[0]?.id, '原来那个请求应当已经被消费').not.toBe(request.id)
  })

  it('AI 座位不给真人倒计时', () => {
    const room = started()
    // 全部托管之后，视图里不该再有真人倒计时
    room.handle(HOST.userId, { type: 'trustee', enabled: true })
    room.handle(GUEST.userId, { type: 'trustee', enabled: true })
    expect(room.view(HOST.userId).deadlineAt).toBeNull()
    expect(room.view(HOST.userId).aiThinking).toBe(true)
  })
})

describe('联机房间：再来一局', () => {
  it('所有真人都点了才开下一局，且局面是全新的', () => {
    const room = playToEnd(started())
    const firstSeed = room.snapshot().game!.seed

    room.handle(HOST.userId, { type: 'next-round' })
    // 只有一个人点，不该直接开
    expect(room.snapshot().game!.status).toBe('game-over')

    room.handle(GUEST.userId, { type: 'next-round' })
    const next = room.snapshot().game!
    expect(next.status).not.toBe('game-over')
    expect(next.seed, '新一局必须换 seed，否则会打出一模一样的牌').not.toBe(firstSeed)
    expect(next.turnNumber).toBeLessThanOrEqual(1)
    // 上一局的准备状态不能带进新局
    for (const seat of room.snapshot().seats) expect(seat.nextRoundReady).toBe(false)
  })

  it('有人一直不点也不会把整桌锁死', () => {
    const room = playToEnd(started())
    const now = room.snapshot().updatedAt + 1_000
    room.handle(HOST.userId, { type: 'next-round' }, now)
    expect(room.snapshot().game!.status).toBe('game-over')

    // 超时之后自动开下一局
    room.runDueJobs(now + 120_000)
    expect(room.snapshot().game!.status).not.toBe('game-over')
  })

  it('牌局没结束时不能点再来一局', () => {
    const room = started()
    expect(() => room.handle(HOST.userId, { type: 'next-round' })).toThrow(/还没结束/)
  })
})

/** 全托管跑到牌局结束。 */
function playToEnd(room: SanguoshaRoomCoordinator): SanguoshaRoomCoordinator {
  room.handle(HOST.userId, { type: 'trustee', enabled: true })
  room.handle(GUEST.userId, { type: 'trustee', enabled: true })
  let now = 10_000
  for (let step = 0; step < 4_000; step += 1) {
    if (room.snapshot().game!.status === 'game-over') return room
    const alarm = room.nextAlarmAt()
    if (alarm === null) throw new Error('牌局停住了，但没有安排任何任务')
    now = Math.max(now, alarm)
    room.runDueJobs(now)
  }
  throw new Error('牌局没能在步数上限内结束')
}

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
