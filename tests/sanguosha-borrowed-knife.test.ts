import { describe, expect, it } from 'vitest'
import { SanguoshaGame } from '@/sanguosha/engine/game'
import { assertGameInvariants } from '@/sanguosha/engine/invariants'
import type { GameSetup, Identity, PlayerId } from '@/sanguosha/engine/types'

/**
 * 借刀杀人与重铸。
 *
 * 借刀的【杀】以前是自己另起一套简化结算，于是仁王盾挡不住、无双不生效、
 * 流离转不走。现在它走完整的杀结算，这里守住那条。
 */

function setup(): GameSetup {
  return {
    mode: 'identity', generalChoices: 1,
    players: Array.from({ length: 5 }, (_, index) => ({ id: `p${index}`, nickname: `玩家${index}`, isHuman: false })),
  }
}

function gameWith(characterIds: (string | null)[], seed = 'knife'): SanguoshaGame {
  const game = new SanguoshaGame({ seed, setup: setup() })
  const identities: Identity[] = ['lord', 'rebel', 'loyalist', 'rebel', 'renegade']
  game.state.players.forEach((player, index) => {
    player.identity = identities[index]
    player.characterId = characterIds[index] ?? 'machao'
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

/** 把某张牌直接装到装备区，跳过出牌流程。 */
function equip(game: SanguoshaGame, playerId: PlayerId, cardName: string, slot: 'weapon' | 'armor'): string {
  const cardId = Object.values(game.state.cards).find((card) => card.name === cardName)?.id
  if (!cardId) throw new Error(`这副牌里没有【${cardName}】`)
  game.state.zones.drawPile = game.state.zones.drawPile.filter((id) => id !== cardId)
  game.state.zones.discardPile = game.state.zones.discardPile.filter((id) => id !== cardId)
  for (const player of game.state.players) player.zones.hand = player.zones.hand.filter((id) => id !== cardId)
  game.state.players.find((player) => player.id === playerId)!.zones.equipment[slot] = cardId
  return cardId
}

/** p0 对 p1 使用借刀杀人，指定 p1 打 p2。返回 p1 手里那张杀。 */
function playBorrowedKnife(game: SanguoshaGame): string {
  const knife = giveNamed(game, 'p0', '借刀杀人')
  // 目标必须有武器，否则借刀选不了他
  equip(game, 'p1', '青釭剑', 'weapon')
  const slash = giveNamed(game, 'p1', '杀')

  const action = game.legalActions('p0').find((candidate) => candidate.kind === 'use-card'
    && candidate.cardIds.includes(knife) && candidate.targetIds.includes('p1'))
  if (!action) throw new Error('构造不出对 p1 的借刀杀人')
  game.act('p0', action.id)

  // 逐个问无懈，全部放弃
  let guard = 0
  while (pending(game)?.kind === 'respond-card' && pending(game).prompt.includes('无懈')) {
    if (guard++ > 12) throw new Error('无懈询问没有收敛')
    game.respond({ requestId: pending(game).id, playerId: pending(game).playerId, payload: { actionId: 'respond-pass' } })
  }

  // 选受害者（由请求本身指明该谁选）
  const targets = pending(game)
  expect(targets.kind).toBe('choose-targets')
  game.respond({ requestId: targets.id, playerId: targets.playerId, payload: { targetIds: ['p2'] } })
  return slash
}

describe('借刀杀人', () => {
  it('打出的【杀】走完整结算：仁王盾能挡住黑杀', () => {
    const game = gameWith([])
    // p2 穿仁王盾
    equip(game, 'p2', '仁王盾', 'armor')
    const slash = playBorrowedKnife(game)
    // 保证那张杀是黑色的，仁王盾才生效
    game.state.cards[slash].color = 'black'

    const askSlash = pending(game)
    expect(askSlash.prompt).toContain('借刀杀人')
    const hpBefore = game.state.players[2].hp
    game.respond({ requestId: askSlash.id, playerId: 'p1', payload: { actionId: `respond-trick:${slash}` } })

    // 仁王盾让这张杀完全无效，连闪都不用问
    expect(game.state.players[2].hp, '仁王盾应当挡住借刀打出的黑杀').toBe(hpBefore)
    assertGameInvariants(game.state)
  })

  it('受害者可以正常用闪响应', () => {
    const game = gameWith([])
    const dodge = giveNamed(game, 'p2', '闪')
    const slash = playBorrowedKnife(game)
    game.state.cards[slash].color = 'red'

    game.respond({ requestId: pending(game).id, playerId: 'p1', payload: { actionId: `respond-trick:${slash}` } })

    const dodgeRequest = pending(game)
    expect(dodgeRequest.kind, '借刀的杀要向受害者求闪').toBe('respond-card')
    expect(dodgeRequest.playerId).toBe('p2')
    const hpBefore = game.state.players[2].hp
    game.respond({ requestId: dodgeRequest.id, playerId: 'p2', payload: { actionId: `respond-dodge:${dodge}` } })
    expect(game.state.players[2].hp).toBe(hpBefore)
    assertGameInvariants(game.state)
  })

  it('不出杀就把武器交出去', () => {
    const game = gameWith([])
    playBorrowedKnife(game)
    const weapon = game.state.players[1].zones.equipment.weapon
    expect(weapon).toBeTruthy()

    game.respond({ requestId: pending(game).id, playerId: 'p1', payload: { actionId: 'respond-pass' } })
    expect(game.state.players[1].zones.equipment.weapon).toBeNull()
    expect(game.state.players[0].zones.hand).toContain(weapon)
    assertGameInvariants(game.state)
  })
})

describe('铁索连环重铸', () => {
  it('可以弃掉换一张新牌，不进处理区也不问无懈', () => {
    const game = gameWith([])
    const chain = giveNamed(game, 'p0', '铁索连环')
    const owner = game.state.players[0]
    const handBefore = owner.zones.hand.length

    const recast = game.legalActions('p0').find((action) => action.id === `play:recast:${chain}`)
    expect(recast, '重铸必须是一条可点的动作').toBeTruthy()
    game.act('p0', recast!.id)

    expect(owner.zones.hand).not.toContain(chain)
    expect(game.state.zones.discardPile).toContain(chain)
    // 弃一张摸一张，手牌数不变
    expect(owner.zones.hand.length).toBe(handBefore)
    // 不是「使用」，所以没有结算状态，也没有无懈询问
    expect(game.state.cardResolution).toBeNull()
    expect(game.state.pendingRequests).toHaveLength(0)
    assertGameInvariants(game.state)
  })

  it('横置用法仍然在', () => {
    const game = gameWith([])
    const chain = giveNamed(game, 'p0', '铁索连环')
    const chainActions = game.legalActions('p0').filter((action) => action.kind === 'use-card'
      && action.cardIds.includes(chain) && !action.id.startsWith('play:recast:'))
    expect(chainActions.length, '单人和双人横置都要在').toBeGreaterThan(1)
  })
})
