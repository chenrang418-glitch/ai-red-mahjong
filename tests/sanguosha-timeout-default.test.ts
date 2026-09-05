import { describe, expect, it } from 'vitest'
import { SanguoshaRoomCoordinator, normalizeSettings, type SgsRoomUser } from '../server/sanguosha-room-core'
import { timeoutDefaultResponse } from '@/sanguosha/engine/timeout-default'
import { NULLIFICATION_TIMEOUT_MS } from '@/sanguosha/engine/nullification'
import type { GameRequest } from '@/sanguosha/engine/requests'

const HOST: SgsRoomUser = { userId: 'u-host', nickname: '房主' }

function request(kind: GameRequest['kind'], extra: Record<string, unknown>): GameRequest {
  return { id: 'r1', kind, playerId: 'seat-0', prompt: '', timeoutMs: 30_000, optional: true, ...extra } as unknown as GameRequest
}

describe('超时默认放弃：纯函数', () => {
  it('能放弃的请求一律回放弃，不替玩家出牌', () => {
    expect(timeoutDefaultResponse(request('respond-card', { actionIds: ['respond-dodge:c1', 'respond-pass'], requiredCardName: '闪' })))
      .toMatchObject({ payload: { actionId: 'respond-pass' } })
    expect(timeoutDefaultResponse(request('use-card', { actionIds: ['use:c1', 'respond-pass'] })))
      .toMatchObject({ payload: { actionId: 'respond-pass' } })
    expect(timeoutDefaultResponse(request('invoke-skill', { skillId: 's', actionIds: ['invoke', 'respond-pass'] })))
      .toMatchObject({ payload: { actionId: 'respond-pass' } })
    expect(timeoutDefaultResponse(request('rescue', { dyingPlayerId: 'seat-1', requiredRecover: 1, actionIds: ['rescue-card:c1', 'rescue-pass'] })))
      .toMatchObject({ payload: { actionId: 'rescue-pass' } })
  })

  it('「本轮均不使用」是更强的承诺，超时不替玩家做', () => {
    const answer = timeoutDefaultResponse(request('respond-card', {
      actionIds: ['respond-nullification:c1', 'respond-pass', 'respond-pass-round'], requiredCardName: '无懈可击',
    }))
    expect(answer).toMatchObject({ payload: { actionId: 'respond-pass' } })
  })

  it('可选的选牌、选目标、分配一律交空', () => {
    expect(timeoutDefaultResponse(request('choose-cards', { cardIds: ['c1'], hiddenCardSlots: [], min: 0, max: 1 })))
      .toMatchObject({ payload: { cardIds: [] } })
    expect(timeoutDefaultResponse(request('choose-targets', { candidateIds: ['seat-1'], min: 0, max: 1 })))
      .toMatchObject({ payload: { targetIds: [] } })
    expect(timeoutDefaultResponse(request('distribute-cards', { cardIds: ['c1'], recipientIds: ['seat-1'], min: 0, max: 1 })))
      .toMatchObject({ payload: { assignments: [] } })
  })

  it('必答的请求返回 null，交给调用方兜底，不能把牌局卡死', () => {
    expect(timeoutDefaultResponse(request('choose-general', { candidates: ['a', 'b'], min: 1, max: 1 }))).toBeNull()
    expect(timeoutDefaultResponse(request('choose-cards', { cardIds: ['c1', 'c2'], hiddenCardSlots: [], min: 1, max: 1 }))).toBeNull()
    expect(timeoutDefaultResponse(request('arrange-cards', { cardIds: ['c1'], minTop: 1, maxTop: 1, allowBottom: false }))).toBeNull()
    expect(timeoutDefaultResponse(request('choose-option', { options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] }))).toBeNull()
    expect(timeoutDefaultResponse(request('choose-suit', { suits: ['heart'] }))).toBeNull()
    expect(timeoutDefaultResponse(request('choose-number', { min: 1, max: 3 }))).toBeNull()
    // 没有 respond-pass 可选时也不能硬编一个非法 actionId
    expect(timeoutDefaultResponse(request('respond-card', { actionIds: ['respond-dodge:c1'], requiredCardName: '闪' }))).toBeNull()
  })
})

