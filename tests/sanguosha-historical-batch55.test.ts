import { describe, expect, it } from 'vitest'
import { ALL_CHARACTERS } from '@/sanguosha/data/characters/standard'
import { SanguoshaGame } from '@/sanguosha/engine/game'
import { getSkillRuntime } from '@/sanguosha/engine/skills/runtime'
import type { RescueRequest, RespondCardRequest } from '@/sanguosha/engine/requests'
import { moveCard } from '@/sanguosha/engine/zones'
import type { CardId } from '@/sanguosha/engine/types'

const batch = ALL_CHARACTERS.filter(({ id }) => id.endsWith('-b55'))
const byName = (name: string) => batch.find((entry) => entry.name === name)!
const daoId = byName('势·于吉').skills.find(({ name }) => name === '道转')!.id
const yanceId = byName('友·诸葛亮').skills.find(({ name }) => name === '演策')!.id

function deal(game: SanguoshaGame, playerId: string, name: string): CardId {
  const cardId = game.state.zones.drawPile[0]!
  moveCard(game.state, cardId, { kind: 'drawPile' }, { kind: 'hand', playerId })
  game.state.cards[cardId]!.name = name
  game.state.cards[cardId]!.category = name === '杀' || name === '闪' || name === '桃' || name === '酒' ? 'basic' : 'trick'
  return cardId
}

function fixture() {
  const game = new SanguoshaGame({ seed: 'historical-batch55-targeted', setup: {
    mode: 'identity', generalChoices: 1,
    players: Array.from({ length: 5 }, (_, index) => ({ id: `b55p${index}`, nickname: `玩家${index}`, isHuman: index === 0 })),
  } })
  const owner = game.state.players[0]!
  const attacker = game.state.players[1]!
  owner.characterId = byName('势·于吉').id
  game.state.status = 'playing'
  game.state.phase = 'play'
  game.state.turnNumber = 1
  game.state.roundNumber = 1
  game.state.currentPlayerId = attacker.id
  const slashId = deal(game, attacker.id, '杀')
  moveCard(game.state, slashId, { kind: 'hand', playerId: attacker.id }, { kind: 'processingArea' })
  game.state.cardResolution = {
    kind: 'slash', cardId: slashId, sourceId: attacker.id, targetId: owner.id, damageNature: 'normal', damageAmount: 1,
    stage: 'awaiting-dodge', interceptsDone: [], extraCardIds: [], remainingTargetIds: [], requestId: 'b55-dodge', dodgeRemaining: 1,
    resolvedTargetIds: [],
  }
  const request: RespondCardRequest = {
    id: 'b55-dodge', kind: 'respond-card', playerId: owner.id, prompt: '求闪', timeoutMs: 30_000, optional: true,
    requiredCardName: '闪', actionIds: [`virtual-basic:${daoId}:闪`, 'respond-pass'],
  }
  game.state.pendingRequests.push(request)
  return { game, owner, attacker, request }
}

