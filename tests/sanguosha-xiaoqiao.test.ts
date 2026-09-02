import { describe, expect, it } from 'vitest'
import { SanguoshaGame } from '@/sanguosha/engine/game'
import { assertGameInvariants } from '@/sanguosha/engine/invariants'
import { performJudgment } from '@/sanguosha/engine/judgment'
import { effectiveCardSuit } from '@/sanguosha/engine/skills/runtime'
import type { CardId, GameSetup, Identity, PlayerId, Suit } from '@/sanguosha/engine/types'

function setup(): GameSetup {
  return {
    mode: 'identity', generalChoices: 1,
    players: Array.from({ length: 5 }, (_, index) => ({ id: `p${index}`, nickname: `玩家${index}`, isHuman: index === 0 })),
  }
}

function gameWithXiaoqiao(seed = 'xiaoqiao'): SanguoshaGame {
  const game = new SanguoshaGame({ seed, setup: setup() })
  const identities: Identity[] = ['lord', 'rebel', 'loyalist', 'rebel', 'renegade']
  game.state.players.forEach((player, index) => {
    player.identity = identities[index]
    player.characterId = index === 0 ? 'xiaoqiao' : 'zhangfei'
  })
  game.start()
  while (game.state.pendingRequests.length > 0) {
    const request = game.state.pendingRequests[0]
    game.respond({ requestId: request.id, playerId: request.playerId, payload: { optionId: 'no' } })
  }
  game.state.currentPlayerId = 'p1'
  game.state.phase = 'play'
  return game
}

function giveSuit(game: SanguoshaGame, playerId: PlayerId, suit: Suit): CardId {
  const cardId = game.state.zones.drawPile.find((id) => game.state.cards[id].suit === suit)
  if (!cardId) throw new Error(`牌堆中没有${suit}牌`)
  game.state.zones.drawPile = game.state.zones.drawPile.filter((id) => id !== cardId)
  game.state.players.find((player) => player.id === playerId)!.zones.hand.push(cardId)
  return cardId
}

function putSuitOnTop(game: SanguoshaGame, suit: Suit): CardId {
  const cardId = game.state.zones.drawPile.find((id) => game.state.cards[id].suit === suit)
  if (!cardId) throw new Error(`牌堆中没有${suit}牌`)
  game.state.zones.drawPile = [cardId, ...game.state.zones.drawPile.filter((id) => id !== cardId)]
  return cardId
}

function answer(game: SanguoshaGame, payload: unknown): void {
  const request = game.state.pendingRequests[0]
  expect(request, '期望存在待回应请求').toBeTruthy()
  game.respond({ requestId: request.id, playerId: request.playerId, payload })
}

/** 伤害防止后，等当前同步结算收尾，再让排队的天香安全发问。 */
function revealQueuedTianxiang(game: SanguoshaGame): void {
  expect(game.state.skillQueue.some((prompt) => prompt.skillId === 'tianxiang')).toBe(true)
  game.state.phase = 'prepare'
  game.advancePhase()
  expect(game.state.pendingRequests[0]?.prompt).toContain('天香')
}

describe('小乔【红颜】', () => {
  it('自己的黑桃牌在统一规则入口中视为红桃', () => {
    const game = gameWithXiaoqiao()
    const spade = giveSuit(game, 'p0', 'spade')
    expect(effectiveCardSuit(game.state, 'p0', spade)).toBe('heart')
    expect(game.state.cards[spade].suit, '实体牌印刷花色不能被改写').toBe('spade')
  })

  it('小乔的黑桃判定按红桃结果结算', () => {
    const game = gameWithXiaoqiao('hongyan-judge')
    const spade = putSuitOnTop(game, 'spade')
    const judged = performJudgment(game, 'p0', '红颜测试')
    expect(judged.id).toBe(spade)
    expect(judged.suit).toBe('heart')
    expect(judged.color).toBe('red')
    expect(game.state.zones.discardPile).toContain(spade)
    assertGameInvariants(game.state)
  })
})

