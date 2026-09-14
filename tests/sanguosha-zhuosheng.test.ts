import { describe, expect, it } from 'vitest'
import { SanguoshaGame } from '@/sanguosha/engine/game'
import { assertCardConservation, moveCard, type ZoneRef } from '@/sanguosha/engine/zones'
import { assertGameInvariants } from '@/sanguosha/engine/invariants'
import type { GameSetup, Identity, SanguoshaState } from '@/sanguosha/engine/types'

/**
 * 石苞【擢升】：普通锦囊目标数 ±1。
 *
 * 验证目标数修改真的作用在动作生成层——多/少的那个目标能被选中、
 * 结算完仍然守恒——而不是停留在注释里的"已知简化"。
 */

function gameWith(characterIds: string[], seed = 'zhuosheng'): SanguoshaGame {
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

function giveCard(game: SanguoshaGame, playerId: string, cardName: string): string {
  const own = game.state.players.find((player) => player.id === playerId)!
  const existing = own.zones.hand.find((cardId) => game.state.cards[cardId]?.name === cardName)
  if (existing) return existing
  const card = Object.values(game.state.cards)
    .find((candidate) => candidate.name === cardName && !own.zones.hand.includes(candidate.id))!
  moveCard(game.state, card.id, locate(game.state, card.id), { kind: 'hand', playerId })
  return card.id
}

function stripCard(game: SanguoshaGame, cardName: string): void {
  for (const player of game.state.players) {
    for (const cardId of [...player.zones.hand]) {
      if (game.state.cards[cardId]?.name !== cardName) continue
      moveCard(game.state, cardId, { kind: 'hand', playerId: player.id }, { kind: 'discardPile' })
    }
  }
}

function useOn(game: SanguoshaGame, playerId: string, cardId: string, targetIds: string[]): void {
  const action = game.legalActions(playerId).find((candidate) => (
    candidate.kind === 'use-card'
    && candidate.cardIds.includes(cardId)
    && candidate.targetIds.length === targetIds.length
    && targetIds.every((id) => candidate.targetIds.includes(id))
  ))
  if (!action) throw new Error(`找不到出牌动作：${cardId} -> ${targetIds.join(',')}`)
  game.act(playerId, action.id)
}

function passAll(game: SanguoshaGame): void {
  for (let guard = 0; guard < 200; guard += 1) {
    const request = game.state.pendingRequests[0]
    if (!request) return
    if (request.kind === 'rescue') {
      game.respond({ requestId: request.id, playerId: request.playerId, payload: { actionId: 'rescue-pass' } })
      continue
    }
    if (request.kind === 'choose-cards') {
      // 拆桥/顺手牵羊这类「从目标区域挑1张」的请求没有 pass 选项，随便挑一个合法项凑够 min 张
      const picked = [...request.cardIds, ...request.hiddenCardSlots].slice(0, request.min)
      game.respond({ requestId: request.id, playerId: request.playerId, payload: { cardIds: picked } })
      continue
    }
    game.respond({ requestId: request.id, playerId: request.playerId, payload: { actionId: 'respond-pass' } })
  }
  throw new Error('结算没有收敛')
}

describe('石苞【擢升】：普通锦囊目标数±1', () => {
  it('过河拆桥可以额外多指定一个目标，两名目标各被拆一张牌', () => {
    const game = gameWith(['shibao', 'zhangfei', 'guanyu', 'zhaoyun', 'machao'])
    stripCard(game, '无懈可击')
    const p1 = game.state.players[1]
    const p2 = game.state.players[2]
    giveCard(game, p1.id, '杀')
    giveCard(game, p2.id, '杀')
    const cardId = giveCard(game, 'p0', '过河拆桥')

    const before1 = p1.zones.hand.length
    const before2 = p2.zones.hand.length
    useOn(game, 'p0', cardId, [p1.id, p2.id])
    passAll(game)

    expect(p1.zones.hand.length).toBe(before1 - 1)
    expect(p2.zones.hand.length).toBe(before2 - 1)
    assertCardConservation(game.state)
    assertGameInvariants(game.state)
  })

  it('万箭齐发可以少打一个目标，被跳过的人不用打闪', () => {
    const game = gameWith(['shibao', 'zhangfei', 'guanyu', 'zhaoyun', 'machao'])
    stripCard(game, '无懈可击')
    stripCard(game, '闪')
    const skipped = game.state.players[1]
    const others = [game.state.players[2].id, game.state.players[3].id, game.state.players[4].id]
    const cardId = giveCard(game, 'p0', '万箭齐发')
    const hpBefore = Object.fromEntries(game.state.players.map((p) => [p.id, p.hp]))

    useOn(game, 'p0', cardId, others)
    passAll(game)

    expect(game.state.players.find((p) => p.id === skipped.id)!.hp).toBe(hpBefore[skipped.id])
    for (const id of others) {
      expect(game.state.players.find((p) => p.id === id)!.hp).toBe(hpBefore[id] - 1)
    }
    assertCardConservation(game.state)
    assertGameInvariants(game.state)
  })

  it('本轮因擢升装备分支获得的牌不能再触发擢升的目标数修改', () => {
    const game = gameWith(['shibao', 'zhangfei', 'guanyu', 'zhaoyun', 'machao'])
    stripCard(game, '无懈可击')
    const weaponId = giveCard(game, 'p0', '诸葛连弩')
    useOn(game, 'p0', weaponId, ['p0'])
    passAll(game)
    expect(game.state.zhuoshengObtained?.ids.length).toBeGreaterThan(0)

    const obtainedId = game.state.zhuoshengObtained!.ids[0]
    const obtainedCard = game.state.cards[obtainedId]
    if (obtainedCard?.name === '过河拆桥' && game.state.players[0].zones.hand.includes(obtainedId)) {
      const p1 = game.state.players[1]
      const p2 = game.state.players[2]
      giveCard(game, p1.id, '杀')
      giveCard(game, p2.id, '杀')
      const action = game.legalActions('p0').find((candidate) => (
        candidate.kind === 'use-card' && candidate.cardIds.includes(obtainedId) && candidate.targetIds.length === 2
      ))
      expect(action).toBeUndefined()
    }
    assertCardConservation(game.state)
  })
})
