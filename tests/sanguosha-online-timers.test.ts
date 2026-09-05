import { describe, expect, it } from 'vitest'
import { SanguoshaRoomCoordinator, normalizeSettings, type SgsRoomUser } from '../server/sanguosha-room-core'

/**
 * 联机牌桌的计时与挂机处理。
 *
 * 两条核心主张：
 * 1. **每个正在被等待的座位都有自己的计时**，而不是全桌共用一个匿名倒计时；
 * 2. 别人做决定**不会**把我的计时拨回起点。
 */

const HOST: SgsRoomUser = { userId: 'u-host', nickname: '房主' }
const GUEST: SgsRoomUser = { userId: 'u-guest', nickname: '客人' }

function started(now = 1_000, turnSeconds = 30): SanguoshaRoomCoordinator {
  const room = SanguoshaRoomCoordinator.create('ABC234', HOST, normalizeSettings({ playerCount: 5, turnSeconds }), now)
  room.connect(GUEST, now)
  room.handle(HOST.userId, { type: 'toggle-ready' }, now)
  room.handle(GUEST.userId, { type: 'toggle-ready' }, now)
  room.handle(HOST.userId, { type: 'start-game' }, now)
  return room
}

describe('牌桌计时', () => {
  it('开局选将：每一家都有自己的计时，不是只有队首那个', () => {
    const room = started()
    const timers = room.view(HOST.userId).timers
    expect(timers).toHaveLength(5)
    expect(new Set(timers.map((timer) => timer.seatId)).size, '每个座位各一项').toBe(5)
    expect(timers.every((timer) => timer.kind === 'pick-general')).toBe(true)
    expect(timers.filter((timer) => timer.ai), '三台电脑由 AI 驱动').toHaveLength(3)
    expect(timers.filter((timer) => !timer.ai), '两个真人').toHaveLength(2)
  })

  it('选将固定给 60 秒，不跟房间的操作时间走', () => {
    for (const turnSeconds of [15, 30, 60] as const) {
      const room = started(1_000, turnSeconds)
      const timers = room.view(HOST.userId).timers
      expect(timers.length).toBeGreaterThan(0)
      for (const timer of timers) {
        expect(timer.deadlineAt - timer.startedAt, `操作时间 ${turnSeconds} 秒时的选将窗口`).toBe(60_000)
      }
    }
  })

  it('AI 的窗口和真人同口径，只是它自己答得早', () => {
    const now = 1_000
    const room = started(now, 30)
    const timers = room.view(HOST.userId).timers
    for (const timer of timers) {
      expect(timer.deadlineAt - timer.startedAt, `${timer.seatId} 号位的名义窗口`).toBe(60_000)
    }
    // 但 AI 实际被安排的执行时刻远早于名义窗口——它的节奏没有被改动
    const aiJob = room.state.jobs.find((job) => job.kind === 'ai-step')!
    expect(aiJob.dueAt - now, 'AI 的实际落子时刻仍然是它自己的节奏').toBeLessThan(30_000)
  })

  it('别人答完不会把我的计时拨回起点', () => {
    let now = 1_000
    const room = started(now)
    const mine = () => room.view(HOST.userId).timers.find((timer) => !timer.ai
      && `seat-${timer.seatId}` === room.view(HOST.userId).playerView!.viewerId)!
    const before = mine()
    expect(before).toBeTruthy()

    // 让三台电脑把选将答完
    now = room.nextAlarmAt()!
    room.runDueJobs(now)
    expect(room.state.game!.pendingRequests.length, '电脑应当已经选完').toBeLessThan(5)

    const after = mine()
    expect(after.deadlineAt, '我的截止时刻不该被别人的操作改动').toBe(before.deadlineAt)
    expect(after.startedAt).toBe(before.startedAt)
  })

  it('答完的座位就没有计时了', () => {
    const room = started()
    const request = room.view(HOST.userId).playerView!.pendingRequest!
    const mySeatId = Number(room.view(HOST.userId).playerView!.viewerId.slice('seat-'.length))
    expect(room.view(HOST.userId).timers.some((timer) => timer.seatId === mySeatId)).toBe(true)

    room.handle(HOST.userId, {
      type: 'respond',
      requestId: request.id,
      payload: { characterId: (request as { candidates: string[] }).candidates[0] },
    }, 1_000)
    expect(room.view(HOST.userId).timers.some((timer) => timer.seatId === mySeatId), '答完就不该再挂着钟').toBe(false)
  })

  it('开关托管不会把倒计时拨回起点', () => {
    const now = 1_000
    const room = started(now)
    const mySeatId = Number(room.view(HOST.userId).playerView!.viewerId.slice('seat-'.length))
    const mine = () => room.view(HOST.userId).timers.find((timer) => timer.seatId === mySeatId)!
    const before = mine()

    // 过一段时间之后再开托管：窗口应当接着走，不是从头再来
    const later = now + 20_000
    room.handle(HOST.userId, { type: 'trustee', enabled: true }, later)
    const during = mine()
    expect(during.ai, '托管期间这一家由 AI 驱动').toBe(true)
    expect(during.startedAt, '起点不该被改写').toBe(before.startedAt)
    expect(during.deadlineAt, '终点不该被推后').toBe(before.deadlineAt)

    // 取消托管同样不该白拿一整轮
    room.handle(HOST.userId, { type: 'trustee', enabled: false }, later + 5_000)
    const after = mine()
    expect(after.ai).toBe(false)
    expect(after.startedAt).toBe(before.startedAt)
    expect(after.deadlineAt, '取消托管不能重新发一整个窗口').toBe(before.deadlineAt)
  })

  /** 推进到「自己正处在出牌阶段、且挂着 turn-timeout」的那一刻。 */
  function driveToOwnPlayPhase(room: SanguoshaRoomCoordinator, userId: string): number {
    let at = 1_000
    for (let guard = 0; guard < 4_000; guard += 1) {
      const mine = room.view(userId).playerView?.pendingRequest
      if (mine?.kind === 'choose-general') {
        room.handle(userId, { type: 'respond', requestId: mine.id, payload: { characterId: mine.candidates[0] } }, at)
        continue
      }
      const seatId = room.state.seats.find((seat) => seat.userId === userId)!.seatId
      const job = room.state.jobs.find((entry) => entry.kind === 'turn-timeout' && entry.seatId === seatId)
      const game = room.state.game
      if (job && game?.status === 'playing' && game.phase === 'play'
        && game.currentPlayerId === `seat-${seatId}` && game.pendingRequests.length === 0) {
        return at
      }
      // 心跳：连续超时会自动转托管，这里要的是「人在、只是慢」
      room.handle(userId, { type: 'trustee', enabled: false }, at)
      const next = room.nextAlarmAt()
      if (next === null) break
      at = Math.max(at + 1, next)
      room.runDueJobs(at)
    }
    throw new Error('没能推进到自己的出牌阶段')
  }

  /*
   * 出牌阶段这条路和选将那条**不是同一个分支**：出牌阶段没有 requestId，
   * 任务靠局面指纹认身份。上一版只覆盖了选将，这条漏了。
   */
  it('自己出牌阶段开关托管，同样不重置倒计时', () => {
    const room = started(1_000)
    const at = driveToOwnPlayPhase(room, HOST.userId)
    const seatId = room.state.seats.find((seat) => seat.userId === HOST.userId)!.seatId
    const mine = () => room.view(HOST.userId).timers.find((timer) => timer.seatId === seatId)!
    const before = mine()
    expect(before.ai).toBe(false)

    room.handle(HOST.userId, { type: 'trustee', enabled: true }, at + 12_000)
    const during = mine()
    expect(during.ai).toBe(true)
    expect(during.startedAt, '起点不该被改写').toBe(before.startedAt)
    expect(during.deadlineAt, '终点不该被推后').toBe(before.deadlineAt)

    room.handle(HOST.userId, { type: 'trustee', enabled: false }, at + 13_000)
    const after = mine()
    expect(after.ai).toBe(false)
    expect(after.startedAt).toBe(before.startedAt)
    expect(after.deadlineAt, '取消托管不能白拿一整轮').toBe(before.deadlineAt)
  })

  /*
   * `windowEndsAt` 是后加的字段。休眠中的房间恢复回来、版本刚上线时还在飞的
   * 那一局，任务都是老形状；那时候如果落回「现在 + 完整窗口」，
   * 倒计时照样会被拨回起点。
   */
  it('恢复出来的老任务没有窗口终点时，也不会把倒计时拨回起点', () => {
    const room = started(1_000)
    const at = driveToOwnPlayPhase(room, HOST.userId)
    const seatId = room.state.seats.find((seat) => seat.userId === HOST.userId)!.seatId
    const job = room.state.jobs.find((entry) => entry.kind === 'turn-timeout' && entry.seatId === seatId)!
    const originalDeadline = job.dueAt
    // 模拟老形状：把新加的字段抹掉
    delete (job as { windowEndsAt?: number }).windowEndsAt

    room.handle(HOST.userId, { type: 'trustee', enabled: true }, at + 12_000)
    const after = room.view(HOST.userId).timers.find((timer) => timer.seatId === seatId)!
    expect(after.deadlineAt, '拿老任务的 dueAt 顶上，而不是重发一个窗口').toBe(originalDeadline)
  })

  it('掉线重连也不会重置窗口', () => {
    const now = 1_000
    const room = started(now)
    const guestSeatId = room.state.seats.find((seat) => seat.userId === GUEST.userId)!.seatId
    const guestTimer = () => room.view(HOST.userId).timers.find((timer) => timer.seatId === guestSeatId)!
    const before = guestTimer()

    room.disconnect(GUEST.userId, now + 5_000)
    room.connect(GUEST, now + 8_000)
    const after = guestTimer()
    expect(after.startedAt).toBe(before.startedAt)
    expect(after.deadlineAt).toBe(before.deadlineAt)
  })

  it('只有窗口真被收短的那种才标成「抢答」', async () => {
    const { timerKindOf } = await import('../server/sanguosha-room-core') as unknown as {
      timerKindOf: (status: string, request: unknown) => string
    }
    const base = { id: 'r', playerId: 'seat-0', prompt: '', timeoutMs: 4_000, optional: true }
    expect(timerKindOf('playing', { ...base, kind: 'respond-card', requiredCardName: '无懈可击' })).toBe('claim')
    // 濒死求桃是按座位顺序一个一个问的，窗口也是完整的，不能套「抢答」的皮
    expect(timerKindOf('playing', { ...base, kind: 'rescue', dyingPlayerId: 'seat-1' })).toBe('response')
    expect(timerKindOf('playing', { ...base, kind: 'respond-card', requiredCardName: '闪' })).toBe('response')
    expect(timerKindOf('playing', undefined)).toBe('action')
    expect(timerKindOf('choosing-general', undefined)).toBe('pick-general')
  })

  it('牌局没开始时没有任何计时', () => {
    const room = SanguoshaRoomCoordinator.create('XYZ789', HOST, normalizeSettings({ playerCount: 5 }), 1_000)
    expect(room.view(HOST.userId).timers).toEqual([])
  })
})

