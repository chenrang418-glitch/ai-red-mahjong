import { describe, expect, it } from 'vitest'
import { SanguoshaGame } from '@/sanguosha/engine/game'
import { assertGameInvariants } from '@/sanguosha/engine/invariants'
import type { GameSetup, Identity, PlayerId } from '@/sanguosha/engine/types'

/**
 * 需要发问的装备特效。
 *
 * 这类东西最容易「代码写了但永远触发不到」，所以每个用例都从
 * 「出一张真的杀」开始走完整流程，而不是直接调内部函数。
 */

function setup(): GameSetup {
  return {
    mode: 'identity', generalChoices: 1,
    players: Array.from({ length: 5 }, (_, index) => ({ id: `p${index}`, nickname: `玩家${index}`, isHuman: false })),
  }
}

function gameWith(seed = 'equip-request'): SanguoshaGame {
  const game = new SanguoshaGame({ seed, setup: setup() })
  const identities: Identity[] = ['lord', 'rebel', 'loyalist', 'rebel', 'renegade']
  game.state.players.forEach((player, index) => {
    player.identity = identities[index]
    player.identityRevealed = identities[index] === 'lord'
    // 马术是纯锁定技，不会插进来发问
    player.characterId = 'machao'
  })
  game.start()
  game.state.currentPlayerId = 'p0'
  game.state.phase = 'play'
  return game
}

function pending(game: SanguoshaGame) {
  return game.state.pendingRequests[0]
}

/** 从牌堆里取一张指定名字的牌塞进某人手里。 */
function giveCard(game: SanguoshaGame, playerId: PlayerId, cardName: string): string {
  const cardId = game.state.zones.drawPile.find((id) => game.state.cards[id].name === cardName)
  if (!cardId) throw new Error(`牌堆里没有【${cardName}】`)
  game.state.zones.drawPile = game.state.zones.drawPile.filter((id) => id !== cardId)
  game.state.players.find((player) => player.id === playerId)!.zones.hand.push(cardId)
  return cardId
}

/**
 * 直接把武器装上，跳过出牌流程。
 *
 * 开局发牌之后这张牌可能已经在别人手上了，所以牌堆、手牌、弃牌堆都要找一遍——
 * 只看牌堆会因为发牌运气不同而随机失败。
 */
function equipWeapon(game: SanguoshaGame, playerId: PlayerId, weaponName: string): string {
  const cardId = Object.values(game.state.cards).find((card) => card.name === weaponName)?.id
  if (!cardId) throw new Error(`这副牌里没有【${weaponName}】`)
  game.state.zones.drawPile = game.state.zones.drawPile.filter((id) => id !== cardId)
  game.state.zones.discardPile = game.state.zones.discardPile.filter((id) => id !== cardId)
  for (const player of game.state.players) {
    player.zones.hand = player.zones.hand.filter((id) => id !== cardId)
  }
  game.state.players.find((player) => player.id === playerId)!.zones.equipment.weapon = cardId
  return cardId
}

/** p0 对 p1 出一张杀，p1 用闪挡掉。返回那张杀的 id。 */
function slashAndDodge(game: SanguoshaGame): string {
  const slash = giveCard(game, 'p0', '杀')
  const dodge = giveCard(game, 'p1', '闪')
  const action = game.legalActions('p0').find((candidate) => candidate.kind === 'use-card'
    && candidate.cardIds.includes(slash) && candidate.targetIds.includes('p1'))
  if (!action) throw new Error('构造不出对 p1 的杀')
  game.act('p0', action.id)

  const request = pending(game)
  expect(request.playerId).toBe('p1')
  game.respond({ requestId: request.id, playerId: 'p1', payload: { actionId: `respond-dodge:${dodge}` } })
  return slash
}

