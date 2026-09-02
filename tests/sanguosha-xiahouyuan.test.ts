import { describe, expect, it } from 'vitest'
import { SanguoshaGame } from '@/sanguosha/engine/game'
import { assertGameInvariants } from '@/sanguosha/engine/invariants'
import type { CardId, GameSetup, Identity, PlayerId } from '@/sanguosha/engine/types'
import { moveCard } from '@/sanguosha/engine/zones'

function setup(): GameSetup {
  return {
    mode: 'identity', generalChoices: 1,
    players: Array.from({ length: 5 }, (_, index) => ({ id: `p${index}`, nickname: `玩家${index}`, isHuman: index === 0 })),
  }
}

function gameWithXiahouyuan(seed = 'xiahouyuan'): SanguoshaGame {
  const game = new SanguoshaGame({ seed, setup: setup() })
  const identities: Identity[] = ['lord', 'rebel', 'loyalist', 'rebel', 'renegade']
  game.state.players.forEach((player, index) => {
    player.identity = identities[index]
    player.characterId = index === 0 ? 'xiahouyuan' : 'zhangfei'
  })
  game.start()
  while (game.state.pendingRequests.length > 0) {
    const request = game.state.pendingRequests[0]
    game.respond({ requestId: request.id, playerId: request.playerId, payload: { optionId: 'no' } })
  }
  game.state.currentPlayerId = 'p0'
  return game
}

function pending(game: SanguoshaGame) {
  const request = game.state.pendingRequests[0]
  expect(request, '期望存在待回应请求').toBeTruthy()
  return request
}

function answer(game: SanguoshaGame, payload: unknown): void {
  const request = pending(game)
  game.respond({ requestId: request.id, playerId: request.playerId, payload })
}

function giveEquipment(game: SanguoshaGame, playerId: PlayerId, preferredName?: string): CardId {
  const cardId = game.state.zones.drawPile.find((id) => {
    const card = game.state.cards[id]
    return card.category === 'equipment' && (!preferredName || card.name === preferredName)
  })
  if (!cardId) throw new Error(`牌堆里没有装备牌${preferredName ? `【${preferredName}】` : ''}`)
  moveCard(game.state, cardId, { kind: 'drawPile' }, { kind: 'hand', playerId })
  return cardId
}

function enterJudgePhase(game: SanguoshaGame): void {
  game.state.phase = 'prepare'
  game.advancePhase()
  expect(game.state.phase).toBe('judge')
  expect(pending(game).prompt).toContain('神速')
}

function enterPlayPhase(game: SanguoshaGame): void {
  game.state.phase = 'draw'
  game.advancePhase()
  expect(game.state.phase).toBe('play')
}

describe('夏侯渊【神速】①', () => {
  it('放弃发动后正常进入摸牌阶段并摸两张牌', () => {
    const game = gameWithXiahouyuan()
    const owner = game.state.players[0]
    const handBefore = owner.zones.hand.length

    enterJudgePhase(game)
    answer(game, { optionId: 'no' })
    expect(game.state.skippedPhases).not.toContain('draw')
    game.advancePhase()

    expect(game.state.phase).toBe('draw')
    expect(owner.zones.hand).toHaveLength(handBefore + 2)
    assertGameInvariants(game.state)
  })

  it('跳过判定和摸牌，对距离二的角色使用不计次数的虚拟杀', () => {
    const game = gameWithXiahouyuan('shensu-judge')
    const owner = game.state.players[0]
    const target = game.state.players[2]
    const handBefore = owner.zones.hand.length

    enterJudgePhase(game)
    answer(game, { optionId: 'shensu-judge' })
    expect(game.state.skippedPhases).toContain('draw')
    const targets = pending(game) as { candidateIds: PlayerId[] }
    expect(targets.candidateIds, '神速不受攻击距离限制').toContain('p2')
    answer(game, { targetIds: ['p2'] })

    expect(game.state.cardResolution?.kind).toBe('slash')
    expect(game.state.cards[game.state.cardResolution!.cardId].virtual).toBe(true)
    answer(game, { actionId: 'respond-pass' })
    expect(target.hp).toBe(3)
    expect(game.state.turnUsage.slashUses).toBe(0)

    game.advancePhase()
    expect(game.state.phase).toBe('play')
    expect(owner.zones.hand).toHaveLength(handBefore)
    assertGameInvariants(game.state)
  })
})

