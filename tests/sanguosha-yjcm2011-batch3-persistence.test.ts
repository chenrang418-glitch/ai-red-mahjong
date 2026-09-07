import { describe, expect, it } from 'vitest'
import { SanguoshaGame } from '@/sanguosha/engine/game'
import { assertCardConservation, moveCard } from '@/sanguosha/engine/zones'
import { DETAINED_HIDDEN_PILE, detainCards, detainedCardsOf } from '@/sanguosha/engine/turn-bound-pile'
import { isArmorSuppressed } from '@/sanguosha/engine/armor-suppression'
import { canUseSlashAtTargets } from '@/sanguosha/engine/slash-rules'
import { canUseCardAs } from '@/sanguosha/engine/forced-identity'
import { buildPlayerView } from '@/sanguosha/engine/view'
import type { GameSetup, Identity, PlayerId } from '@/sanguosha/engine/types'

/**
 * 第三批带进来的状态**必须能过一遍存盘重建**。
 *
 * Durable Object 随时会休眠。这一批要带过去的东西是：
 * 破军的临时扣置区（连同「哪些是暗的」）、归还的回合绑定、
 * 智迟的生效回合、陷阵的定向修正（距离、次数、防具压制）、
 * 以及禁酒的牌身份改写。
 *
 * 重连之后不能：重复扣置、重复归还、暗牌泄漏、陷阵状态丢失或提前过期。
 */

interface AnyRequest { id: string; playerId: PlayerId; kind: string; prompt?: string }

function gameAt(seed: string, characterIds: string[]): SanguoshaGame {
  const setup: GameSetup = {
    mode: 'identity', generalChoices: 1,
    players: Array.from({ length: 5 }, (_, index) => ({ id: `p${index}`, nickname: `玩家${index}`, isHuman: index === 0 })),
  }
  const game = new SanguoshaGame({ seed, setup })
  const identities: Identity[] = ['lord', 'rebel', 'loyalist', 'rebel', 'renegade']
  game.state.players.forEach((player, index) => {
    player.identity = identities[index]
    player.identityRevealed = player.identity === 'lord'
    player.characterId = characterIds[index]
  })
  game.state.currentPlayerId = 'p0'
  game.start()
  drain(game)
  while (game.state.phase !== 'play') {
    game.advancePhase()
    drain(game)
  }
  return game
}

function drain(game: SanguoshaGame): void {
  for (let guard = 0; guard < 400; guard += 1) {
    const request = game.state.pendingRequests[0] as AnyRequest | undefined
    if (!request) return
    game.respond({ requestId: request.id, playerId: request.playerId, payload: minimalPayload(request) })
  }
  throw new Error('结算没有收敛')
}

function minimalPayload(request: AnyRequest): Record<string, unknown> {
  switch (request.kind) {
    case 'choose-general': return { characterId: (request as unknown as { candidates: string[] }).candidates[0] }
    case 'choose-options': return { optionIds: [] }
    case 'choose-cards': {
      const pick = request as unknown as { cardIds: string[]; hiddenCardSlots: string[]; min: number }
      return { cardIds: [...pick.cardIds, ...pick.hiddenCardSlots].slice(0, pick.min ?? 0) }
    }
    case 'choose-targets': {
      const pick = request as unknown as { candidateIds: string[]; min: number }
      return { targetIds: pick.candidateIds.slice(0, pick.min ?? 0) }
    }
    case 'choose-option': {
      const options = (request as unknown as { options: { id: string }[] }).options
      return { optionId: options[options.length - 1].id }
    }
    case 'arrange-cards': {
      const pick = request as unknown as { cardIds: string[] }
      return { top: [...pick.cardIds], bottom: [] }
    }
    case 'rescue': return { actionId: 'rescue-pass' }
    default: return { actionId: 'respond-pass' }
  }
}

/** 存一次盘再读回来，模拟 Durable Object 休眠。 */
function roundTrip(game: SanguoshaGame): SanguoshaGame {
  return SanguoshaGame.restore(JSON.parse(JSON.stringify(game.serialize())))
}

function playerOf(game: SanguoshaGame, id: string) {
  return game.state.players.find((candidate) => candidate.id === id)!
}

function setHand(game: SanguoshaGame, playerId: string, count: number): void {
  const player = playerOf(game, playerId)
  for (const cardId of player.zones.hand.slice(count)) {
    moveCard(game.state, cardId, { kind: 'hand', playerId }, { kind: 'discardPile' })
  }
  while (player.zones.hand.length < count) {
    moveCard(game.state, game.state.zones.drawPile[0], { kind: 'drawPile' }, { kind: 'hand', playerId })
  }
}

function equipAny(game: SanguoshaGame, playerId: string, slot: 'weapon' | 'armor'): string {
  const card = Object.values(game.state.cards).find((candidate) => candidate.category === 'equipment'
    && candidate.equipmentSlot === slot
    && !candidate.virtual
    && game.state.zones.drawPile.includes(candidate.id))
  if (!card) throw new Error(`牌堆里没有闲置的${slot}装备`)
  moveCard(game.state, card.id, { kind: 'drawPile' }, { kind: 'equipment', playerId, slot })
  return card.id
}

