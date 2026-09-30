import { describe, expect, it } from 'vitest'
import { SanguoshaGame } from '@/sanguosha/engine/game'
import { assertGameInvariants } from '@/sanguosha/engine/invariants'
import { assertCardConservation } from '@/sanguosha/engine/zones'
import type { ChooseOptionRequest, RespondCardRequest } from '@/sanguosha/engine/requests'
import type { GameSetup, Identity, PlayerId } from '@/sanguosha/engine/types'

const RESENTMENT = 'xinzheng:resentment'
const AFFECTED_COUNT = 'ligui:affected-count'
const ANGER_ACTIVE = 'xinzheng:anger-active'

function gameWith(seed: string): SanguoshaGame {
  const characterIds = ['yixing', 'caocao', 'liubei', 'sunquan', 'lvbu']
  const setup: GameSetup = {
    mode: 'identity', generalChoices: 1,
    players: characterIds.map((_, index) => ({ id: `p${index}`, nickname: `玩家${index}`, isHuman: false })),
  }
  const game = new SanguoshaGame({ seed, setup })
  const identities: Identity[] = ['lord', 'rebel', 'loyalist', 'rebel', 'renegade']
  game.state.players.forEach((candidate, index) => {
    candidate.identity = identities[index]
    candidate.characterId = characterIds[index]
  })
  game.state.currentPlayerId = 'p0'
  game.start()
  return game
}

function player(game: SanguoshaGame, id: PlayerId) {
  return game.state.players.find((candidate) => candidate.id === id)!
}

function currentRequest(game: SanguoshaGame) {
  return game.state.pendingRequests[0]
}

function answer(game: SanguoshaGame, payload: Record<string, unknown>): void {
  const request = currentRequest(game)
  if (!request) throw new Error('没有待回答请求')
  game.respond({ requestId: request.id, playerId: request.playerId, payload })
}

function chooseRule(game: SanguoshaGame): void {
  const request = currentRequest(game) as ChooseOptionRequest
  expect(request.prompt).toContain('【立规】')
  answer(game, { optionId: 'wine' })
}

function detach(game: SanguoshaGame, cardId: string): void {
  game.state.zones.drawPile = game.state.zones.drawPile.filter((id) => id !== cardId)
  game.state.zones.discardPile = game.state.zones.discardPile.filter((id) => id !== cardId)
  game.state.zones.processingArea = game.state.zones.processingArea.filter((id) => id !== cardId)
  for (const candidate of game.state.players) {
    candidate.zones.hand = candidate.zones.hand.filter((id) => id !== cardId)
    candidate.zones.judgingArea = candidate.zones.judgingArea.filter((id) => id !== cardId)
    for (const slot of Object.keys(candidate.zones.equipment) as Array<keyof typeof candidate.zones.equipment>) {
      if (candidate.zones.equipment[slot] === cardId) candidate.zones.equipment[slot] = null
    }
  }
}

function give(game: SanguoshaGame, playerId: PlayerId, cardIds: string[]): void {
  for (const cardId of cardIds) {
    detach(game, cardId)
    player(game, playerId).zones.hand.push(cardId)
  }
}

function findCards(game: SanguoshaGame, name: string, count: number): string[] {
  const cards = Object.values(game.state.cards).filter((card) => card.name === name).slice(0, count)
  if (cards.length !== count) throw new Error(`没有足够的【${name}】`)
  return cards.map((card) => card.id)
}

function clearHand(game: SanguoshaGame, playerId: PlayerId): void {
  const owner = player(game, playerId)
  game.state.zones.discardPile.push(...owner.zones.hand)
  owner.zones.hand = []
}

function startAnger(game: SanguoshaGame): void {
  const owner = player(game, 'p0')
  owner.marks[RESENTMENT] = 2
  owner.marks[AFFECTED_COUNT] = 2
  game.state.currentPlayerId = 'p1'
  game.state.phase = 'play'
  game.state.turnUsage = { slashUses: 0, slashUsesThisTurn: 0, wineUses: 0, wineDamageBonus: 0 }
  const wine = findCards(game, '酒', 1)[0]
  give(game, 'p1', [wine])
  const action = game.legalActions('p1').find((candidate) => candidate.kind === 'use-card'
    && candidate.cardIds.includes(wine) && candidate.asCardName === '酒' && candidate.targetIds.includes('p1'))
  if (!action) throw new Error('找不到触发群怒的【酒】动作')
  game.act('p1', action.id)
  const costRequest = currentRequest(game)
  if (costRequest?.kind === 'choose-cards' && costRequest.prompt.includes('【酒】须额外弃置')) answer(game, { cardIds: [] })
}

