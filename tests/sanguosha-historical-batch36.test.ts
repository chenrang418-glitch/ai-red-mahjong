import { describe, expect, it } from 'vitest'
import { ALL_CHARACTERS, getCharacter, skillIdsOf } from '@/sanguosha/data/characters/standard'
import { HISTORICAL_BATCH36_CHARACTERS } from '@/sanguosha/data/characters/historical-batch36'
import { getSkillRuntime, ownedSkillIds } from '@/sanguosha/engine/skills/runtime'
import { SanguoshaGame } from '@/sanguosha/engine/game'
import { maxCardsOf } from '@/sanguosha/engine/phase'
import { moveCard } from '@/sanguosha/engine/zones'
import type { SkillHost } from '@/sanguosha/engine/skills/runtime'

function fixture() {
  const game = new SanguoshaGame({ seed: 'batch38-targeted', setup: {
    mode: 'identity', generalChoices: 1,
    players: Array.from({ length: 5 }, (_, index) => ({ id: `p${index}`, nickname: `玩家${index}`, isHuman: index === 0 })),
  } })
  const state = game.state as any
  state.status = 'playing'; state.phase = 'play'; state.currentPlayerId = 'p0'; state.normalTurnPlayerId = 'p0'; state.turnNumber = 1
  state.players.forEach((p: any, index: number) => { p.characterId = index === 0 ? 'jie-liubei-b38' : 'zhangfei'; p.hp = 3; p.maxHp = 4 })
  const requests: any[] = [], queue: any[] = []
  const host = {
    state, rng: game.rng, dispatch: game.dispatch.bind(game),
    askSkill(options: any) { requests.push({ ...options, request: options.build(`b38-${requests.length}`) }) },
    queueSkill(prompt: any) { queue.push(prompt) },
    beginVirtualSlash: game.beginVirtualSlash.bind(game), beginVirtualTrick: game.beginVirtualTrick.bind(game),
    resumeCardTarget: game.resumeCardTarget.bind(game), enterDying: game.enterDying.bind(game),
  } as any as SkillHost
  function moveFromDeck(playerId: string, name: string, suit = 'spade', count = 1) {
    const ids = state.zones.drawPile.slice(0, count)
    for (const [index, id] of ids.entries()) {
      const card = state.cards[id]; card.name = name; card.suit = suit; card.color = suit === 'heart' || suit === 'diamond' ? 'red' : 'black'
      card.category = ['杀', '闪', '桃', '酒'].includes(name) ? 'basic' : name.includes('马') ? 'equipment' : 'trick'
      moveCard(state, id, { kind: 'drawPile' }, { kind: 'hand', playerId })
      if (index > 0) card.rank = index + 1
    }
    return ids
  }
  return { game, state, host, requests, queue, moveFromDeck }
}

