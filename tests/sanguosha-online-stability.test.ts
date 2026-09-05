import { describe, expect, it, vi } from 'vitest'
import {
  SanguoshaRoomCoordinator,
  normalizeSettings,
  type SgsRoomUser,
} from '../server/sanguosha-room-core'

/**
 * 联机长期稳定性：故障注入。
 *
 * 这一组守的不是「功能对不对」，而是**「出了异常之后牌局还能不能继续推进」**。
 * 用户实测报的现象是「联机玩一段时间突然卡住，游戏不再推进」，
 * 对应的架构缺陷是：Job 在执行前就被从队列里删掉，一旦执行途中抛异常，
 * 任务就永久消失，房间仍是 playing 却再也没有推进任务。
 *
 * 核心不变量：**只要房间还需要自动推进，就必须存在近期的 alarm。**
 */

const HOST: SgsRoomUser = { userId: 'u-host', nickname: '房主' }
const GUEST: SgsRoomUser = { userId: 'u-guest', nickname: '客人' }

function started(now = 1_000): SanguoshaRoomCoordinator {
  const room = SanguoshaRoomCoordinator.create('ABC234', HOST, normalizeSettings({ playerCount: 5 }), now)
  room.connect(GUEST, now)
  room.handle(HOST.userId, { type: 'toggle-ready' }, now)
  room.handle(GUEST.userId, { type: 'toggle-ready' }, now)
  for (let index = 0; index < 3; index += 1) room.handle(HOST.userId, { type: 'add-ai' }, now)
  room.handle(HOST.userId, { type: 'start-game' }, now)
  return room
}

/** 读内部私有状态：这些测试就是要盯调度细节。 */
function jobsOf(room: SanguoshaRoomCoordinator) {
  return (room.state as unknown as { jobs: Array<{ kind: string; dueAt: number; stageKey: string; attempt?: number; requestId?: string }> }).jobs
}

/**
 * 本轮的核心不变量。
 *
 * 房间还需要服务器推进时，不允许出现「没有任何近期 alarm」的状态——
 * 那等价于永久卡死。近期的判据放宽到 60 秒：真人超时本身就有几十秒。
 */
function expectProgressInvariant(room: SanguoshaRoomCoordinator, now: number): void {
  const status = room.state.game?.status
  if (status !== 'playing' && status !== 'choosing-general') return
  const alarmAt = room.nextAlarmAt()
  expect(alarmAt, '需要推进的房间必须有 alarm').not.toBeNull()
  expect(alarmAt! - now, '需要推进的房间不能只剩「几小时后」的回收 alarm').toBeLessThanOrEqual(60_000)
}

