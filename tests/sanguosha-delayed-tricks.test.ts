import { describe, expect, it } from 'vitest'
import { SanguoshaGame } from '@/sanguosha/engine/game'
import { assertGameInvariants } from '@/sanguosha/engine/invariants'
import type { GameSetup, Identity, PhysicalCard, SanguoshaState } from '@/sanguosha/engine/types'
import { moveCard, type ZoneRef } from '@/sanguosha/engine/zones'

function setup(): GameSetup {
  return {
    mode: 'identity', generalChoices: 3,
    players: Array.from({ length: 5 }, (_, index) => ({ id: `p${index}`, nickname: `玩家${index}`, isHuman: index === 0 })),
  }
}

function startedGame(seed: string): SanguoshaGame {
  const game = new SanguoshaGame({ seed, setup: setup() })
  const identities: Identity[] = ['lord', 'rebel', 'loyalist', 'rebel', 'renegade']
  game.state.players.forEach((player, index) => {
    player.identity = identities[index]
    player.identityRevealed = player.identity === 'lord'
  })
  game.state.currentPlayerId = 'p0'
  game.start()
  return game
}

function playPhaseGame(seed: string): SanguoshaGame {
  const game = startedGame(seed)
  game.advancePhase()
  game.advancePhase()
  game.advancePhase()
  return game
}

function locate(state: SanguoshaState, cardId: string): ZoneRef {
  if (state.zones.drawPile.includes(cardId)) return { kind: 'drawPile' }
  if (state.zones.discardPile.includes(cardId)) return { kind: 'discardPile' }
  if (state.zones.processingArea.includes(cardId)) return { kind: 'processingArea' }
  for (const owner of state.players) {
    if (owner.zones.hand.includes(cardId)) return { kind: 'hand', playerId: owner.id }
    if (owner.zones.judgingArea.includes(cardId)) return { kind: 'judgingArea', playerId: owner.id }
    for (const [slot, equipped] of Object.entries(owner.zones.equipment)) {
      if (equipped === cardId) return { kind: 'equipment', playerId: owner.id, slot: slot as keyof typeof owner.zones.equipment }
    }
  }
  throw new Error(`找不到卡牌：${cardId}`)
}

function card(game: SanguoshaGame, predicate: (candidate: PhysicalCard) => boolean): PhysicalCard {
  return Object.values(game.state.cards).find(predicate)!
}

function placeDelayed(game: SanguoshaGame, playerId: string, name: string): string {
  const delayed = card(game, (candidate) => candidate.name === name)
  moveCard(game.state, delayed.id, locate(game.state, delayed.id), { kind: 'judgingArea', playerId })
  return delayed.id
}

function forceTop(game: SanguoshaGame, predicate: (candidate: PhysicalCard) => boolean): string {
  const selected = card(game, (candidate) => predicate(candidate) && !game.state.players.some((player) => player.zones.judgingArea.includes(candidate.id)))
  moveCard(game.state, selected.id, locate(game.state, selected.id), { kind: 'drawPile' }, { toTop: true })
  return selected.id
}

function passAllResponses(game: SanguoshaGame): void {
  let guard = 30
  while (game.state.cardResolution && guard-- > 0) {
    const request = game.state.pendingRequests[0]
    game.respond({ requestId: request.id, playerId: request.playerId, payload: { actionId: 'respond-pass' } })
  }
  if (game.state.cardResolution) throw new Error('锦囊响应未结束')
}

function respondCurrent(game: SanguoshaGame, actionId: string): void {
  const request = game.state.pendingRequests[0]
  game.respond({ requestId: request.id, playerId: request.playerId, payload: { actionId } })
}

function passJudgmentWindow(game: SanguoshaGame): void {
  let guard = 50
  while (game.state.judgment?.stage === 'awaiting-nullification' && guard-- > 0) respondCurrent(game, 'respond-pass')
  if (game.state.judgment?.stage === 'awaiting-nullification') throw new Error('判定无懈窗口未结束')
}