describe('第55批武将：批次定向验证', () => {
  it('按武将册982—991顺序注册十名角色，且每项技能均有运行时', () => {
    expect(batch.map(({ name }) => name)).toEqual([
      '星·董卓', '势·董昭', '王经', '友·诸葛亮', '友·庞统',
      '友·徐庶', '谋·郭淮', '娄圭', '势·于吉', '张布',
    ])
    for (const character of batch) for (const skill of character.skills) {
      expect(getSkillRuntime(skill.id), `${character.name}【${skill.name}】`).toBeDefined()
    }
  })

  it('友·诸葛亮【方遒】展示后增强全中结算，并按条件返还限定技', () => {
    const game = new SanguoshaGame({ seed: 'b55-fangqiu', setup: {
      mode: 'identity', generalChoices: 1,
      players: Array.from({ length: 5 }, (_, index) => ({ id: `fangqiu-${index}`, nickname: `玩家${index}`, isHuman: index === 0 })),
    } })
    const owner = game.state.players[0]!
    owner.characterId = byName('友·诸葛亮').id
    game.state.status = 'playing'
    ;(game.state as any).b55YanceForecast = { [owner.id]: {
      round: 1, count: 4, mode: 'category', value: 'basic', verified: 0, correct: 0, draws: 0, revealed: false,
    } }
    const fangqiuId = byName('友·诸葛亮').skills.find(({ name }) => name === '方遒')!.id
    const runtime = getSkillRuntime(yanceId)!
    const fangqiu = getSkillRuntime(fangqiuId)!
    fangqiu.startQueued?.(game, owner.id, { skillId: fangqiuId, ownerId: owner.id, step: 'show-forecast', data: {} } as any)
    fangqiu.resume?.(game, owner.id, { step: 'show-forecast', data: {} } as any, { payload: { optionId: 'show' } } as any)
    expect(owner.usedLimitedSkills).toContain(byName('友·诸葛亮').skills.find(({ name }) => name === '方遒')!.id)
    expect((game.state as any).b55YanceForecast[owner.id].revealed).toBe(true)

    const cardUsed = runtime.triggers!.find(({ event }) => event === 'CardUsed')!
    for (let index = 0; index < 4; index += 1) cardUsed.handle(game, owner.id, {
      event: { payload: { cardName: '杀' } },
    } as any)
    expect(game.state.skillQueue).toContainEqual(expect.objectContaining({ skillId: fangqiuId, step: 'resolve-enhanced' }))
    fangqiu.startQueued?.(game, owner.id, { skillId: fangqiuId, ownerId: owner.id, step: 'resolve-enhanced', data: {} } as any)
    expect((game.state as any).b55YanceForecast[owner.id]).toBeUndefined()
    expect((game.state as any).b55YanceCount[owner.id]).toBe(6)
    expect(owner.usedLimitedSkills).not.toContain(byName('友·诸葛亮').skills.find(({ name }) => name === '方遒')!.id)
  })

  it('道转响应闪时可秘密选择当前回合角色手牌支付，弃牌后完成原杀响应并令本轮失效', () => {
    const { game, owner, attacker, request } = fixture()
    const expectedCost = deal(game, attacker.id, '闪')
    game.respond({ requestId: request.id, playerId: owner.id, payload: { actionId: `virtual-basic:${daoId}:闪` } })
    const costRequest = game.state.pendingRequests.find((item) => item.kind === 'choose-cards')!
    expect(costRequest.kind).toBe('choose-cards')
    if (costRequest.kind !== 'choose-cards') throw new Error('缺少道转弃牌请求')
    const hiddenSlot = costRequest.hiddenCardSlots[0]!
    game.respond({ requestId: costRequest.id, playerId: owner.id, payload: { cardIds: [hiddenSlot] } })

    expect(game.state.zones.discardPile).toContain(expectedCost)
    expect(game.state.cardResolution).toBeNull()
    expect((game.state as typeof game.state & { b55Daozhuan?: Record<string, { disabledRound?: number }> }).b55Daozhuan?.[owner.id]?.disabledRound)
      .toBe(game.state.roundNumber)
    expect(getSkillRuntime(daoId)?.virtualBasicResponse?.(game.state, owner.id, '闪')).toBe(false)
  })

  it('道转响应时弃置于吉自己的牌只消耗本回合次数，不会错误封禁本轮', () => {
    const { game, owner, request } = fixture()
    const ownCost = deal(game, owner.id, '闪')
    game.respond({ requestId: request.id, playerId: owner.id, payload: { actionId: `virtual-basic:${daoId}:闪` } })
    const costRequest = game.state.pendingRequests.find((item) => item.kind === 'choose-cards')!
    if (costRequest.kind !== 'choose-cards') throw new Error('缺少道转弃牌请求')
    game.respond({ requestId: costRequest.id, playerId: owner.id, payload: { cardIds: [ownCost] } })

    expect(game.state.zones.discardPile).toContain(ownCost)
    expect((game.state as typeof game.state & { b55Daozhuan?: Record<string, { disabledRound?: number }> })
      .b55Daozhuan?.[owner.id]?.disabledRound).toBeUndefined()
  })

  it('道转主动使用按普通牌的合法目标和使用次数结算，弃置自身牌并保留整轮牌名限制', () => {
    const { game, owner } = fixture()
    deal(game, owner.id, '闪')
    game.state.cardResolution = null
    game.state.pendingRequests = []
    game.state.currentPlayerId = owner.id
    const runtime = getSkillRuntime(daoId)!
    const actions = runtime.activeActions?.(game.state, owner.id) ?? []
    const slashAction = actions.find(({ label }) => label.includes('【杀】'))
    expect(slashAction).toBeDefined()
    runtime.invokeActive?.(game, owner.id, slashAction!.id)
    const costRequest = game.state.pendingRequests.find((item) => item.kind === 'choose-cards')!
    if (costRequest.kind !== 'choose-cards') throw new Error('缺少道转弃牌请求')
    const costId = costRequest.cardIds[0]!
    game.respond({ requestId: costRequest.id, playerId: owner.id, payload: { cardIds: [costId] } })

    expect(game.state.zones.discardPile).toContain(costId)
    expect(game.state.turnUsage.slashUses).toBe(1)
    expect(runtime.activeActions?.(game.state, owner.id)).toEqual([])
  })

  it('道转在出牌阶段按通常合法性提供【桃】和【酒】，并完整执行桃的回复', () => {
    const { game, owner } = fixture()
    game.state.cardResolution = null
    game.state.pendingRequests = []
    game.state.currentPlayerId = owner.id
    owner.hp = owner.maxHp - 1
    const costId = deal(game, owner.id, '闪')
    const runtime = getSkillRuntime(daoId)!
    const peach = runtime.activeActions?.(game.state, owner.id).find(({ label }) => label.includes('回复体力'))
    const wine = runtime.activeActions?.(game.state, owner.id).find(({ label }) => label.includes('强化下一张杀'))
    expect(peach).toBeDefined()
    expect(wine).toBeDefined()

    runtime.invokeActive?.(game, owner.id, peach!.id)
    const request = game.state.pendingRequests.find((item) => item.kind === 'choose-cards')!
    if (request.kind !== 'choose-cards') throw new Error('缺少道转主动弃牌请求')
    game.respond({ requestId: request.id, playerId: owner.id, payload: { cardIds: [costId] } })

    expect(owner.hp).toBe(owner.maxHp)
    expect(game.state.zones.discardPile).toContain(costId)
  })

  it('道转主动使用【酒】经过普通使用流程并强化下一张【杀】', () => {
    const { game, owner } = fixture()
    game.state.cardResolution = null
    game.state.pendingRequests = []
    game.state.currentPlayerId = owner.id
    const costId = deal(game, owner.id, '闪')
    const runtime = getSkillRuntime(daoId)!
    const wine = runtime.activeActions?.(game.state, owner.id).find(({ label }) => label.includes('强化下一张杀'))
    expect(wine).toBeDefined()

    runtime.invokeActive?.(game, owner.id, wine!.id)
    const request = game.state.pendingRequests.find((item) => item.kind === 'choose-cards')!
    if (request.kind !== 'choose-cards') throw new Error('缺少道转主动弃牌请求')
    game.respond({ requestId: request.id, playerId: owner.id, payload: { cardIds: [costId] } })

    expect(game.state.turnUsage.wineDamageBonus).toBe(1)
    expect(game.state.zones.discardPile).toContain(costId)
  })

  it('道转可在濒死求桃时秘密选择当前回合角色的牌支付，并续接濒死救援', () => {
    const { game, owner, attacker } = fixture()
    game.state.cardResolution = null
    game.state.pendingRequests = []
    const expectedCost = deal(game, attacker.id, '闪')
    owner.hp = 0
    game.state.dying = {
      playerId: owner.id, sourceId: attacker.id, damageNature: 'normal',
      responderOrder: [attacker.id, owner.id], responderIndex: 1, requestId: 'b55-rescue',
    }
    const request: RescueRequest = {
      id: 'b55-rescue', kind: 'rescue', playerId: owner.id, prompt: '濒死求桃', timeoutMs: 30_000,
      optional: true, dyingPlayerId: owner.id, requiredRecover: 1, actionIds: [`rescue:${daoId}:桃`, 'rescue-pass'],
    }
    game.state.pendingRequests.push(request)
    game.respond({ requestId: request.id, playerId: owner.id, payload: { actionId: `rescue:${daoId}:桃` } })
    const costRequest = game.state.pendingRequests.find((item) => item.kind === 'choose-cards')!
    if (costRequest.kind !== 'choose-cards') throw new Error('缺少道转救援弃牌请求')
    game.respond({ requestId: costRequest.id, playerId: owner.id, payload: { cardIds: [costRequest.hiddenCardSlots[0]!] } })

    expect(game.state.zones.discardPile).toContain(expectedCost)
    expect(owner.hp).toBe(1)
    expect(game.state.dying).toBeNull()
  })

  it('道转允许濒死的于吉以酒自救，并按虚拟酒的响应时机结算', () => {
    const { game, owner, attacker } = fixture()
    game.state.cardResolution = null
    game.state.pendingRequests = []
    const cost = deal(game, attacker.id, '闪')
    owner.hp = 0
    game.state.dying = {
      playerId: owner.id, sourceId: attacker.id, damageNature: 'normal',
      responderOrder: [attacker.id, owner.id], responderIndex: 1, requestId: 'b55-wine-rescue',
    }
    const request: RescueRequest = {
      id: 'b55-wine-rescue', kind: 'rescue', playerId: owner.id, prompt: '濒死自救', timeoutMs: 30_000,
      optional: true, dyingPlayerId: owner.id, requiredRecover: 1,
      actionIds: [`rescue:${daoId}:酒`, 'rescue-pass'],
    }
    game.state.pendingRequests.push(request)
    game.respond({ requestId: request.id, playerId: owner.id, payload: { actionId: `rescue:${daoId}:酒` } })
    const costRequest = game.state.pendingRequests.find((item) => item.kind === 'choose-cards')!
    if (costRequest.kind !== 'choose-cards') throw new Error('缺少道转酒自救弃牌请求')
    game.respond({ requestId: costRequest.id, playerId: owner.id, payload: { cardIds: [costRequest.hiddenCardSlots[0]!] } })

    expect(game.state.zones.discardPile).toContain(cost)
    expect(owner.hp).toBe(1)
    expect(game.state.dying).toBeNull()
    expect((game.state as typeof game.state & { b55Daozhuan?: Record<string, { usedNames: string[] }> })
      .b55Daozhuan?.[owner.id]?.usedNames).toContain('酒')
  })

  it('道转以虚拟杀响应决斗时先支付当前回合角色手牌，再续接决斗的下一名响应者', () => {
    const { game, owner, attacker } = fixture()
    game.state.cardResolution = null
    game.state.pendingRequests = []
    const expectedCost = deal(game, attacker.id, '闪')
    const duelCard = deal(game, attacker.id, '决斗')
    game.state.cards[duelCard]!.category = 'trick'
    game.state.cards[duelCard]!.name = '决斗'
    moveCard(game.state, duelCard, { kind: 'hand', playerId: attacker.id }, { kind: 'processingArea' })
    game.state.cardResolution = {
      kind: 'trick', cardId: duelCard, cardName: '决斗', sourceId: attacker.id,
      targetIds: [owner.id], targetIndex: 0, nullifiedTargetIds: [], stage: 'awaiting-effect',
      interceptsDone: [], cancelledTargetIds: [], unresponsiveTargetIds: [], responderOrder: [owner.id], responderIndex: 0,
      nullificationCount: 0, declinedAllIds: [], lastNullifierId: null, requestId: 'b55-duel',
      effect: { kind: 'duel', responderId: owner.id, otherId: attacker.id, requestId: 'b55-duel', slashRemaining: 1 },
    }
    const request: RespondCardRequest = {
      id: 'b55-duel', kind: 'respond-card', playerId: owner.id, prompt: '决斗求杀', timeoutMs: 30_000,
      optional: true, requiredCardName: '杀', actionIds: [`virtual-basic:${daoId}:杀`, 'respond-pass'],
    }
    game.state.pendingRequests.push(request)
    game.respond({ requestId: request.id, playerId: owner.id, payload: { actionId: `virtual-basic:${daoId}:杀` } })
    const costRequest = game.state.pendingRequests.find((item) => item.kind === 'choose-cards')!
    if (costRequest.kind !== 'choose-cards') throw new Error('缺少道转决斗响应弃牌请求')
    game.respond({ requestId: costRequest.id, playerId: owner.id, payload: { cardIds: [costRequest.hiddenCardSlots[0]!] } })

    expect(game.state.zones.discardPile).toContain(expectedCost)
    expect(game.state.cardResolution?.kind).toBe('trick')
    if (game.state.cardResolution?.kind === 'trick')
      expect(game.state.cardResolution.effect).toMatchObject({ kind: 'duel', responderId: attacker.id })
  })
})
