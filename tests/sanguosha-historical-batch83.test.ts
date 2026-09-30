import { describe, expect, it, vi } from 'vitest'
import { SanguoshaGame } from '@/sanguosha/engine/game'
import { moveCard } from '@/sanguosha/engine/zones'
import { skillDiscardCardUseActions } from '@/sanguosha/engine/cards/basic'
import '@/sanguosha/data/characters/historical-batch83'
import { getSkillRuntime } from '@/sanguosha/engine/skills/runtime'
import { markUsedThisPhase, usedThisPhase } from '@/sanguosha/engine/phase-usage'
import { resolveGroupDecisionResponse } from '@/sanguosha/engine/group-decision'

describe('弃牌堆实体牌的技能使用公共入口', () => {
  it('生成普通合法目标动作并保留实体牌，不复制或吞掉材料', () => {
    const game = new SanguoshaGame({ seed: 'b83-discard-use', setup: { mode: 'identity', generalChoices: 1,
      players: Array.from({ length: 6 }, (_, index) => ({ id: `b83-${index}`, nickname: `玩家${index}`, isHuman: true })) } })
    game.state.status = 'playing'
    game.state.pendingRequests = []
    const actor = game.state.players[0]!
    game.state.currentPlayerId = actor.id
    const cardId = game.state.zones.drawPile.find((id) => game.state.cards[id]?.name === '无中生有')
    expect(cardId).toBeDefined()
    moveCard(game.state, cardId!, { kind: 'drawPile' }, { kind: 'discardPile' })

    const actions = skillDiscardCardUseActions(game.state, actor.id, cardId!, 'test-discard-skill')
    const use = actions.find((action) => action.targetIds.length === 1 && action.targetIds[0] === actor.id)
    expect(use).toBeDefined()
    expect(game.state.zones.discardPile.filter((id) => id === cardId)).toHaveLength(1)
    expect(actor.zones.hand).not.toContain(cardId)

    expect(game.beginSkillCardUseFromDiscard(actor.id, cardId!, 'test-discard-skill', use!.id)).toBe(true)
    expect(game.state.cards[cardId!]).toBeDefined()
    expect(game.state.zones.discardPile.filter((id) => id === cardId)).toHaveLength(1)
    expect(actor.zones.hand).not.toContain(cardId)
  })
})

describe('伍孚【绝忾】', () => {
  it('仅禁止本出牌阶段获得过牌的角色主动使用手牌，并重置【忠锷】阶段次数', () => {
    const game = new SanguoshaGame({ seed: 'b83-juekai', setup: { mode: 'identity', generalChoices: 1,
      players: Array.from({ length: 6 }, (_, index) => ({ id: `juekai-${index}`, nickname: `玩家${index}`, isHuman: true })) } })
    game.state.status = 'playing'
    game.state.pendingRequests = []
    const [owner, recipient, other] = game.state.players
    expect(owner && recipient && other).toBeTruthy()
    game.state.currentPlayerId = owner!.id
    game.state.phase = 'play'
    const runtime = getSkillRuntime('juekai-wufu-b83')!
    const trigger = (name: string, payload: Record<string, unknown>) => runtime.triggers!
      .find((candidate) => candidate.event === name)!.handle(game as never, owner!.id, { event: { name, payload } } as never)

    trigger('PhaseStart', { playerId: owner!.id, phase: 'play' })
    trigger('GainCard', { playerId: recipient!.id, cardIds: [] })
    markUsedThisPhase(game.state, owner!.id, 'zhonge-wufu-b83')
    const actionId = runtime.activeActions!(game.state, owner!.id)[0]?.id
    expect(actionId).toBe('juekai-wufu-b83:activate')
    runtime.invokeActive!(game as never, owner!.id, actionId!)
    expect(usedThisPhase(game.state, owner!.id, 'zhonge-wufu-b83')).toBe(false)
    expect((game.state as never as { b83?: { juekaiPhases?: Record<string, { active: boolean; gainedPlayerIds: string[] }> } })
      .b83?.juekaiPhases?.[owner!.id]).toEqual({ gainedPlayerIds: [recipient!.id], active: true })

    const recipientHandCard = game.state.zones.drawPile[0]!
    const otherHandCard = game.state.zones.drawPile[1]!
    moveCard(game.state, recipientHandCard, { kind: 'drawPile' }, { kind: 'hand', playerId: recipient!.id })
    moveCard(game.state, otherHandCard, { kind: 'drawPile' }, { kind: 'hand', playerId: other!.id })
    expect(runtime.globallyProhibitsCardUse!(game.state, owner!.id, recipient!.id, recipientHandCard)).toBe(true)
    expect(runtime.globallyProhibitsCardUse!(game.state, owner!.id, other!.id, other!.zones.hand[0]!)).toBe(false)
    trigger('PhaseEnd', { playerId: owner!.id, phase: 'play' })
    expect(runtime.globallyProhibitsCardUse!(game.state, owner!.id, recipient!.id, recipientHandCard)).toBe(false)
  })
})