describe('超时默认放弃：联机房间', () => {
  /** 把房间推进到「真人正处在自己的出牌阶段、且挂着 turn-timeout」的那一刻。 */
  function driveToHumanPlayTimeout(): SanguoshaRoomCoordinator {
    let at = 1_000
    const room = SanguoshaRoomCoordinator.create('ABC234', HOST, normalizeSettings({ playerCount: 5, turnSeconds: 30 }), at)
    room.handle(HOST.userId, { type: 'toggle-ready' }, at)
    room.handle(HOST.userId, { type: 'start-game' }, at)

    for (let guard = 0; guard < 4_000; guard += 1) {
      const mine = room.view(HOST.userId).playerView?.pendingRequest
      if (mine?.kind === 'choose-general') {
        room.handle(HOST.userId, { type: 'respond', requestId: mine.id, payload: { characterId: mine.candidates[0] } }, at)
        continue
      }
      const waiting = room.state.jobs.find((job) => job.kind === 'turn-timeout')
      const playing = room.state.game
      if (waiting && playing?.status === 'playing' && playing.phase === 'play'
        && playing.currentPlayerId === `seat-${waiting.seatId}` && playing.pendingRequests.length === 0) {
        return room
      }
      // 心跳：连续超时到阈值会自动转托管，这里要的是「人在、只是慢」，
      // 所以每轮发一次取消托管把计数清零（不会重置已经在跑的计时）
      room.handle(HOST.userId, { type: 'trustee', enabled: false }, at)
      const next = room.nextAlarmAt()
      if (next === null) throw new Error('房间没有任何推进任务')
      at = Math.max(at + 1, next)
      room.runDueJobs(at)
    }
    throw new Error('没能推进到真人的出牌阶段')
  }

  it('出牌阶段超时 = 放弃出牌，不替玩家花牌，也不再续一个新窗口', () => {
    const room = driveToHumanPlayTimeout()
    const job = room.state.jobs.find((entry) => entry.kind === 'turn-timeout')!
    const me = `seat-${job.seatId}`
    const before = room.state.game!.players.find((player) => player.id === me)!
    const handBefore = [...before.zones.hand]
    const equipBefore = JSON.stringify(before.zones.equipment)

    room.runDueJobs(job.dueAt)

    const after = room.state.game!.players.find((player) => player.id === me)!
    // 弃牌阶段可能要求弃牌（那是必答请求，另有兜底），所以只断言「出牌阶段结束了」
    expect(room.state.game!.phase, '超时后不该还停在出牌阶段').not.toBe('play')
    expect(after.zones.hand, '超时不该替玩家打出任何牌').toEqual(handBefore)
    expect(JSON.stringify(after.zones.equipment), '超时不该替玩家装备任何牌').toBe(equipBefore)
  })

  it('响应请求超时时保留手牌，不替玩家打出闪或桃', () => {
    let at = 1_000
    const room = SanguoshaRoomCoordinator.create('DEF345', HOST, normalizeSettings({ playerCount: 5, turnSeconds: 30 }), at)
    room.handle(HOST.userId, { type: 'toggle-ready' }, at)
    room.handle(HOST.userId, { type: 'start-game' }, at)

    let checked = 0
    for (let guard = 0; guard < 8_000 && checked < 3; guard += 1) {
      const mine = room.view(HOST.userId).playerView?.pendingRequest
      if (mine?.kind === 'choose-general') {
        room.handle(HOST.userId, { type: 'respond', requestId: mine.id, payload: { characterId: mine.candidates[0] } }, at)
        continue
      }
      const waiting = room.state.jobs.find((job) => job.kind === 'turn-timeout')
      const pending = waiting
        ? room.state.game?.pendingRequests.find((candidate) => candidate.playerId === `seat-${waiting.seatId}`)
        : undefined
      if (waiting && pending && timeoutDefaultResponse(pending)) {
        const me = `seat-${waiting.seatId}`
        const handBefore = [...room.state.game!.players.find((player) => player.id === me)!.zones.hand]
        room.runDueJobs(waiting.dueAt)
        at = Math.max(at, waiting.dueAt)
        const handAfter = room.state.game!.players.find((player) => player.id === me)!.zones.hand
        // 放弃只会让请求消失，不该少牌（多牌是可能的：放弃之后可能被技能补牌）
        for (const cardId of handBefore) {
          expect(handAfter, `超时放弃不该打出 ${cardId}`).toContain(cardId)
        }
        checked += 1
        continue
      }
      room.handle(HOST.userId, { type: 'trustee', enabled: false }, at)
      const next = room.nextAlarmAt()
      if (next === null) break
      at = Math.max(at + 1, next)
      room.runDueJobs(at)
    }
    expect(checked, '这局没能覆盖到任何一次可放弃的超时').toBeGreaterThan(0)
  })

  it('房间视图带上服务器时间，客户端才能校正倒计时', () => {
    const room = SanguoshaRoomCoordinator.create('GHI456', HOST, normalizeSettings({ playerCount: 5 }), 1_000)
    const view = room.view(HOST.userId)
    expect(view.serverNow).toBeGreaterThan(0)
    expect(Math.abs(view.serverNow - Date.now())).toBeLessThan(5_000)
  })

  it('无懈可击的抢答窗口是 4 秒', () => {
    expect(NULLIFICATION_TIMEOUT_MS).toBe(4_000)
  })
})