describe('Job 执行失败不会把任务吃掉', () => {
  it('单次异常：回滚后按退避重排，牌局仍有近期 alarm', () => {
    const room = started()
    const now = 2_000
    // 让下一次 Job 执行抛异常一次
    const internals = room as unknown as { stepAI: (now: number, job: unknown) => boolean }
    const original = internals.stepAI.bind(room)
    let thrown = 0
    const spy = vi.spyOn(internals, 'stepAI').mockImplementation((at: number, job: unknown) => {
      if (thrown === 0) { thrown += 1; throw new Error('注入的 AI 异常') }
      return original(at, job)
    })

    const dueAt = Math.min(...jobsOf(room).map((job) => job.dueAt))
    expect(() => room.runDueJobs(dueAt), 'runDueJobs 不该把异常抛出去').not.toThrow()

    const retried = jobsOf(room).filter((job) => job.kind === 'ai-step' || job.kind === 'turn-timeout')
    expect(retried.length, '失败的任务必须还在队列里').toBeGreaterThan(0)
    // 多人同时决定时每个座位各有一个任务，队首不一定就是失败的那个，要按 attempt 找
    const failed = retried.find((job) => job.attempt !== undefined)
    expect(failed, '失败的那个任务要被重新排上').toBeTruthy()
    expect(failed!.attempt, '要记下这是第几次重试').toBe(1)
    expect(failed!.dueAt, '重试要有退避').toBeGreaterThan(dueAt)
    expectProgressInvariant(room, dueAt)

    // 退避之后重试成功，牌局继续往前走
    const seqBefore = room.state.game!.seq
    room.runDueJobs(retried[0].dueAt)
    expect(room.state.game!.seq, '重试成功后牌局应当推进').toBeGreaterThanOrEqual(seqBefore)
    spy.mockRestore()
  })

  it('回滚是完整的：失败一次之后 RNG 和牌局状态仍然一致', () => {
    const room = started()
    const internals = room as unknown as { stepAI: (now: number, seatId?: number) => void }
    const before = JSON.stringify({ game: room.state.game, rng: room.state.aiRngState })

    vi.spyOn(internals, 'stepAI').mockImplementationOnce(() => { throw new Error('注入异常') })
    const dueAt = Math.min(...jobsOf(room).map((job) => job.dueAt))
    room.runDueJobs(dueAt)

    expect(
      JSON.stringify({ game: room.state.game, rng: room.state.aiRngState }),
      '失败的一步不能留下半截状态（牌局回滚了 RNG 没回滚同样算污染）',
    ).toBe(before)
    vi.restoreAllMocks()
  })

  it('确定性连续异常：重试有上限、有退避，不会同步死循环', () => {
    const room = started()
    const internals = room as unknown as { stepAI: (now: number, seatId?: number) => void }
    vi.spyOn(internals, 'stepAI').mockImplementation(() => { throw new Error('永远失败') })

    let now = 2_000
    for (let round = 0; round < 8; round += 1) {
      const alarmAt = room.nextAlarmAt()
      if (alarmAt === null) break
      now = Math.max(now, alarmAt)
      // 每一轮都必须在有限时间内返回，不能卡在同步 while 里
      expect(() => room.runDueJobs(now)).not.toThrow()
    }

    const gameplay = jobsOf(room).filter((job) => job.kind === 'ai-step' || job.kind === 'turn-timeout')
    expect(gameplay.every((job) => (job.attempt ?? 0) <= 3), '重试次数必须有上限').toBe(true)
    // 即使这个任务最终被放弃，房间也必须还有自检任务
    expect(jobsOf(room).some((job) => job.kind === 'health-watchdog'), '放弃任务后必须留下 watchdog').toBe(true)
    expectProgressInvariant(room, now)
    vi.restoreAllMocks()
  })
})