describe('伍孚【忠锷】秘密选择', () => {
  it('双方请求同时挂起，收齐选择后按分歧生成两项操作并加倍伍孚执行次数', () => {
    const game = new SanguoshaGame({ seed: 'b83-zhonge', setup: { mode: 'identity', generalChoices: 1,
      players: Array.from({ length: 6 }, (_, index) => ({ id: `zhonge-${index}`, nickname: `玩家${index}`, isHuman: true })) } })
    game.state.status = 'playing'
    game.state.pendingRequests = []
    const [owner, target] = game.state.players
    expect(owner && target).toBeTruthy()
    game.state.currentPlayerId = owner!.id
    game.state.phase = 'play'
    const runtime = getSkillRuntime('zhonge-wufu-b83')!
    runtime.invokeActive!(game as never, owner!.id, 'zhonge-wufu-b83:activate')
    expect(game.state.pendingRequests[0]?.kind).toBe('choose-targets')

    runtime.resume!(game as never, owner!.id, { step: 'target', data: {} } as never,
      { playerId: owner!.id, payload: { targetIds: [target!.id] } } as never)
    const decision = game.state.groupDecision!
    expect(decision.playerIds).toEqual([owner!.id, target!.id])
    expect(decision.requestIds[owner!.id]).toBeDefined()
    expect(decision.requestIds[target!.id]).toBeDefined()
    expect(Object.keys(decision.responses)).toHaveLength(0)

    resolveGroupDecisionResponse(game as never, decision.requestIds[owner!.id]!,
      { requestId: decision.requestIds[owner!.id]!, playerId: owner!.id, payload: { optionId: 'draw' } } as never)
    expect(game.state.groupDecision?.responses[owner!.id]).toBe('draw')
    expect(game.state.groupDecision?.responses[target!.id]).toBeUndefined()
    resolveGroupDecisionResponse(game as never, decision.requestIds[target!.id]!,
      { requestId: decision.requestIds[target!.id]!, playerId: target!.id, payload: { optionId: 'slash' } } as never)

    const queued = game.state.skillQueue.find((entry) => entry.skillId === 'zhonge-wufu-b83')
    expect(queued?.data).toMatchObject({ operations: ['draw', 'slash'], ownerRepeatCount: 2 })
  })

  it('选项二使用标准虚拟【杀】结算入口并等待响应', () => {
    const game = new SanguoshaGame({ seed: 'b83-zhonge-slash', setup: { mode: 'identity', generalChoices: 1,
      players: Array.from({ length: 6 }, (_, index) => ({ id: `zhonge-slash-${index}`, nickname: `玩家${index}`, isHuman: true })) } })
    game.state.status = 'playing'
    game.state.pendingRequests = []
    const [owner, target] = game.state.players
    expect(owner && target).toBeTruthy()
    game.state.currentPlayerId = owner!.id
    game.state.phase = 'play'
    const runtime = getSkillRuntime('zhonge-wufu-b83')!
    runtime.startQueued!(game as never, owner!.id, { step: 'resolve', data: {
      targetId: target!.id, operations: ['slash'], operationIndex: 0, actorIndex: 0, actorRepeatIndex: 0, ownerRepeatCount: 2,
    } } as never)
    expect((game.state as never as { b83?: { wufuFlow?: { pendingSlash?: string } } }).b83?.wufuFlow?.pendingSlash).toBe(owner!.id)
    expect(game.state.pendingRequests.some((request) => request.kind === 'respond-card' && request.playerId === target!.id)).toBe(true)

    const afterSlash = runtime.triggers!.find((trigger) => trigger.event === 'AfterCardUse')!
    afterSlash.handle(game as never, owner!.id, { event: { sourceId: owner!.id, sourceSkillId: 'zhonge-wufu-b83' } } as never)
    const repeatedOwnerSlash = game.state.skillQueue.find((entry) => entry.skillId === 'zhonge-wufu-b83')!
    expect(repeatedOwnerSlash.data).toMatchObject({ actorIndex: 0, actorRepeatIndex: 1, operationIndex: 0 })
  })
})

