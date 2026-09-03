import { describe, expect, it } from 'vitest'
import { SanguoshaGame } from '@/sanguosha/engine/game'
import { ALL_CHARACTERS, allCharacterIds, displayCharacterName, entertainmentCharacterIds, getCharacter, isEntertainmentCharacter, skillIdsOf } from '@/sanguosha/data/characters/standard'
import { getSkillRuntime } from '@/sanguosha/engine/skills/runtime'
import { getDistance } from '@/sanguosha/engine/distance'
import { resolveDamage } from '@/sanguosha/engine/damage'
import type { GameSetup, Identity, SanguoshaState } from '@/sanguosha/engine/types'
import { assertCardConservation, moveCard, type ZoneRef } from '@/sanguosha/engine/zones'

function setup(): GameSetup {
  return {
    mode: 'identity', generalChoices: 1,
    players: Array.from({ length: 5 }, (_, index) => ({ id: `p${index}`, nickname: `玩家${index}`, isHuman: index === 0 })),
  }
}

describe('吕蒙【克己】', () => {
  function fillAboveLimit(game: SanguoshaGame): void {
    while (game.state.players[0].zones.hand.length <= game.state.players[0].hp) {
      const cardId = game.state.zones.drawPile[0]
      moveCard(game.state, cardId, { kind: 'drawPile' }, { kind: 'hand', playerId: 'p0' })
    }
  }

  it('本回合没有使用杀时可以跳过弃牌阶段', () => {
    const game = gameWith('skill-keji-skip', { p0: 'lvmeng' })
    fillAboveLimit(game)
    const handBefore = game.state.players[0].zones.hand.length

    game.advancePhase()
    const request = game.state.pendingRequests[0]
    expect(request).toMatchObject({ kind: 'choose-option', playerId: 'p0' })
    expect(request.prompt).toContain('克己')
    game.respond({ requestId: request.id, playerId: 'p0', payload: { optionId: 'yes' } })

    expect(game.state.pendingRequests).toEqual([])
    expect(game.state.players[0].zones.hand.length).toBe(handBefore)
  })

  it('放弃克己后仍生成严格数量的弃牌请求', () => {
    const game = gameWith('skill-keji-decline', { p0: 'lvmeng' })
    fillAboveLimit(game)
    const excess = game.state.players[0].zones.hand.length - game.state.players[0].hp
    game.advancePhase()
    const ask = game.state.pendingRequests[0]
    game.respond({ requestId: ask.id, playerId: 'p0', payload: { optionId: 'no' } })
    expect(game.state.pendingRequests[0]).toMatchObject({ kind: 'choose-cards', purpose: 'discard-phase', min: excess, max: excess })
  })

  it('使用过杀后不能发动克己', () => {
    const game = gameWith('skill-keji-used-slash', { p0: 'lvmeng' })
    stripCard(game, '闪')
    const slash = giveNamed(game, 'p0', (card) => card.name === '杀' && !card.damageNature)
    const action = game.legalActions('p0').find((candidate) => candidate.kind === 'use-card' && candidate.cardIds.includes(slash))!
    game.act('p0', action.id)
    passAll(game)
    fillAboveLimit(game)

    game.advancePhase()
    expect(game.state.pendingRequests[0]).toMatchObject({ kind: 'choose-cards', purpose: 'discard-phase' })
    expect(game.state.pendingRequests[0].prompt).not.toContain('克己')
  })

  it('出牌阶段打出过杀后不能发动克己', () => {
    const game = gameWith('skill-keji-responded-slash', { p0: 'lvmeng' })
    fillAboveLimit(game)
    game.dispatch('CardResponded', { playerId: 'p0', cardName: '杀' }, { sourceId: 'p0' })

    game.advancePhase()
    expect(game.state.pendingRequests[0]).toMatchObject({ kind: 'choose-cards', purpose: 'discard-phase' })
    expect(game.state.pendingRequests[0].prompt).not.toContain('克己')
  })
})

