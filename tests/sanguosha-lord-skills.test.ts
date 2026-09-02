import { describe, expect, it } from 'vitest'
import { SanguoshaGame } from '@/sanguosha/engine/game'
import { assertGameInvariants } from '@/sanguosha/engine/invariants'
import type { GameSetup, Identity, PlayerId } from '@/sanguosha/engine/types'

// 填充角色用张飞而不是马超：马超有了【铁骑】之后，每次出杀都会多一个询问，
// 把这些测试的响应序列全部打乱。张飞的【咆哮】是纯被动（只放宽出杀次数），
// 不产生任何请求，才是真正的「无干扰填充」。

/**
 * 主公技。
 *
 * 主公技只在坐主公位时生效，所以每个用例都成对验证：
 * 坐主公位时生效，不坐主公位时**必须**没有任何效果。
 */

function setup(count = 5): GameSetup {
  return {
    mode: 'identity', generalChoices: 1,
    players: Array.from({ length: count }, (_, index) => ({ id: `p${index}`, nickname: `玩家${index}`, isHuman: false })),
  }
}

function gameWith(characterIds: (string | null)[], identities: Identity[], seed = 'lord-skill'): SanguoshaGame {
  const game = new SanguoshaGame({ seed, setup: setup(characterIds.length) })
  game.state.players.forEach((player, index) => {
    player.identity = identities[index]
    player.identityRevealed = identities[index] === 'lord'
    player.characterId = characterIds[index] ?? 'zhangfei'
  })
  game.start()
  while (game.state.pendingRequests.length > 0) {
    const request = game.state.pendingRequests[0]
    game.respond({ requestId: request.id, playerId: request.playerId, payload: { optionId: 'no' } })
  }
  return game
}

const LORD_FIRST: Identity[] = ['lord', 'rebel', 'loyalist', 'rebel', 'renegade']
/** 曹操坐在 p1，主公是 p0，用来验证主公技不生效 */
const LORD_ELSEWHERE: Identity[] = ['lord', 'rebel', 'loyalist', 'rebel', 'renegade']

function pending(game: SanguoshaGame) {
  return game.state.pendingRequests[0]
}

/** 把一张指定名字的牌塞进某人手里，返回牌 id。 */
function giveCard(game: SanguoshaGame, playerId: PlayerId, cardName: string): string {
  const cardId = game.state.zones.drawPile.find((id) => game.state.cards[id].name === cardName)
  if (!cardId) throw new Error(`牌堆里没有【${cardName}】`)
  game.state.zones.drawPile = game.state.zones.drawPile.filter((id) => id !== cardId)
  game.state.players.find((player) => player.id === playerId)!.zones.hand.push(cardId)
  return cardId
}

/** 清空某人手里所有指定名字的牌，避免他自己就能响应。 */
function stripCard(game: SanguoshaGame, playerId: PlayerId, cardName: string): void {
  const owner = game.state.players.find((player) => player.id === playerId)!
  const kept: string[] = []
  for (const cardId of owner.zones.hand) {
    if (game.state.cards[cardId].name === cardName) game.state.zones.discardPile.push(cardId)
    else kept.push(cardId)
  }
  owner.zones.hand = kept
}