function finishOtherActors(game: SanguoshaGame): void {
  for (const actorId of ['p2', 'p3', 'p4']) {
    expect(currentRequest(game)?.playerId).toBe(actorId)
    answer(game, { optionId: 'lose-hp' })
  }
}

function passDodge(game: SanguoshaGame): void {
  const request = currentRequest(game) as RespondCardRequest
  expect(request.requiredCardName).toBe('闪')
  const passId = request.actionIds.find((id) => id.includes('pass'))
  expect(passId).toBeTruthy()
  answer(game, { actionId: passId! })
}

function invariants(game: SanguoshaGame): void {
  assertCardConservation(game.state)
  assertGameInvariants(game.state)
}

describe('audit: 奕星【群怒】物理杀载体与次数', () => {
  it('选择出杀时仅消耗该杀，群怒不占回合次数，之后仍可正常出杀', () => {
    const game = gameWith('audit-yixing-slash')
    chooseRule(game)
    const [angerSlash, ordinarySlash] = findCards(game, '杀', 2)
    give(game, 'p1', [angerSlash, ordinarySlash])
    for (const actorId of ['p2', 'p3', 'p4']) clearHand(game, actorId)

    startAnger(game)
    expect((currentRequest(game) as ChooseOptionRequest).playerId).toBe('p1')
    answer(game, { optionId: 'slash' })
    answer(game, { cardIds: [angerSlash] })
    expect((currentRequest(game) as RespondCardRequest).requiredCardName).toBe('闪')
    passDodge(game)
    finishOtherActors(game)

    expect(player(game, 'p1').zones.hand).toContain(ordinarySlash)
    expect(game.state.zones.discardPile).toContain(angerSlash)
    expect(game.state.turnUsage.slashUses).toBe(0)
    expect(game.state.turnUsage.slashUsesThisTurn).toBe(0)
    expect(player(game, 'p0').marks[ANGER_ACTIVE]).toBeUndefined()

    const normalAction = game.legalActions('p1').find((candidate) => candidate.kind === 'use-card'
      && candidate.cardIds.includes(ordinarySlash) && candidate.asCardName === '杀' && candidate.targetIds.includes('p2'))
    expect(normalAction, '群怒虚拟杀不消耗之后的正常出杀资格').toBeTruthy()
    game.act('p1', normalAction!.id)
    expect(game.state.turnUsage.slashUses).toBe(1)
    expect(game.state.turnUsage.slashUsesThisTurn).toBe(1)
    invariants(game)
  })

  it('选择失去体力时自己的杀仍留手牌，且群怒只造成选择对应的失去体力', () => {
    const game = gameWith('audit-yixing-lose-hp')
    chooseRule(game)
    const [unusedSlash] = findCards(game, '杀', 1)
    give(game, 'p1', [unusedSlash])
    for (const actorId of ['p2', 'p3', 'p4']) clearHand(game, actorId)
    startAnger(game)
    const actorHpBefore = player(game, 'p1').hp
    const ownerHpBefore = player(game, 'p0').hp
    expect((currentRequest(game) as ChooseOptionRequest).playerId).toBe('p1')
    answer(game, { optionId: 'lose-hp' })
    finishOtherActors(game)

    expect(player(game, 'p1').hp).toBe(actorHpBefore - 1)
    expect(player(game, 'p1').zones.hand).toContain(unusedSlash)
    expect(game.state.zones.discardPile).not.toContain(unusedSlash)
    expect(player(game, 'p0').hp).toBe(ownerHpBefore)
    expect(player(game, 'p0').marks[ANGER_ACTIVE]).toBeUndefined()
    invariants(game)
  })
})