describe('周瑜【英姿】【反间】', () => {
  it('英姿发动时摸三张，放弃时仍正常摸两张', () => {
    for (const [seed, optionId, expected] of [['skill-yingzi-yes', 'yes', 3], ['skill-yingzi-no', 'no', 2]] as const) {
      const game = gameWith(seed, { p0: 'zhouyu' })
      const before = game.state.players[0].zones.hand.length
      const context = game.dispatch('DrawPhase', { playerId: 'p0', count: 2 }, { sourceId: 'p0', phase: 'draw' })
      expect(context.cancelled).toBe(true)
      const request = game.state.pendingRequests[0]
      expect(request).toMatchObject({ kind: 'choose-option', playerId: 'p0' })
      game.respond({ requestId: request.id, playerId: 'p0', payload: { optionId } })
      expect(game.state.players[0].zones.hand.length).toBe(before + expected)
    }
  })

  it('反间由目标选择花色，猜错时获得随机手牌并受到伤害', () => {
    const game = gameWith('skill-fanjian-wrong-suit', { p0: 'zhouyu' })
    for (const cardId of [...game.state.players[0].zones.hand]) {
      moveCard(game.state, cardId, { kind: 'hand', playerId: 'p0' }, { kind: 'discardPile' })
    }
    const cardId = giveNamed(game, 'p0', (card) => card.color === 'red')
    const card = game.state.cards[cardId]
    const wrongSuit = (['spade', 'heart', 'club', 'diamond'] as const).find((suit) => suit !== card.suit)!
    const targetHp = game.state.players[1].hp

    game.act('p0', 'skill:fanjian')
    let request = game.state.pendingRequests[0]
    expect(request).toMatchObject({ kind: 'choose-targets', playerId: 'p0' })
    game.respond({ requestId: request.id, playerId: 'p0', payload: { targetIds: ['p1'] } })
    request = game.state.pendingRequests[0]
    expect(request).toMatchObject({ kind: 'choose-suit', playerId: 'p1' })
    game.respond({ requestId: request.id, playerId: 'p1', payload: { suit: wrongSuit } })

    expect(game.state.players[1].zones.hand).toContain(cardId)
    expect(game.state.players[1].hp).toBe(targetHp - 1)
    expect(game.legalActions('p0').some((action) => action.id === 'skill:fanjian')).toBe(false)
  })

  it('反间猜中花色时只获得牌，不造成伤害', () => {
    const game = gameWith('skill-fanjian-correct-suit', { p0: 'zhouyu' })
    for (const cardId of [...game.state.players[0].zones.hand].slice(1)) {
      moveCard(game.state, cardId, { kind: 'hand', playerId: 'p0' }, { kind: 'discardPile' })
    }
    const cardId = game.state.players[0].zones.hand[0]
    const targetHp = game.state.players[1].hp

    game.act('p0', 'skill:fanjian')
    let request = game.state.pendingRequests[0]
    game.respond({ requestId: request.id, playerId: 'p0', payload: { targetIds: ['p1'] } })
    request = game.state.pendingRequests[0]
    game.respond({ requestId: request.id, playerId: 'p1', payload: { suit: game.state.cards[cardId].suit } })

    expect(game.state.players[1].zones.hand).toContain(cardId)
    expect(game.state.players[1].hp).toBe(targetHp)
  })
})

describe('陆逊【谦逊】【连营】', () => {
  it('谦逊阻止顺手牵羊和乐不思蜀选择陆逊，但不影响其他合法目标', () => {
    const game = gameWith('skill-qianxun', { p0: 'guanyu', p1: 'luxun' })
    const snatch = giveNamed(game, 'p0', (card) => card.name === '顺手牵羊')
    const indulgence = giveNamed(game, 'p0', (card) => card.name === '乐不思蜀')
    const actions = game.legalActions('p0')

    expect(actions.some((action) => action.kind === 'use-card' && action.cardIds.includes(snatch) && action.targetIds.includes('p1'))).toBe(false)
    expect(actions.some((action) => action.kind === 'use-card' && action.cardIds.includes(snatch) && action.targetIds.includes('p4'))).toBe(true)
    expect(actions.some((action) => action.kind === 'use-card' && action.cardIds.includes(indulgence) && action.targetIds.includes('p1'))).toBe(false)
    expect(actions.some((action) => action.kind === 'use-card' && action.cardIds.includes(indulgence) && action.targetIds.includes('p2'))).toBe(true)
  })

  it('使用最后一张手牌后可发动连营摸一张', () => {
    const game = gameWith('skill-lianying', { p0: 'luxun' })
    for (const cardId of [...game.state.players[0].zones.hand]) {
      moveCard(game.state, cardId, { kind: 'hand', playerId: 'p0' }, { kind: 'discardPile' })
    }
    const wine = giveNamed(game, 'p0', (card) => card.name === '酒')
    const action = game.legalActions('p0').find((candidate) => candidate.kind === 'use-card' && candidate.cardIds.includes(wine))!
    game.act('p0', action.id)

    const request = game.state.pendingRequests[0]
    expect(request).toMatchObject({ kind: 'choose-option', playerId: 'p0' })
    expect(request.prompt).toContain('连营')
    game.respond({ requestId: request.id, playerId: 'p0', payload: { optionId: 'yes' } })
    expect(game.state.players[0].zones.hand).toHaveLength(1)
  })

  it('还有手牌时不触发连营', () => {
    const game = gameWith('skill-lianying-not-empty', { p0: 'luxun' })
    const wine = giveNamed(game, 'p0', (card) => card.name === '酒')
    const before = game.state.players[0].zones.hand.length
    const action = game.legalActions('p0').find((candidate) => candidate.kind === 'use-card' && candidate.cardIds.includes(wine))!
    game.act('p0', action.id)
    expect(game.state.players[0].zones.hand.length).toBe(before - 1)
    expect(game.state.pendingRequests).toEqual([])
  })
})

