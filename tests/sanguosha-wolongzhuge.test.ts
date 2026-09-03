import { describe, expect, it } from 'vitest'
import { SanguoshaGame } from '@/sanguosha/engine/game'
import type { GameSetup, Identity, PlayerId, SanguoshaState } from '@/sanguosha/engine/types'
import { moveCard, type ZoneRef } from '@/sanguosha/engine/zones'

function gameWithWolong(seed: string): SanguoshaGame {
  const setup: GameSetup = {
    mode: 'identity', generalChoices: 1,
    players: Array.from({ length: 5 }, (_, index) => ({ id: `p${index}`, nickname: `玩家${index}`, isHuman: false })),
  }
  const game = new SanguoshaGame({ seed, setup })
  const identities: Identity[] = ['lord', 'rebel', 'loyalist', 'rebel', 'renegade']
  game.state.players.forEach((player, index) => {
    player.identity = identities[index]
    player.characterId = index === 0 ? 'wolongzhuge' : 'zhangfei'
  })
  game.start()
  game.state.currentPlayerId = 'p0'
  game.state.phase = 'play'
  return game
}

function locate(state: SanguoshaState, cardId: string): ZoneRef {
  if (state.zones.drawPile.includes(cardId)) return { kind: 'drawPile' }
  if (state.zones.discardPile.includes(cardId)) return { kind: 'discardPile' }
  if (state.zones.processingArea.includes(cardId)) return { kind: 'processingArea' }
  for (const owner of state.players) {
    if (owner.zones.hand.includes(cardId)) return { kind: 'hand', playerId: owner.id }
    for (const [slot, equipped] of Object.entries(owner.zones.equipment)) {
      if (equipped === cardId) return { kind: 'equipment', playerId: owner.id, slot: slot as keyof typeof owner.zones.equipment }
    }
  }
  throw new Error(`找不到卡牌：${cardId}`)
}

function giveCard(game: SanguoshaGame, playerId: PlayerId, predicate: (cardId: string) => boolean): string {
  const cardId = Object.keys(game.state.cards).find((id) => predicate(id))
  if (!cardId) throw new Error('找不到测试牌')
  moveCard(game.state, cardId, locate(game.state, cardId), { kind: 'hand', playerId })
  return cardId
}

function clearHand(game: SanguoshaGame, playerId: PlayerId): void {
  const owner = game.state.players.find((player) => player.id === playerId)!
  for (const cardId of [...owner.zones.hand]) moveCard(game.state, cardId, { kind: 'hand', playerId }, { kind: 'discardPile' })
}

describe('卧龙诸葛', () => {
  it('名称固定为卧龙诸葛，火计把红牌当火攻且看破把黑牌当无懈可击', () => {
    const game = gameWithWolong('wolong-view-as')
    clearHand(game, 'p0')
    const red = giveCard(game, 'p0', (id) => game.state.cards[id].color === 'red' && game.state.cards[id].name !== '火攻')
    const black = giveCard(game, 'p0', (id) => game.state.cards[id].color === 'black' && game.state.cards[id].name !== '无懈可击')
    const actions = game.legalActions('p0')
    expect(game.state.players[0].characterId).toBe('wolongzhuge')
    expect(actions.some((action) => action.kind === 'use-card' && action.cardIds.includes(red) && action.asCardName === '火攻')).toBe(true)
    // 无懈可击只在响应窗口使用，不应在出牌阶段产生动作。
    expect(actions.some((action) => action.kind === 'use-card' && action.cardIds.includes(black) && action.asCardName === '无懈可击')).toBe(false)
  })

  it('八阵在没有真实防具时提供八卦阵响应，装备真实防具后不再叠加', () => {
    const game = gameWithWolong('wolong-bazhen')
    clearHand(game, 'p0')
    const slash = giveCard(game, 'p1', (id) => game.state.cards[id].name === '杀')
    game.state.currentPlayerId = 'p1'
    const use = game.legalActions('p1').find((action) => action.kind === 'use-card' && action.cardIds.includes(slash) && action.targetIds.includes('p0'))!
    game.act('p1', use.id)
    const dodge = game.state.pendingRequests[0]
    expect(dodge.kind === 'respond-card' && dodge.actionIds).toContain('invoke-bagua')

    const second = gameWithWolong('wolong-real-armor')
    clearHand(second, 'p0')
    const armor = Object.values(second.state.cards).find((card) => card.name === '仁王盾')!
    moveCard(second.state, armor.id, locate(second.state, armor.id), { kind: 'equipment', playerId: 'p0', slot: 'armor' })
    const redSlash = giveCard(second, 'p1', (id) => second.state.cards[id].name === '杀' && second.state.cards[id].color === 'red')
    second.state.currentPlayerId = 'p1'
    const secondUse = second.legalActions('p1').find((action) => action.kind === 'use-card' && action.cardIds.includes(redSlash) && action.targetIds.includes('p0'))!
    second.act('p1', secondUse.id)
    const secondDodge = second.state.pendingRequests[0]
    expect(secondDodge.kind === 'respond-card' && secondDodge.actionIds).not.toContain('invoke-bagua')
  })

  it('看破能在无懈可击响应窗口消耗黑牌', () => {
    const game = gameWithWolong('wolong-kanpo')
    clearHand(game, 'p0')
    const black = giveCard(game, 'p0', (id) => game.state.cards[id].color === 'black' && game.state.cards[id].name !== '无懈可击')
    const trick = giveCard(game, 'p1', (id) => game.state.cards[id].name === '无中生有')
    game.state.currentPlayerId = 'p1'
    const use = game.legalActions('p1').find((action) => action.kind === 'use-card' && action.cardIds.includes(trick))!
    game.act('p1', use.id)
    while (game.state.pendingRequests[0]?.playerId !== 'p0') {
      const other = game.state.pendingRequests[0]
      expect(other?.kind).toBe('respond-card')
      game.respond({ requestId: other.id, playerId: other.playerId, payload: { actionId: 'respond-pass' } })
    }
    const request = game.state.pendingRequests[0]
    expect(request?.kind).toBe('respond-card')
    expect(request?.kind === 'respond-card' && request.actionIds).toContain(`respond-nullification:${black}`)
    game.respond({ requestId: request!.id, playerId: 'p0', payload: { actionId: `respond-nullification:${black}` } })
    expect(game.state.zones.discardPile).toContain(black)
  })
})