describe('吴质【伪涕】', () => {
  it('满体力目标仍可执行回复项，并拒绝点数重复的弃牌后允许合法弃牌', () => {
    const game = new SanguoshaGame({ seed: 'b83-weiti-discard', setup: { mode: 'identity', generalChoices: 1,
      players: Array.from({ length: 6 }, (_, index) => ({ id: `weiti-${index}`, nickname: `玩家${index}`, isHuman: true })) } })
    game.state.status = 'playing'
    game.state.pendingRequests = []
    const [owner, target] = game.state.players
    expect(owner && target).toBeTruthy()
    game.state.currentPlayerId = owner!.id
    game.state.phase = 'play'
    const runtime = getSkillRuntime('weiti-wuzhi-b83')!
    runtime.invokeActive!(game as never, owner!.id, 'weiti-wuzhi-b83:activate')
    game.state.skillResolution = null
    game.state.pendingRequests = []
    runtime.resume!(game as never, owner!.id, { step: 'mode', data: {} } as never,
      { requestId: 'mode', playerId: owner!.id, payload: { optionId: 'recover-discard' } } as never)
    game.state.skillResolution = null
    game.state.pendingRequests = []

    const rankGroups = new Map<number, string[]>()
    for (const cardId of game.state.zones.drawPile) {
      const rank = game.state.cards[cardId]?.rank
      if (rank !== undefined) rankGroups.set(rank, [...(rankGroups.get(rank) ?? []), cardId])
    }
    const duplicateGroup = [...rankGroups.values()].find((ids) => ids.length >= 2)!
    const distinctGroups = [...rankGroups.values()].filter((ids) => ids.length >= 1 && ids[0] !== duplicateGroup[0])
    const otherCard = distinctGroups[0]![0]!
    const pairCard = distinctGroups[1]![0]!
    moveCard(game.state, duplicateGroup[0]!, { kind: 'drawPile' }, { kind: 'hand', playerId: target!.id })
    moveCard(game.state, duplicateGroup[1]!, { kind: 'drawPile' }, { kind: 'hand', playerId: target!.id })
    moveCard(game.state, otherCard, { kind: 'drawPile' }, { kind: 'hand', playerId: target!.id })
    moveCard(game.state, pairCard, { kind: 'drawPile' }, { kind: 'hand', playerId: target!.id })
    target!.hp = target!.maxHp
    const hpBefore = target!.hp
    runtime.resume!(game as never, owner!.id, { step: 'target', data: { mode: 'recover-discard' } } as never,
      { requestId: 'target', playerId: owner!.id, payload: { targetIds: [target!.id] } } as never)
    expect(target!.hp).toBe(hpBefore)
    const discardRequest = game.state.pendingRequests.find((request) => request.kind === 'choose-cards')!
    expect(discardRequest.playerId).toBe(target!.id)
    const invalidResolution = { step: 'discard-distinct', data: { targetId: target!.id } } as never
    runtime.resume!(game as never, owner!.id, invalidResolution,
      { requestId: discardRequest.id, playerId: target!.id, payload: { cardIds: [duplicateGroup[0], duplicateGroup[1]] } } as never)
    expect(target!.zones.hand).toContain(duplicateGroup[0])
    runtime.resume!(game as never, owner!.id, invalidResolution,
      { requestId: discardRequest.id, playerId: target!.id, payload: { cardIds: [otherCard, pairCard] } } as never)
    expect(target!.zones.hand).not.toContain(otherCard)
    expect(target!.zones.hand).not.toContain(pairCard)
  })

  it('只从牌堆取得与原手牌及本次已摸牌点数均不同的牌', () => {
    const game = new SanguoshaGame({ seed: 'b83-weiti-draw', setup: { mode: 'identity', generalChoices: 1,
      players: Array.from({ length: 6 }, (_, index) => ({ id: `weiti-draw-${index}`, nickname: `玩家${index}`, isHuman: true })) } })
    game.state.status = 'playing'
    game.state.pendingRequests = []
    const target = game.state.players[1]!
    const runtime = getSkillRuntime('weiti-wuzhi-b83')!
    const groups = new Map<number, string[]>()
    for (const cardId of game.state.zones.drawPile) {
      const rank = game.state.cards[cardId]?.rank
      if (rank !== undefined) groups.set(rank, [...(groups.get(rank) ?? []), cardId])
    }
    const duplicateRanks = [...groups.values()].find((ids) => ids.length >= 2)!
    const ranks = [...groups.entries()].filter(([rank]) => rank !== game.state.cards[duplicateRanks[0]]?.rank && rank !== game.state.cards[duplicateRanks[1]]?.rank && rank > 0)
    const ownCard = duplicateRanks[0]!
    const firstValid = ranks[0]![1][0]!
    const firstDuplicate = ranks[0]![1][1]!
    const secondValid = ranks[1]![1][0]!
    moveCard(game.state, ownCard, { kind: 'drawPile' }, { kind: 'hand', playerId: target.id })
    const preferredOrder = [duplicateRanks[1]!, firstValid, firstDuplicate, secondValid]
    game.state.zones.drawPile = [...preferredOrder, ...game.state.zones.drawPile.filter((cardId) => !preferredOrder.includes(cardId))]
    runtime.startQueued!(game as never, game.state.players[0]!.id, { step: 'draw-different-ranks', data: { targetId: target.id } } as never)
    const drawn = target.zones.hand.filter((cardId) => cardId !== ownCard)
    expect(drawn).toContain(firstValid)
    expect(drawn).toContain(secondValid)
    expect(drawn).not.toContain(duplicateRanks[1])
    expect(drawn).not.toContain(firstDuplicate)
    const ranksInHand = target.zones.hand.map((cardId) => game.state.cards[cardId]?.rank)
    expect(ranksInHand.filter((rank) => rank === game.state.cards[ownCard]?.rank)).toHaveLength(1)
    expect(ranksInHand.filter((rank) => rank === game.state.cards[firstValid]?.rank)).toHaveLength(1)
    expect(ranksInHand.filter((rank) => rank === game.state.cards[secondValid]?.rank)).toHaveLength(1)
  })
})