describe('诸葛亮【观星】【空城】', () => {
  it('观星只向技能拥有者展示牌面，并按回答重排牌堆顶和牌堆底', () => {
    const game = new SanguoshaGame({ seed: 'skill-guanxing', setup: setup() })
    const identities: Identity[] = ['lord', 'rebel', 'loyalist', 'rebel', 'renegade']
    game.state.players.forEach((player, index) => {
      player.identity = identities[index]
      player.characterId = index === 0 ? 'zhugeliang' : 'guanyu'
    })
    game.state.currentPlayerId = 'p0'
    game.start()

    const request = game.state.pendingRequests[0]
    expect(request).toMatchObject({ kind: 'arrange-cards', playerId: 'p0', minTop: 0, maxTop: 5, allowBottom: true })
    if (request.kind !== 'arrange-cards') throw new Error('观星没有生成排列请求')
    expect(game.viewFor('p0').requestCards.map((card) => card.id)).toEqual(request.cardIds)
    expect(game.viewFor('p1').requestCards).toEqual([])
    expect(game.viewFor('p1').pendingRequest).toBeNull()

    const top = [request.cardIds[2], request.cardIds[0]]
    const bottom = [request.cardIds[4], request.cardIds[1], request.cardIds[3]]
    game.respond({ requestId: request.id, playerId: 'p0', payload: { top, bottom } })
    expect(game.state.zones.drawPile.slice(0, top.length)).toEqual(top)
    expect(game.state.zones.drawPile.slice(-bottom.length)).toEqual(bottom)
  })

  it('空手时不能成为杀或决斗的目标', () => {
    const game = gameWith('skill-kongcheng-empty', { p0: 'guanyu', p1: 'zhugeliang' })
    for (const cardId of [...game.state.players[1].zones.hand]) {
      moveCard(game.state, cardId, { kind: 'hand', playerId: 'p1' }, { kind: 'discardPile' })
    }
    const slash = giveNamed(game, 'p0', (card) => card.name === '杀' && !card.damageNature)
    const duel = giveNamed(game, 'p0', (card) => card.name === '决斗')
    const actions = game.legalActions('p0')
    expect(actions.some((action) => action.kind === 'use-card' && action.cardIds.includes(slash) && action.targetIds.includes('p1'))).toBe(false)
    expect(actions.some((action) => action.kind === 'use-card' && action.cardIds.includes(duel) && action.targetIds.includes('p1'))).toBe(false)
    expect(actions.some((action) => action.kind === 'use-card' && action.cardIds.includes(duel) && action.targetIds.includes('p2'))).toBe(true)
  })

  it('有手牌时空城不生效', () => {
    const game = gameWith('skill-kongcheng-hand', { p0: 'guanyu', p1: 'zhugeliang' })
    const slash = giveNamed(game, 'p0', (card) => card.name === '杀' && !card.damageNature)
    const duel = giveNamed(game, 'p0', (card) => card.name === '决斗')
    const actions = game.legalActions('p0')
    expect(actions.some((action) => action.kind === 'use-card' && action.cardIds.includes(slash) && action.targetIds.includes('p1'))).toBe(true)
    expect(actions.some((action) => action.kind === 'use-card' && action.cardIds.includes(duel) && action.targetIds.includes('p1'))).toBe(true)
  })
})

describe('吕布【无双】', () => {
  function giveSeveral(game: SanguoshaGame, playerId: string, cardName: string, count: number): string[] {
    const ids = Object.values(game.state.cards).filter((card) => card.name === cardName).slice(0, count).map((card) => card.id)
    for (const cardId of ids) moveCard(game.state, cardId, locate(game.state, cardId), { kind: 'hand', playerId })
    return ids
  }

  function passNullificationRound(game: SanguoshaGame): void {
    for (let guard = 0; guard < 20; guard += 1) {
      const request = game.state.pendingRequests[0]
      if (!request || request.kind !== 'respond-card' || request.requiredCardName !== '无懈可击') return
      game.respond({ requestId: request.id, playerId: request.playerId, payload: { actionId: 'respond-pass' } })
    }
    throw new Error('无懈询问没有收敛')
  }

  it('吕布的杀需要目标连续打出两张闪', () => {
    const game = gameWith('skill-wushuang-slash', { p0: 'lvbu' })
    stripCard(game, '闪')
    const dodges = giveSeveral(game, 'p1', '闪', 2)
    const slash = giveNamed(game, 'p0', (card) => card.name === '杀' && !card.damageNature)
    const action = game.legalActions('p0').find((candidate) => candidate.kind === 'use-card' && candidate.cardIds.includes(slash) && candidate.targetIds.includes('p1'))!
    game.act('p0', action.id)

    let request = game.state.pendingRequests[0]
    game.respond({ requestId: request.id, playerId: 'p1', payload: { actionId: `respond-dodge:${dodges[0]}` } })
    request = game.state.pendingRequests[0]
    expect(request).toMatchObject({ kind: 'respond-card', playerId: 'p1', requiredCardName: '闪' })
    game.respond({ requestId: request.id, playerId: 'p1', payload: { actionId: `respond-dodge:${dodges[1]}` } })
    expect(game.state.cardResolution).toBeNull()
    expect(game.state.players[1].hp).toBe(game.state.players[1].maxHp)
  })

  it('无双的第二张闪未打出时正常造成伤害', () => {
    const game = gameWith('skill-wushuang-one-dodge', { p0: 'lvbu' })
    stripCard(game, '闪')
    const [dodge] = giveSeveral(game, 'p1', '闪', 1)
    const slash = giveNamed(game, 'p0', (card) => card.name === '杀' && !card.damageNature)
    const action = game.legalActions('p0').find((candidate) => candidate.kind === 'use-card' && candidate.cardIds.includes(slash) && candidate.targetIds.includes('p1'))!
    const before = game.state.players[1].hp
    game.act('p0', action.id)
    let request = game.state.pendingRequests[0]
    game.respond({ requestId: request.id, playerId: 'p1', payload: { actionId: `respond-dodge:${dodge}` } })
    request = game.state.pendingRequests[0]
    game.respond({ requestId: request.id, playerId: 'p1', payload: { actionId: 'respond-pass' } })
    expect(game.state.players[1].hp).toBe(before - 1)
  })

  it('与吕布决斗的角色每轮需要连续打出两张杀', () => {
    const game = gameWith('skill-wushuang-duel', { p0: 'lvbu' })
    stripCard(game, '杀')
    const slashes = giveSeveral(game, 'p1', '杀', 2)
    const duel = giveNamed(game, 'p0', (card) => card.name === '决斗')
    const action = game.legalActions('p0').find((candidate) => candidate.kind === 'use-card' && candidate.cardIds.includes(duel) && candidate.targetIds.includes('p1'))!
    const before = game.state.players[0].hp
    game.act('p0', action.id)
    passNullificationRound(game)

    let request = game.state.pendingRequests[0]
    expect(request).toMatchObject({ playerId: 'p1', requiredCardName: '杀' })
    game.respond({ requestId: request.id, playerId: 'p1', payload: { actionId: `respond-trick:${slashes[0]}` } })
    request = game.state.pendingRequests[0]
    expect(request).toMatchObject({ playerId: 'p1', requiredCardName: '杀' })
    game.respond({ requestId: request.id, playerId: 'p1', payload: { actionId: `respond-trick:${slashes[1]}` } })
    request = game.state.pendingRequests[0]
    expect(request).toMatchObject({ playerId: 'p0', requiredCardName: '杀' })
    game.respond({ requestId: request.id, playerId: 'p0', payload: { actionId: 'respond-pass' } })
    expect(game.state.players[0].hp).toBe(before - 1)
  })
})

