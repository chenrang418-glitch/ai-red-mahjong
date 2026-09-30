import { describe, expect, it } from 'vitest'
import { SanguoshaGame } from '@/sanguosha/engine/game'
import { locateOwnedCard, moveCard } from '@/sanguosha/engine/zones'
import { registerSkillRuntime } from '@/sanguosha/engine/skills/runtime'
import { assertGameInvariants } from '@/sanguosha/engine/invariants'
import { resolveDamageSequence, resumeTargetDamagePrevention } from '@/sanguosha/engine/damage'

const AFTER_DAMAGE_AUDIT = 'audit-pending-damage-after-trigger'
const GLOBAL_DAMAGE_AUDIT = 'audit-global-pending-damage-owner'

registerSkillRuntime({
  id: AFTER_DAMAGE_AUDIT,
  triggers: [{
    event: 'DamageSettled',
    handle(host, ownerId, context) {
      if (context.event.targetId !== 'p1') return
      host.queueSkill({ skillId: AFTER_DAMAGE_AUDIT, ownerId, step: 'after-damage', data: {} })
    },
  }],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'after-damage') return
    host.askSkill({
      skillId: AFTER_DAMAGE_AUDIT,
      ownerId,
      step: 'after-damage',
      data: {},
      build: (id) => ({
        id, kind: 'choose-option', playerId: ownerId, prompt: '审计：伤害牌完成后的排队触发',
        timeoutMs: 20_000, optional: true, options: [{ id: 'ok', label: '继续' }],
      }),
    })
  },
  resume() {},
})

registerSkillRuntime({
  id: GLOBAL_DAMAGE_AUDIT,
  offersGlobalDamagePreventionAsk(host, ownerId, context) {
    if (ownerId !== 'p4' || context.targetId !== 'p1') return false
    host.queueSkill({ skillId: GLOBAL_DAMAGE_AUDIT, ownerId, step: 'global-prevent', data: {} })
    return true
  },
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'global-prevent') return
    host.askSkill({
      skillId: GLOBAL_DAMAGE_AUDIT, ownerId, step: 'global-prevent', data: {},
      build: (id) => ({
        id, kind: 'choose-option', playerId: ownerId, prompt: '审计：全局伤害防止 owner',
        timeoutMs: 20_000, optional: true, options: [{ id: 'no', label: '不发动' }],
      }),
    })
  },
  resume(host) {
    resumeTargetDamagePrevention(host as never, false)
  },
})

function createGame(luotongIds: string[] = ['p1']) {
  const game = new SanguoshaGame({
    seed: 'audit-pending-damage-' + luotongIds.join('-'),
    setup: {
      mode: 'identity', generalChoices: 1,
      players: Array.from({ length: 5 }, (_, index) => ({
        id: 'p' + index, nickname: '玩家' + index, isHuman: true,
      })),
    },
  })
  game.state.players.forEach((player) => {
    player.characterId = luotongIds.includes(player.id) ? 'luotong' : 'zhangfei'
  })
  game.start()
  game.state.phase = 'play'
  game.state.currentPlayerId = 'p0'
  game.state.normalTurnPlayerId = 'p0'
  return game
}

function useNanman(game: SanguoshaGame) {
  const cardId = Object.keys(game.state.cards).find((id) => game.state.cards[id]?.name === '南蛮入侵')!
  const holder = game.state.players.find((player) => player.zones.hand.includes(cardId))
  moveCard(game.state, cardId,
    game.state.zones.drawPile.includes(cardId) ? { kind: 'drawPile' } : locateOwnedCard(game.state, holder!.id, cardId)!,
    { kind: 'hand', playerId: 'p0' })
  const action = game.legalActions('p0').find((candidate) =>
    candidate.kind === 'use-card' && candidate.cardIds.includes(cardId) && candidate.targetIds[0] === 'p1')
  expect(action).toBeDefined()
  game.act('p0', action!.id)
  return cardId
}

function passResponsesUntilOption(game: SanguoshaGame) {
  let guard = 0
  while (game.state.pendingRequests[0]?.kind === 'respond-card') {
    if (guard++ > 20) throw new Error('没有到达伤害防止窗口')
    const request = game.state.pendingRequests[0]!
    game.respond({ requestId: request.id, playerId: request.playerId, payload: { actionId: 'respond-pass' } })
  }
  return game.state.pendingRequests[0]!
}