describe('贯石斧', () => {
  it('弃两张牌可以让被闪掉的杀依然造成伤害', () => {
    const game = gameWith()
    equipWeapon(game, 'p0', '贯石斧')
    const victim = game.state.players[1]
    const hpBefore = victim.hp
    slashAndDodge(game)

    const ask = pending(game)
    expect(ask, '闪掉之后应当问攻击方要不要发动').toBeTruthy()
    expect(ask.playerId).toBe('p0')
    expect(ask.prompt).toContain('贯石斧')
    game.respond({ requestId: ask.id, playerId: 'p0', payload: { optionId: 'yes' } })

    const discard = pending(game)
    expect(discard.kind).toBe('choose-cards')
    const owner = game.state.players[0]
    const toDiscard = (discard as { cardIds: string[] }).cardIds.slice(0, 2)
    game.respond({ requestId: discard.id, playerId: 'p0', payload: { cardIds: toDiscard } })

    expect(victim.hp).toBe(hpBefore - 1)
    for (const cardId of toDiscard) {
      expect(owner.zones.hand).not.toContain(cardId)
      expect(game.state.zones.discardPile).toContain(cardId)
    }
    assertGameInvariants(game.state)
  })

  it('放弃发动就什么也不做', () => {
    const game = gameWith()
    equipWeapon(game, 'p0', '贯石斧')
    const victim = game.state.players[1]
    const hpBefore = victim.hp
    slashAndDodge(game)

    game.respond({ requestId: pending(game).id, playerId: 'p0', payload: { optionId: 'no' } })
    expect(victim.hp).toBe(hpBefore)
    expect(game.state.pendingRequests).toHaveLength(0)
    expect(game.state.cardResolution).toBeNull()
    assertGameInvariants(game.state)
  })

  it('可弃的牌不足两张时根本不发问', () => {
    const game = gameWith('equip-empty')
    equipWeapon(game, 'p0', '贯石斧')
    const slash = giveCard(game, 'p0', '杀')
    const dodge = giveCard(game, 'p1', '闪')
    const action = game.legalActions('p0').find((candidate) => candidate.kind === 'use-card'
      && candidate.cardIds.includes(slash) && candidate.targetIds.includes('p1'))!
    // 手上只留这张杀，出掉之后可弃的就只剩装备区那把斧头，凑不够两张
    const owner = game.state.players[0]
    game.state.zones.discardPile.push(...owner.zones.hand.filter((id) => id !== slash))
    owner.zones.hand = [slash]

    game.act('p0', action.id)
    game.respond({ requestId: pending(game).id, playerId: 'p1', payload: { actionId: `respond-dodge:${dodge}` } })
    expect(game.state.pendingRequests).toHaveLength(0)
  })
})

describe('青龙偃月刀', () => {
  it('被闪掉之后可以立即再出一张杀', () => {
    const game = gameWith()
    equipWeapon(game, 'p0', '青龙偃月刀')
    const second = giveCard(game, 'p0', '杀')
    slashAndDodge(game)

    const ask = pending(game)
    expect(ask, '闪掉之后应当问要不要追杀').toBeTruthy()
    expect(ask.playerId).toBe('p0')
    expect(ask.prompt).toContain('青龙偃月刀')
    expect((ask as { cardIds: string[] }).cardIds).toContain(second)

    game.respond({ requestId: ask.id, playerId: 'p0', payload: { cardIds: [second] } })

    // 追加的杀要真的打出去：现在应当轮到 p1 再响应一次
    const dodgeRequest = pending(game)
    expect(dodgeRequest, '追加的杀应当向目标求闪').toBeTruthy()
    expect(dodgeRequest.playerId).toBe('p1')
    expect(dodgeRequest.kind).toBe('respond-card')

    const victim = game.state.players[1]
    const hpBefore = victim.hp
    game.respond({ requestId: dodgeRequest.id, playerId: 'p1', payload: { actionId: 'respond-pass' } })
    expect(victim.hp).toBe(hpBefore - 1)
    assertGameInvariants(game.state)
  })

  it('追加的杀不占用本回合的出杀次数', () => {
    const game = gameWith()
    equipWeapon(game, 'p0', '青龙偃月刀')
    const second = giveCard(game, 'p0', '杀')
    slashAndDodge(game)
    const usesAfterFirst = game.state.turnUsage.slashUses

    game.respond({ requestId: pending(game).id, playerId: 'p0', payload: { cardIds: [second] } })
    game.respond({ requestId: pending(game).id, playerId: 'p1', payload: { actionId: 'respond-pass' } })
    expect(game.state.turnUsage.slashUses).toBe(usesAfterFirst)
  })

  it('空选表示放弃', () => {
    const game = gameWith()
    equipWeapon(game, 'p0', '青龙偃月刀')
    giveCard(game, 'p0', '杀')
    slashAndDodge(game)
    game.respond({ requestId: pending(game).id, playerId: 'p0', payload: { cardIds: [] } })
    expect(game.state.pendingRequests).toHaveLength(0)
    expect(game.state.cardResolution).toBeNull()
    assertGameInvariants(game.state)
  })

  it('手上没有第二张杀时不发问', () => {
    const game = gameWith('equip-noslash')
    equipWeapon(game, 'p0', '青龙偃月刀')
    const slash = giveCard(game, 'p0', '杀')
    const dodge = giveCard(game, 'p1', '闪')
    // 手上只留这一张杀
    const owner = game.state.players[0]
    game.state.zones.discardPile.push(...owner.zones.hand.filter((id) => id !== slash))
    owner.zones.hand = [slash]
    const action = game.legalActions('p0').find((candidate) => candidate.kind === 'use-card'
      && candidate.cardIds.includes(slash) && candidate.targetIds.includes('p1'))!
    game.act('p0', action.id)
    game.respond({ requestId: pending(game).id, playerId: 'p1', payload: { actionId: `respond-dodge:${dodge}` } })
    expect(game.state.pendingRequests).toHaveLength(0)
  })
})