describe('挂机识别', () => {
  /** 一直不操作，直到这个座位被自动托管；返回用掉了几次超时。 */
  function idleUntilTrustee(room: SanguoshaRoomCoordinator, userId: string, from: number): number {
    let now = from
    let timeouts = 0
    for (let guard = 0; guard < 200; guard += 1) {
      const seat = room.state.seats.find((candidate) => candidate.userId === userId)!
      if (seat.trustee) return timeouts
      const job = room.state.jobs.find((candidate) => candidate.kind === 'turn-timeout' && candidate.seatId === seat.seatId)
      if (!job) {
        const alarm = room.nextAlarmAt()
        if (alarm === null) break
        now = Math.max(now + 1, alarm)
        room.runDueJobs(now)
        continue
      }
      now = Math.max(now + 1, job.dueAt)
      room.runDueJobs(now)
      timeouts += 1
    }
    throw new Error('这个座位始终没有被自动托管')
  }

  it('连续三次超时自动转托管，并写进战报', () => {
    const room = started(1_000)
    // 客人正常选将，只有房主一直不动
    const guestRequest = room.view(GUEST.userId).playerView!.pendingRequest!
    room.handle(GUEST.userId, {
      type: 'respond',
      requestId: guestRequest.id,
      payload: { characterId: (guestRequest as { candidates: string[] }).candidates[0] },
    }, 1_000)

    const used = idleUntilTrustee(room, HOST.userId, 1_000)
    expect(used, '第三次超时才转托管，不能一次就判挂机').toBe(3)
    const hostSeat = room.state.seats.find((seat) => seat.userId === HOST.userId)!
    expect(hostSeat.trustee).toBe(true)
    expect(hostSeat.kind, '座位仍然属于这个人，不是被换成电脑').toBe('human')
    const log = room.view(GUEST.userId).log.join('\n')
    expect(log, '别人也该看到发生了什么').toContain('自动托管')
  })

  it('中途操作一次就清零，不会累计到托管', () => {
    const room = started(1_000)
    const seat = room.state.seats.find((candidate) => candidate.userId === HOST.userId)!
    let now = 1_000
    // 先超时两次
    for (let round = 0; round < 2; round += 1) {
      const job = room.state.jobs.find((candidate) => candidate.kind === 'turn-timeout' && candidate.seatId === seat.seatId)
      if (!job) break
      now = Math.max(now + 1, job.dueAt)
      room.runDueJobs(now)
    }
    expect(seat.timeoutStreak ?? 0).toBeGreaterThan(0)

    // 任意一次真人操作
    room.handle(HOST.userId, { type: 'trustee', enabled: false }, now)
    expect(seat.timeoutStreak, '操作过就该清零').toBe(0)
    expect(seat.trustee).toBe(false)
  })

  it('自动托管之后，本人一动就自动收回', () => {
    const room = started(1_000)
    const guestRequest = room.view(GUEST.userId).playerView!.pendingRequest!
    room.handle(GUEST.userId, {
      type: 'respond',
      requestId: guestRequest.id,
      payload: { characterId: (guestRequest as { candidates: string[] }).candidates[0] },
    }, 1_000)
    idleUntilTrustee(room, HOST.userId, 1_000)

    const seat = room.state.seats.find((candidate) => candidate.userId === HOST.userId)!
    expect(seat.trustee).toBe(true)

    // 托管期间人回来了，直接做一次操作即可，不必先去点「取消托管」
    let now = 200_000
    for (let guard = 0; guard < 400 && !room.view(HOST.userId).playerView?.pendingRequest; guard += 1) {
      const alarm = room.nextAlarmAt()
      if (alarm === null) break
      now = Math.max(now + 1, alarm)
      room.runDueJobs(now)
    }
    const request = room.view(HOST.userId).playerView?.pendingRequest
    if (!request) return
    const payload = request.kind === 'choose-general'
      ? { characterId: request.candidates[0] }
      : request.kind === 'choose-option'
        ? { optionId: request.options[0].id }
        : null
    if (!payload) return
    room.handle(HOST.userId, { type: 'respond', requestId: request.id, payload }, now)
    expect(seat.trustee, '人回来了就该把托管收回去').toBe(false)
    expect(room.view(GUEST.userId).log.join('\n')).toContain('托管解除')
  })

  it('重连会清掉超时计数，不会刚回来就又被判挂机', () => {
    const room = started(1_000)
    const seat = room.state.seats.find((candidate) => candidate.userId === GUEST.userId)!
    seat.timeoutStreak = 2
    room.disconnect(GUEST.userId, 2_000)
    room.connect(GUEST, 3_000)
    expect(seat.timeoutStreak).toBe(0)
    expect(seat.trustee).toBe(false)
  })
})