describe('董絮【清冷】', () => {
  it('只响应黑色非转化牌，弃置非装备牌后把当前实体牌登记到酖毒候选', () => {
    const game = new SanguoshaGame({ seed: 'b83-qingleng', setup: { mode: 'identity', generalChoices: 1,
      players: Array.from({ length: 6 }, (_, index) => ({ id: `qingleng-${index}`, nickname: `玩家${index}`, isHuman: true })) } })
    game.state.status = 'playing'
    game.state.pendingRequests = []
    const [owner, source, discardTarget] = game.state.players
    expect(owner && source && discardTarget).toBeTruthy()
    const runtime = getSkillRuntime('qingleng-dongxu-b83')!
    const incoming = game.state.zones.drawPile.find((id) => game.state.cards[id]?.name === '杀'
      && ['spade', 'club'].includes(game.state.cards[id]?.suit ?? ''))!
    const discarded = game.state.zones.drawPile.find((id) => id !== incoming)!
    moveCard(game.state, incoming, { kind: 'drawPile' }, { kind: 'discardPile' })
    moveCard(game.state, discarded, { kind: 'drawPile' }, { kind: 'hand', playerId: discardTarget!.id })
    const resume = vi.fn()
    ;(game as never as { resumeCardTarget: () => void }).resumeCardTarget = resume

    expect(runtime.interceptTarget!(game as never, owner!.id, { sourceId: source!.id, targetId: owner!.id,
      cardId: incoming, cardName: '杀', category: 'basic' })).toBe(true)
    const flow = { sourceId: source!.id, cardId: incoming, cardName: '杀' }
    game.state.skillResolution = null
    game.state.pendingRequests = []
    runtime.resume!(game as never, owner!.id, { step: 'offer', data: flow } as never,
      { playerId: owner!.id, payload: { optionId: 'yes' } } as never)
    game.state.skillResolution = null
    game.state.pendingRequests = []
    runtime.resume!(game as never, owner!.id, { step: 'discard-target', data: flow } as never,
      { playerId: owner!.id, payload: { targetIds: [discardTarget!.id] } } as never)
    game.state.skillResolution = null
    game.state.pendingRequests = []
    runtime.resume!(game as never, owner!.id, { step: 'discard-card', data: { ...flow, discardTargetId: discardTarget!.id } } as never,
      { playerId: owner!.id, payload: { cardIds: [discarded] } } as never)
    game.state.skillResolution = null
    game.state.pendingRequests = []
    runtime.resume!(game as never, owner!.id, { step: 'add-poison', data: flow } as never,
      { playerId: owner!.id, payload: { optionId: 'yes' } } as never)

    expect(discardTarget!.zones.hand).not.toContain(discarded)
    expect((game.state as never as { b83?: { dongxuPoisonCards?: Record<string, string[]> } })
      .b83?.dongxuPoisonCards?.[owner!.id]).toEqual([incoming])
    expect(resume).toHaveBeenCalledTimes(1)
  })

  it('【酖毒】在出牌阶段结束时保存展示牌，并于下回合开始生成无距离限制的合法使用请求', () => {
    const game = new SanguoshaGame({ seed: 'b83-zhendu', setup: { mode: 'identity', generalChoices: 1,
      players: Array.from({ length: 6 }, (_, index) => ({ id: `zhendu-${index}`, nickname: `玩家${index}`, isHuman: true })) } })
    game.state.status = 'playing'
    game.state.pendingRequests = []
    game.state.skillResolution = null
    const owner = game.state.players[0]!
    game.state.currentPlayerId = owner.id
    game.state.phase = 'play'
    const cardId = game.state.zones.drawPile.find((id) => game.state.cards[id]?.name === '无中生有')!
    const discardCardId = game.state.zones.drawPile.find((id) => game.state.cards[id]?.name === '杀'
      && ['spade', 'club'].includes(game.state.cards[id]?.suit ?? ''))!
    moveCard(game.state, cardId, { kind: 'drawPile' }, { kind: 'hand', playerId: owner.id })
    moveCard(game.state, discardCardId, { kind: 'drawPile' }, { kind: 'discardPile' })
    ;(game.state as never as { b83?: { dongxuPoisonCards?: Record<string, string[]> } }).b83 = {
      dongxuPoisonCards: { [owner.id]: [discardCardId] },
    }
    const runtime = getSkillRuntime('zhendu-dongxu-b83')!
    const phaseEnd = runtime.triggers!.find((trigger) => trigger.event === 'PhaseEnd')!
    phaseEnd.handle(game as never, owner.id, { event: { name: 'PhaseEnd', payload: { playerId: owner.id, phase: 'play' } } } as never)
    game.state.skillResolution = null
    game.state.pendingRequests = []
    runtime.resume!(game as never, owner.id, { step: 'show', data: { extraCardIds: [discardCardId] } } as never,
      { playerId: owner.id, payload: { cardIds: [discardCardId] } } as never)
    expect((game.state as never as { b83?: { dongxuPoisonQueue?: Record<string, string[]> } }).b83?.dongxuPoisonQueue?.[owner.id])
      .toEqual([discardCardId])

    const turnStart = runtime.triggers!.find((trigger) => trigger.event === 'TurnStart')!
    turnStart.handle(game as never, owner.id, { event: { name: 'TurnStart', payload: { playerId: owner.id } } } as never)
    runtime.startQueued!(game as never, owner.id, { step: 'next', data: { cardIds: [discardCardId], index: 0 } } as never)
    const request = game.state.pendingRequests.find((entry) => entry.kind === 'choose-option')
    expect(request?.kind).toBe('choose-option')
    expect(request?.options.length).toBeGreaterThan(0)
  })
})