describe('没装这些武器的人不受影响', () => {
  it('普通武器闪掉之后直接结束，不发问', () => {
    const game = gameWith()
    equipWeapon(game, 'p0', '古锭刀')
    slashAndDodge(game)
    expect(game.state.pendingRequests).toHaveLength(0)
    expect(game.state.cardResolution).toBeNull()
    assertGameInvariants(game.state)
  })
})

/** p0 对 p1 出一张杀，p1 不闪。返回那张杀的 id。 */
function slashAndTakeHit(game: SanguoshaGame): string {
  const slash = giveCard(game, 'p0', '杀')
  const action = game.legalActions('p0').find((candidate) => candidate.kind === 'use-card'
    && candidate.cardIds.includes(slash) && candidate.targetIds.includes('p1'))
  if (!action) throw new Error('构造不出对 p1 的杀')
  game.act('p0', action.id)
  const request = pending(game)
  expect(request.playerId).toBe('p1')
  game.respond({ requestId: request.id, playerId: 'p1', payload: { actionId: 'respond-pass' } })
  return slash
}

/** 把目标手上的闪全部拿掉，保证杀一定命中。 */
function stripDodges(game: SanguoshaGame, playerId: PlayerId): void {
  const owner = game.state.players.find((player) => player.id === playerId)!
  const kept: string[] = []
  for (const cardId of owner.zones.hand) {
    if (game.state.cards[cardId].name === '闪') game.state.zones.discardPile.push(cardId)
    else kept.push(cardId)
  }
  owner.zones.hand = kept
}

describe('寒冰剑', () => {
  it('可以把伤害换成弃置目标两张牌', () => {
    const game = gameWith('hanbing')
    equipWeapon(game, 'p0', '寒冰剑')
    stripDodges(game, 'p1')
    const victim = game.state.players[1]
    const hpBefore = victim.hp
    const handBefore = victim.zones.hand.length
    expect(handBefore).toBeGreaterThanOrEqual(2)
    slashAndTakeHit(game)

    const ask = pending(game)
    expect(ask, '命中之后应当先问寒冰剑').toBeTruthy()
    expect(ask.playerId).toBe('p0')
    expect(ask.prompt).toContain('寒冰剑')
    game.respond({ requestId: ask.id, playerId: 'p0', payload: { optionId: 'yes' } })

    // 连问两张
    for (let round = 0; round < 2; round += 1) {
      const pick = pending(game)
      expect(pick.kind).toBe('choose-cards')
      const options = [...(pick as { cardIds: string[] }).cardIds, ...(pick as { hiddenCardSlots: string[] }).hiddenCardSlots]
      game.respond({ requestId: pick.id, playerId: 'p0', payload: { cardIds: [options[0]] } })
    }

    expect(victim.hp, '寒冰剑替代伤害，不该掉血').toBe(hpBefore)
    expect(victim.zones.hand.length).toBe(handBefore - 2)
    assertGameInvariants(game.state)
  })

  it('放弃发动则伤害照常结算', () => {
    const game = gameWith('hanbing-no')
    equipWeapon(game, 'p0', '寒冰剑')
    stripDodges(game, 'p1')
    const victim = game.state.players[1]
    const hpBefore = victim.hp
    slashAndTakeHit(game)
    game.respond({ requestId: pending(game).id, playerId: 'p0', payload: { optionId: 'no' } })
    expect(victim.hp).toBe(hpBefore - 1)
    assertGameInvariants(game.state)
  })

  it('目标一张牌都没有时不发问，伤害照常', () => {
    const game = gameWith('hanbing-empty')
    equipWeapon(game, 'p0', '寒冰剑')
    const victim = game.state.players[1]
    game.state.zones.discardPile.push(...victim.zones.hand)
    victim.zones.hand = []
    const hpBefore = victim.hp
    slashAndTakeHit(game)
    expect(game.state.pendingRequests).toHaveLength(0)
    expect(victim.hp).toBe(hpBefore - 1)
    assertGameInvariants(game.state)
  })
})