describe('已登记武将的缺失技能补齐', () => {
  it('甄姬可用黑色手牌发动倾国响应闪', () => {
    const game = gameWith('skill-qingguo', { p0: 'guanyu', p1: 'zhenji' })
    stripCard(game, '闪')
    const black = giveNamed(game, 'p1', (card) => card.color === 'black' && card.name !== '杀')
    const slash = giveNamed(game, 'p0', (card) => card.name === '杀' && !card.damageNature)
    const action = game.legalActions('p0').find((candidate) => candidate.kind === 'use-card' && candidate.cardIds.includes(slash) && candidate.targetIds.includes('p1'))!
    const before = game.state.players[1].hp
    game.act('p0', action.id)
    const request = game.state.pendingRequests[0]
    expect(request).toMatchObject({ kind: 'respond-card', playerId: 'p1', requiredCardName: '闪' })
    if (request.kind !== 'respond-card') throw new Error('没有生成闪响应')
    expect(request.actionIds).toContain(`respond-dodge:${black}`)
    game.respond({ requestId: request.id, playerId: 'p1', payload: { actionId: `respond-dodge:${black}` } })
    expect(game.state.players[1].hp).toBe(before)
  })

  it('华佗回合外可将红色手牌当桃用于急救', () => {
    const game = gameWith('skill-jijiu', { p0: 'guanyu', p1: 'huatuo' })
    stripCard(game, '桃')
    const red = giveNamed(game, 'p1', (card) => card.color === 'red' && card.name !== '桃')
    const target = game.state.players[2]
    resolveDamage(game, { sourceId: 'p0', targetId: target.id, amount: target.hp, nature: 'normal' })
    // 求桃从濒死者本人起按座次问一圈，这里走到华佗那一问
    let request = game.state.pendingRequests[0]
    while (request.playerId !== 'p1') {
      game.respond({ requestId: request.id, playerId: request.playerId, payload: { actionId: 'rescue-pass' } })
      request = game.state.pendingRequests[0]
    }
    expect(request).toMatchObject({ kind: 'rescue', playerId: 'p1' })
    if (request.kind !== 'rescue') throw new Error('没有生成急救请求')
    expect(request.actionIds).toContain(`rescue-card:${red}`)
    game.respond({ requestId: request.id, playerId: 'p1', payload: { actionId: `rescue-card:${red}` } })
    expect(target.hp).toBe(1)
    expect(game.state.zones.discardPile).toContain(red)
  })

  it('孙尚香结姻弃两张牌后与受伤男性角色各回复一点', () => {
    const game = gameWith('skill-jieyin', { p0: 'sunshangxiang', p1: 'guanyu' })
    game.state.players[0].hp -= 1
    game.state.players[1].hp -= 1
    const before = [game.state.players[0].hp, game.state.players[1].hp]
    game.act('p0', 'skill:jieyin')
    let request = game.state.pendingRequests[0]
    expect(request).toMatchObject({ kind: 'choose-cards', min: 2, max: 2 })
    if (request.kind !== 'choose-cards') throw new Error('结姻没有生成弃牌请求')
    game.respond({ requestId: request.id, playerId: 'p0', payload: { cardIds: request.cardIds.slice(0, 2) } })
    request = game.state.pendingRequests[0]
    expect(request).toMatchObject({ kind: 'choose-targets', candidateIds: expect.arrayContaining(['p1']) })
    game.respond({ requestId: request.id, playerId: 'p0', payload: { targetIds: ['p1'] } })
    expect(game.state.players[0].hp).toBe(before[0] + 1)
    expect(game.state.players[1].hp).toBe(before[1] + 1)
    expect(game.legalActions('p0').some((action) => action.id === 'skill:jieyin')).toBe(false)
  })
})

function locate(state: SanguoshaState, cardId: string): ZoneRef {
  if (state.zones.drawPile.includes(cardId)) return { kind: 'drawPile' }
  if (state.zones.discardPile.includes(cardId)) return { kind: 'discardPile' }
  if (state.zones.processingArea.includes(cardId)) return { kind: 'processingArea' }
  for (const owner of state.players) {
    if (owner.zones.hand.includes(cardId)) return { kind: 'hand', playerId: owner.id }
    if (owner.zones.judgingArea.includes(cardId)) return { kind: 'judgingArea', playerId: owner.id }
    for (const [slot, equipped] of Object.entries(owner.zones.equipment)) {
      if (equipped === cardId) return { kind: 'equipment', playerId: owner.id, slot: slot as keyof typeof owner.zones.equipment }
    }
  }
  throw new Error(`找不到卡牌：${cardId}`)
}