describe('主公技', () => {
  it('护驾：主公打不出闪时，魏势力角色被依次询问', () => {
    // p0 曹操主公，p2 司马懿（魏）忠臣
    const game = gameWith(['caocao', 'zhangfei', 'simayi', 'zhangfei', 'zhangfei'], LORD_FIRST)
    stripCard(game, 'p0', '闪')
    const allyDodge = giveCard(game, 'p2', '闪')
    const slash = giveCard(game, 'p1', '杀')

    game.state.currentPlayerId = 'p1'
    game.state.phase = 'play'
    const action = game.legalActions('p1').find((candidate) => candidate.kind === 'use-card'
      && candidate.cardIds.includes(slash) && candidate.targetIds.includes('p0'))
    expect(action, '应当能对主公出杀').toBeTruthy()
    game.act('p1', action!.id)

    // 先问主公自己
    expect(pending(game).playerId).toBe('p0')
    game.respond({ requestId: pending(game).id, playerId: 'p0', payload: { actionId: 'respond-pass' } })

    // 主公放弃之后转问魏势力角色
    const surrogateRequest = pending(game)
    expect(surrogateRequest, '护驾应当转问同势力角色').toBeTruthy()
    expect(surrogateRequest.playerId).toBe('p2')
    expect(surrogateRequest.prompt).toContain('主公')

    const hpBefore = game.state.players[0].hp
    game.respond({ requestId: surrogateRequest.id, playerId: 'p2', payload: { actionId: `respond-dodge:${allyDodge}` } })
    // 代打成功，主公不掉血
    expect(game.state.players[0].hp).toBe(hpBefore)
    expect(game.state.cardResolution).toBeNull()
    assertGameInvariants(game.state)
  })

  it('护驾：所有魏势力角色都放弃时，伤害照常结算', () => {
    const game = gameWith(['caocao', 'zhangfei', 'simayi', 'zhangfei', 'zhangfei'], LORD_FIRST)
    stripCard(game, 'p0', '闪')
    stripCard(game, 'p2', '闪')
    const slash = giveCard(game, 'p1', '杀')

    game.state.currentPlayerId = 'p1'
    game.state.phase = 'play'
    const action = game.legalActions('p1').find((candidate) => candidate.kind === 'use-card'
      && candidate.cardIds.includes(slash) && candidate.targetIds.includes('p0'))!
    game.act('p1', action.id)

    const hpBefore = game.state.players[0].hp
    game.respond({ requestId: pending(game).id, playerId: 'p0', payload: { actionId: 'respond-pass' } })
    const surrogate = pending(game)
    expect(surrogate.playerId).toBe('p2')
    game.respond({ requestId: surrogate.id, playerId: 'p2', payload: { actionId: 'respond-pass' } })

    expect(game.state.players[0].hp).toBe(hpBefore - 1)
    assertGameInvariants(game.state)
  })

  it('护驾：曹操不是主公时完全不生效', () => {
    // 曹操坐 p2（忠臣），主公是 p0
    const game = gameWith(['zhangfei', 'zhangfei', 'caocao', 'zhangfei', 'zhangfei'], LORD_ELSEWHERE)
    stripCard(game, 'p2', '闪')
    giveCard(game, 'p0', '闪')
    const slash = giveCard(game, 'p1', '杀')

    game.state.currentPlayerId = 'p1'
    game.state.phase = 'play'
    const action = game.legalActions('p1').find((candidate) => candidate.kind === 'use-card'
      && candidate.cardIds.includes(slash) && candidate.targetIds.includes('p2'))!
    game.act('p1', action.id)

    const hpBefore = game.state.players[2].hp
    game.respond({ requestId: pending(game).id, playerId: 'p2', payload: { actionId: 'respond-pass' } })
    // 不是主公，没有代打，直接掉血
    expect(game.state.players[2].hp).toBe(hpBefore - 1)
    // 唯一可能剩下的请求是曹操自己的奸雄（他确实受了伤），绝不能是别人替他打闪
    for (const request of game.state.pendingRequests) {
      expect(request.kind).not.toBe('respond-card')
      expect(request.playerId).toBe('p2')
    }
  })

  it('救援：吴势力角色的桃让主公多回复一点', () => {
    const game = gameWith(['sunquan', 'zhangfei', 'ganning', 'zhangfei', 'zhangfei'], LORD_FIRST)
    const lord = game.state.players[0]
    lord.hp = 0
    const peach = giveCard(game, 'p2', '桃')
    game.enterDying('p0')

    // 依次问到 p2（甘宁，吴）
    let guard = 0
    while (pending(game) && pending(game).playerId !== 'p2') {
      if (guard++ > 8) throw new Error('没有问到吴势力角色')
      game.respond({ requestId: pending(game).id, playerId: pending(game).playerId, payload: { actionId: 'rescue-pass' } })
    }
    game.respond({ requestId: pending(game).id, playerId: 'p2', payload: { actionId: `rescue-card:${peach}` } })

    // 桃回 1 点 + 救援 1 点
    expect(lord.hp).toBe(2)
    expect(game.state.dying).toBeNull()
    assertGameInvariants(game.state)
  })

  it('救援：孙权不是主公时只回一点', () => {
    const game = gameWith(['zhangfei', 'zhangfei', 'sunquan', 'ganning', 'zhangfei'], LORD_ELSEWHERE)
    const sunquan = game.state.players[2]
    sunquan.hp = 0
    const peach = giveCard(game, 'p3', '桃')
    game.enterDying('p2')

    let guard = 0
    while (pending(game) && pending(game).playerId !== 'p3') {
      if (guard++ > 8) throw new Error('没有问到吴势力角色')
      game.respond({ requestId: pending(game).id, playerId: pending(game).playerId, payload: { actionId: 'rescue-pass' } })
    }
    game.respond({ requestId: pending(game).id, playerId: 'p3', payload: { actionId: `rescue-card:${peach}` } })
    expect(sunquan.hp).toBe(1)
  })
})