describe('麒麟弓', () => {
  it('造成伤害后可以弃掉目标的一匹坐骑', () => {
    const game = gameWith('qilin')
    equipWeapon(game, 'p0', '麒麟弓')
    stripDodges(game, 'p1')
    const victim = game.state.players[1]
    // 给目标装一匹马
    const horseId = game.state.zones.drawPile.find((id) => game.state.cards[id].equipmentSlot === 'offensiveHorse')!
    game.state.zones.drawPile = game.state.zones.drawPile.filter((id) => id !== horseId)
    victim.zones.equipment.offensiveHorse = horseId

    const hpBefore = victim.hp
    slashAndTakeHit(game)
    // 伤害先结算，弃马是之后排队问的
    expect(victim.hp).toBe(hpBefore - 1)

    const ask = pending(game)
    expect(ask, '伤害之后应当问麒麟弓').toBeTruthy()
    expect(ask.prompt).toContain('麒麟弓')
    expect((ask as { cardIds: string[] }).cardIds).toContain(horseId)

    game.respond({ requestId: ask.id, playerId: 'p0', payload: { cardIds: [horseId] } })
    expect(victim.zones.equipment.offensiveHorse).toBeNull()
    expect(game.state.zones.discardPile).toContain(horseId)
    assertGameInvariants(game.state)
  })

  it('目标没有坐骑时不发问', () => {
    const game = gameWith('qilin-nohorse')
    equipWeapon(game, 'p0', '麒麟弓')
    stripDodges(game, 'p1')
    const victim = game.state.players[1]
    victim.zones.equipment.offensiveHorse = null
    victim.zones.equipment.defensiveHorse = null
    slashAndTakeHit(game)
    expect(game.state.pendingRequests).toHaveLength(0)
    assertGameInvariants(game.state)
  })

  it('空选表示放弃，马还在', () => {
    const game = gameWith('qilin-pass')
    equipWeapon(game, 'p0', '麒麟弓')
    stripDodges(game, 'p1')
    const victim = game.state.players[1]
    const horseId = game.state.zones.drawPile.find((id) => game.state.cards[id].equipmentSlot === 'defensiveHorse')!
    game.state.zones.drawPile = game.state.zones.drawPile.filter((id) => id !== horseId)
    victim.zones.equipment.defensiveHorse = horseId

    slashAndTakeHit(game)
    game.respond({ requestId: pending(game).id, playerId: 'p0', payload: { cardIds: [] } })
    expect(victim.zones.equipment.defensiveHorse).toBe(horseId)
    assertGameInvariants(game.state)
  })
})

/** 把某人的武将换掉，用来控制性别。 */
function setCharacter(game: SanguoshaGame, playerId: PlayerId, characterId: string): void {
  game.state.players.find((player) => player.id === playerId)!.characterId = characterId
}