/** 开一局，并把指定武将直接装到对应座位上。 */
function gameWith(seed: string, assign: Record<string, string>): SanguoshaGame {
  const game = new SanguoshaGame({ seed, setup: setup() })
  const identities: Identity[] = ['lord', 'rebel', 'loyalist', 'rebel', 'renegade']
  game.state.players.forEach((player, index) => {
    player.identity = identities[index]
    player.identityRevealed = player.identity === 'lord'
    const characterId = assign[player.id]
    if (characterId) {
      player.characterId = characterId
      player.maxHp = getCharacter(characterId)!.maxHp
      player.hp = player.maxHp
    }
  })
  game.state.currentPlayerId = 'p0'
  game.start()
  for (let index = 0; index < 3; index += 1) {
    game.advancePhase()
    const request = game.state.pendingRequests[0]
    if (request?.kind === 'choose-option' && request.prompt.includes('英姿')) {
      game.respond({ requestId: request.id, playerId: request.playerId, payload: { optionId: 'no' } })
    }
  }
  expect(game.state.phase).toBe('play')
  return game
}

function giveNamed(game: SanguoshaGame, playerId: string, predicate: (card: { name: string; color: string; damageNature?: string }) => boolean): string {
  const card = Object.values(game.state.cards).find((candidate) => predicate(candidate))!
  moveCard(game.state, card.id, locate(game.state, card.id), { kind: 'hand', playerId })
  return card.id
}

function stripCard(game: SanguoshaGame, cardName: string): void {
  for (const player of game.state.players) {
    for (const cardId of [...player.zones.hand]) {
      if (game.state.cards[cardId]?.name !== cardName) continue
      moveCard(game.state, cardId, { kind: 'hand', playerId: player.id }, { kind: 'discardPile' })
    }
  }
}

function passAll(game: SanguoshaGame): void {
  for (let guard = 0; guard < 200; guard += 1) {
    const request = game.state.pendingRequests[0]
    if (!request) return
    const actionId = request.kind === 'rescue' ? 'rescue-pass' : 'respond-pass'
    game.respond({ requestId: request.id, playerId: request.playerId, payload: { actionId } })
  }
  throw new Error('结算没有收敛')
}

describe('武将包完整性', () => {
  it('注册的武将必须每个技能都有真正的运行时实现', () => {
    // 任务书禁止「选将页看得到、技能其实没写」，这条就是防线
    for (const character of ALL_CHARACTERS) {
      expect(character.skills.length).toBeGreaterThan(0)
      for (const skill of character.skills) {
        expect(getSkillRuntime(skill.id), `${character.name}的【${skill.name}】没有运行时实现`).toBeDefined()
        expect(skill.description.length).toBeGreaterThan(0)
      }
    }
  })

  it('技能说明只有一份，规则页直接读武将数据', () => {
    const guanyu = getCharacter('guanyu')!
    expect(guanyu.skills[0].description).toContain('红色牌')
    expect(skillIdsOf('guanyu')).toEqual(['wusheng'])
  })

  it('武将 id 不重复', () => {
    const ids = allCharacterIds()
    expect(new Set(ids).size).toBe(ids.length)
  })
})