describe('吉邈吉穆【诹议】【掩袭】', () => {
  it('诹议按两个选项结算后的相同手牌人数增加次数并回复', () => {
    const game = new SanguoshaGame({ seed: 'b83-zouyi', setup: { mode: 'identity', generalChoices: 1,
      players: Array.from({ length: 6 }, (_, index) => ({ id: `zouyi-${index}`, nickname: `玩家${index}`, isHuman: true })) } })
    game.state.status = 'playing'
    game.state.pendingRequests = []
    game.state.skillResolution = null
    const owner = game.state.players[0]!
    owner.hp = 2
    game.state.currentPlayerId = owner.id
    game.state.phase = 'play'
    const runtime = getSkillRuntime('zouyi-jimiaojimu-b83')!
    runtime.invokeActive!(game as never, owner.id, 'zouyi-jimiaojimu-b83:activate')
    game.state.skillResolution = null
    game.state.pendingRequests = []
    runtime.resume!(game as never, owner.id, { step: 'options', data: {} } as never,
      { playerId: owner.id, payload: { optionIds: ['discard'] } } as never)
    expect(owner.zones.hand).toHaveLength(2)
    const expectedCharges = game.state.players.filter((candidate) => candidate.alive
      && candidate.zones.hand.length === owner.zones.hand.length).length
    game.state.skillResolution = null
    game.state.pendingRequests = []
    runtime.resume!(game as never, owner.id, { step: 'discard-target', data: { selected: ['discard'], index: 0 } } as never,
      { playerId: owner.id, payload: { targetIds: [] } } as never)
    expect((game.state as never as { b83?: { jimiaoYanxiUses?: Record<string, number> } }).b83?.jimiaoYanxiUses?.[owner.id])
      .toBe(expectedCharges)
    expect(owner.hp).toBe(Math.min(owner.maxHp, 2 + expectedCharges))
  })

  it('掩袭使用剩余次数连续对原回合角色出杀，并只将此技能之杀的伤害改为失去体力', () => {
    const game = new SanguoshaGame({ seed: 'b83-yanxi', setup: { mode: 'identity', generalChoices: 1,
      players: Array.from({ length: 6 }, (_, index) => ({ id: `yanxi-${index}`, nickname: `玩家${index}`, isHuman: true })) } })
    game.state.status = 'playing'
    game.state.pendingRequests = []
    game.state.skillResolution = null
    const [owner, target] = game.state.players
    expect(owner && target).toBeTruthy()
    const state = game.state as never as { b83?: { jimiaoYanxiUses?: Record<string, number> } }
    state.b83 = { jimiaoYanxiUses: { [owner!.id]: 2 } }
    const runtime = getSkillRuntime('yanxi-jimiaojimu-b83')!
    runtime.triggers!.find((trigger) => trigger.event === 'TurnEnd')!.handle(game as never, owner!.id,
      { event: { name: 'TurnEnd', payload: { playerId: target!.id } } } as never)
    game.state.skillResolution = null
    game.state.pendingRequests = []
    runtime.resume!(game as never, owner!.id, { step: 'activate', data: { targetId: target!.id } } as never,
      { playerId: owner!.id, payload: { optionId: 'yes' } } as never)
    const firstSlash = game.state.cardResolution
    expect(firstSlash?.kind).toBe('slash')
    if (firstSlash?.kind !== 'slash') return
    expect(game.state.cards[firstSlash.cardId]?.sourceSkillId).toBe('yanxi-jimiaojimu-b83')
    expect(runtime.replacesDamageWithHpLoss!(game.state, owner!.id, {
      targetId: target!.id, amount: 1, nature: 'normal', cardName: '杀',
    })).toBe(true)
    runtime.triggers!.find((trigger) => trigger.event === 'AfterCardUse')!.handle(game as never, owner!.id,
      { event: { name: 'AfterCardUse', sourceId: owner!.id, sourceSkillId: 'yanxi-jimiaojimu-b83' } } as never)
    expect(game.state.skillQueue.some((entry) => entry.skillId === 'yanxi-jimiaojimu-b83' && entry.step === 'repeat')).toBe(true)

    game.state.cardResolution = null
    game.state.skillResolution = null
    game.state.pendingRequests = []
    runtime.startQueued!(game as never, owner!.id, { step: 'repeat', data: { targetId: target!.id } } as never)
    expect((game.state as never as { b83?: { jimiaoYanxiUses?: Record<string, number> } }).b83?.jimiaoYanxiUses?.[owner!.id])
      .toBe(0)
    expect(game.state.cardResolution?.kind).toBe('slash')
  })
})

