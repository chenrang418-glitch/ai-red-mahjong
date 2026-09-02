import { describe, expect, it } from 'vitest'
import { SanguoshaGame } from '@/sanguosha/engine/game'
import { assertGameInvariants } from '@/sanguosha/engine/invariants'
import type { CardColor, GameSetup, Identity } from '@/sanguosha/engine/types'

function setup(): GameSetup {
  return {
    mode: 'identity', generalChoices: 1,
    players: Array.from({ length: 5 }, (_, index) => ({ id: `p${index}`, nickname: `玩家${index}`, isHuman: index === 0 })),
  }
}

function gameWithYanliangWenchou(seed = 'shuangxiong'): SanguoshaGame {
  const game = new SanguoshaGame({ seed, setup: setup() })
  const identities: Identity[] = ['lord', 'rebel', 'loyalist', 'rebel', 'renegade']
  game.state.players.forEach((player, index) => {
    player.identity = identities[index]
    player.characterId = index === 0 ? 'yanliangwenchou' : 'zhangfei'
  })
  game.start()
  while (game.state.pendingRequests.length > 0) {
    const request = game.state.pendingRequests[0]
    game.respond({ requestId: request.id, playerId: request.playerId, payload: { optionId: 'no' } })
  }
  game.state.currentPlayerId = 'p0'
  return game
}

function enterDrawPhase(game: SanguoshaGame): void {
  game.state.phase = 'judge'
  game.advancePhase()
}

function putColorOnTop(game: SanguoshaGame, color: CardColor): string {
  const cardId = game.state.zones.drawPile.find((id) => game.state.cards[id].color === color)
  if (!cardId) throw new Error(`牌堆里没有${color}牌`)
  game.state.zones.drawPile = [cardId, ...game.state.zones.drawPile.filter((id) => id !== cardId)]
  return cardId
}

describe('颜良文丑【双雄】', () => {
  it('可以放弃发动并正常摸两张牌', () => {
    const game = gameWithYanliangWenchou()
    const owner = game.state.players[0]
    const before = owner.zones.hand.length

    enterDrawPhase(game)
    const request = game.state.pendingRequests[0]
    expect(request.prompt).toContain('双雄')
    game.respond({ requestId: request.id, playerId: 'p0', payload: { optionId: 'no' } })

    expect(owner.zones.hand).toHaveLength(before + 2)
    expect(owner.marks.shuangxiong).toBeUndefined()
    assertGameInvariants(game.state)
  })

  it('发动后进行判定、获得判定牌且不再默认摸牌', () => {
    const game = gameWithYanliangWenchou()
    const owner = game.state.players[0]
    const judgedCardId = putColorOnTop(game, 'red')
    const before = owner.zones.hand.length

    enterDrawPhase(game)
    const request = game.state.pendingRequests[0]
    game.respond({ requestId: request.id, playerId: 'p0', payload: { optionId: 'yes' } })

    expect(owner.zones.hand).toHaveLength(before + 1)
    expect(owner.zones.hand).toContain(judgedCardId)
    expect(game.state.zones.discardPile).not.toContain(judgedCardId)
    expect(owner.marks.shuangxiong).toBe(1)
    assertGameInvariants(game.state)
  })

  it('本回合只有与判定牌异色的手牌能当【决斗】使用', () => {
    const game = gameWithYanliangWenchou()
    const owner = game.state.players[0]
    putColorOnTop(game, 'red')
    enterDrawPhase(game)
    const request = game.state.pendingRequests[0]
    game.respond({ requestId: request.id, playerId: 'p0', payload: { optionId: 'yes' } })
    game.state.phase = 'play'

    const blackCardId = owner.zones.hand.find((id) => game.state.cards[id].color === 'black')
    const redCardId = owner.zones.hand.find((id) => game.state.cards[id].color === 'red')
    expect(blackCardId, '起始手牌应有黑牌供转化').toBeTruthy()
    expect(redCardId, '手牌中至少包含刚获得的红色判定牌').toBeTruthy()

    const actions = game.legalActions('p0')
    expect(actions.some((action) => action.kind === 'use-card' && action.cardIds.includes(blackCardId!) && action.asCardName === '决斗')).toBe(true)
    expect(actions.some((action) => action.kind === 'use-card' && action.cardIds.includes(redCardId!) && action.asCardName === '决斗')).toBe(false)
  })

  it('转化牌进入完整的【决斗】响应链', () => {
    const game = gameWithYanliangWenchou('shuangxiong-duel')
    const owner = game.state.players[0]
    putColorOnTop(game, 'red')
    enterDrawPhase(game)
    game.respond({ requestId: game.state.pendingRequests[0].id, playerId: 'p0', payload: { optionId: 'yes' } })
    game.state.phase = 'play'

    const blackCardId = owner.zones.hand.find((id) => game.state.cards[id].color === 'black')!
    const action = game.legalActions('p0').find((candidate) => candidate.kind === 'use-card'
      && candidate.cardIds.includes(blackCardId) && candidate.asCardName === '决斗' && candidate.targetIds.includes('p1'))
    expect(action).toBeTruthy()
    game.act('p0', action!.id)

    expect(game.state.cardResolution?.kind).toBe('trick')
    expect(game.state.cardResolution?.cardName).toBe('决斗')
    // 普通锦囊先依座次逐个询问无懈，全部放弃后才轮到决斗目标出杀。
    while (game.state.pendingRequests[0]?.prompt.includes('无懈可击')) {
      const nullification = game.state.pendingRequests[0]
      game.respond({ requestId: nullification.id, playerId: nullification.playerId, payload: { actionId: 'respond-pass' } })
    }
    expect(game.state.pendingRequests[0]?.kind).toBe('respond-card')
    expect(game.state.pendingRequests[0]?.playerId).toBe('p1')
    assertGameInvariants(game.state)
  })

  it('回合结束后清除判定颜色，不能跨回合转化', () => {
    const game = gameWithYanliangWenchou()
    const owner = game.state.players[0]
    owner.marks.shuangxiong = 2
    game.state.phase = 'play'
    expect(game.legalActions('p0').some((action) => action.kind === 'use-card' && action.asCardName === '决斗')).toBe(true)

    game.emit('TurnEnd', { playerId: 'p0' })
    expect(owner.marks.shuangxiong).toBeUndefined()
    expect(game.legalActions('p0').some((action) => action.kind === 'use-card' && action.asCardName === '决斗')).toBe(false)
  })
})