describe('选将流程', () => {
  it('相同 seed 得到相同候选；普通武将不重复，自定义武将只固定给真人', () => {
    const first = new SanguoshaGame({ seed: 'pick-generals', setup: setup() })
    const second = new SanguoshaGame({ seed: 'pick-generals', setup: setup() })
    first.dealGenerals()
    second.dealGenerals()
    const candidatesOf = (game: SanguoshaGame) => game.state.pendingRequests.map((request) => (
      request.kind === 'choose-general' ? request.candidates.join(',') : ''
    ))
    expect(candidatesOf(first)).toEqual(candidatesOf(second))

    const requests = first.state.pendingRequests.filter((request) => request.kind === 'choose-general')
    const ordinary = requests.flatMap((request) => request.candidates.filter((id) => !isEntertainmentCharacter(id)))
    expect(new Set(ordinary).size).toBe(ordinary.length)
    for (const request of requests) {
      const player = first.state.players.find((candidate) => candidate.id === request.playerId)!
      // 固定的自定义池只发给真人，AI 只能靠随机池分到
      expect(request.fixedCandidates).toEqual(player.isHuman ? entertainmentCharacterIds() : [])
    }
  })

  it('单机真人可从全部武将自选，选中普通武将后 AI 不再撞将', () => {
    const localSetup = { ...setup(), allowHumanGeneralSelection: true }
    const game = new SanguoshaGame({ seed: 'self-pick', setup: localSetup })
    game.dealGenerals()
    const human = game.state.pendingRequests.find((request) => request.kind === 'choose-general' && request.playerId === 'p0')!
    expect(human.allCandidates).toEqual(allCharacterIds())
    /*
     * 不能写死「p1 的候选」：`generalChoices` 为 1 时每个 AI 只发到一张，
     * 那一张完全可能正好是娱乐武将（娱乐武将允许多人重复，撞不撞将无从谈起）。
     * 池子一变顺序就变，写死 p1 迟早翻车——改成挑**任意一个**拿到普通武将的 AI。
     */
    const ai = game.state.pendingRequests.find((request) => request.kind === 'choose-general'
      && request.playerId !== 'p0'
      && request.candidates.some((id) => !isEntertainmentCharacter(id)))!
    expect(ai, '至少要有一个 AI 拿到普通武将').toBeTruthy()
    expect(ai.allCandidates).toBeUndefined()
    const selected = ai.candidates.find((id) => !isEntertainmentCharacter(id))!
    game.respond({ requestId: human.id, playerId: 'p0', payload: { characterId: selected } })
    const remaining = game.state.pendingRequests.find((request) => request.kind === 'choose-general' && request.playerId === ai.playerId)!
    expect(remaining.candidates).not.toContain(selected)
  })

  it('多人可以选择同一个自定义武将，并按座次显示编号', () => {
    // 自定义池只发给真人，所以这一条要两个真人
    const twoHumans = setup()
    twoHumans.players = twoHumans.players.map((player, index) => ({ ...player, isHuman: index < 2 }))
    const game = new SanguoshaGame({ seed: 'custom-duplicate', setup: twoHumans })
    game.dealGenerals()
    const requests = game.state.pendingRequests.filter((request) => request.kind === 'choose-general')
    const custom = entertainmentCharacterIds()[0]
    for (const request of requests.slice(0, 2)) {
      game.respond({ requestId: request.id, playerId: request.playerId, payload: { characterId: custom } })
    }
    expect(displayCharacterName(game.state.players, 'p0')).toBe('平头方块①')
    expect(displayCharacterName(game.state.players, 'p1')).toBe('平头方块②')
  })

  it('选将没结束不能开局；选完后武将和体力都装上', () => {
    const game = new SanguoshaGame({ seed: 'pick-then-start', setup: setup() })
    game.state.players.forEach((player, index) => {
      player.identity = (['lord', 'rebel', 'loyalist', 'rebel', 'renegade'] as Identity[])[index]
    })
    game.dealGenerals()
    expect(() => game.start()).toThrow('还有玩家没有选将')

    for (const request of [...game.state.pendingRequests]) {
      if (request.kind !== 'choose-general') continue
      game.respond({ requestId: request.id, playerId: request.playerId, payload: { characterId: request.candidates[0] } })
    }
    expect(game.state.pendingRequests).toEqual([])
    for (const player of game.state.players) {
      expect(player.characterId).not.toBeNull()
      expect(player.hp).toBe(player.maxHp)
    }
    // 五人局主公体力上限 +1
    const lord = game.state.players.find((player) => player.identity === 'lord')!
    expect(lord.maxHp).toBe(getCharacter(lord.characterId!)!.maxHp + 1)

    game.start()
    expect(game.state.status).toBe('playing')
  })

  it('拒绝不在候选里的武将和伪造的响应', () => {
    const game = new SanguoshaGame({ seed: 'pick-invalid', setup: setup() })
    game.dealGenerals()
    const request = game.state.pendingRequests[0]
    expect(() => game.respond({ requestId: request.id, playerId: request.playerId, payload: { characterId: '不存在的武将' } })).toThrow()
    expect(() => game.respond({ requestId: request.id, playerId: 'p9', payload: { characterId: 'guanyu' } })).toThrow()
  })
})

describe('张飞【咆哮】', () => {
  it('出杀不限次，和诸葛连弩走同一个入口', () => {
    const game = gameWith('skill-paoxiao', { p0: 'zhangfei' })
    stripCard(game, '闪')
    const first = giveNamed(game, 'p0', (card) => card.name === '杀' && !card.damageNature)
    const slashActions = () => game.legalActions('p0').filter((action) => action.kind === 'use-card' && action.asCardName === '杀')

    expect(slashActions().length).toBeGreaterThan(0)
    const action = slashActions().find((candidate) => candidate.cardIds.includes(first))!
    game.act('p0', action.id)
    passAll(game)

    // 打完一张之后仍然能继续出杀
    const second = giveNamed(game, 'p0', (card) => card.name === '杀' && !card.damageNature)
    expect(slashActions().some((candidate) => candidate.cardIds.includes(second))).toBe(true)
    assertCardConservation(game.state)
  })

  it('没有咆哮的人打完一张就不能再出', () => {
    const game = gameWith('skill-no-paoxiao', { p0: 'guanyu' })
    stripCard(game, '闪')
    const first = giveNamed(game, 'p0', (card) => card.name === '杀' && !card.damageNature)
    const action = game.legalActions('p0').find((candidate) => candidate.kind === 'use-card' && candidate.cardIds.includes(first))!
    game.act('p0', action.id)
    passAll(game)
    const second = giveNamed(game, 'p0', (card) => card.name === '杀' && !card.damageNature)
    expect(game.legalActions('p0').some((candidate) => candidate.kind === 'use-card' && candidate.cardIds.includes(second))).toBe(false)
  })
})

describe('马超【马术】', () => {
  it('与其他角色的距离减一，走统一距离入口', () => {
    const plain = gameWith('skill-no-mashu', { p0: 'guanyu' })
    const withSkill = gameWith('skill-mashu', { p0: 'machao' })
    // 座次相同，只有技能不同
    expect(getDistance(withSkill.state, 'p0', 'p2')).toBe(Math.max(1, getDistance(plain.state, 'p0', 'p2') - 1))
  })

  it('只影响自己出去的距离，别人到自己的距离不变', () => {
    const game = gameWith('skill-mashu-oneway', { p0: 'machao' })
    const plain = gameWith('skill-mashu-oneway-plain', { p0: 'guanyu' })
    expect(getDistance(game.state, 'p2', 'p0')).toBe(getDistance(plain.state, 'p2', 'p0'))
  })
})