describe('夏侯渊【神速】②', () => {
  it('没有装备牌时不产生神速询问', () => {
    const game = gameWithXiahouyuan('shensu-no-equipment')
    const owner = game.state.players[0]
    for (const cardId of [...owner.zones.hand]) {
      if (game.state.cards[cardId].category === 'equipment') {
        moveCard(game.state, cardId, { kind: 'hand', playerId: 'p0' }, { kind: 'discardPile' })
      }
    }
    enterPlayPhase(game)
    expect(game.state.pendingRequests).toHaveLength(0)
    expect(game.legalActions('p0').length).toBeGreaterThan(0)
  })

  it('弃置手中的装备牌，虚拟杀结算后跳过出牌阶段', () => {
    const game = gameWithXiahouyuan('shensu-play')
    const equipment = giveEquipment(game, 'p0')
    enterPlayPhase(game)
    expect(pending(game).prompt).toContain('弃置一张装备牌')
    answer(game, { optionId: 'shensu-play' })
    const cards = pending(game) as { cardIds: CardId[] }
    expect(cards.cardIds).toContain(equipment)
    answer(game, { cardIds: [equipment] })
    answer(game, { targetIds: ['p2'] })
    expect(game.state.cardResolution?.kind).toBe('slash')

    answer(game, { actionId: 'respond-pass' })
    expect(game.state.zones.discardPile).toContain(equipment)
    expect(game.state.players[2].hp).toBe(3)
    expect(game.state.phase).toBe('discard')
    assertGameInvariants(game.state)
  })

  it('可以弃置装备区的牌，并正常触发失去装备效果', () => {
    const game = gameWithXiahouyuan('shensu-equipped')
    const lion = giveEquipment(game, 'p0', '白银狮子')
    moveCard(game.state, lion, { kind: 'hand', playerId: 'p0' }, { kind: 'equipment', playerId: 'p0', slot: 'armor' })
    const owner = game.state.players[0]
    owner.hp = 2

    enterPlayPhase(game)
    answer(game, { optionId: 'shensu-play' })
    answer(game, { cardIds: [lion] })
    answer(game, { targetIds: ['p1'] })

    expect(owner.zones.equipment.armor).toBeNull()
    expect(owner.hp, '白银狮子离开装备区应回复体力').toBe(3)
    answer(game, { actionId: 'respond-pass' })
    expect(game.state.phase).toBe('discard')
  })

  it('放弃第二段后仍停留在正常出牌阶段', () => {
    const game = gameWithXiahouyuan('shensu-play-decline')
    giveEquipment(game, 'p0')
    enterPlayPhase(game)
    answer(game, { optionId: 'no' })
    expect(game.state.phase).toBe('play')
    expect(game.state.pendingRequests).toHaveLength(0)
    expect(game.legalActions('p0').some((action) => action.kind === 'pass')).toBe(true)
  })

  it('选择目标期间序列化恢复后仍能完成神速并跳过出牌阶段', () => {
    const game = gameWithXiahouyuan('shensu-restore')
    const equipment = giveEquipment(game, 'p0')
    enterPlayPhase(game)
    answer(game, { optionId: 'shensu-play' })
    answer(game, { cardIds: [equipment] })

    const restored = SanguoshaGame.restore(game.serialize())
    answer(restored, { targetIds: ['p2'] })
    answer(restored, { actionId: 'respond-pass' })
    expect(restored.state.phase).toBe('discard')
    expect(restored.state.zones.discardPile).toContain(equipment)
    assertGameInvariants(restored.state)
  })
})
