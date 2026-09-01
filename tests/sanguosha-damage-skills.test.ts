import { describe, expect, it } from 'vitest'
import { SanguoshaGame } from '@/sanguosha/engine/game'
import { hiddenHandSlot } from '@/sanguosha/engine/cards/host'
import { assertGameInvariants } from '@/sanguosha/engine/invariants'
import type { GameSetup, Identity, PlayerId } from '@/sanguosha/engine/types'

/**
 * 「受到伤害后」触发的技能。
 *
 * 这类技能不在 Damaged 事件里当场发问，而是排队等牌局干净了再问。
 * 所以每个用例都要确认两件事：
 * 1. 伤害当场不会冒出请求（否则会和濒死救援抢同一个玩家）；
 * 2. 牌局回到干净状态之后，请求确实出现了。
 */

function setup(): GameSetup {
  return {
    mode: 'identity', generalChoices: 1,
    players: Array.from({ length: 5 }, (_, index) => ({ id: `p${index}`, nickname: `玩家${index}`, isHuman: index === 0 })),
  }
}

function gameWith(characterIds: (string | null)[], seed = 'damage-skill'): SanguoshaGame {
  const game = new SanguoshaGame({ seed, setup: setup() })
  const identities: Identity[] = ['lord', 'rebel', 'loyalist', 'rebel', 'renegade']
  game.state.players.forEach((player, index) => {
    player.identity = identities[index]
    // 默认给马术，它是纯锁定技，不会插进来发问
    player.characterId = characterIds[index] ?? 'machao'
  })
  game.start()
  // 主公若带发问技能，开局的准备阶段会先问一次，这里不关心，先清掉
  while (game.state.pendingRequests.length > 0) {
    const request = game.state.pendingRequests[0]
    game.respond({ requestId: request.id, playerId: request.playerId, payload: { optionId: 'no' } })
  }
  return game
}

function pending(game: SanguoshaGame) {
  return game.state.pendingRequests[0]
}

function answer(game: SanguoshaGame, payload: unknown): void {
  const request = pending(game)
  expect(request, '期望有一个待处理请求').toBeTruthy()
  game.respond({ requestId: request.id, playerId: request.playerId, payload })
}

/** 造成伤害并把牌局推回干净状态，让排队的技能发问出来。 */
function damageThenSettle(game: SanguoshaGame, options: { sourceId?: PlayerId; targetId: PlayerId; amount?: number; cardName?: string; cardId?: string }): void {
  game.damage({ nature: 'normal', ...options })
  // 伤害当场不该冒出请求
  expect(game.state.pendingRequests, '伤害结算中途不应该发问').toHaveLength(0)
  expect(game.state.skillQueue.length, '技能应当已经排队').toBeGreaterThan(0)
  game.advancePhase()
}