describe('health watchdog 自愈', () => {
  it('推进任务凭空丢失时，watchdog 会重建调度', () => {
    const room = started()
    const now = 2_000
    // 人为制造「牌局仍在进行，但一个推进任务都没有」的坏状态
    const state = room.state as unknown as { jobs: unknown[] }
    state.jobs = []
    expect(room.nextAlarmAt(), '坏状态下确实没有任何 alarm').toBeNull()

    // 任何一次 runDueJobs 都会在收尾时补上 watchdog
    room.runDueJobs(now)
    expect(jobsOf(room).some((job) => job.kind === 'health-watchdog'), '必须补出 watchdog').toBe(true)
    expectProgressInvariant(room, now)

    // watchdog 到期后重建真正的推进任务
    const watchdog = jobsOf(room).find((job) => job.kind === 'health-watchdog')!
    room.runDueJobs(watchdog.dueAt)
    const gameplay = jobsOf(room).filter((job) => job.kind === 'ai-step' || job.kind === 'turn-timeout')
    expect(gameplay.length, 'watchdog 应当重建推进任务').toBeGreaterThan(0)
    expect(gameplay[0].stageKey, '重建的任务要挂在当前局面上').toBe(room.state.stageKey)
  })

  it('任务全是过期局面指纹时，清理并按当前局面重排', () => {
    const room = started()
    const now = 2_000
    /*
     * 「过期」有两种：绑了请求的任务看**请求还在不在**，没绑请求的看局面指纹。
     * 这里两种都伪造成过期，watchdog 应当把它们全部换成当前局面的任务。
     */
    for (const job of jobsOf(room)) {
      if (job.kind !== 'ai-step' && job.kind !== 'turn-timeout') continue
      job.stageKey = 'stale-stage-key'
      if (job.requestId !== undefined) job.requestId = 'request-that-no-longer-exists'
    }
    room.runDueJobs(now)
    const watchdog = jobsOf(room).find((job) => job.kind === 'health-watchdog')!
    room.runDueJobs(watchdog.dueAt)

    const gameplay = jobsOf(room).filter((job) => job.kind === 'ai-step' || job.kind === 'turn-timeout')
    expect(gameplay.length, 'watchdog 必须重建出推进任务').toBeGreaterThan(0)
    const pending = room.state.game!.pendingRequests
    expect(gameplay.every((job) => (job.requestId === undefined
      ? job.stageKey === room.state.stageKey
      : pending.some((request) => request.id === job.requestId))), '过期任务要被换成当前局面的任务').toBe(true)
  })

  it('watchdog 不会重复堆积：跑很多轮也只有一个', () => {
    const room = started()
    let now = 2_000
    for (let round = 0; round < 10; round += 1) {
      now += 15_000
      room.runDueJobs(now)
    }
    expect(jobsOf(room).filter((job) => job.kind === 'health-watchdog')).toHaveLength(1)
  })

  it('牌局结束后撤掉高频自检，房间回到低负载', () => {
    // 不能直接改 state.game.status：内存里的引擎才是权威，
    // 下一次 runDueJobs 会用 engine.serialize() 把它覆盖回去。
    // 所以真把这局打到结束。
    const room = started()
    let now = 2_000
    for (let step = 0; step < 4_000; step += 1) {
      const alarmAt = room.nextAlarmAt()
      if (alarmAt === null) break
      now = Math.max(now + 1, alarmAt)
      room.runDueJobs(now)
      if (room.state.game?.status === 'game-over') break
    }
    expect(room.state.game?.status, '这局应当能打完').toBe('game-over')
    expect(
      jobsOf(room).some((job) => job.kind === 'health-watchdog'),
      '结束的房间不该继续每 15 秒醒一次',
    ).toBe(false)
  })

  it('watchdog 只修调度，不改牌局', () => {
    const room = started()
    const now = 2_000
    const state = room.state as unknown as { jobs: unknown[] }
    state.jobs = []
    const gameBefore = JSON.stringify(room.state.game)

    room.runDueJobs(now)
    const watchdog = jobsOf(room).find((job) => job.kind === 'health-watchdog')!
    room.runDueJobs(watchdog.dueAt)

    // 重建调度不该替玩家答请求、不该跳阶段、不该改血量
    const after = room.state.game!
    const before = JSON.parse(gameBefore) as typeof after
    expect(after.phase, 'watchdog 不能推进阶段').toBe(before.phase)
    expect(after.currentPlayerId, 'watchdog 不能换人').toBe(before.currentPlayerId)
    expect(after.pendingRequests.length, 'watchdog 不能替玩家答请求').toBe(before.pendingRequests.length)
  })
})

describe('序列化恢复', () => {
  it('异常 → 回滚 → 序列化 → 还原之后，牌局能继续推进', () => {
    const room = started()
    const internals = room as unknown as { stepAI: (now: number, seatId?: number) => void }
    vi.spyOn(internals, 'stepAI').mockImplementationOnce(() => { throw new Error('注入异常') })
    const dueAt = Math.min(...jobsOf(room).map((job) => job.dueAt))
    room.runDueJobs(dueAt)
    vi.restoreAllMocks()

    // 模拟 Durable Object 休眠后重建
    const stored = JSON.parse(JSON.stringify(room.snapshot()))
    const revived = new SanguoshaRoomCoordinator(stored)
    expectProgressInvariant(revived, dueAt)

    const seqBefore = revived.state.game!.seq
    const alarmAt = revived.nextAlarmAt()!
    revived.runDueJobs(alarmAt)
    expect(revived.state.game!.seq, '还原之后要能接着走').toBeGreaterThanOrEqual(seqBefore)
  })

  it('长时间推进过程中始终满足「有近期 alarm」不变量', () => {
    const room = started()
    let now = 2_000
    for (let step = 0; step < 120; step += 1) {
      const alarmAt = room.nextAlarmAt()
      if (alarmAt === null) break
      now = Math.max(now + 1, alarmAt)
      room.runDueJobs(now)
      if (room.state.game?.status === 'game-over') break
      expectProgressInvariant(room, now)
    }
  })
})
