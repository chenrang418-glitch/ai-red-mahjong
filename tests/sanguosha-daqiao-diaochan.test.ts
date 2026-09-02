import { describe, expect, it } from 'vitest'
import { SanguoshaGame } from '@/sanguosha/engine/game'
import { assertGameInvariants } from '@/sanguosha/engine/invariants'
import { effectiveCardName } from '@/sanguosha/engine/zones'
import type { GameSetup, Identity, PlayerId } from '@/sanguosha/engine/types'

// 填充角色用张飞而不是马超：马超有了【铁骑】之后，每次出杀都会多一个询问，
// 把这些测试的响应序列全部打乱。张飞的【咆哮】是纯被动（只放宽出杀次数），
// 不产生任何请求，才是真正的「无干扰填充」。

/**
 * 大乔与貂蝉。
 *
 * 这两个武将各自要动引擎里之前没有的东西：
 * 国色要延时锦囊的转化（判定区得记住「当作什么用」），
 * 流离要在结算途中换掉【杀】的目标，
 * 离间要凭空发起一次决斗。
 */

function setup(): GameSetup {
  return {
    mode: 'identity', generalChoices: 1,
    players: Array.from({ length: 5 }, (_, index) => ({ id: `p${index}`, nickname: `玩家${index}`, isHuman: false })),
  }
}