describe('关羽【武圣】', () => {
  it('红色牌可以当杀用，并且原用途同时保留', () => {
    const game = gameWith('skill-wusheng', { p0: 'guanyu' })
    stripCard(game, '闪')
    // 给一张红色的桃：它既可以当桃用，也可以当杀用
    const peach = giveNamed(game, 'p0', (card) => card.name === '桃' && card.color === 'red')
    game.state.players[0].hp = 3 // 让桃有原用途

    const actions = game.legalActions('p0').filter((action) => action.kind === 'use-card' && action.cardIds.includes(peach))
    const asPeach = actions.filter((action) => action.asCardName === '桃')
    const asSlash = actions.filter((action) => action.asCardName === '杀')
    // 关键：两种用途都要在，玩家自己选，引擎不替他决定
    expect(asPeach.length).toBeGreaterThan(0)
    expect(asSlash.length).toBeGreaterThan(0)
    expect(asSlash[0].label).toContain('当【杀】')
  })

  it('当杀打出去之后按杀结算，目标要出闪', () => {
    const game = gameWith('skill-wusheng-use', { p0: 'guanyu' })
    stripCard(game, '闪')
    stripCard(game, '杀')
    const red = giveNamed(game, 'p0', (card) => card.color === 'red' && card.name === '桃')
    const hpBefore = game.state.players[1].hp

    const action = game.legalActions('p0').find((candidate) => (
      candidate.kind === 'use-card' && candidate.cardIds.includes(red) && candidate.asCardName === '杀' && candidate.targetIds.includes('p1')
    ))!
    game.act('p0', action.id)
    expect(game.state.pendingRequests[0]).toMatchObject({ kind: 'respond-card', requiredCardName: '闪', playerId: 'p1' })
    passAll(game)

    expect(game.state.players[1].hp).toBe(hpBefore - 1)
    assertCardConservation(game.state)
  })

  it('黑色牌不能当杀用', () => {
    const game = gameWith('skill-wusheng-black', { p0: 'guanyu' })
    stripCard(game, '杀')
    // 注意：ruleset-v1 里所有【闪】都是红色，黑色牌得另找——这里用黑色的过河拆桥
    const black = giveNamed(game, 'p0', (card) => card.color === 'black' && card.name === '过河拆桥')
    const asSlash = game.legalActions('p0').filter((action) => (
      action.kind === 'use-card' && action.cardIds.includes(black) && action.asCardName === '杀'
    ))
    expect(asSlash).toEqual([])
  })
})

describe('赵云【龙胆】', () => {
  it('闪可以当杀用', () => {
    const game = gameWith('skill-longdan-slash', { p0: 'zhaoyun' })
    stripCard(game, '杀')
    const dodge = giveNamed(game, 'p0', (card) => card.name === '闪')
    const asSlash = game.legalActions('p0').filter((action) => (
      action.kind === 'use-card' && action.cardIds.includes(dodge) && action.asCardName === '杀'
    ))
    expect(asSlash.length).toBeGreaterThan(0)
  })

  it('杀可以当闪打出来免伤', () => {
    const game = gameWith('skill-longdan-dodge', { p0: 'guanyu', p1: 'zhaoyun' })
    stripCard(game, '闪')
    const attackerSlash = giveNamed(game, 'p0', (card) => card.name === '杀' && !card.damageNature)
    const defenderSlash = Object.values(game.state.cards).find((card) => (
      card.name === '杀' && card.id !== attackerSlash && !card.damageNature
    ))!
    moveCard(game.state, defenderSlash.id, locate(game.state, defenderSlash.id), { kind: 'hand', playerId: 'p1' })
    const hpBefore = game.state.players[1].hp

    const action = game.legalActions('p0').find((candidate) => (
      candidate.kind === 'use-card' && candidate.cardIds.includes(attackerSlash) && candidate.targetIds.includes('p1')
    ))!
    game.act('p0', action.id)

    const request = game.state.pendingRequests[0] as Extract<typeof game.state.pendingRequests[0], { kind: 'respond-card' }>
    // 关键：手里明明没有【闪】，但龙胆让这张【杀】成为一条合法响应动作
    expect(request.actionIds).toContain(`respond-dodge:${defenderSlash.id}`)
    game.respond({ requestId: request.id, playerId: 'p1', payload: { actionId: `respond-dodge:${defenderSlash.id}` } })

    expect(game.state.players[1].hp).toBe(hpBefore)
    expect(game.state.zones.discardPile).toContain(defenderSlash.id)
    assertCardConservation(game.state)
  })

  it('没有龙胆的人不能拿杀当闪', () => {
    const game = gameWith('skill-longdan-none', { p0: 'guanyu', p1: 'zhangfei' })
    stripCard(game, '闪')
    const attackerSlash = giveNamed(game, 'p0', (card) => card.name === '杀' && !card.damageNature)
    const defenderSlash = Object.values(game.state.cards).find((card) => (
      card.name === '杀' && card.id !== attackerSlash && !card.damageNature
    ))!
    moveCard(game.state, defenderSlash.id, locate(game.state, defenderSlash.id), { kind: 'hand', playerId: 'p1' })

    const action = game.legalActions('p0').find((candidate) => (
      candidate.kind === 'use-card' && candidate.cardIds.includes(attackerSlash) && candidate.targetIds.includes('p1')
    ))!
    game.act('p0', action.id)
    const request = game.state.pendingRequests[0] as Extract<typeof game.state.pendingRequests[0], { kind: 'respond-card' }>
    expect(request.actionIds).not.toContain(`respond-dodge:${defenderSlash.id}`)
    expect(() => game.respond({
      requestId: request.id, playerId: 'p1', payload: { actionId: `respond-dodge:${defenderSlash.id}` },
    })).toThrow()
  })
})