describe('武将册第38批注册与定向玩法', () => {
  it('完整登记496–505十将，所有自带技能均有运行时且无角色重复', () => {
    expect(HISTORICAL_BATCH36_CHARACTERS).toHaveLength(10)
    for (const character of HISTORICAL_BATCH36_CHARACTERS) {
      expect(getCharacter(character.id)).toBe(character)
      expect(skillIdsOf(character.id)).toEqual(character.skills.filter(skill => !skill.granted).map(skill => skill.id))
      for (const skill of character.skills.filter(skill => !skill.granted)) expect(getSkillRuntime(skill.id), `${character.name}:${skill.id}`).toBeDefined()
    }
    expect(new Set(ALL_CHARACTERS.map(character => character.id)).size).toBe(ALL_CHARACTERS.length)
  })

  it('界法正恩怨可逐点选择伤害来源交牌或失去体力，拒绝后继续剩余伤害点', () => {
    const { state, host, requests, queue, moveFromDeck } = fixture()
    state.players[0].characterId = 'jie-fazheng-b38'
    const [gift] = moveFromDeck('p1', '闪')
    const runtime = getSkillRuntime('enyuan-jie-b38')!
    runtime.triggers!.find(item => item.event === 'Damaged')!.handle(host, 'p0', { event: { targetId: 'p0', sourceId: 'p1', payload: { amount: 2 } } } as any)
    expect(queue).toHaveLength(1)
    runtime.startQueued!(host, 'p0', queue[0])
    runtime.resume!(host, 'p0', requests.at(-1) as any, { payload: { optionId: 'yes' } } as any)
    runtime.resume!(host, 'p0', requests.at(-1) as any, { payload: { optionId: 'give' } } as any)
    runtime.resume!(host, 'p0', requests.at(-1) as any, { payload: { cardIds: [gift] } } as any)
    expect(state.players[0].zones.hand).toContain(gift)
    expect(queue.at(-1)).toMatchObject({ step: 'yuan-offer', data: { remaining: 1 } })
  })

  it('界周泰不屈重复点数时弃置新牌，独特点数留创并设置手牌上限', () => {
    const { state, host } = fixture()
    state.players[0].characterId = 'jie-zhoutai-b38'
    const pileId = state.zones.drawPile[1], duplicateId = state.zones.drawPile[0]
    state.cards[pileId].rank = 7; state.cards[duplicateId].rank = 7
    moveCard(state, pileId, { kind: 'drawPile' }, { kind: 'characterPile', playerId: 'p0', pile: 'buqu-jie-b38' })
    expect(getSkillRuntime('buqu-jie-b38')!.dyingIntercept!(host, 'p0')).toBe(false)
    expect(state.players[0].characterPiles['buqu-jie-b38']).toEqual([pileId])
    expect(state.zones.discardPile).toContain(duplicateId)
    state.players[0].hp = 0
    state.cards[state.zones.drawPile[0]].rank = 8
    expect(getSkillRuntime('buqu-jie-b38')!.dyingIntercept!(host, 'p0')).toBe(true)
    expect(state.players[0].characterPiles['buqu-jie-b38']).toHaveLength(2)
    expect(state.players[0].hp).toBe(1)
    expect(maxCardsOf(state, 'p0')).toBe(2)
  })

  it('界刘备仁德一名角色每出牌阶段只收一次，给出第二张后可用基本牌', () => {
    const { state, host, requests, moveFromDeck } = fixture()
    const [first, second] = moveFromDeck('p0', '杀', 'spade', 2)
    const runtime = getSkillRuntime('rende-jie-b38')!
    runtime.invokeActive!(host, 'p0', 'skill:rende-jie-b38')
    runtime.resume!(host, 'p0', { step: 'cards', data: {} } as any, { payload: { cardIds: [first, second] } } as any)
    runtime.resume!(host, 'p0', requests.at(-1) as any, { payload: { targetIds: ['p1'] } } as any)
    expect(state.players[1].zones.hand).toEqual(expect.arrayContaining([first, second]))
    expect(requests.at(-1).request.options.map((option: any) => option.id)).toContain('杀')
    moveFromDeck('p0', '闪')
    expect(getSkillRuntime('rende-jie-b38')!.activeActions!(state, 'p0')).toHaveLength(1)
    runtime.invokeActive!(host, 'p0', 'skill:rende-jie-b38')
    runtime.resume!(host, 'p0', { step: 'cards', data: {} } as any, { payload: { cardIds: [state.players[0].zones.hand[0]] } } as any)
    expect(requests.at(-1).request.candidateIds).not.toContain('p1')
  })

  it('界张飞咆哮首次出杀后仅本出牌阶段忽略距离', () => {
    const { state, host } = fixture()
    state.players[0].characterId = 'jie-zhangfei-b38'
    const runtime = getSkillRuntime('paoxiao-jie-b38')!
    expect(runtime.unlimitedSlash).toBe(true)
    expect(runtime.slashIgnoresDistance!(state, 'p0')).toBe(false)
    runtime.triggers!.find(item => item.event === 'CardUsed')!.handle(host, 'p0', { event: { sourceId: 'p0', payload: { cardName: '杀' } } } as any)
    expect(runtime.slashIgnoresDistance!(state, 'p0')).toBe(true)
    state.phase = 'discard'
    expect(runtime.slashIgnoresDistance!(state, 'p0')).toBe(false)
  })

  it('界张飞替身收回实体杀时只检查目标本人是否实际受伤', () => {
    const { state, host, queue, requests, moveFromDeck } = fixture()
    state.players[0].characterId = 'jie-zhangfei-b38'
    const [trick] = moveFromDeck('p0', '无中生有')
    state.cards[trick].category = 'trick'
    const runtime = getSkillRuntime('tishen-jie-b38')!
    runtime.triggers!.find(item => item.event === 'PhaseEnd')!.handle(host, 'p0', { event: { payload: { playerId: 'p0', phase: 'play' } } } as any)
    runtime.startQueued!(host, 'p0', queue[0])
    runtime.resume!(host, 'p0', requests.at(-1) as any, { payload: { optionId: 'yes' } } as any)
    expect(state.zones.discardPile).toContain(trick)
    const [slash] = moveFromDeck('p1', '杀')
    moveCard(state, slash, { kind: 'hand', playerId: 'p1' }, { kind: 'discardPile' })
    runtime.triggers!.find(item => item.event === 'CardUsed')!.handle(host, 'p0', { event: { sourceId: 'p1', payload: { cardId: slash, cardName: '杀', targetIds: ['p0'], virtual: false } } } as any)
    runtime.triggers!.find(item => item.event === 'DamageSettled')!.handle(host, 'p0', { event: { targetId: 'p0', payload: { cardId: slash, finalAmount: 0 } } } as any)
    runtime.triggers!.find(item => item.event === 'CardResolved')!.handle(host, 'p0', { event: { sourceId: 'p1', payload: { cardId: slash, targetIds: ['p0'] } } } as any)
    expect(state.players[0].zones.hand).toContain(slash)
  })

  it('界赵云涯角仅响应回合外实体手牌，公开顶牌、交付后类别不同须弃牌', () => {
    const { state, host, queue, requests, moveFromDeck } = fixture()
    state.players[0].characterId = 'jie-zhaoyun-b38'; state.currentPlayerId = 'p1'
    const [responseCard, costCard] = moveFromDeck('p0', '闪', 'spade', 2)
    const top = state.zones.drawPile[0]
    state.cards[top].name = '无中生有'; state.cards[top].category = 'trick'
    const runtime = getSkillRuntime('yajiao-jie-b38')!
    runtime.triggers!.find(item => item.event === 'CardResponded')!.handle(host, 'p0', { event: { payload: { playerId: 'p0', cardId: responseCard, cardName: '闪', fromKind: 'hand' } } } as any)
    expect(queue).toHaveLength(1)
    runtime.startQueued!(host, 'p0', queue[0])
    expect(state.zones.processingArea).toContain(top)
    runtime.resume!(host, 'p0', requests.at(-1) as any, { payload: { targetIds: ['p1'] } } as any)
    expect(state.players[1].zones.hand).toContain(top)
    expect(requests.at(-1).step).toBe('discard')
    runtime.resume!(host, 'p0', requests.at(-1) as any, { payload: { cardIds: [costCard] } } as any)
    expect(state.zones.discardPile).toContain(costCard)
  })

  it('界马超铁骑实际判定后压制非锁定技能，并仅允许弃置同花色代价响应', () => {
    const { game, state, moveFromDeck } = fixture()
    state.players[0].characterId = 'jie-machao-b38'; state.players[1].characterId = 'jie-zhaoyun-b38'
    const [dodge] = moveFromDeck('p1', '闪', 'spade')
    const [matchingCost] = moveFromDeck('p1', '杀', 'heart')
    moveFromDeck('p1', '桃', 'club')
    const judged = state.zones.drawPile[0]
    state.cards[judged].suit = 'heart'; state.cards[judged].color = 'red'
    expect(game.beginVirtualSlash({ sourceId: 'p0', targetId: 'p1', sourceSkillId: 'batch38-test' })).toBe(true)
    const invoke = state.pendingRequests.find((request: any) => request.playerId === 'p0')!
    game.respond({ requestId: invoke.id, playerId: 'p0', payload: { optionId: 'yes' } })
    expect(ownedSkillIds(state, 'p1')).not.toContain('longdan')
    expect(state.cardResolution.responseDiscardCostRequirements).toEqual([{ targetId: 'p1', suit: 'heart' }])
    const dodgeRequest = state.pendingRequests.find((request: any) => request.kind === 'respond-card')!
    game.respond({ requestId: dodgeRequest.id, playerId: 'p1', payload: { actionId: `respond-dodge:${dodge}` } })
    const payment = state.pendingRequests.find((request: any) => request.kind === 'choose-cards')!
    expect(payment.cardIds).toEqual([matchingCost])
  })

  it.each([
    ['真牌，不限红心并授予缠怨', '杀', true],
    ['假牌作废且不惩罚质疑者', '桃', false],
  ])('界于吉蛊惑：%s', (_label, realName, truthful) => {
    const { game, state, host, requests, moveFromDeck } = fixture()
    state.players[0].characterId = 'jie-yuji-b38'
    const [declaredCard] = moveFromDeck('p0', realName as string, 'spade')
    const p1Before = state.players[1].zones.hand.length
    const runtime = getSkillRuntime('guhuo')!
    runtime.invokeActive!(host, 'p0', 'skill:guhuo')
    runtime.resume!(host, 'p0', requests.at(-1) as any, { payload: { cardIds: [declaredCard] } } as any)
    runtime.resume!(host, 'p0', requests.at(-1) as any, { payload: { optionId: 'guhuo-name:杀' } } as any)
    const targetId = requests.at(-1).request.candidateIds.find((id: string) => id !== 'p1')
    runtime.resume!(host, 'p0', requests.at(-1) as any, { payload: { targetIds: [targetId] } } as any)
    const challengeRequests = [...state.pendingRequests]
    expect(challengeRequests.length).toBeGreaterThan(0)
    for (const request of challengeRequests) {
      game.respond({ requestId: request.id, playerId: request.playerId, payload: { optionId: request.playerId === 'p1' ? 'guhuo-challenge-yes' : 'guhuo-challenge-no' } })
    }
    if (truthful) {
      expect(state.players[1].grantedSkills).toContain('chanyuan-jie-b38')
      expect(state.cardResolution).toMatchObject({ kind: 'slash', sourceId: 'p0', targetId })
      expect(state.cards[declaredCard].suit).toBe('spade')
    } else {
      expect(state.players[1].grantedSkills ?? []).not.toContain('chanyuan-jie-b38')
      expect(state.players[1].zones.hand).toHaveLength(p1Before)
      expect(state.zones.discardPile).toContain(declaredCard)
      expect(state.cardResolution).toBeNull()
    }
  })

  it('缠怨在1体力只保留自身，非锁定技之外的锁定技也统一失效', () => {
    const { state } = fixture()
    state.players[1].grantedSkills = ['chanyuan-jie-b38']
    state.players[1].hp = 1
    expect(ownedSkillIds(state, 'p1')).toEqual(['chanyuan-jie-b38'])
    state.players[1].hp = 2
    expect(ownedSkillIds(state, 'p1')).toEqual(expect.arrayContaining(['chanyuan-jie-b38', 'paoxiao']))
  })
})
