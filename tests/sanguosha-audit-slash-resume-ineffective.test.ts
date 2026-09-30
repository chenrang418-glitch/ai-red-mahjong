import { describe, expect, it } from 'vitest'
import { SanguoshaGame } from '@/sanguosha/engine/game'
import { setCardNature, moveCard } from '@/sanguosha/engine/zones'
import { suppressEquipmentEffectsUntilTurnEnd } from '@/sanguosha/engine/equipment-suppression'
import { XIAHOU_EN_CHIJIAN } from '@/sanguosha/data/characters/historical-batch87'
import { assertGameInvariants } from '@/sanguosha/engine/invariants'
import type { GameSetup, Identity, PlayerId } from '@/sanguosha/engine/types'

const CHARACTERS = ['huangzhong', 'zhangfei', 'zhangfei', 'zhangfei', 'zhangfei']

function gameWith(characterIds = CHARACTERS, seed = 'slash-resume-ineffective'): SanguoshaGame {
  const setup: GameSetup = {
    mode: 'identity', generalChoices: 1,
    players: Array.from({ length: characterIds.length }, (_, index) => ({ id: `p${index}`, nickname: `玩家${index}`, isHuman: false })),
  }
  const game = new SanguoshaGame({ seed, setup })
  const identities: Identity[] = ['lord', 'rebel', 'loyalist', 'rebel', 'renegade']
  game.state.players.forEach((player, index) => {
    player.identity = identities[index % identities.length]
    player.characterId = characterIds[index]
  })
  game.start()
  while (game.state.pendingRequests.length > 0) {
    const request = game.state.pendingRequests[0]
    game.respond({ requestId: request.id, playerId: request.playerId, payload: { optionId: 'no' } })
  }
  game.state.currentPlayerId = 'p0'
  game.state.phase = 'play'
  return game
}

function takeFromDrawPile(game: SanguoshaGame, predicate: (card: SanguoshaGame['state']['cards'][string]) => boolean): string {
  const cardId = game.state.zones.drawPile.find((id) => predicate(game.state.cards[id]))
  if (!cardId) throw new Error('牌堆中没有符合条件的测试牌')
  game.state.zones.drawPile = game.state.zones.drawPile.filter((id) => id !== cardId)
  return cardId
}

function giveNamed(game: SanguoshaGame, playerId: PlayerId, cardName: string): string {
  const cardId = takeFromDrawPile(game, (card) => card.name === cardName)
  game.state.players.find((player) => player.id === playerId)!.zones.hand.push(cardId)
  return cardId
}

function equip(game: SanguoshaGame, playerId: PlayerId, cardName: string, slot: 'weapon' | 'armor'): string {
  const cardId = takeFromDrawPile(game, (card) => card.name === cardName)
  game.state.players.find((player) => player.id === playerId)!.zones.equipment[slot] = cardId
  return cardId
}

type SlashNature = 'normal' | 'fire'

function giveSlash(game: SanguoshaGame, nature: SlashNature, playerId = 'p0', color?: 'red' | 'black'): string {
  const cardId = takeFromDrawPile(game, (card) => card.name === '杀'
    && (card.damageNature ?? 'normal') === 'normal'
    && (!color || card.color === color))
  if (nature === 'fire') setCardNature(game.state, cardId, 'fire')
  game.state.players.find((player) => player.id === playerId)!.zones.hand.push(cardId)
  return cardId
}

