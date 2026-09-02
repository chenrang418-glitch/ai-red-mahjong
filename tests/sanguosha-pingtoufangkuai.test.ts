import { describe, expect, it } from 'vitest'
import { SanguoshaGame } from '@/sanguosha/engine/game'
import { assertGameInvariants } from '@/sanguosha/engine/invariants'
import type { GameRequest } from '@/sanguosha/engine/requests'
import type { GameSetup, Identity, PlayerId, Suit } from '@/sanguosha/engine/types'

function gameWith(characterIds: string[], seed = 'pingtoufangkuai'): SanguoshaGame {
  const setup: GameSetup = {
    mode: 'identity', generalChoices: 1,
    players: characterIds.map((_, index) => ({ id: `p${index}`, nickname: `玩家${index}`, isHuman: false })),
  }
  const game = new SanguoshaGame({ seed, setup })
  const identities: Identity[] = ['lord', 'rebel', 'loyalist', 'rebel', 'renegade']
  game.state.players.forEach((player, index) => {
    player.identity = identities[index % identities.length]
    player.characterId = characterIds[index]
  })
  game.start()
  game.state.currentPlayerId = 'p0'
  game.state.phase = 'play'
  return game
}

function player(game: SanguoshaGame, id: PlayerId) {
  return game.state.players.find((candidate) => candidate.id === id)!
}

function giveNamed(game: SanguoshaGame, playerId: PlayerId, name: string): string {
  const cardId = game.state.zones.drawPile.find((id) => game.state.cards[id].name === name)
  if (!cardId) throw new Error(`牌堆里没有【${name}】`)
  game.state.zones.drawPile = game.state.zones.drawPile.filter((id) => id !== cardId)
  player(game, playerId).zones.hand.push(cardId)
  return cardId
}

function putSuitOnTop(game: SanguoshaGame, suit: Suit): string {
  const cardId = game.state.zones.drawPile.find((id) => game.state.cards[id].suit === suit)
  if (!cardId) throw new Error(`牌堆里没有${suit}`)
  game.state.zones.drawPile = [cardId, ...game.state.zones.drawPile.filter((id) => id !== cardId)]
  return cardId
}

function pending(game: SanguoshaGame): GameRequest {
  const request = game.state.pendingRequests[0]
  if (!request) throw new Error('没有待处理请求')
  return request
}

function respondOption(game: SanguoshaGame, optionId: string): void {
  const request = pending(game)
  if (request.kind !== 'choose-option') throw new Error(`期待 choose-option，实际 ${request.kind}`)
  game.respond({ requestId: request.id, playerId: request.playerId, payload: { optionId } })
}

function respondCard(game: SanguoshaGame, actionId: string): void {
  const request = pending(game)
  if (request.kind !== 'respond-card') throw new Error(`期待 respond-card，实际 ${request.kind}`)
  game.respond({ requestId: request.id, playerId: request.playerId, payload: { actionId } })
}

function startShuajian(game: SanguoshaGame, targetId = 'p1'): void {
  const action = game.legalActions('p0').find((candidate) => candidate.id === 'skill:shuajian')
  if (!action) throw new Error('没有【耍剑】动作')
  game.act('p0', action.id)
  const targetRequest = pending(game)
  if (targetRequest.kind !== 'choose-targets') throw new Error('耍剑没有询问目标')
  game.respond({ requestId: targetRequest.id, playerId: 'p0', payload: { targetIds: [targetId] } })
}

function useCardOn(game: SanguoshaGame, sourceId: PlayerId, cardId: string, targetId: PlayerId): void {
  const action = game.legalActions(sourceId).find((candidate) => (
    candidate.kind === 'use-card' && candidate.cardIds.includes(cardId) && candidate.targetIds.includes(targetId)
  ))
  if (!action) throw new Error('找不到指定用牌动作')
  game.act(sourceId, action.id)
}

function passNullifications(game: SanguoshaGame): void {
  while (game.state.pendingRequests[0]?.kind === 'respond-card'
    && game.state.cardResolution?.kind === 'trick'
    && game.state.cardResolution.stage === 'awaiting-nullification') {
    respondCard(game, 'respond-pass')
  }
}