describe('威曹丕【典论】', () => {
  it('只接受等差点数序列；所摸实体牌本回合豁免肃纲限制、距离和使用次数', () => {
    const game = new SanguoshaGame({ seed: 'b83-dianlun', setup: { mode: 'identity', generalChoices: 1,
      players: Array.from({ length: 6 }, (_, index) => ({ id: `dianlun-${index}`, nickname: `玩家${index}`, isHuman: true })) } })
    game.state.status = 'playing'
    game.state.pendingRequests = []
    game.state.skillResolution = null
    const [owner, actor] = game.state.players
    expect(owner && actor).toBeTruthy()
    game.state.currentPlayerId = owner!.id
    game.state.phase = 'play'
    const runtime = getSkillRuntime('dianlun-weicaopi-b83')!
    const materials = game.state.zones.drawPile.slice(0, 3)
    materials.forEach((cardId, index) => {
      game.state.cards[cardId]!.rank = [2, 5, 8][index]!
      moveCard(game.state, cardId, { kind: 'drawPile' }, { kind: 'hand', playerId: owner!.id })
    })
    runtime.invokeActive!(game as never, owner!.id, 'dianlun-weicaopi-b83:activate')
    game.state.skillResolution = null
    game.state.pendingRequests = []
    runtime.resume!(game as never, owner!.id, { step: 'select', data: {} } as never,
      { playerId: owner!.id, payload: { cardIds: materials } } as never)
    expect(owner!.zones.hand).toHaveLength(3)
    expect(materials.every((cardId) => game.state.zones.discardPile.includes(cardId))).toBe(true)
    const state = game.state as never as { b83?: { dianlunFreeCards?: Record<string, string[]>; sugangPointLimits?: Record<string, { turnNumber: number; low: number; high: number }> } }
    const freeCards = state.b83?.dianlunFreeCards?.[owner!.id] ?? []
    expect(freeCards).toHaveLength(3)
    game.state.cards[freeCards[0]!]!.rank = 13
    game.state.cards[freeCards[1]!]!.rank = 1
    expect(runtime.unlimitedCardUses!(game.state, owner!.id, freeCards[0]!)).toBe(true)
    expect(runtime.ignoresDistanceTo!(game.state, owner!.id, actor!.id, freeCards[0]!)).toBe(true)

    const restrictedCard = game.state.zones.drawPile[0]!
    game.state.cards[restrictedCard]!.rank = 13
    moveCard(game.state, restrictedCard, { kind: 'drawPile' }, { kind: 'hand', playerId: actor!.id })
    state.b83!.sugangPointLimits = { [owner!.id]: { turnNumber: game.state.turnNumber, low: 4, high: 9 } }
    expect(runtime.globallyProhibitsCardUse!(game.state, owner!.id, actor!.id, restrictedCard)).toBe(true)
    expect(runtime.globallyProhibitsCardUse!(game.state, owner!.id, owner!.id, freeCards[0]!)).toBe(false)
  })

  it('拒绝非等差点数选择且保留手牌和本阶段发动机会', () => {
    const game = new SanguoshaGame({ seed: 'b83-dianlun-invalid', setup: { mode: 'identity', generalChoices: 1,
      players: Array.from({ length: 6 }, (_, index) => ({ id: `dianlun-invalid-${index}`, nickname: `玩家${index}`, isHuman: true })) } })
    game.state.status = 'playing'
    game.state.pendingRequests = []
    game.state.skillResolution = null
    const owner = game.state.players[0]!
    game.state.currentPlayerId = owner.id
    game.state.phase = 'play'
    const runtime = getSkillRuntime('dianlun-weicaopi-b83')!
    const materials = game.state.zones.drawPile.slice(0, 3)
    materials.forEach((cardId, index) => {
      game.state.cards[cardId]!.rank = [1, 3, 8][index]!
      moveCard(game.state, cardId, { kind: 'drawPile' }, { kind: 'hand', playerId: owner.id })
    })
    runtime.invokeActive!(game as never, owner.id, 'dianlun-weicaopi-b83:activate')
    game.state.skillResolution = null
    game.state.pendingRequests = []
    runtime.resume!(game as never, owner.id, { step: 'select', data: {} } as never,
      { playerId: owner.id, payload: { cardIds: materials } } as never)
    expect(materials.every((cardId) => owner.zones.hand.includes(cardId))).toBe(true)
    expect(usedThisPhase(game.state, owner.id, 'dianlun-weicaopi-b83')).toBe(false)
  })
})

