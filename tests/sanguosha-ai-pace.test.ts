import { describe, expect, it } from 'vitest'
import { SanguoshaRoomCoordinator, TEST_SGS_ROOM_TIMING, normalizeSettings, type SgsRoomUser } from '../server/sanguosha-room-core'
import { AI_PACE_MS, AI_TRIVIAL_STEP_MS, phaseDelay, playActionDelay } from '../src/sanguosha/shared/timing'

/**
 * AI 的节奏分两档。
 *
 * 玩家反馈「AI 太快，来不及反应」，但**响应牌那条路不能动**：无懈可击、桃、闪
 * 是被动接话，各自的询问窗口有规则约束，放慢只会让整桌人干等。
 * 真正看不清的是 AI 主动出牌那一下——谁对谁用了什么牌、触发了什么技能。
 *
 * 所以这里钉住的是「两条路必须是两个值」，而不是某个具体毫秒数。
 */

const HOST: SgsRoomUser = { userId: 'u-host', nickname: '房主' }

describe('AI 节奏', () => {
  it('主动出牌明显慢于响应牌', () => {
    for (const base of [AI_PACE_MS.fast, AI_PACE_MS.normal, AI_PACE_MS.relaxed]) {
      expect(playActionDelay(base), `${base}ms 档的出牌应当比响应慢`).toBeGreaterThan(base)
    }
    // 即使玩家选了最快的档，主动出牌也不会快到看不清
    expect(playActionDelay(AI_PACE_MS.fast)).toBeGreaterThanOrEqual(1_800)
  })

  it('响应牌和自动阶段的节奏没有被改动', () => {
    // 这两条是 codex 那轮调好的，本次不该受影响
    expect(AI_PACE_MS).toEqual({ fast: 450, normal: 700, relaxed: 1000 })
    expect(AI_TRIVIAL_STEP_MS).toBe(60)
    expect(phaseDelay(AI_PACE_MS.normal)).toBe(350)
  })

  it('关掉动画（0ms）时出牌也不额外等待', () => {
    expect(playActionDelay(0)).toBe(0)
  })

  it('有上限，不会因为节奏调慢就无限拉长', () => {
    expect(playActionDelay(10_000)).toBeLessThanOrEqual(4_800)
  })

  it('联机：AI 主动出牌排的等待比响应牌长', () => {
    const now = 1_000
    const room = SanguoshaRoomCoordinator.create('PACE01', HOST, normalizeSettings({ playerCount: 5 }), now)
    room.handle(HOST.userId, { type: 'toggle-ready' }, now)
    room.handle(HOST.userId, { type: 'start-game' }, now)

    // 推到牌局真正开始（选将阶段由 AI 自己选完）
    let cursor = now
    for (let guard = 0; guard < 60; guard += 1) {
      const due = room.nextAlarmAt()
      if (due === null) break
      cursor = Math.max(cursor, due)
      room.runDueJobs(cursor)
      if (room.state.game?.status === 'playing') break
    }
    expect(room.state.game?.status, '应当已经开局').toBe('playing')

    // 走到某个 AI 的出牌阶段且没有待处理请求：这就是「主动出牌」那一步
    for (let guard = 0; guard < 200; guard += 1) {
      const game = room.state.game!
      if (game.phase === 'play' && game.pendingRequests.length === 0) break
      const due = room.nextAlarmAt()
      if (due === null) break
      cursor = Math.max(cursor, due)
      room.runDueJobs(cursor)
    }
    const game = room.state.game!
    expect(game.phase, '停在出牌阶段').toBe('play')
    expect(game.pendingRequests, '出牌阶段不该有待处理请求').toHaveLength(0)

    /*
     * 要看的是**这一步的推进任务**，不能用 `nextAlarmAt()`：
     * 那是所有任务里最早的一个，健康自检（15 秒一次）经常比它还早，
     * 量到的就变成自检的剩余时间了。原来的写法只是碰巧没撞上。
     */
    const step = (room.state.jobs as Array<{ kind: string; dueAt: number; startedAt?: number }>)
      .find((job) => job.kind === 'ai-step')
    expect(step, 'AI 的出牌任务应当已经排上').toBeTruthy()
    const waiting = step!.dueAt - room.state.updatedAt
    expect(waiting, 'AI 出牌的等待应当用加长后的那一档').toBe(playActionDelay(AI_PACE_MS.normal))
    expect(waiting, '而且确实比响应牌那一档长').toBeGreaterThan(AI_PACE_MS.normal)
  })

  it('测试可显式注入 0ms 节奏，且真人请求仍然等待真人', () => {
    const now = 1_000
    const room = SanguoshaRoomCoordinator.create('FAST01', HOST, normalizeSettings({ playerCount: 5 }), now, TEST_SGS_ROOM_TIMING)
    room.handle(HOST.userId, { type: 'toggle-ready' }, now)
    room.handle(HOST.userId, { type: 'start-game' }, now)

    expect(room.nextAlarmAt()).toBe(now)
    room.runDueJobs(now)
    const request = room.view(HOST.userId).playerView?.pendingRequest
    expect(request?.playerId).toBe('seat-0')
    // 即便 AI delay=0，真人选将也没有被自动替他提交。
    expect(request?.kind).toBe('choose-general')
  })
})