function prepareLiegongSlash(game: SanguoshaGame, nature: SlashNature, choice: 'yes' | 'no', color?: 'red' | 'black') {
  const source = game.state.players.find((player) => player.id === 'p0')!
  const target = game.state.players.find((player) => player.id === 'p1')!
  source.hp = 3
  game.state.zones.discardPile.push(...target.zones.hand)
  target.zones.hand = []
  for (let index = 0; index < 3; index += 1) giveNamed(game, 'p1', '闪')
  const slashId = giveSlash(game, nature, 'p0', color)
  const eventCounts = { cardUsed: 0, targetSpecified: 0, targetConfirmed: 0, damageInflicted: 0, damaged: 0, settled: [] as number[] }
  const offUsed = game.events.on('CardUsed', (context) => {
    if (context.event.cardIds?.includes(slashId)) eventCounts.cardUsed += 1
  })
  const offSpecified = game.events.on('TargetSpecified', (context) => {
    if (context.event.payload.cardId === slashId) eventCounts.targetSpecified += 1
  })
  const offConfirmed = game.events.on('TargetConfirmed', (context) => {
    if (context.event.payload.cardId === slashId) eventCounts.targetConfirmed += 1
  })
  const offInflicted = game.events.on('DamageInflicted', (context) => {
    if (context.event.cardIds?.includes(slashId)) eventCounts.damageInflicted += 1
  })
  const offDamaged = game.events.on('Damaged', (context) => {
    if (context.event.cardIds?.includes(slashId)) eventCounts.damaged += 1
  })
  const offSettled = game.events.on('DamageSettled', (context) => {
    if (context.event.payload.cardId === slashId) eventCounts.settled.push(Number(context.event.payload.finalAmount ?? 0))
  })
  const action = game.legalActions('p0').find((candidate) => candidate.kind === 'use-card'
    && candidate.cardIds.includes(slashId) && candidate.targetIds.includes('p1'))
  if (!action) throw new Error('构造不出黄忠对 p1 的实体杀')
  const hpBefore = target.hp
  game.act('p0', action.id)
  const choiceRequest = game.state.pendingRequests[0]
  if (choiceRequest?.kind !== 'choose-option' || !choiceRequest.prompt.includes('烈弓'))
    throw new Error(`未得到烈弓选项请求：${choiceRequest?.kind ?? 'none'}`)
  game.respond({ requestId: choiceRequest.id, playerId: 'p0', payload: { optionId: choice } })
  const postLiegongRequest = game.state.pendingRequests[0]
  if (choice === 'no' && postLiegongRequest?.kind === 'respond-card') {
    game.respond({ requestId: postLiegongRequest.id, playerId: 'p1', payload: { actionId: 'respond-pass' } })
  }
  offUsed(); offSpecified(); offConfirmed(); offInflicted(); offDamaged(); offSettled()
  return { game, slashId, hpBefore, eventCounts, postLiegongRequest }
}

function expectSettledOnce(game: SanguoshaGame, slashId: string) {
  expect(game.state.zones.discardPile, '实体杀应在结算后进入弃牌堆').toContain(slashId)
  expect(game.state.zones.processingArea, '结算后不能留在处理区').not.toContain(slashId)
  expect(game.state.players.some((player) => player.zones.hand.includes(slashId)), '结算后不能回到手牌').toBe(false)
  expect(game.state.pendingRequests, '结算后不能遗留请求').toHaveLength(0)
  expect(game.state.cardResolution, '结算后不能遗留牌续接状态').toBeNull()
  assertGameInvariants(game.state)
}

describe('异步目标插入续接后仍须重新检查【杀】是否有效', () => {
  it.each(['yes', 'no'] as const)('烈弓选择 %s 时，藤甲仍让普通杀无效且不造成伤害', (choice) => {
    const game = gameWith()
    equip(game, 'p1', '藤甲', 'armor')
    const { game: played, slashId, hpBefore, eventCounts } = prepareLiegongSlash(game, 'normal', choice)
    expect(played.state.players[1].hp, '藤甲应使普通杀不造成伤害').toBe(hpBefore)
    expect(eventCounts.damageInflicted, '无效杀不应进入伤害时机').toBe(0)
    expect(eventCounts.damaged).toBe(0)
    expect(eventCounts.settled).toEqual([])
    expect(eventCounts.targetSpecified, '异步回答后不能重复指定当前目标').toBe(1)
    expect(eventCounts.cardUsed).toBe(1)
    expect(eventCounts.targetConfirmed).toBe(1)
    expectSettledOnce(played, slashId)
  })

  it('火杀不被藤甲免疫，且藤甲使火焰伤害增加一点', () => {
    const game = gameWith()
    equip(game, 'p1', '藤甲', 'armor')
    const { game: played, slashId, hpBefore, eventCounts } = prepareLiegongSlash(game, 'fire', 'yes')
    expect(played.state.players[1].hp).toBe(hpBefore - 2)
    expect(eventCounts.damageInflicted).toBe(1)
    expect(eventCounts.damaged).toBe(1)
    expect(eventCounts.settled).toEqual([2])
    expect(eventCounts.targetSpecified).toBe(1)
    expect(eventCounts.cardUsed).toBe(1)
    expect(eventCounts.targetConfirmed).toBe(1)
    expectSettledOnce(played, slashId)
  })

})