describe('威曹丕【肃纲】', () => {
  it('以最终判定点数建立全角色手牌限制，并使本回合的【行殇】可认领死亡牌', () => {
    const game = new SanguoshaGame({ seed: 'b83-sugang', setup: { mode: 'identity', generalChoices: 1,
      players: Array.from({ length: 6 }, (_, index) => ({ id: `sugang-${index}`, nickname: `玩家${index}`, isHuman: true })) } })
    game.state.status = 'playing'; game.state.pendingRequests = []; game.state.skillResolution = null
    const [owner, actor] = game.state.players
    expect(owner && actor).toBeTruthy()
    const judged = game.state.zones.drawPile[0]!, shown = game.state.zones.drawPile[1]!, restricted = game.state.zones.drawPile[2]!
    game.state.cards[judged]!.rank = 5; game.state.cards[shown]!.rank = 8; game.state.cards[restricted]!.rank = 13
    moveCard(game.state, judged, { kind: 'drawPile' }, { kind: 'hand', playerId: owner!.id })
    moveCard(game.state, shown, { kind: 'drawPile' }, { kind: 'hand', playerId: owner!.id })
    moveCard(game.state, restricted, { kind: 'drawPile' }, { kind: 'hand', playerId: actor!.id })
    const extended = game.state as never as { b83?: Record<string, any> }
    extended.b83 = { sugangJudgmentRank: { [owner!.id]: 5 } }
    game.state.currentPlayerId = owner!.id; game.state.phase = 'play'
    const runtime = getSkillRuntime('sugang-weicaopi-b83')!
    runtime.resume!(game as never, owner!.id, { step: 'choose-effects', data: { judgedId: judged } } as never,
      { playerId: owner!.id, payload: { optionIds: ['point-limit', 'xingshang'] } } as never)
    runtime.resume!(game as never, owner!.id, { step: 'show-card', data: {} } as never,
      { playerId: owner!.id, payload: { cardIds: [shown] } } as never)
    expect(runtime.globallyProhibitsCardUse!(game.state, owner!.id, actor!.id, restricted)).toBe(true)
    expect(runtime.claimsDeathCards!(game.state, owner!.id, actor!.id)).toBe(true)
    extended.b83!.dianlunFreeCards = { [actor!.id]: [restricted] }
    expect(runtime.globallyProhibitsCardUse!(game.state, owner!.id, actor!.id, restricted)).toBe(false)
  })
})

