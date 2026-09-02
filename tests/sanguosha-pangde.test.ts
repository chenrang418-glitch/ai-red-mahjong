import { describe, expect, it } from 'vitest'
import { SanguoshaGame } from '@/sanguosha/engine/game'
import { assertGameInvariants } from '@/sanguosha/engine/invariants'
import { getDistance } from '@/sanguosha/engine/distance'
import { skillIdsOf } from '@/sanguosha/data/characters/standard'
import type { GameSetup, Identity, PlayerId } from '@/sanguosha/engine/types'

/**
 * 庞德【马术】【猛进】。
 *
 * 马术直接复用马超那套 distanceModifier——不允许为庞德另写一份距离判断，
 * 所以这里只验「效果一致」。
 *
 * 猛进挂在「杀被【闪】抵消后」的时机链上（贯石斧、青龙偃月刀走同一条），
 * 重点是**不能泄露对方手牌**：只能给暗槽，不能让庞德先看见点数花色再挑。
 */

function gameWith(characterIds: string[], seed = 'pangde'): SanguoshaGame {
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

function pending(game: SanguoshaGame) {
  return game.state.pendingRequests[0]
}

function giveNamed(game: SanguoshaGame, playerId: PlayerId, cardName: string): string {
  const cardId = game.state.zones.drawPile.find((id) => game.state.cards[id].name === cardName)
  if (!cardId) throw new Error(`牌堆里没有【${cardName}】`)
  game.state.zones.drawPile = game.state.zones.drawPile.filter((id) => id !== cardId)
  game.state.players.find((player) => player.id === playerId)!.zones.hand.push(cardId)
  return cardId
}

const FILLER = ['pangde', 'zhangfei', 'zhangfei', 'zhangfei', 'zhangfei']

/** p0 出杀打 p1，p1 用闪抵消，返回抵消之后的第一个请求。 */
function slashAndDodge(game: SanguoshaGame) {
  const slash = giveNamed(game, 'p0', '杀')
  const dodge = giveNamed(game, 'p1', '闪')
  const action = game.legalActions('p0').find((candidate) => candidate.kind === 'use-card'
    && candidate.cardIds.includes(slash) && candidate.targetIds.includes('p1'))
  if (!action) throw new Error('构造不出对 p1 的杀')
  game.act('p0', action.id)
  const dodgeAsk = pending(game)
  expect(dodgeAsk?.kind).toBe('respond-card')
  game.respond({ requestId: dodgeAsk.id, playerId: 'p1', payload: { actionId: `respond-dodge:${dodge}` } })
  return pending(game)
}

describe('庞德【马术】复用马超那套', () => {
  it('技能 id 就是马超的 mashu，不是另写的一份', () => {
    expect(skillIdsOf('pangde')).toContain('mashu')
  })

  it('距离效果和马超一致', () => {
    const withMashu = gameWith(FILLER)
    const without = gameWith(['zhangfei', 'zhangfei', 'zhangfei', 'zhangfei', 'zhangfei'])
    expect(getDistance(withMashu.state, 'p0', 'p2'))
      .toBe(getDistance(without.state, 'p0', 'p2') - 1)
  })
})

describe('庞德【猛进】', () => {
  it('杀被闪抵消后才发问', () => {
    const game = gameWith(FILLER)
    giveNamed(game, 'p1', '桃')
    const ask = slashAndDodge(game)
    expect(ask?.prompt, '被闪之后应当问猛进').toContain('猛进')
    expect(ask.playerId).toBe('p0')
    assertGameInvariants(game.state)
  })

  it('杀没被闪掉就不发问', () => {
    const game = gameWith(FILLER)
    giveNamed(game, 'p1', '桃')
    const slash = giveNamed(game, 'p0', '杀')
    const action = game.legalActions('p0').find((candidate) => candidate.kind === 'use-card'
      && candidate.cardIds.includes(slash) && candidate.targetIds.includes('p1'))
    game.act('p0', action!.id)
    // 目标放弃响应，直接吃伤害
    game.respond({ requestId: pending(game).id, playerId: 'p1', payload: { actionId: 'respond-pass' } })
    expect(pending(game)?.prompt ?? '', '没被闪就没有猛进').not.toContain('猛进')
    assertGameInvariants(game.state)
  })

  it('对方一张牌都没有时不发问', () => {
    const game = gameWith(FILLER)
    const slash = giveNamed(game, 'p0', '杀')
    const dodge = giveNamed(game, 'p1', '闪')
    // 开局发过手牌，要打空才是「无牌可拆」；装备区本来就是空的
    game.state.players[1].zones.hand = [dodge]
    const action = game.legalActions('p0').find((candidate) => candidate.kind === 'use-card'
      && candidate.cardIds.includes(slash) && candidate.targetIds.includes('p1'))
    game.act('p0', action!.id)
    game.respond({ requestId: pending(game).id, playerId: 'p1', payload: { actionId: `respond-dodge:${dodge}` } })

    expect(game.state.players[1].zones.hand.length, '闪打出去之后应当空手').toBe(0)
    expect(pending(game)?.prompt ?? '', '对方无牌可拆就不该问').not.toContain('猛进')
  })

  it('自己没牌可弃时不发问', () => {
    const game = gameWith(FILLER)
    giveNamed(game, 'p1', '桃')
    const slash = giveNamed(game, 'p0', '杀')
    const dodge = giveNamed(game, 'p1', '闪')
    const action = game.legalActions('p0').find((candidate) => candidate.kind === 'use-card'
      && candidate.cardIds.includes(slash) && candidate.targetIds.includes('p1'))
    game.act('p0', action!.id)
    // 出完这张杀之后把庞德的牌清空，代价就付不起了
    game.state.players[0].zones.hand = []
    game.respond({ requestId: pending(game).id, playerId: 'p1', payload: { actionId: `respond-dodge:${dodge}` } })
    expect(pending(game)?.prompt ?? '').not.toContain('猛进')
  })

  it('完整流程：弃自己一张，再拆对方一张', () => {
    const game = gameWith(FILLER)
    giveNamed(game, 'p0', '桃')
    giveNamed(game, 'p1', '桃')
    const ownerHandBefore = game.state.players[0].zones.hand.length
    const victimHandBefore = game.state.players[1].zones.hand.length

    const ask = slashAndDodge(game)
    game.respond({ requestId: ask.id, playerId: 'p0', payload: { optionId: 'yes' } })

    const cost = pending(game)
    expect(cost?.kind, '先弃自己的牌').toBe('choose-cards')
    expect(cost.prompt).toContain('自己')
    game.respond({ requestId: cost.id, playerId: 'p0', payload: { cardIds: [(cost as { cardIds: string[] }).cardIds[0]] } })

    const pick = pending(game)
    expect(pick?.kind, '再拆对方的牌').toBe('choose-cards')
    const slots = (pick as { hiddenCardSlots: string[] }).hiddenCardSlots
    expect(slots.length, '对方手牌只能是暗槽').toBe(victimHandBefore)
    game.respond({ requestId: pick.id, playerId: 'p0', payload: { cardIds: [slots[0]] } })

    expect(game.state.players[0].zones.hand.length, '自己弃了一张').toBe(ownerHandBefore - 1)
    expect(game.state.players[1].zones.hand.length, '对方被拆了一张').toBe(victimHandBefore - 1)
    assertGameInvariants(game.state)
  })

  it('不泄露对方手牌：候选里只有暗槽，没有真实牌 id', () => {
    const game = gameWith(FILLER)
    const secret = giveNamed(game, 'p1', '桃')
    const ask = slashAndDodge(game)
    game.respond({ requestId: ask.id, playerId: 'p0', payload: { optionId: 'yes' } })
    const cost = pending(game)
    game.respond({ requestId: cost.id, playerId: 'p0', payload: { cardIds: [(cost as { cardIds: string[] }).cardIds[0]] } })

    const pick = pending(game)
    const visible = (pick as { cardIds: string[] }).cardIds
    expect(visible, '对方手牌不能出现在明牌候选里').not.toContain(secret)
    expect(JSON.stringify(pick), '整个请求里都不该出现那张牌的 id').not.toContain(secret)
  })

  it('放弃发动，结算照常收尾', () => {
    const game = gameWith(FILLER)
    giveNamed(game, 'p0', '桃')
    giveNamed(game, 'p1', '桃')
    const ask = slashAndDodge(game)
    game.respond({ requestId: ask.id, playerId: 'p0', payload: { optionId: 'no' } })

    expect(game.state.cardResolution, '放弃之后这次结算应当收尾').toBeNull()
    assertGameInvariants(game.state)
  })
})