describe('平头方块【耍剑】', () => {
  it('目标不理会：摸一张，本回合不能再主动对其用指定目标牌，但全体牌不受影响', () => {
    const game = gameWith(['pingtoufangkuai', 'zhangfei', 'zhangfei', 'zhangfei', 'zhangfei'])
    const before = player(game, 'p0').zones.hand.length
    startShuajian(game)
    respondOption(game, 'shuajian-ignore')

    expect(player(game, 'p0').zones.hand.length).toBe(before + 1)
    const slash = giveNamed(game, 'p0', '杀')
    const invasion = giveNamed(game, 'p0', '南蛮入侵')
    const actions = game.legalActions('p0')
    expect(actions.some((action) => action.kind === 'use-card' && action.cardIds.includes(slash) && action.targetIds.includes('p1'))).toBe(false)
    expect(actions.some((action) => action.kind === 'use-card' && action.cardIds.includes(invasion) && action.targetIds.includes('p1'))).toBe(true)

    game.state.turnNumber += 1
    expect(game.legalActions('p0').some((action) => action.kind === 'use-card' && action.cardIds.includes(slash) && action.targetIds.includes('p1'))).toBe(true)
    assertGameInvariants(game.state)
  })

  it('虚拟杀被闪抵消：不占实体杀和次数，完整结算后摸两张', () => {
    const game = gameWith(['pingtoufangkuai', 'zhangfei', 'zhangfei', 'zhangfei', 'zhangfei'])
    const dodge = giveNamed(game, 'p0', '闪')
    const before = player(game, 'p0').zones.hand.length
    startShuajian(game)
    respondOption(game, 'shuajian-attack')
    respondOption(game, 'cancel') // 不发动【发呆】
    respondCard(game, `respond-dodge:${dodge}`)

    expect(player(game, 'p0').zones.hand.length).toBe(before - 1 + 2)
    expect(game.state.turnUsage.slashUses).toBe(0)
    expect(Object.values(game.state.cards).some((card) => card.virtual)).toBe(false)
    assertGameInvariants(game.state)
  })

  it('虚拟杀造成伤害：先受伤，再摸一张', () => {
    const game = gameWith(['pingtoufangkuai', 'zhangfei', 'zhangfei', 'zhangfei', 'zhangfei'])
    const owner = player(game, 'p0')
    const hp = owner.hp
    const hand = owner.zones.hand.length
    startShuajian(game)
    respondOption(game, 'shuajian-attack')
    respondOption(game, 'cancel')
    respondCard(game, 'respond-pass')

    expect(owner.hp).toBe(hp - 1)
    expect(owner.zones.hand.length).toBe(hand + 1)
    assertGameInvariants(game.state)
  })
})