describe('徐妏【赋绘】', () => {
  it('用两张实体手牌生成真实合法牌动作，并在首次花色组合结算后摸牌', () => {
    const game = new SanguoshaGame({ seed: 'b83-fuhui', setup: { mode: 'identity', generalChoices: 1,
      players: Array.from({ length: 6 }, (_, index) => ({ id: `fuhui-${index}`, nickname: `玩家${index}`, isHuman: true })) } })
    game.state.status = 'playing'; game.state.pendingRequests = []; game.state.skillResolution = null
    const owner = game.state.players[0]!
    owner.hp = Math.max(1, owner.maxHp - 1); game.state.currentPlayerId = owner.id; game.state.phase = 'play'
    const cardIds = game.state.zones.drawPile.slice(0, 2)
    game.state.cards[cardIds[0]!]!.suit = 'spade'; game.state.cards[cardIds[1]!]!.suit = 'heart'
    cardIds.forEach((cardId) => moveCard(game.state, cardId, { kind: 'drawPile' }, { kind: 'hand', playerId: owner.id }))
    const runtime = getSkillRuntime('fuhui-xuwen-b83')!
    runtime.invokeActive!(game as never, owner.id, 'fuhui-xuwen-b83:activate')
    game.state.skillResolution = null; game.state.pendingRequests = []
    runtime.resume!(game as never, owner.id, { step: 'materials', data: {} } as never,
      { playerId: owner.id, payload: { cardIds } } as never)
    const resolution = game.state.skillResolution!
    const request = game.state.pendingRequests.at(-1) as { options: Array<{ id: string; label: string }> }
    const peachIndex = request.options.findIndex((option) => option.label.includes('【桃】'))
    expect(peachIndex).toBeGreaterThanOrEqual(0)
    const before = owner.zones.hand.length
    game.state.skillResolution = null; game.state.pendingRequests = []
    runtime.resume!(game as never, owner.id, resolution as never,
      { playerId: owner.id, payload: { optionId: `use:${peachIndex}` } } as never)
    runtime.triggers!.find((trigger) => trigger.event === 'CardResolved')!.handle(game as never, owner.id,
      { event: { name: 'CardResolved', sourceId: owner.id, payload: { cardId: cardIds[0] } } } as never)
    const drawPrompt = game.state.skillQueue.find((prompt) => prompt.skillId === 'fuhui-xuwen-b83')!
    expect(drawPrompt?.step).toBe('optional-draw')
    runtime.startQueued!(game as never, owner.id, drawPrompt)
    const drawResolution = game.state.skillResolution!
    expect(drawResolution?.step).toBe('optional-draw')
    game.state.skillResolution = null; game.state.pendingRequests = []
    runtime.resume!(game as never, owner.id, drawResolution as never,
      { playerId: owner.id, payload: { optionId: 'yes' } } as never)
    expect(cardIds.every((cardId) => game.state.zones.discardPile.includes(cardId))).toBe(true)
    expect(owner.zones.hand.length).toBe(before - 2 + 1)
    const state = game.state as never as { b83?: { fuhuiUses?: Record<string, { names: string[]; suitPairs: string[] }> } }
    expect(state.b83?.fuhuiUses?.[owner.id]?.names).toContain('桃')
    expect(state.b83?.fuhuiUses?.[owner.id]?.suitPairs).toHaveLength(1)
  })
})

describe('威·孙策【猘锋】', () => {
  it('按手牌与体力关系切换酒、杀和多目标决斗，并开放不计次数限制的酒', () => {
    const game = new SanguoshaGame({ seed: 'b83-zhefeng', setup: { mode: 'identity', generalChoices: 1,
      players: Array.from({ length: 6 }, (_, index) => ({ id: `zhefeng-${index}`, nickname: `玩家${index}`, isHuman: true })) } })
    game.state.status = 'playing'; game.state.pendingRequests = []; game.state.skillResolution = null
    const owner = game.state.players[0]!, runtime = getSkillRuntime('zhefeng-weisunce-b83')!
    const cards = game.state.zones.drawPile.slice(0, 4)
    cards.forEach((cardId) => { game.state.cards[cardId]!.suit = 'spade'; game.state.cards[cardId]!.color = 'black' })
    cards.slice(0, 2).forEach((cardId) => moveCard(game.state, cardId, { kind: 'drawPile' }, { kind: 'hand', playerId: owner.id }))
    owner.hp = 1
    game.state.currentPlayerId = owner.id; game.state.phase = 'play'
    expect(runtime.viewAs!(game.state, owner.id)).toHaveLength(0)
    expect(runtime.unlimitedWineFor!(game.state, owner.id, cards[0]!)).toBe(true)
    expect(runtime.activeActions!(game.state, owner.id).some((action) => action.id === 'zhefeng-weisunce-b83:wine')).toBe(true)
    game.state.turnUsage.wineUses = 1
    runtime.invokeActive!(game as never, owner.id, 'zhefeng-weisunce-b83:wine')
    game.state.skillResolution = null; game.state.pendingRequests = []
    runtime.resume!(game as never, owner.id, { step: 'wine-materials', data: {} } as never,
      { playerId: owner.id, payload: { cardIds: cards.slice(0, 2) } } as never)
    expect(cards.slice(0, 2).every((cardId) => game.state.zones.discardPile.includes(cardId))).toBe(true)
    expect(game.state.turnUsage.wineUses).toBe(1)
    cards.slice(2).forEach((cardId) => { game.state.cards[cardId]!.suit = 'heart'; game.state.cards[cardId]!.color = 'red';
      moveCard(game.state, cardId, { kind: 'drawPile' }, { kind: 'hand', playerId: owner.id }) })
    cards.forEach((cardId) => { game.state.cards[cardId]!.suit = 'heart'; game.state.cards[cardId]!.color = 'red' })
    owner.hp = owner.maxHp
    expect(runtime.viewAs!(game.state, owner.id).every((option) => option.asCardName === '杀')).toBe(true)
    expect(runtime.slashIgnoresDistance!(game.state, owner.id, cards[2]!)).toBe(true)
    owner.hp = owner.zones.hand.length
    game.state.currentPlayerId = owner.id; game.state.phase = 'play'
    expect(runtime.activeActions!(game.state, owner.id).some((action) => action.id === 'zhefeng-weisunce-b83:duel')).toBe(true)
    expect(runtime.additionalTargetSetsForTrick!(game.state, owner.id, cards[2]!, '决斗').some((targets) => targets.length === 2)).toBe(true)
  })
})