describe('雌雄双股剑', () => {
  it('对异性目标发问，目标可以选择弃一张手牌', () => {
    const game = gameWith('cixiong')
    equipWeapon(game, 'p0', '雌雄双股剑')
    setCharacter(game, 'p0', 'guanyu')       // 男
    setCharacter(game, 'p1', 'sunshangxiang') // 女
    const victim = game.state.players[1]
    const handBefore = victim.zones.hand.length

    const slash = giveCard(game, 'p0', '杀')
    const action = game.legalActions('p0').find((candidate) => candidate.kind === 'use-card'
      && candidate.cardIds.includes(slash) && candidate.targetIds.includes('p1'))!
    game.act('p0', action.id)

    // 求闪之前先问目标
    const ask = pending(game)
    expect(ask.playerId, '雌雄双股剑问的是目标，不是持剑的人').toBe('p1')
    expect(ask.prompt).toContain('雌雄双股剑')
    expect(game.state.cardResolution?.stage).toBe('awaiting-intercept')
    assertGameInvariants(game.state)

    game.respond({ requestId: ask.id, playerId: 'p1', payload: { optionId: 'discard' } })
    const discard = pending(game)
    expect(discard.kind).toBe('choose-cards')
    game.respond({ requestId: discard.id, playerId: 'p1', payload: { cardIds: [victim.zones.hand[0]] } })

    expect(victim.zones.hand.length).toBe(handBefore - 1)
    // 剑结束之后回到正常求闪
    const dodgeRequest = pending(game)
    expect(dodgeRequest.kind).toBe('respond-card')
    expect(dodgeRequest.playerId).toBe('p1')
    expect(game.state.cardResolution?.stage).toBe('awaiting-dodge')
    assertGameInvariants(game.state)
  })

  it('目标也可以选择让持剑者摸一张牌', () => {
    const game = gameWith('cixiong-draw')
    equipWeapon(game, 'p0', '雌雄双股剑')
    setCharacter(game, 'p0', 'guanyu')
    setCharacter(game, 'p1', 'sunshangxiang')
    const slash = giveCard(game, 'p0', '杀')
    // 拿到杀之后再记数：出掉这张杀、再摸回一张，净持平
    const attackerHandBefore = game.state.players[0].zones.hand.length
    const action = game.legalActions('p0').find((candidate) => candidate.kind === 'use-card'
      && candidate.cardIds.includes(slash) && candidate.targetIds.includes('p1'))!
    game.act('p0', action.id)
    game.respond({ requestId: pending(game).id, playerId: 'p1', payload: { optionId: 'draw' } })

    expect(game.state.players[0].zones.hand.length).toBe(attackerHandBefore)
    expect(pending(game).kind).toBe('respond-card')
    assertGameInvariants(game.state)
  })

  it('同性目标完全不触发', () => {
    const game = gameWith('cixiong-same')
    equipWeapon(game, 'p0', '雌雄双股剑')
    setCharacter(game, 'p0', 'guanyu')
    setCharacter(game, 'p1', 'zhangfei') // 同为男性

    const slash = giveCard(game, 'p0', '杀')
    const action = game.legalActions('p0').find((candidate) => candidate.kind === 'use-card'
      && candidate.cardIds.includes(slash) && candidate.targetIds.includes('p1'))!
    game.act('p0', action.id)
    // 直接进求闪
    expect(pending(game).kind).toBe('respond-card')
    expect(game.state.cardResolution?.stage).toBe('awaiting-dodge')
  })

  it('目标没有手牌时只给「让对方摸牌」一个选项', () => {
    const game = gameWith('cixiong-empty')
    equipWeapon(game, 'p0', '雌雄双股剑')
    setCharacter(game, 'p0', 'guanyu')
    setCharacter(game, 'p1', 'sunshangxiang')
    const victim = game.state.players[1]
    game.state.zones.discardPile.push(...victim.zones.hand)
    victim.zones.hand = []

    const slash = giveCard(game, 'p0', '杀')
    const action = game.legalActions('p0').find((candidate) => candidate.kind === 'use-card'
      && candidate.cardIds.includes(slash) && candidate.targetIds.includes('p1'))!
    game.act('p0', action.id)

    const ask = pending(game)
    const options = (ask as { options: Array<{ id: string }> }).options
    expect(options.map((option) => option.id)).toEqual(['draw'])
  })
})