describe('受到伤害后触发的技能', () => {
  it('奸雄：获得造成伤害的那张牌', () => {
    const game = gameWith([null, 'caocao'])
    const cardId = game.state.zones.drawPile[0]
    // 模拟这张牌用完之后进弃牌堆
    game.state.zones.drawPile.shift()
    game.state.zones.discardPile.push(cardId)

    damageThenSettle(game, { sourceId: 'p0', targetId: 'p1', cardName: '杀', cardId })

    const request = pending(game)
    expect(request.kind).toBe('choose-option')
    expect(request.playerId).toBe('p1')
    expect(request.prompt).toContain(game.state.cards[cardId].name)

    answer(game, { optionId: 'yes' })
    expect(game.state.players[1].zones.hand).toContain(cardId)
    expect(game.state.zones.discardPile).not.toContain(cardId)
    assertGameInvariants(game.state)
  })

  it('奸雄：牌已经不在弃牌堆时安静放弃，不发问', () => {
    const game = gameWith([null, 'caocao'])
    const cardId = game.state.zones.drawPile[0]
    // 牌还在牌堆里，不在弃牌堆
    damageThenSettle(game, { sourceId: 'p0', targetId: 'p1', cardName: '杀', cardId })
    expect(game.state.pendingRequests).toHaveLength(0)
    expect(game.state.skillResolution).toBeNull()
  })

  it('反馈：可以从暗手牌里拿一张，来源手牌数减一', () => {
    const game = gameWith([null, 'simayi'])
    const source = game.state.players[0]
    const handBefore = source.zones.hand.length
    expect(handBefore).toBeGreaterThan(0)

    damageThenSettle(game, { sourceId: 'p0', targetId: 'p1', cardName: '杀' })
    const request = pending(game)
    expect(request.kind).toBe('choose-cards')
    // 别人的手牌只以占位槽出现，牌 id 不能泄露
    const chooseCards = request as { cardIds: string[]; hiddenCardSlots: string[] }
    expect(chooseCards.hiddenCardSlots).toHaveLength(handBefore)
    for (const cardId of source.zones.hand) expect(chooseCards.cardIds).not.toContain(cardId)

    answer(game, { cardIds: [hiddenHandSlot('p0', 0)] })
    expect(source.zones.hand.length).toBe(handBefore - 1)
    expect(game.state.players[1].zones.hand.length).toBeGreaterThan(0)
    assertGameInvariants(game.state)
  })

  it('反馈：来源没有任何牌时不发问', () => {
    const game = gameWith([null, 'simayi'])
    game.state.zones.discardPile.push(...game.state.players[0].zones.hand)
    game.state.players[0].zones.hand = []
    damageThenSettle(game, { sourceId: 'p0', targetId: 'p1', cardName: '杀' })
    expect(game.state.pendingRequests).toHaveLength(0)
  })

  it('刚烈：判定非红桃时，来源选择弃两张牌', () => {
    const game = gameWith([null, 'xiahoudun'])
    const blackId = Object.values(game.state.cards).find((card) => card.suit === 'spade' && game.state.zones.drawPile.includes(card.id))!.id
    game.state.zones.drawPile = [blackId, ...game.state.zones.drawPile.filter((id) => id !== blackId)]

    damageThenSettle(game, { sourceId: 'p0', targetId: 'p1', cardName: '杀' })
    expect(pending(game).playerId).toBe('p1')
    answer(game, { optionId: 'yes' })

    // 判定之后轮到伤害来源做选择
    const choice = pending(game)
    expect(choice.playerId).toBe('p0')
    expect(choice.kind).toBe('choose-option')
    answer(game, { optionId: 'discard' })

    const discard = pending(game)
    expect(discard.kind).toBe('choose-cards')
    const handBefore = game.state.players[0].zones.hand.length
    answer(game, { cardIds: game.state.players[0].zones.hand.slice(0, 2) })
    expect(game.state.players[0].zones.hand.length).toBe(handBefore - 2)
    assertGameInvariants(game.state)
  })

  it('刚烈：判定为红桃时什么也不发生', () => {
    const game = gameWith([null, 'xiahoudun'])
    const heartId = Object.values(game.state.cards).find((card) => card.suit === 'heart' && game.state.zones.drawPile.includes(card.id))!.id
    game.state.zones.drawPile = [heartId, ...game.state.zones.drawPile.filter((id) => id !== heartId)]

    const hpBefore = game.state.players[0].hp
    const handBefore = game.state.players[0].zones.hand.length
    damageThenSettle(game, { sourceId: 'p0', targetId: 'p1', cardName: '杀' })
    answer(game, { optionId: 'yes' })

    expect(game.state.pendingRequests).toHaveLength(0)
    expect(game.state.players[0].hp).toBe(hpBefore)
    expect(game.state.players[0].zones.hand.length).toBe(handBefore)
  })

  it('刚烈：来源选择失去体力', () => {
    const game = gameWith([null, 'xiahoudun'])
    const blackId = Object.values(game.state.cards).find((card) => card.suit === 'club' && game.state.zones.drawPile.includes(card.id))!.id
    game.state.zones.drawPile = [blackId, ...game.state.zones.drawPile.filter((id) => id !== blackId)]

    const hpBefore = game.state.players[0].hp
    damageThenSettle(game, { sourceId: 'p0', targetId: 'p1', cardName: '杀' })
    answer(game, { optionId: 'yes' })
    answer(game, { optionId: 'lose-hp' })
    expect(game.state.players[0].hp).toBe(hpBefore - 1)
    assertGameInvariants(game.state)
  })

  it('遗计：受到两点伤害就问两次，牌可以分给别人', () => {
    const game = gameWith([null, 'guojia'])
    const guojia = game.state.players[1]
    guojia.maxHp = 5
    guojia.hp = 5

    damageThenSettle(game, { sourceId: 'p0', targetId: 'p1', amount: 2, cardName: '决斗' })
    // 每一点伤害各排一次
    expect(game.state.skillQueue.length + 1).toBe(2)

    const handBefore = guojia.zones.hand.length
    answer(game, { optionId: 'yes' })
    expect(guojia.zones.hand.length).toBe(handBefore + 2)

    const distribute = pending(game)
    expect(distribute.kind).toBe('distribute-cards')
    const [first] = (distribute as { cardIds: string[] }).cardIds
    const receiverBefore = game.state.players[2].zones.hand.length
    answer(game, { assignments: [{ cardId: first, recipientId: 'p2' }] })

    expect(game.state.players[2].zones.hand.length).toBe(receiverBefore + 1)
    expect(guojia.zones.hand).not.toContain(first)

    // 第二点伤害的那一次紧接着问出来
    expect(pending(game).prompt).toContain('遗计')
    answer(game, { optionId: 'no' })
    expect(game.state.pendingRequests).toHaveLength(0)
    assertGameInvariants(game.state)
  })

  it('排队的技能在濒死救援结束之前不会发问', () => {
    const game = gameWith([null, 'caocao'])
    const caocao = game.state.players[1]
    caocao.hp = 1
    const cardId = game.state.zones.drawPile.shift()!
    game.state.zones.discardPile.push(cardId)

    game.damage({ sourceId: 'p0', targetId: 'p1', amount: 1, nature: 'normal', cardName: '杀', cardId })
    // 现在应该是濒死求桃，而不是奸雄
    expect(game.state.dying?.playerId).toBe('p1')
    expect(pending(game).kind).toBe('rescue')
    expect(game.state.skillQueue.length).toBe(1)
    assertGameInvariants(game.state)
  })

  it('整个等待状态可以过一遍 JSON——DO 才存得住', () => {
    const game = gameWith([null, 'guojia'])
    game.damage({ sourceId: 'p0', targetId: 'p1', amount: 1, nature: 'normal', cardName: '杀' })
    expect(game.state.skillQueue).toHaveLength(1)
    const roundTripped = JSON.parse(JSON.stringify(game.state))
    expect(roundTripped.skillQueue).toEqual(game.state.skillQueue)
  })
})