describe('ARMOR-IGNORE：青釭剑对藤甲的既有装备规则', () => {
  it('张飞同步出杀时真实青釭剑应令藤甲失效并产生伤害', () => {
    const game = gameWith(['zhangfei', 'zhangfei', 'zhangfei', 'zhangfei', 'zhangfei'])
    const slashId = giveSlash(game, 'normal')
    equip(game, 'p0', '青釭剑', 'weapon')
    equip(game, 'p1', '藤甲', 'armor')
    const target = game.state.players[1]!
    game.state.zones.discardPile.push(...target.zones.hand)
    target.zones.hand = []
    giveNamed(game, 'p1', '闪')
    const hpBefore = target.hp
    const action = game.legalActions('p0').find((candidate) => candidate.kind === 'use-card'
      && candidate.cardIds.includes(slashId) && candidate.targetIds.includes('p1'))
    if (!action) throw new Error('构造不出张飞对 p1 的普通杀')

    game.act('p0', action.id)
    const dodge = game.state.pendingRequests[0]
    expect(dodge, '青釭剑应压制藤甲，否则普通杀会被整张牌免疫').toMatchObject({
      kind: 'respond-card', playerId: 'p1', requiredCardName: '闪',
    })
    if (dodge?.kind !== 'respond-card') return
    game.respond({ requestId: dodge.id, playerId: 'p1', payload: { actionId: 'respond-pass' } })
    expect(game.state.players[1]!.hp).toBe(hpBefore - 1)
    expect(game.state.zones.discardPile).toContain(slashId)
    expect(game.state.zones.processingArea).not.toContain(slashId)
    expect(game.state.pendingRequests).toHaveLength(0)
    expect(game.state.cardResolution).toBeNull()
    assertGameInvariants(game.state)
  })

  it('同一来源装备青釭剑后，普通杀应穿过目标藤甲', () => {
    const game = gameWith()
    equip(game, 'p0', '青釭剑', 'weapon')
    equip(game, 'p1', '藤甲', 'armor')
    const { game: played, slashId, hpBefore, eventCounts } = prepareLiegongSlash(game, 'normal', 'yes')
    expect(played.state.players[1].hp).toBe(hpBefore - 1)
    expect(eventCounts.damageInflicted).toBe(1)
    expect(eventCounts.damaged).toBe(1)
    expect(eventCounts.settled).toEqual([1])
    expect(eventCounts.targetSpecified).toBe(1)
    expect(eventCounts.cardUsed).toBe(1)
    expect(eventCounts.targetConfirmed).toBe(1)
    expectSettledOnce(played, slashId)
  })

})