describe('主公武将的普通技能', () => {
  it('制衡：弃几张摸几张，每回合限一次', () => {
    const game = gameWith(['sunquan', 'zhangfei', 'zhangfei', 'zhangfei', 'zhangfei'], LORD_FIRST)
    game.state.currentPlayerId = 'p0'
    game.state.phase = 'play'
    const owner = game.state.players[0]
    const handBefore = owner.zones.hand.length

    expect(game.legalActions('p0').some((action) => action.id === 'skill:zhiheng')).toBe(true)
    game.act('p0', 'skill:zhiheng')
    const request = pending(game)
    expect(request.kind).toBe('choose-cards')
    const toDiscard = owner.zones.hand.slice(0, 2)
    game.respond({ requestId: request.id, playerId: 'p0', payload: { cardIds: toDiscard } })

    expect(owner.zones.hand.length).toBe(handBefore)
    for (const cardId of toDiscard) expect(game.state.zones.discardPile).toContain(cardId)
    // 限一次
    expect(game.legalActions('p0').some((action) => action.id === 'skill:zhiheng')).toBe(false)
    assertGameInvariants(game.state)
  })

  it('仁德：给出两张牌后回复一点体力，同一回合只回一次', () => {
    const game = gameWith(['liubei', 'zhangfei', 'zhangfei', 'zhangfei', 'zhangfei'], LORD_FIRST)
    game.state.currentPlayerId = 'p0'
    game.state.phase = 'play'
    const owner = game.state.players[0]
    owner.hp = owner.maxHp - 2
    const hpBefore = owner.hp
    const receiverBefore = game.state.players[1].zones.hand.length

    game.act('p0', 'skill:rende')
    const cardsRequest = pending(game)
    const given = owner.zones.hand.slice(0, 2)
    game.respond({ requestId: cardsRequest.id, playerId: 'p0', payload: { cardIds: given } })

    const targetRequest = pending(game)
    expect(targetRequest.kind).toBe('choose-targets')
    game.respond({ requestId: targetRequest.id, playerId: 'p0', payload: { targetIds: ['p1'] } })

    expect(game.state.players[1].zones.hand.length).toBe(receiverBefore + 2)
    expect(owner.hp).toBe(hpBefore + 1)

    // 再给两张不会再回血
    game.act('p0', 'skill:rende')
    const again = pending(game)
    game.respond({ requestId: again.id, playerId: 'p0', payload: { cardIds: owner.zones.hand.slice(0, 2) } })
    game.respond({ requestId: pending(game).id, playerId: 'p0', payload: { targetIds: ['p1'] } })
    expect(owner.hp).toBe(hpBefore + 1)
    assertGameInvariants(game.state)
  })
})
