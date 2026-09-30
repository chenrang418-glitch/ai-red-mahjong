import { describe, expect, it } from 'vitest'
import { SanguoshaGame } from '@/sanguosha/engine/game'
import { cardPlayable } from '@/sanguosha/engine/card-play-lock'
import { assertGameInvariants } from '@/sanguosha/engine/invariants'
import { moveCard } from '@/sanguosha/engine/zones'
import { startPindian } from '@/sanguosha/engine/pindian'
import type { GameSetup, Identity, PlayerId } from '@/sanguosha/engine/types'
import { FENGJI_2026_PINDIAN_TAG } from '@/sanguosha/data/characters/fengji-2026'
import { lockedCategoriesOf } from '@/sanguosha/engine/card-play-lock'

function gameWithFengji(): SanguoshaGame {
  const setup: GameSetup = {
    mode: 'identity', generalChoices: 1,
    players: Array.from({ length: 5 }, (_, index) => ({ id: `p${index}`, nickname: `玩家${index}`, isHuman: false })),
  }
  const game = new SanguoshaGame({ seed: 'fengji-2026', setup })
  const identities: Identity[] = ['lord', 'rebel', 'loyalist', 'rebel', 'renegade']
  game.state.players.forEach((player, index) => {
    player.identity = identities[index]
    player.characterId = index === 0 ? 'fengji-2026' : 'zhangfei'
  })
  game.start()
  while (game.state.pendingRequests.length) {
    const request = game.state.pendingRequests[0]
    game.respond({ requestId: request.id, playerId: request.playerId, payload: { optionId: 'no' } })
  }
  return game
}

function clearHand(game: SanguoshaGame, playerId: PlayerId): void {
  const player = game.state.players.find((item) => item.id === playerId)!
  game.state.zones.discardPile.push(...player.zones.hand)
  player.zones.hand = []
}

function giveRank(game: SanguoshaGame, playerId: PlayerId, rank: number): string {
  const cardId = game.state.zones.drawPile.find((id) => game.state.cards[id].rank === rank)
  if (!cardId) throw new Error(`牌堆里没有点数 ${rank} 的牌`)
  moveCard(game.state, cardId, { kind: 'drawPile' }, { kind: 'hand', playerId })
  return cardId
}

describe('逢纪【斗誉】【愎果】', () => {
  it('斗誉在亮牌前允许交换拼点牌，愎果按交换后的胜负与牌类别结算', () => {
    const game = gameWithFengji()
    clearHand(game, 'p0')
    clearHand(game, 'p1')
    const lowCard = giveRank(game, 'p0', 2)
    const highCard = giveRank(game, 'p1', 13)
    const originalCategories = [game.state.cards[lowCard].category, game.state.cards[highCard].category]
      .filter((category): category is NonNullable<typeof category> => Boolean(category))
    startPindian(game, {
      id: 'fengji-test-pindian', initiatorId: 'p0', opponentId: 'p1',
      reason: 'test-fengji', continuationTag: FENGJI_2026_PINDIAN_TAG,
    })
    const submission = (playerId: PlayerId, cardId: string) => {
      const request = game.state.pendingRequests.find((item) => item.playerId === playerId)!
      game.respond({ requestId: request.id, playerId, payload: { cardIds: [cardId] } })
    }
    submission('p0', lowCard)
    submission('p1', highCard)

    const choice = game.state.pendingRequests.find((item) => item.playerId === 'p0' && item.kind === 'choose-option')
    expect(choice, '拼点牌已经暗选，但尚未亮出时询问是否交换').toBeDefined()
    expect(game.state.pindian?.stage).toBe('selecting')
    expect(game.state.zones.discardPile).not.toContain(lowCard)
    expect(game.state.zones.discardPile).not.toContain(highCard)
    game.respond({ requestId: choice!.id, playerId: 'p0', payload: { optionId: 'exchange' } })

    expect(game.state.pindian).toBeNull()
    expect(game.state.zones.discardPile).toEqual(expect.arrayContaining([lowCard, highCard]))
    expect(lockedCategoriesOf(game.state, 'p1')).toEqual(expect.arrayContaining([...new Set(originalCategories)]))
    for (const cardId of game.state.players.find((item) => item.id === 'p1')!.zones.hand) {
      if (originalCategories.includes(game.state.cards[cardId].category!))
        expect(cardPlayable(game.state, 'p1', cardId)).toBe(false)
    }
    assertGameInvariants(game.state)
  })
})