function gameWith(characterIds: (string | null)[], seed = 'daqiao'): SanguoshaGame {
  const game = new SanguoshaGame({ seed, setup: setup() })
  const identities: Identity[] = ['lord', 'rebel', 'loyalist', 'rebel', 'renegade']
  game.state.players.forEach((player, index) => {
    player.identity = identities[index]
    player.characterId = characterIds[index] ?? 'zhangfei'
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

function giveHeart(game: SanguoshaGame, playerId: PlayerId): string {
  const cardId = game.state.zones.drawPile.find((id) => {
    const card = game.state.cards[id]
    return card.suit === 'heart' && card.name !== '乐不思蜀'
  })
  if (!cardId) throw new Error('牌堆里没有红桃牌')
  game.state.zones.drawPile = game.state.zones.drawPile.filter((id) => id !== cardId)
  game.state.players.find((player) => player.id === playerId)!.zones.hand.push(cardId)
  return cardId
}

/** 找出把某张牌当某个牌名用的那条动作。 */
function viewAsAction(game: SanguoshaGame, cardId: string, asName: string, targetId: PlayerId) {
  return game.legalActions('p0').find((candidate) => candidate.kind === 'use-card'
    && candidate.cardIds.includes(cardId)
    && candidate.asCardName === asName
    && candidate.targetIds.includes(targetId))
}

describe('大乔【国色】', () => {
  it('红桃牌当【乐不思蜀】放进判定区，判定时按乐不思蜀结算', () => {
    const game = gameWith(['daqiao'])
    const heart = giveHeart(game, 'p0')

    const action = viewAsAction(game, heart, '乐不思蜀', 'p1')
    expect(action, '国色必须真的产生一条合法动作').toBeTruthy()
    game.act('p0', action!.id)

    // 牌进了目标的判定区，并且记住了「当作乐不思蜀」
    expect(game.state.players[1].zones.judgingArea).toContain(heart)
    expect(effectiveCardName(game.state, heart)).toBe('乐不思蜀')
    expect(game.state.cards[heart].name).not.toBe('乐不思蜀')
    assertGameInvariants(game.state)
  })

  it('同一个人身上不能叠两张乐不思蜀', () => {
    const game = gameWith(['daqiao'])
    const first = giveHeart(game, 'p0')
    game.act('p0', viewAsAction(game, first, '乐不思蜀', 'p1')!.id)

    const second = giveHeart(game, 'p0')
    expect(viewAsAction(game, second, '乐不思蜀', 'p1')).toBeUndefined()
  })

  it('别名在牌离开判定区之后就忘掉', () => {
    const game = gameWith(['daqiao'])
    const heart = giveHeart(game, 'p0')
    game.act('p0', viewAsAction(game, heart, '乐不思蜀', 'p1')!.id)

    // 走完 p1 的判定阶段，牌进弃牌堆
    game.state.currentPlayerId = 'p1'
    game.state.phase = 'prepare'
    game.advancePhase()
    while (game.state.pendingRequests.length > 0) {
      const request = game.state.pendingRequests[0]
      game.respond({ requestId: request.id, playerId: request.playerId, payload: { actionId: 'respond-pass' } })
    }
    expect(game.state.zones.discardPile).toContain(heart)
    expect(effectiveCardName(game.state, heart)).toBe(game.state.cards[heart].name)
  })
})

describe('大乔【流离】', () => {
  it('弃一张牌可以把【杀】转给别人', () => {
    // p1 是大乔，p0 打他
    const game = gameWith([null, 'daqiao'])
    const slash = giveNamed(game, 'p0', '杀')
    const victim = game.state.players[1]
    const handBefore = victim.zones.hand.length

    const action = game.legalActions('p0').find((candidate) => candidate.kind === 'use-card'
      && candidate.cardIds.includes(slash) && candidate.targetIds.includes('p1'))!
    game.act('p0', action.id)

    const ask = pending(game)
    expect(ask.playerId, '流离问的是被杀的人').toBe('p1')
    expect(ask.prompt).toContain('流离')
    expect(game.state.cardResolution?.stage).toBe('awaiting-intercept')
    assertGameInvariants(game.state)

    game.respond({ requestId: ask.id, playerId: 'p1', payload: { optionId: 'yes' } })
    const discard = pending(game)
    expect(discard.kind).toBe('choose-cards')
    game.respond({ requestId: discard.id, playerId: 'p1', payload: { cardIds: [(discard as { cardIds: string[] }).cardIds[0]] } })

    const targetRequest = pending(game)
    expect(targetRequest.kind).toBe('choose-targets')
    const candidates = (targetRequest as { candidateIds: string[] }).candidateIds
    expect(candidates, '不能转给出杀的人').not.toContain('p0')
    expect(candidates, '不能转给自己').not.toContain('p1')

    const newTarget = candidates[0]
    game.respond({ requestId: targetRequest.id, playerId: 'p1', payload: { targetIds: [newTarget] } })

    expect(victim.zones.hand.length).toBe(handBefore - 1)
    expect(game.state.cardResolution?.kind).toBe('slash')
    expect((game.state.cardResolution as { targetId: string }).targetId).toBe(newTarget)
    // 转移之后向新目标求闪
    expect(pending(game).playerId).toBe(newTarget)
    assertGameInvariants(game.state)
  })

  it('放弃发动就照常求闪，而且不会被再问一次', () => {
    const game = gameWith([null, 'daqiao'])
    const slash = giveNamed(game, 'p0', '杀')
    const action = game.legalActions('p0').find((candidate) => candidate.kind === 'use-card'
      && candidate.cardIds.includes(slash) && candidate.targetIds.includes('p1'))!
    game.act('p0', action.id)
    game.respond({ requestId: pending(game).id, playerId: 'p1', payload: { optionId: 'no' } })

    // 放弃之后必须是求闪。再问一次流离就会死循环——插入点必须记账
    const dodge = pending(game)
    expect(dodge.kind).toBe('respond-card')
    expect(dodge.playerId).toBe('p1')
    expect(game.state.cardResolution?.stage).toBe('awaiting-dodge')
  })
})

describe('貂蝉', () => {
  it('离间令两名男性角色决斗', () => {
    const game = gameWith(['diaochan', 'guanyu', 'zhangfei'])
    const owner = game.state.players[0]
    const handBefore = owner.zones.hand.length

    expect(game.legalActions('p0').some((action) => action.id === 'skill:lijian'), '离间必须能发动').toBe(true)
    game.act('p0', 'skill:lijian')

    const discard = pending(game)
    expect(discard.kind).toBe('choose-cards')
    game.respond({ requestId: discard.id, playerId: 'p0', payload: { cardIds: [(discard as { cardIds: string[] }).cardIds[0]] } })

    const targets = pending(game)
    expect(targets.kind).toBe('choose-targets')
    const candidates = (targets as { candidateIds: string[] }).candidateIds
    expect(candidates, '只能选男性角色').toEqual(expect.arrayContaining(['p1', 'p2']))
    expect(candidates, '不能选自己').not.toContain('p0')
    game.respond({ requestId: targets.id, playerId: 'p0', payload: { targetIds: ['p1', 'p2'] } })

    expect(owner.zones.hand.length).toBe(handBefore - 1)
    // 决斗真的打起来了
    const resolution = game.state.cardResolution as { kind: string; cardName: string; sourceId: string }
    expect(resolution.kind).toBe('trick')
    expect(resolution.cardName).toBe('决斗')
    expect(resolution.sourceId).toBe('p1')
    assertGameInvariants(game.state)
  })

  it('离间每回合只能用一次', () => {
    const game = gameWith(['diaochan', 'guanyu', 'zhangfei'])
    game.act('p0', 'skill:lijian')
    const discard = pending(game)
    game.respond({ requestId: discard.id, playerId: 'p0', payload: { cardIds: [(discard as { cardIds: string[] }).cardIds[0]] } })
    expect(game.legalActions('p0').some((action) => action.id === 'skill:lijian')).toBe(false)
  })

  it('场上不足两名男性角色时不给出这个动作', () => {
    // 只有 p1 是男性，其余都换成女性武将
    const game = gameWith(['diaochan', 'guanyu', 'sunshangxiang', 'zhenji', 'huangyueying'])
    expect(game.legalActions('p0').some((action) => action.id === 'skill:lijian')).toBe(false)
  })

  it('闭月在结束阶段摸一张牌', () => {
    const game = gameWith(['diaochan'])
    const owner = game.state.players[0]
    const handBefore = owner.zones.hand.length
    game.state.phase = 'discard'
    game.advancePhase()
    expect(game.state.phase).toBe('finish')
    expect(owner.zones.hand.length).toBe(handBefore + 1)
    assertGameInvariants(game.state)
  })
})