describe('小乔【天香】', () => {
  it('真实【杀】结算命中后会挂起天香，回答后牌的结算仍能完整收尾', () => {
    const game = gameWithXiaoqiao('tianxiang-slash')
    giveSuit(game, 'p0', 'heart')
    const slash = game.state.zones.drawPile.find((id) => game.state.cards[id].name === '杀')!
    game.state.zones.drawPile = game.state.zones.drawPile.filter((id) => id !== slash)
    game.state.players[1].zones.hand.push(slash)
    const action = game.legalActions('p1').find((candidate) => candidate.kind === 'use-card'
      && candidate.cardIds.includes(slash) && candidate.targetIds.includes('p0'))!
    game.act('p1', action.id)
    const dodge = game.state.pendingRequests[0]
    expect(dodge.kind).toBe('respond-card')
    game.respond({ requestId: dodge.id, playerId: 'p0', payload: { actionId: 'respond-pass' } })

    expect(game.state.pendingRequests[0]?.prompt).toContain('天香')
    expect(game.state.cardResolution, '天香发问时【杀】本身应已安全收尾').toBeNull()
    answer(game, { optionId: 'no' })
    expect(game.state.players[0].hp).toBe(3)
    expect(game.state.zones.discardPile).toContain(slash)
    assertGameInvariants(game.state)
  })

  it('放弃发动后只承受一次原伤害，不会重复询问', () => {
    const game = gameWithXiaoqiao()
    giveSuit(game, 'p0', 'heart')
    const owner = game.state.players[0]
    const hpBefore = owner.hp

    game.damage({ sourceId: 'p1', targetId: 'p0', amount: 1, nature: 'normal', cardName: '杀' })
    revealQueuedTianxiang(game)
    expect(owner.hp, '询问天香时原伤害已经被挂起').toBe(hpBefore)
    expect(game.state.pendingRequests[0]?.prompt).toContain('天香')
    answer(game, { optionId: 'no' })

    expect(owner.hp).toBe(hpBefore - 1)
    expect(game.state.pendingRequests).toHaveLength(0)
    expect(owner.marks.tianxiangSkip).toBeUndefined()
    assertGameInvariants(game.state)
  })

  it('弃红桃把整次伤害转移，受伤角色按已损失体力摸牌', () => {
    const game = gameWithXiaoqiao('tianxiang-transfer')
    const heart = giveSuit(game, 'p0', 'heart')
    const owner = game.state.players[0]
    const target = game.state.players[1]
    const ownerHp = owner.hp
    const targetHp = target.hp
    const targetHand = target.zones.hand.length

    game.damage({ sourceId: 'p2', targetId: 'p0', amount: 2, nature: 'fire', cardName: '火攻' })
    revealQueuedTianxiang(game)
    answer(game, { optionId: 'tianxiang-invoke' })
    expect(game.state.pendingRequests[0]?.kind).toBe('choose-cards')
    answer(game, { cardIds: [heart] })
    expect(game.state.pendingRequests[0]?.kind).toBe('choose-targets')
    answer(game, { targetIds: ['p1'] })

    expect(owner.hp).toBe(ownerHp)
    expect(target.hp).toBe(targetHp - 2)
    expect(target.zones.hand).toHaveLength(targetHand + 2)
    expect(game.state.zones.discardPile).toContain(heart)
    assertGameInvariants(game.state)
  })

  it('【红颜】转换后的黑桃手牌可以支付天香', () => {
    const game = gameWithXiaoqiao('tianxiang-hongyan')
    const spade = giveSuit(game, 'p0', 'spade')
    game.damage({ sourceId: 'p1', targetId: 'p0', amount: 1 })
    revealQueuedTianxiang(game)
    answer(game, { optionId: 'tianxiang-invoke' })

    const request = game.state.pendingRequests[0] as { cardIds: CardId[] }
    expect(request.cardIds).toContain(spade)
    answer(game, { cardIds: [spade] })
    answer(game, { targetIds: ['p2'] })
    expect(game.state.zones.discardPile).toContain(spade)
    expect(game.state.players[2].hp).toBe(3)
  })

  it('方块和梅花不能作为天香代价', () => {
    const game = gameWithXiaoqiao('tianxiang-suits')
    const diamond = giveSuit(game, 'p0', 'diamond')
    const club = giveSuit(game, 'p0', 'club')
    const heart = giveSuit(game, 'p0', 'heart')
    game.damage({ sourceId: 'p1', targetId: 'p0', amount: 1 })
    revealQueuedTianxiang(game)
    answer(game, { optionId: 'tianxiang-invoke' })

    const request = game.state.pendingRequests[0] as { cardIds: CardId[] }
    expect(request.cardIds).toContain(heart)
    expect(request.cardIds).not.toContain(diamond)
    expect(request.cardIds).not.toContain(club)
  })

  it('等待选择期间序列化恢复后仍能完成伤害转移', () => {
    const game = gameWithXiaoqiao('tianxiang-restore')
    const heart = giveSuit(game, 'p0', 'heart')
    game.damage({ sourceId: 'p1', targetId: 'p0', amount: 1, nature: 'thunder', cardName: '杀' })
    revealQueuedTianxiang(game)
    answer(game, { optionId: 'tianxiang-invoke' })

    const restored = SanguoshaGame.restore(game.serialize())
    answer(restored, { cardIds: [heart] })
    answer(restored, { targetIds: ['p2'] })

    expect(restored.state.players[0].hp).toBe(4)
    expect(restored.state.players[2].hp).toBe(3)
    expect(restored.state.zones.discardPile).toContain(heart)
    assertGameInvariants(restored.state)
  })
})
