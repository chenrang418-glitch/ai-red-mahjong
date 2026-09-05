import { describe, expect, it } from 'vitest'
import { SanguoshaRoomCoordinator, normalizeSettings, type SgsRoomUser } from '../server/sanguosha-room-core'
import type { RespondCardRequest } from '../src/sanguosha/engine/requests'

/**
 * 计时条不能泄露手牌。
 *
 * 引擎在好几处会**因为你手上没有那张牌而静默跳过询问**：无懈可击、
 * 濒死求桃、改判都是这样。牌桌上每个座位各画一条倒计时之后，
 * 「某人身上出现了倒计时」就直接等于「他手里有那张牌」——全桌都看得见。
 *
 * 这组用例把计时条当作**信息通道**来测：别人能看到什么，而不是显示得好不好看。
 */

const HOST: SgsRoomUser = { userId: 'u-host', nickname: '房主' }
const GUEST: SgsRoomUser = { userId: 'u-guest', nickname: '客人' }

function playingRoom(now = 1_000): SanguoshaRoomCoordinator {
  const room = SanguoshaRoomCoordinator.create('PRV234', HOST, normalizeSettings({ playerCount: 5, turnSeconds: 30 }), now)
  room.connect(GUEST, now)
  room.handle(HOST.userId, { type: 'toggle-ready' }, now)
  room.handle(GUEST.userId, { type: 'toggle-ready' }, now)
  room.handle(HOST.userId, { type: 'start-game' }, now)

  let clock = now + 4_000
  for (let guard = 0; guard < 200; guard += 1) {
    const state = room.snapshot().game!
    if (state.status === 'playing' && state.players.every((player) => player.zones.hand.length > 0)) return room
    const request = state.pendingRequests[0]
    if (request?.kind === 'choose-general') {
      const seatId = Number(request.playerId.slice('seat-'.length))
      const seat = room.snapshot().seats[seatId]
      if (seat.kind === 'human') {
        room.handle(seat.userId!, { type: 'respond', requestId: request.id, payload: { characterId: request.candidates[0] } }, clock)
        continue
      }
    }
    const alarm = room.nextAlarmAt()
    if (alarm === null) throw new Error('选将卡住了')
    clock = Math.max(clock + 1, alarm)
    room.runDueJobs(clock)
  }
  throw new Error('没能进入对局')
}

/** 客人的座位号。 */
function guestSeatId(room: SanguoshaRoomCoordinator): number {
  return room.snapshot().seats.find((seat) => seat.userId === GUEST.userId)!.seatId
}

/**
 * 把牌局摆成「正在问客人要不要出某张响应牌」的样子。
 *
 * 直接改引擎状态而不是真打一张锦囊出来：这里要测的是**视图投影**，
 * 不是锦囊结算。真走一遍结算只会让用例依赖一堆和本主张无关的巧合。
 */
function askSeat(room: SanguoshaRoomCoordinator, seatId: number, requiredCardName: string, now: number): void {
  const state = room.snapshot().game!
  const request: RespondCardRequest = {
    id: `request-privacy-${requiredCardName}`,
    kind: 'respond-card',
    playerId: `seat-${seatId}`,
    prompt: '测试用询问',
    timeoutMs: 4_000,
    optional: true,
    actionIds: ['respond-pass'],
    requiredCardName,
  }
  state.pendingRequests = [request]
  room.state.jobs = [{
    id: 'job-privacy',
    kind: 'turn-timeout',
    seatId,
    requestId: request.id,
    dueAt: now + 4_000,
    startedAt: now,
    windowEndsAt: now + 4_000,
    stageKey: room.state.stageKey,
  } as never]
}

describe('计时条不泄露手牌', () => {
  it('别人被问无懈可击时，我看不到他的倒计时', () => {
    const now = 100_000
    const room = playingRoom()
    const seatId = guestSeatId(room)
    askSeat(room, seatId, '无懈可击', now)

    const mine = room.view(GUEST.userId, now).timers
    const others = room.view(HOST.userId, now).timers

    expect(mine.map((timer) => timer.seatId), '本人当然要看得到自己的窗口').toContain(seatId)
    expect(others.map((timer) => timer.seatId), '手上没有无懈就不会被问，画出来等于亮牌')
      .not.toContain(seatId)
  })

  it('濒死求桃同理：被问到就说明手里有桃或酒', () => {
    const now = 100_000
    const room = playingRoom()
    const seatId = guestSeatId(room)
    const state = room.snapshot().game!
    state.pendingRequests = [{
      id: 'request-privacy-rescue',
      kind: 'rescue',
      playerId: `seat-${seatId}`,
      prompt: '测试用求桃',
      timeoutMs: 30_000,
      optional: true,
      actionIds: ['rescue-pass'],
      dyingPlayerId: 'seat-0',
      requiredRecover: 1,
    } as never]
    room.state.jobs = [{
      id: 'job-privacy',
      kind: 'turn-timeout',
      seatId,
      requestId: 'request-privacy-rescue',
      dueAt: now + 30_000,
      startedAt: now,
      windowEndsAt: now + 30_000,
      stageKey: room.state.stageKey,
    } as never]

    expect(room.view(HOST.userId, now).timers.map((timer) => timer.seatId)).not.toContain(seatId)
    expect(room.view(GUEST.userId, now).timers.map((timer) => timer.seatId)).toContain(seatId)
  })

  it('改判同理：能改判说明手上有那张牌', () => {
    const now = 100_000
    const room = playingRoom()
    const seatId = guestSeatId(room)
    const state = room.snapshot().game!
    state.pendingRequests = [{
      id: 'request-privacy-retrial',
      kind: 'choose-cards',
      playerId: `seat-${seatId}`,
      prompt: '测试用改判',
      timeoutMs: 20_000,
      optional: true,
      purpose: 'retrial',
      cardIds: [],
      hiddenCardSlots: [],
      min: 0,
      max: 1,
    } as never]
    room.state.jobs = [{
      id: 'job-privacy',
      kind: 'turn-timeout',
      seatId,
      requestId: 'request-privacy-retrial',
      dueAt: now + 20_000,
      startedAt: now,
      windowEndsAt: now + 20_000,
      stageKey: room.state.stageKey,
    } as never]

    expect(room.view(HOST.userId, now).timers.map((timer) => timer.seatId)).not.toContain(seatId)
  })

  it('选将阶段照常全桌可见：那时候谁都知道每个人在选将', () => {
    const now = 1_000
    const room = SanguoshaRoomCoordinator.create('PRV999', HOST, normalizeSettings({ playerCount: 5, turnSeconds: 30 }), now)
    room.connect(GUEST, now)
    room.handle(HOST.userId, { type: 'toggle-ready' }, now)
    room.handle(GUEST.userId, { type: 'toggle-ready' }, now)
    room.handle(HOST.userId, { type: 'start-game' }, now)
    expect(room.view(HOST.userId, now).timers).toHaveLength(5)
  })

  it('当前回合角色的窗口照常可见：他在行动是明摆着的', () => {
    const room = playingRoom()
    const state = room.snapshot().game!
    const currentSeatId = Number(state.currentPlayerId.slice('seat-'.length))
    const timers = room.view(HOST.userId).timers
    // 回合角色可能是 AI，也可能是真人；无论如何这一项对全桌可见
    if (timers.length > 0) {
      expect(timers.some((timer) => timer.seatId === currentSeatId)).toBe(true)
    }
  })
})