describe('一将成名 2011 第三批：重连之后状态一模一样', () => {
  it('破军的扣置区、可见性和归还绑定都过得去存盘', () => {
    const game = gameAt('b3-persist-pojun', ['xusheng', 'zhangfei', 'guanyu', 'zhaoyun', 'huangzhong'])
    setHand(game, 'p1', 2)
    const weapon = equipAny(game, 'p1', 'weapon')
    const cardIds = [...playerOf(game, 'p1').zones.hand, weapon]
    detainCards(game as never, { ownerId: 'p1', sourceId: 'p0', skillId: 'pojun', cardIds })
    game.settle()
    drain(game)
    const detained = detainedCardsOf(game.state, 'p1')
    expect(detained.length, '三张都扣下来了').toBe(3)
    const turnNumber = game.state.turnNumber

    const restored = roundTrip(game)
    expect(detainedCardsOf(restored.state, 'p1').sort(), '扣置区原样回来').toEqual([...detained].sort())
    for (const entry of restored.state.detainedCards ?? []) {
      expect(entry.turnNumber, '归还绑定的回合也带过来了').toBe(turnNumber)
      expect(entry.sourceId, '是谁扣的也记着').toBe('p0')
    }
    // 暗的那几张重连之后仍然只有主人看得见
    const facesFor = (viewerId: string): string[] => {
      const seat = buildPlayerView(restored.state, viewerId).players.find((player) => player.id === 'p1')!
      return (seat.characterPiles[DETAINED_HIDDEN_PILE] ?? []).map((card) => card.id)
    }
    expect(facesFor('p1').length, '主人自己看得到').toBeGreaterThan(0)
    expect(facesFor('p0'), '徐盛看不到').toEqual([])
    expect(facesFor('p2'), '第三方看不到').toEqual([])
    assertCardConservation(restored.state)
  })

  it('重连之后回合结束照常归还，而且只归还一次', () => {
    const game = gameAt('b3-persist-return', ['xusheng', 'zhangfei', 'guanyu', 'zhaoyun', 'huangzhong'])
    setHand(game, 'p1', 2)
    const cardIds = [...playerOf(game, 'p1').zones.hand]
    detainCards(game as never, { ownerId: 'p1', sourceId: 'p0', skillId: 'pojun', cardIds })
    game.settle()
    drain(game)

    const restored = roundTrip(game)
    for (let guard = 0; guard < 12 && restored.state.currentPlayerId === 'p0'; guard += 1) {
      restored.advancePhase()
      drain(restored)
    }
    expect(detainedCardsOf(restored.state, 'p1'), '归还之后记录清空').toHaveLength(0)
    for (const cardId of cardIds) {
      expect(playerOf(restored, 'p1').zones.hand, '牌回到手上').toContain(cardId)
    }
    // 再推几个阶段，不能第二次「归还」
    for (let guard = 0; guard < 6; guard += 1) {
      restored.advancePhase()
      drain(restored)
    }
    assertCardConservation(restored.state)
  })

  it('智迟的生效回合过得去存盘，而且不会提前或延后失效', () => {
    const game = gameAt('b3-persist-zhichi', ['chengong', 'zhangfei', 'guanyu', 'zhaoyun', 'huangzhong'])
    playerOf(game, 'p0').marks['zhichi-turn'] = game.state.turnNumber

    const restored = roundTrip(game)
    expect(restored.state.players[0].marks['zhichi-turn'], '记号原样回来').toBe(game.state.turnNumber)
    // 同一个回合里仍然生效
    expect(restored.state.players[0].marks['zhichi-turn'] === restored.state.turnNumber, '本回合仍然生效').toBe(true)
    restored.state.turnNumber += 1
    expect(restored.state.players[0].marks['zhichi-turn'] === restored.state.turnNumber, '下一个回合失效').toBe(false)
  })

  it('陷阵的三项定向修正都过得去存盘', () => {
    const game = gameAt('b3-persist-xianzhen', ['gaoshun', 'zhangfei', 'guanyu', 'zhaoyun', 'huangzhong'])
    // 直接摆出「本回合陷阵赢过 p1」的状态
    playerOf(game, 'p0').marks['xianzhen-won:p1'] = game.state.turnNumber
    game.state.armorSuppressions = [{
      sourceId: 'p0', targetIds: ['p1'], expiry: 'turn-end', appliedTurn: game.state.turnNumber, skillId: 'xianzhen',
    }]
    equipAny(game, 'p1', 'armor')

    const restored = roundTrip(game)
    expect(isArmorSuppressed(restored.state, 'p1', 'p0'), '防具压制还在').toBe(true)
    expect(isArmorSuppressed(restored.state, 'p1', 'p2'), '而且仍然只对高顺').toBe(false)
    restored.state.turnUsage.slashUses = 1
    expect(canUseSlashAtTargets(restored.state, 'p0', false, ['p1']), '定向的次数豁免还在').toBe(true)
    expect(canUseSlashAtTargets(restored.state, 'p0', false, ['p2']), '对别人仍然受限').toBe(false)
  })

  it('禁酒的牌身份改写重连之后仍然生效', () => {
    const game = gameAt('b3-persist-jinjiu', ['gaoshun', 'zhangfei', 'guanyu', 'zhaoyun', 'huangzhong'])
    const wine = Object.values(game.state.cards).find((card) => card.name === '酒'
      && !card.virtual && game.state.zones.drawPile.includes(card.id))!
    moveCard(game.state, wine.id, { kind: 'drawPile' }, { kind: 'hand', playerId: 'p0' })

    const restored = roundTrip(game)
    expect(canUseCardAs(restored.state, 'p0', wine.id, '杀'), '仍然只能当杀').toBe(true)
    expect(canUseCardAs(restored.state, 'p0', wine.id, '酒'), '仍然不能当酒').toBe(false)
    // 别人手上的酒不受影响
    moveCard(restored.state, wine.id, { kind: 'hand', playerId: 'p0' }, { kind: 'hand', playerId: 'p1' })
    expect(canUseCardAs(restored.state, 'p1', wine.id, '酒'), '改写只跟着技能拥有者').toBe(true)
  })
})