function finishNanman(game: SanguoshaGame) {
  let guard = 0
  while (game.state.pendingRequests.length > 0) {
    if (guard++ > 30) throw new Error('南蛮目标结算未收敛')
    const request = game.state.pendingRequests[0]!
    if (request.kind === 'respond-card') {
      game.respond({ requestId: request.id, playerId: request.playerId, payload: { actionId: 'respond-pass' } })
    } else if (request.kind === 'choose-option' && request.options.some((option) => option.id === 'no')) {
      game.respond({ requestId: request.id, playerId: request.playerId, payload: { optionId: 'no' } })
    } else if (request.kind === 'choose-option' && request.options.some((option) => option.id === 'ok')) {
      game.respond({ requestId: request.id, playerId: request.playerId, payload: { optionId: 'ok' } })
    } else {
      throw new Error('出现未预期的后续请求：' + request.kind)
    }
  }
}

function settleInternal(game: SanguoshaGame) {
  // This audit deliberately exercises the scheduler boundary without adding a public test hook.
  ;(game as unknown as { settle(): void }).settle()
}

describe('审计：挂起伤害交互与牌解析续接', () => {
  for (const choice of ['yes', 'no'] as const) {
    it('南蛮目标进谏' + choice + '在序列化恢复后只结算一次并继续牌目标', () => {
      let game = createGame()
      const cardId = useNanman(game)
      const request = passResponsesUntilOption(game)
      expect(request.kind).toBe('choose-option')
      expect(game.state.cardResolution?.kind).toBe('trick')
      expect(game.state.pendingTargetDamage?.skillId).toBe('jinjian')

      game = SanguoshaGame.restore(JSON.parse(JSON.stringify(game.serialize())))
      const restoredRequest = game.state.pendingRequests[0]!
      const targetHp = game.state.players[1]!.hp
      game.respond({ requestId: restoredRequest.id, playerId: restoredRequest.playerId, payload: { optionId: choice } })

      expect(game.state.players[1]!.hp).toBe(targetHp - (choice === 'yes' ? 0 : 1))
      expect(game.state.pendingTargetDamage).toBeUndefined()
      expect(game.state.cardResolution?.kind).toBe('trick')
      if (game.state.cardResolution?.kind === 'trick') expect(game.state.cardResolution.targetIndex).toBe(1)
      finishNanman(game)
      expect(game.state.zones.discardPile).toContain(cardId)
      assertGameInvariants(game.state)
    })
  }

  it('多名南蛮目标各自完成一次进谏与一次实际伤害', () => {
    const game = createGame(['p1', 'p2'])
    const cardId = useNanman(game)
    const settled: string[] = []
    game.events.on('DamageSettled', (context) => {
      if (context.event.sourceId === 'p0') settled.push(String(context.event.targetId))
    })
    for (const targetId of ['p1', 'p2']) {
      const request = passResponsesUntilOption(game)
      if (request.playerId !== targetId || request.kind !== 'choose-option')
        throw new Error(targetId + ' 未收到该目标的进谏请求')
      expect(game.state.cardResolution?.kind).toBe('trick')
      if (game.state.cardResolution?.kind === 'trick')
        expect(game.state.cardResolution.targetIds[game.state.cardResolution.targetIndex]).toBe(targetId)
      game.respond({ requestId: request.id, playerId: targetId, payload: { optionId: 'no' } })
      if (targetId === 'p1') {
        const next = game.state.pendingRequests[0]!
        expect(next.kind).toBe('respond-card')
        game.respond({ requestId: next.id, playerId: next.playerId, payload: { actionId: 'respond-pass' } })
      }
      expect(game.state.players.find((player) => player.id === targetId)!.hp).toBe(3)
    }
    finishNanman(game)
    expect(settled).toEqual(['p1', 'p2', 'p3', 'p4'])
    expect(game.state.zones.discardPile).toContain(cardId)
    assertGameInvariants(game.state)
  })

  it('元素传导在目标进谏拒绝后每名连环角色各受伤一次', () => {
    const game = createGame()
    game.state.players[1]!.chained = true
    game.state.players[2]!.chained = true
    const settled: string[] = []
    game.events.on('DamageSettled', (context) => {
      if (context.event.sourceId === 'p0') settled.push(String(context.event.targetId))
    })
    game.damage({ sourceId: 'p0', targetId: 'p1', amount: 1, nature: 'fire' })
    settleInternal(game)
    const request = game.state.pendingRequests[0]!
    expect(request.kind).toBe('choose-option')
    game.respond({ requestId: request.id, playerId: request.playerId, payload: { optionId: 'no' } })
    expect(game.state.players[1]!.hp).toBe(3)
    expect(game.state.players[2]!.hp).toBe(3)
    expect(settled).toEqual(['p1', 'p2'])
    expect(game.state.players[1]!.chained).toBe(false)
    expect(game.state.players[2]!.chained).toBe(false)
    assertGameInvariants(game.state)
  })

  it('伤害后的排队触发等待多目标牌完全结束', () => {
    const game = createGame([])
    game.state.players[4]!.grantedSkills.push(AFTER_DAMAGE_AUDIT)
    useNanman(game)
    game.dispatch('DamageSettled', { finalAmount: 1 }, { sourceId: 'p0', targetId: 'p1' })
    expect(game.state.skillQueue.some((prompt) => prompt.skillId === AFTER_DAMAGE_AUDIT)).toBe(true)
    game.state.pendingRequests = []
    game.state.skillResolution = undefined
    game.state.pendingTargetDamage = undefined
    settleInternal(game)
    expect(game.state.cardResolution?.kind).toBe('trick')
    expect(game.state.skillResolution?.skillId).not.toBe(AFTER_DAMAGE_AUDIT)
    expect(game.state.pendingRequests).toHaveLength(0)
    game.state.cardResolution = null
    settleInternal(game)
    expect(game.state.skillResolution?.skillId).toBe(AFTER_DAMAGE_AUDIT)
    expect(game.state.pendingRequests[0]?.playerId).toBe('p4')
    game.respond({ requestId: game.state.pendingRequests[0]!.id, playerId: 'p4', payload: { optionId: 'ok' } })
    assertGameInvariants(game.state)
  })

  it('同一技能多名拥有者时仅启动与挂起目标匹配的owner', () => {
    const game = createGame(['p1', 'p2'])
    useNanman(game)
    const active = passResponsesUntilOption(game)
    expect(active.kind).toBe('choose-option')

    game.state.pendingRequests = []
    game.state.skillResolution = undefined
    game.state.skillQueue = [
      { skillId: 'jinjian', ownerId: 'p2', step: 'in-ask', data: {} },
      { skillId: 'jinjian', ownerId: 'p1', step: 'in-ask', data: {} },
    ]
    settleInternal(game)
    expect(game.state.skillResolution?.skillId).toBe('jinjian')
    expect(game.state.skillResolution?.ownerId).toBe('p1')
    expect(game.state.pendingRequests[0]?.playerId).toBe('p1')
  })

  it('同时挂起来源侧与目标侧的同技能询问时先匹配来源owner与step', () => {
    const game = createGame(['p0', 'p1'])
    const state = game.state as typeof game.state & Record<string, any>
    state.pendingSourceDamage = { skillId: 'jinjian', options: { sourceId: 'p0', targetId: 'p1', amount: 1 } }
    state.pendingTargetDamage = { skillId: 'jinjian', options: { sourceId: 'p0', targetId: 'p1', amount: 1 } }
    state.skillQueue = [
      { skillId: 'jinjian', ownerId: 'p1', step: 'in-ask', data: {} },
      { skillId: 'jinjian', ownerId: 'p0', step: 'out-ask', data: {} },
    ]
    settleInternal(game)
    expect(game.state.skillResolution?.skillId).toBe('jinjian')
    expect(game.state.skillResolution?.ownerId).toBe('p0')
    expect(game.state.skillResolution?.step).toBe('out-ask')
    expect(game.state.pendingRequests[0]?.playerId).toBe('p0')
  })

  it('伤害排队的全局owner死亡后跳过问询并继续目标伤害', () => {
    const game = createGame([])
    game.state.players[4]!.grantedSkills.push(GLOBAL_DAMAGE_AUDIT)
    const cardId = useNanman(game)
    const first = passResponsesUntilOption(game)
    expect(first.kind).toBe('choose-option')
    expect(first.playerId).toBe('p4')
    game.state.pendingRequests = []
    game.state.skillResolution = undefined
    game.state.skillQueue = [{ skillId: GLOBAL_DAMAGE_AUDIT, ownerId: 'p4', step: 'global-prevent', data: {} }]
    game.state.players[4]!.alive = false
    settleInternal(game)
    expect(game.state.pendingTargetDamage).toBeUndefined()
    expect(game.state.players[1]!.hp).toBe(3)
    expect(game.state.skillQueue).toHaveLength(0)
    finishNanman(game)
    expect(game.state.zones.discardPile).toContain(cardId)
    assertGameInvariants(game.state)
  })

  it('全局owner与目标不同的挂起状态可在旧格式缺owner字段的活动请求中恢复', () => {
    const game = createGame([])
    game.state.players[4]!.grantedSkills.push(GLOBAL_DAMAGE_AUDIT)
    game.damage({ sourceId: 'p0', targetId: 'p1', amount: 1 })
    settleInternal(game)
    expect(game.state.pendingTargetDamage?.ownerId).toBe('p4')
    expect(game.state.skillResolution?.ownerId).toBe('p4')
    const stored = JSON.parse(JSON.stringify(game.serialize()))
    delete stored.pendingTargetDamage.ownerId
    const restored = SanguoshaGame.restore(stored)
    const request = restored.state.pendingRequests[0]!
    expect(request.playerId).toBe('p4')
    restored.respond({ requestId: request.id, playerId: 'p4', payload: { optionId: 'no' } })
    expect(restored.state.pendingTargetDamage).toBeUndefined()
    expect(restored.state.players[1]!.hp).toBe(3)
    assertGameInvariants(restored.state)
  })

  it('DamageSequence在交互回答后继续剩余目标且不重复前一目标', () => {
    const game = createGame()
    const settled: string[] = []
    game.events.on('DamageSettled', (context) => {
      if (context.event.sourceId === 'p0') settled.push(String(context.event.targetId))
    })
    resolveDamageSequence(game as never, {
      sourceId: 'p0', targetIds: ['p1', 'p2', 'p3'], amount: 1,
      nature: 'normal', cardId: null, cardName: 'audit-sequence',
    })
    settleInternal(game)
    const request = game.state.pendingRequests[0]!
    expect(request.kind).toBe('choose-option')
    expect(request.playerId).toBe('p1')
    game.respond({ requestId: request.id, playerId: 'p1', payload: { optionId: 'no' } })
    expect(settled).toEqual(['p1', 'p2', 'p3'])
    expect(game.state.damageSequence).toBeNull()
    expect(game.state.players.slice(1, 4).map((player) => player.hp)).toEqual([3, 3, 3])
    assertGameInvariants(game.state)
  })

  it('同owner同skillId但不同step时只启动挂起记录指定的step', () => {
    const game = createGame()
    useNanman(game)
    const active = passResponsesUntilOption(game)
    expect(active.kind).toBe('choose-option')

    game.state.pendingRequests = []
    game.state.skillResolution = undefined
    game.state.skillQueue = [
      { skillId: 'jinjian', ownerId: 'p1', step: 'out-ask', data: {} },
      { skillId: 'jinjian', ownerId: 'p1', step: 'in-ask', data: {} },
    ]
    settleInternal(game)
    expect(game.state.skillResolution?.skillId).toBe('jinjian')
    expect(game.state.skillResolution?.ownerId).toBe('p1')
    expect(game.state.skillResolution?.step).toBe('in-ask')
  })

  it('旧全局挂起记录若停在队列边界且缺owner元数据会被卡住', () => {
    const game = createGame([])
    game.state.players[4]!.grantedSkills.push(GLOBAL_DAMAGE_AUDIT)
    const state = game.state as typeof game.state & Record<string, any>
    state.pendingTargetDamage = {
      skillId: GLOBAL_DAMAGE_AUDIT,
      step: 'global-prevent',
      options: { sourceId: 'p0', targetId: 'p1', amount: 1, cardId: null, cardName: null },
    }
    state.skillQueue = [{
      skillId: GLOBAL_DAMAGE_AUDIT, ownerId: 'p4', step: 'global-prevent', data: {},
    }]
    settleInternal(game)
    expect(game.state.skillResolution?.ownerId).toBe('p4')
    expect(game.state.pendingRequests[0]?.playerId).toBe('p4')
  })
})