describe('平头方块【发呆】', () => {
  it('面对普通杀翻到方块：只取消自己作为目标，展示牌进入弃牌堆', () => {
    const game = gameWith(['zhangfei', 'pingtoufangkuai', 'zhangfei', 'zhangfei', 'zhangfei'])
    const slash = giveNamed(game, 'p0', '杀')
    const revealed = putSuitOnTop(game, 'diamond')
    const hp = player(game, 'p1').hp
    useCardOn(game, 'p0', slash, 'p1')
    respondOption(game, 'fadai-invoke')

    expect(player(game, 'p1').hp).toBe(hp)
    expect(game.state.zones.discardPile).toContain(revealed)
    expect(game.state.cardResolution).toBeNull()
    assertGameInvariants(game.state)
  })

  it('面对普通杀翻到非方块：获得展示牌，并且不能打闪', () => {
    const game = gameWith(['zhangfei', 'pingtoufangkuai', 'zhangfei', 'zhangfei', 'zhangfei'])
    const slash = giveNamed(game, 'p0', '杀')
    const dodge = giveNamed(game, 'p1', '闪')
    const revealed = putSuitOnTop(game, 'club')
    const hp = player(game, 'p1').hp
    useCardOn(game, 'p0', slash, 'p1')
    respondOption(game, 'fadai-invoke')

    expect(player(game, 'p1').zones.hand).toContain(revealed)
    expect(player(game, 'p1').zones.hand).toContain(dodge)
    expect(player(game, 'p1').hp).toBe(hp - 1)
    expect(game.state.cardResolution).toBeNull()
    assertGameInvariants(game.state)
  })

  it('与耍剑联动：方块取消虚拟杀后，耍剑摸两张', () => {
    const game = gameWith(['pingtoufangkuai', 'zhangfei', 'zhangfei', 'zhangfei', 'zhangfei'])
    const revealed = putSuitOnTop(game, 'diamond')
    const owner = player(game, 'p0')
    const before = owner.zones.hand.length
    startShuajian(game)
    respondOption(game, 'shuajian-attack')
    respondOption(game, 'fadai-invoke')

    expect(owner.hp).toBe(owner.maxHp)
    expect(owner.zones.hand.length).toBe(before + 2)
    expect(game.state.zones.discardPile).toContain(revealed)
    assertGameInvariants(game.state)
  })

  it('虚拟杀与发呆请求可序列化，断线恢复后不会重复翻牌或摸牌', () => {
    let game = gameWith(['pingtoufangkuai', 'zhangfei', 'zhangfei', 'zhangfei', 'zhangfei'])
    const revealed = putSuitOnTop(game, 'diamond')
    const before = player(game, 'p0').zones.hand.length
    startShuajian(game)
    respondOption(game, 'shuajian-attack')
    expect(pending(game).kind).toBe('choose-option')

    game = SanguoshaGame.restore(game.serialize())
    respondOption(game, 'fadai-invoke')

    expect(player(game, 'p0').zones.hand.length).toBe(before + 2)
    expect(game.state.zones.discardPile.filter((id) => id === revealed)).toHaveLength(1)
    expect(Object.values(game.state.cards).some((card) => card.virtual)).toBe(false)
    assertGameInvariants(game.state)
  })

  it('同一自然回合只可发动一次', () => {
    const game = gameWith(['zhangfei', 'pingtoufangkuai', 'zhangfei', 'zhangfei', 'zhangfei'])
    const first = giveNamed(game, 'p0', '杀')
    const second = giveNamed(game, 'p0', '杀')
    putSuitOnTop(game, 'diamond')
    useCardOn(game, 'p0', first, 'p1')
    respondOption(game, 'fadai-invoke')

    useCardOn(game, 'p0', second, 'p1')
    expect(pending(game).kind, '第二次应直接进入闪响应，不再询问发呆').toBe('respond-card')
    respondCard(game, 'respond-pass')
    assertGameInvariants(game.state)
  })

  it('多目标普通锦囊翻到方块：只取消平头方块，其他目标继续结算', () => {
    const game = gameWith(['zhangfei', 'pingtoufangkuai', 'zhangfei', 'zhangfei', 'zhangfei'])
    const chain = giveNamed(game, 'p0', '铁索连环')
    putSuitOnTop(game, 'diamond')
    const action = game.legalActions('p0').find((candidate) => (
      candidate.kind === 'use-card' && candidate.cardIds.includes(chain)
      && candidate.targetIds.length === 2 && candidate.targetIds.includes('p1') && candidate.targetIds.includes('p2')
    ))
    if (!action) throw new Error('找不到双目标铁索连环')
    game.act('p0', action.id)
    respondOption(game, 'fadai-invoke')
    passNullifications(game)

    expect(player(game, 'p1').chained).toBe(false)
    expect(player(game, 'p2').chained).toBe(true)
    assertGameInvariants(game.state)
  })

  it('普通锦囊翻到非方块：获得展示牌，并跳过自己的响应', () => {
    const game = gameWith(['zhangfei', 'pingtoufangkuai', 'zhangfei', 'zhangfei', 'zhangfei'])
    const duel = giveNamed(game, 'p0', '决斗')
    giveNamed(game, 'p1', '杀')
    const revealed = putSuitOnTop(game, 'heart')
    const hp = player(game, 'p1').hp
    useCardOn(game, 'p0', duel, 'p1')
    respondOption(game, 'fadai-invoke')
    passNullifications(game)

    expect(player(game, 'p1').zones.hand).toContain(revealed)
    expect(player(game, 'p1').hp).toBe(hp - 1)
    expect(game.state.cardResolution).toBeNull()
    assertGameInvariants(game.state)
  })
})