describe('黄月英【集智】【奇才】', () => {
  it('使用非延时锦囊后摸一张牌', () => {
    const game = gameWith('skill-jizhi', { p0: 'huangyueying' })
    stripCard(game, '无懈可击')
    const trick = giveNamed(game, 'p0', (card) => card.name === '无中生有')
    const handBefore = game.state.players[0].zones.hand.length

    const action = game.legalActions('p0').find((candidate) => candidate.kind === 'use-card' && candidate.cardIds.includes(trick))!
    game.act('p0', action.id)
    passAll(game)

    // 打出锦囊 -1、无中生有摸 2、集智再摸 1
    expect(game.state.players[0].zones.hand.length).toBe(handBefore - 1 + 2 + 1)
    assertCardConservation(game.state)
  })

  it('延时锦囊不触发集智', () => {
    const game = gameWith('skill-jizhi-delayed', { p0: 'huangyueying' })
    const trick = giveNamed(game, 'p0', (card) => card.name === '乐不思蜀')
    const handBefore = game.state.players[0].zones.hand.length

    const action = game.legalActions('p0').find((candidate) => (
      candidate.kind === 'use-card' && candidate.cardIds.includes(trick) && candidate.targetIds.includes('p1')
    ))!
    game.act('p0', action.id)
    passAll(game)

    // 只少了打出去的那张，没有额外摸牌
    expect(game.state.players[0].zones.hand.length).toBe(handBefore - 1)
  })

  it('没有集智的人使用锦囊不会摸牌', () => {
    const game = gameWith('skill-jizhi-none', { p0: 'guanyu' })
    stripCard(game, '无懈可击')
    const trick = giveNamed(game, 'p0', (card) => card.name === '无中生有')
    const handBefore = game.state.players[0].zones.hand.length
    // 无中生有是红牌，关羽的【武圣】会额外给出「当杀用」的动作，
    // 所以这里必须显式挑「按锦囊用」那条——两种用途都在，本来就该由玩家选。
    const action = game.legalActions('p0').find((candidate) => (
      candidate.kind === 'use-card' && candidate.cardIds.includes(trick) && candidate.asCardName === '无中生有'
    ))!
    game.act('p0', action.id)
    passAll(game)
    expect(game.state.players[0].zones.hand.length).toBe(handBefore - 1 + 2)
  })

  it('奇才让顺手牵羊无视距离限制', () => {
    const plain = gameWith('skill-qicai-plain', { p0: 'guanyu' })
    const skilled = gameWith('skill-qicai', { p0: 'huangyueying' })
    const snatchTargets = (game: SanguoshaGame) => {
      const cardId = giveNamed(game, 'p0', (card) => card.name === '顺手牵羊')
      return game.legalActions('p0')
        .filter((action) => action.kind === 'use-card' && action.cardIds.includes(cardId))
        .flatMap((action) => action.targetIds)
    }
    // 奇才能顺到距离更远的人
    expect(snatchTargets(skilled).length).toBeGreaterThan(snatchTargets(plain).length)
  })
})


describe('自定义武将池只发给真人', () => {
  it('AI 的候选里没有固定的自定义池', () => {
    const game = new SanguoshaGame({ seed: 'custom-pool', setup: setup() })
    game.dealGenerals()
    const custom = new Set(entertainmentCharacterIds())
    const requests = game.state.pendingRequests.filter((request) => request.kind === 'choose-general')

    for (const request of requests) {
      const player = game.state.players.find((candidate) => candidate.id === request.playerId)!
      if (player.isHuman) {
        expect(request.fixedCandidates, '真人要能看到自定义池').toEqual([...custom])
        for (const id of custom) expect(request.candidates).toContain(id)
        continue
      }
      expect(request.fixedCandidates, 'AI 不该看到自定义池').toEqual([])
      // 随机池里恰好分到的自定义武将仍然算数，所以这里只断言「不是全都有」
      expect([...custom].every((id) => request.candidates.includes(id)),
        'AI 不该每个自定义武将都拿到').toBe(false)
    }
  })

  it('随机池分到的自定义武将，AI 仍然可以选', () => {
    // 把自定义武将塞进某个 AI 的候选里，验证引擎不会额外拦一道
    const game = new SanguoshaGame({ seed: 'custom-random', setup: setup() })
    game.dealGenerals()
    const custom = entertainmentCharacterIds()[0]
    const request = game.state.pendingRequests.find((candidate) => candidate.kind === 'choose-general'
      && candidate.playerId === 'p1')!
    if (request.kind !== 'choose-general') throw new Error('请求类型不对')
    request.candidates = [...request.candidates, custom]

    game.respond({ requestId: request.id, playerId: 'p1', payload: { characterId: custom } })
    expect(game.state.players[1].characterId).toBe(custom)
  })
})