describe('技能 cardEffectInvalid 在异步续接后仍须生效', () => {
  it('恢复后仍尊重于禁【毅重】的黑杀无效规则', () => {
    const game = gameWith(['huangzhong', 'yujin', 'zhangfei', 'zhangfei', 'zhangfei'])
    const { game: played, slashId, hpBefore, eventCounts } = prepareLiegongSlash(game, 'normal', 'yes', 'black')
    expect(played.state.players[1].hp).toBe(hpBefore)
    expect(eventCounts.damageInflicted).toBe(0)
    expect(eventCounts.damaged).toBe(0)
    expect(eventCounts.settled).toEqual([])
    expect(eventCounts.targetSpecified).toBe(1)
    expect(eventCounts.cardUsed).toBe(1)
    expect(eventCounts.targetConfirmed).toBe(1)
    expectSettledOnce(played, slashId)
  })

  it('青釭压制仅持续到该杀结算结束，防具实体保留且下一杀恢复藤甲', () => {
    const game = gameWith(['zhangfei', 'zhangfei', 'zhangfei', 'zhangfei', 'zhangfei'])
    const weaponId = equip(game, 'p0', '青釭剑', 'weapon')
    const armorId = equip(game, 'p1', '藤甲', 'armor')
    const target = game.state.players[1]!
    game.state.zones.discardPile.push(...target.zones.hand)
    target.zones.hand = []
    giveNamed(game, 'p1', '闪')

    const firstSlash = giveSlash(game, 'normal')
    const firstAction = game.legalActions('p0').find((candidate) => candidate.kind === 'use-card'
      && candidate.cardIds.includes(firstSlash) && candidate.targetIds.includes('p1'))
    if (!firstAction) throw new Error('构造不出青釭剑的第一张杀')
    const hpBeforeFirst = target.hp
    game.act('p0', firstAction.id)
    const firstDodge = game.state.pendingRequests[0]
    expect(firstDodge?.kind, '青釭剑压制藤甲后应向目标求闪').toBe('respond-card')
    if (firstDodge?.kind !== 'respond-card') return
    game.respond({ requestId: firstDodge.id, playerId: 'p1', payload: { actionId: 'respond-pass' } })

    expect(target.hp).toBe(hpBeforeFirst - 1)
    expect(target.zones.equipment.armor).toBe(armorId)
    expect(game.state.armorSuppressions?.some((entry) => entry.cardId === firstSlash)).toBe(false)
    expect(game.state.zones.discardPile).toContain(firstSlash)
    expect(game.state.cardResolution).toBeNull()
    assertGameInvariants(game.state)

    moveCard(game.state, weaponId, { kind: 'equipment', playerId: 'p0', slot: 'weapon' }, { kind: 'discardPile' })
    game.state.turnUsage.slashUses = 0
    const secondSlash = giveSlash(game, 'normal')
    const secondAction = game.legalActions('p0').find((candidate) => candidate.kind === 'use-card'
      && candidate.cardIds.includes(secondSlash) && candidate.targetIds.includes('p1'))
    if (!secondAction) throw new Error('构造不出移除青釭后的第二张杀')
    const hpBeforeSecond = target.hp
    game.act('p0', secondAction.id)

    expect(game.state.pendingRequests, '移除青釭后藤甲应直接令普通杀无效').toHaveLength(0)
    expect(target.hp).toBe(hpBeforeSecond)
    expect(target.zones.equipment.armor).toBe(armorId)
    expect(game.state.armorSuppressions?.some((entry) => entry.cardId === secondSlash)).toBe(false)
    expect(game.state.zones.discardPile).toContain(secondSlash)
    expect(game.state.cardResolution).toBeNull()
    assertGameInvariants(game.state)
  })

  it('来源装备效果被压制时，真实青釭剑不能穿过藤甲', () => {
    const game = gameWith(['zhangfei', 'zhangfei', 'zhangfei', 'zhangfei', 'zhangfei'])
    equip(game, 'p0', '青釭剑', 'weapon')
    const armorId = equip(game, 'p1', '藤甲', 'armor')
    suppressEquipmentEffectsUntilTurnEnd(game.state, 'p0', game.state.turnNumber)
    const slashId = giveSlash(game, 'normal')
    const hpBefore = game.state.players[1]!.hp
    const action = game.legalActions('p0').find((candidate) => candidate.kind === 'use-card'
      && candidate.cardIds.includes(slashId) && candidate.targetIds.includes('p1'))
    if (!action) throw new Error('构造不出装备效果被压制时的普通杀')

    game.act('p0', action.id)
    expect(game.state.pendingRequests, '被压制的青釭剑不能阻止藤甲免疫').toHaveLength(0)
    expect(game.state.players[1]!.hp).toBe(hpBefore)
    expect(game.state.players[1]!.zones.equipment.armor).toBe(armorId)
    expect(game.state.armorSuppressions?.some((entry) => entry.cardId === slashId)).toBe(false)
    expect(game.state.zones.discardPile).toContain(slashId)
    expect(game.state.cardResolution).toBeNull()
    assertGameInvariants(game.state)
  })

  it('夏侯恩虚拟青釭也不能绕过于禁【毅重】的无效黑杀', () => {
    const game = gameWith(['zhangfei', 'yujin', 'zhangfei', 'zhangfei', 'zhangfei'])
    game.state.players[0]!.grantedSkills.push(XIAHOU_EN_CHIJIAN)
    const slashId = giveSlash(game, 'normal', 'p0', 'black')
    const hpBefore = game.state.players[1]!.hp
    const action = game.legalActions('p0').find((candidate) => candidate.kind === 'use-card'
      && candidate.cardIds.includes(slashId) && candidate.targetIds.includes('p1'))
    if (!action) throw new Error('构造不出虚拟青釭对于禁的黑杀')

    game.act('p0', action.id)
    expect(game.state.pendingRequests, '青釭只绕过防具，不能绕过技能免疫').toHaveLength(0)
    expect(game.state.players[1]!.hp).toBe(hpBefore)
    expect(game.state.armorSuppressions?.some((entry) => entry.cardId === slashId)).toBe(false)
    expect(game.state.zones.discardPile).toContain(slashId)
    expect(game.state.cardResolution).toBeNull()
  })
})