function passUntilResponder(game: SanguoshaGame, playerId: string): void {
  let guard = 20
  while (game.state.pendingRequests[0]?.playerId !== playerId && guard-- > 0) respondCurrent(game, 'respond-pass')
  if (game.state.pendingRequests[0]?.playerId !== playerId) throw new Error(`未轮到响应者：${playerId}`)
}

describe('延时锦囊与判定阶段', () => {
  it('延时锦囊使用后直接进入目标判定区，兵粮目标受距离限制', () => {
    const game = playPhaseGame('place-delayed')
    const indulgence = card(game, (candidate) => candidate.name === '乐不思蜀')
    moveCard(game.state, indulgence.id, locate(game.state, indulgence.id), { kind: 'hand', playerId: 'p0' })
    const indulgenceAction = game.legalActions('p0').find((action) => action.kind === 'use-card' && action.cardIds.includes(indulgence.id) && action.targetIds[0] === 'p2')!
    game.act('p0', indulgenceAction.id)
    passAllResponses(game)
    expect(game.state.players[2].zones.judgingArea).toContain(indulgence.id)

    const shortage = card(game, (candidate) => candidate.name === '兵粮寸断')
    moveCard(game.state, shortage.id, locate(game.state, shortage.id), { kind: 'hand', playerId: 'p0' })
    const targets = game.legalActions('p0')
      .filter((action) => action.kind === 'use-card' && action.cardIds.includes(shortage.id))
      .map((action) => action.targetIds[0]).sort()
    expect(targets).toEqual(['p1', 'p4'])
    assertGameInvariants(game.state)
  })

  it('乐不思蜀判定非红桃时跳过出牌阶段', () => {
    const game = startedGame('indulgence-fail')
    const delayedId = placeDelayed(game, 'p0', '乐不思蜀')
    const judgeId = forceTop(game, (candidate) => candidate.suit === 'spade')
    game.advancePhase()
    passJudgmentWindow(game)
    expect(game.state.skippedPhases).toContain('play')
    expect(game.state.zones.discardPile).toEqual(expect.arrayContaining([delayedId, judgeId]))
    game.advancePhase()
    expect(game.state.phase).toBe('draw')
    game.advancePhase()
    expect(game.state.phase).toBe('discard')
  })

  it('兵粮寸断判定非梅花时跳过摸牌阶段', () => {
    const game = startedGame('shortage-fail')
    placeDelayed(game, 'p0', '兵粮寸断')
    forceTop(game, (candidate) => candidate.suit === 'heart')
    const handBefore = game.state.players[0].zones.hand.length
    game.advancePhase()
    passJudgmentWindow(game)
    expect(game.state.skippedPhases).toContain('draw')
    game.advancePhase()
    expect(game.state.phase).toBe('play')
    expect(game.state.players[0].zones.hand).toHaveLength(handBefore)
  })

  it('闪电判定黑桃2～9时造成无来源三点雷电伤害并弃置', () => {
    const game = startedGame('lightning-hit')
    const lightningId = placeDelayed(game, 'p0', '闪电')
    const judgeId = forceTop(game, (candidate) => candidate.suit === 'spade' && candidate.rank >= 2 && candidate.rank <= 9)
    game.advancePhase()
    passJudgmentWindow(game)
    expect(game.state.players[0].hp).toBe(1)
    expect(game.state.judgment).toBeNull()
    expect(game.state.zones.discardPile).toEqual(expect.arrayContaining([lightningId, judgeId]))
    assertGameInvariants(game.state)
  })

  it('闪电未命中时移动到下一名没有闪电的存活角色判定区', () => {
    const game = startedGame('lightning-pass')
    const lightningId = placeDelayed(game, 'p0', '闪电')
    forceTop(game, (candidate) => candidate.suit === 'heart')
    game.advancePhase()
    passJudgmentWindow(game)
    expect(game.state.players[0].zones.judgingArea).not.toContain(lightningId)
    expect(game.state.players[1].zones.judgingArea).toContain(lightningId)
    expect(game.state.players[0].hp).toBe(4)
    assertGameInvariants(game.state)
  })

  it('闪电造成濒死时判定状态可序列化，救援结束后继续弃置并收束', () => {
    const game = startedGame('lightning-dying-resume')
    const lightningId = placeDelayed(game, 'p0', '闪电')
    forceTop(game, (candidate) => candidate.suit === 'spade' && candidate.rank >= 2 && candidate.rank <= 9)
    game.state.players[0].hp = 2
    game.advancePhase()
    passJudgmentWindow(game)
    expect(game.state.dying?.playerId).toBe('p0')
    expect(game.state.judgment).toEqual({ playerId: 'p0', delayedCardId: lightningId, stage: 'awaiting-damage' })
    expect(JSON.parse(JSON.stringify(game.state)).judgment.delayedCardId).toBe(lightningId)
    while (game.state.dying) {
      const request = game.state.pendingRequests[0]
      game.respond({ requestId: request.id, playerId: request.playerId, payload: { actionId: 'rescue-pass' } })
    }
    expect(game.state.players[0].alive).toBe(false)
    expect(game.state.judgment).toBeNull()
    expect(game.state.zones.discardPile).toContain(lightningId)
    assertGameInvariants(game.state)
  })

  it('判定前单次无懈抵消乐不思蜀且不翻开判定牌', () => {
    const game = startedGame('judge-nullification-once')
    const delayedId = placeDelayed(game, 'p0', '乐不思蜀')
    const judgeId = forceTop(game, (candidate) => candidate.suit === 'spade')
    const nullification = card(game, (candidate) => candidate.name === '无懈可击')
    moveCard(game.state, nullification.id, locate(game.state, nullification.id), { kind: 'hand', playerId: 'p0' })
    game.advancePhase()
    expect(game.state.pendingRequests[0].playerId).toBe('p0')
    respondCurrent(game, `respond-nullification:${nullification.id}`)
    passJudgmentWindow(game)
    expect(game.state.skippedPhases).not.toContain('play')
    expect(game.state.zones.drawPile[0]).toBe(judgeId)
    expect(game.state.zones.discardPile).toEqual(expect.arrayContaining([delayedId, nullification.id]))
  })

  it('判定前无懈再被无懈后恢复乐不思蜀判定', () => {
    const game = startedGame('judge-nullification-twice')
    placeDelayed(game, 'p0', '乐不思蜀')
    const judgeId = forceTop(game, (candidate) => candidate.suit === 'spade')
    const nullifications = Object.values(game.state.cards).filter((candidate) => candidate.name === '无懈可击').slice(0, 2)
    moveCard(game.state, nullifications[0].id, locate(game.state, nullifications[0].id), { kind: 'hand', playerId: 'p0' })
    moveCard(game.state, nullifications[1].id, locate(game.state, nullifications[1].id), { kind: 'hand', playerId: 'p1' })
    game.advancePhase()
    respondCurrent(game, `respond-nullification:${nullifications[0].id}`)
    passUntilResponder(game, 'p1')
    respondCurrent(game, `respond-nullification:${nullifications[1].id}`)
    passJudgmentWindow(game)
    expect(game.state.skippedPhases).toContain('play')
    expect(game.state.zones.discardPile).toContain(judgeId)
  })

  it('判定前闪电被无懈抵消后传给下一名合法角色', () => {
    const game = startedGame('lightning-nullified')
    const lightningId = placeDelayed(game, 'p0', '闪电')
    const nullification = card(game, (candidate) => candidate.name === '无懈可击')
    moveCard(game.state, nullification.id, locate(game.state, nullification.id), { kind: 'hand', playerId: 'p0' })
    game.advancePhase()
    respondCurrent(game, `respond-nullification:${nullification.id}`)
    passJudgmentWindow(game)
    expect(game.state.players[1].zones.judgingArea).toContain(lightningId)
    expect(game.state.players[0].hp).toBe(4)
  })
})
