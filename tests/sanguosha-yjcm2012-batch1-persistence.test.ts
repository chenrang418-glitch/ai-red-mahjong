import { describe, expect, it } from 'vitest'
import { SanguoshaGame } from '@/sanguosha/engine/game'
import { assertCardConservation, moveCard } from '@/sanguosha/engine/zones'
import { maxCardsOf } from '@/sanguosha/engine/phase'
import { grantTurnSlashBonus, slashRules } from '@/sanguosha/engine/slash-rules'
import { cardColorOverrideOf, setCardColorOverride } from '@/sanguosha/engine/card-color'
import { ownedSkillIds } from '@/sanguosha/engine/skills/runtime'
import { QUAN_PILE, quanCountOf } from '@/sanguosha/data/characters/yjcm2012-zhonghui'
import { skillIdsOf } from '@/sanguosha/data/characters/standard'
import { buildPlayerView } from '@/sanguosha/engine/view'
import type { GameSetup, Identity, PlayerId } from '@/sanguosha/engine/types'

/**
 * 一将成名 2012 第一批带进来的状态**必须能过一遍存盘重建**。
 *
 * Durable Object 随时会休眠。这一批要带过去的是：将驰两个分支的本回合状态、
 * 钟会的权堆与觉醒记账、荀攸虚拟牌的颜色改写、王异的挂起步骤。
 *
 * 重连之后不能：重复摸牌、重复放权、重复觉醒、丢掉本回合的禁令或加成、
 * 泄漏暗牌。
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
    case 'distribute-cards': return { assignments: [] }
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

function stackQuan(game: SanguoshaGame, playerId: string, count: number): string[] {
  const placed: string[] = []
  for (let index = 0; index < count; index += 1) {
    const cardId = game.state.zones.drawPile[0]
    moveCard(game.state, cardId, { kind: 'drawPile' }, { kind: 'characterPile', playerId, pile: QUAN_PILE })
    placed.push(cardId)
  }
  return placed
}

describe('一将成名 2012 第一批：重连之后状态一模一样', () => {
  it('将驰的「多摸」禁令过得去存盘', () => {
    const game = gameAt('b1-persist-jiangchi-more', ['caozhang', 'zhangfei', 'guanyu', 'zhaoyun', 'huangzhong'])
    playerOf(game, 'p0').marks['jiangchi-no-slash'] = game.state.turnNumber
    playerOf(game, 'p0').attackRangeBonus = 6
    moveCard(game.state, game.state.zones.drawPile[0], { kind: 'drawPile' }, { kind: 'hand', playerId: 'p0' })

    const restored = roundTrip(game)
    expect(playerOf(restored, 'p0').marks['jiangchi-no-slash'], '记号原样回来').toBe(game.state.turnNumber)
    const slashActions = restored.legalActions('p0').filter((action) => action.kind === 'use-card' && action.asCardName === '杀')
    expect(slashActions, '重连之后仍然出不了杀').toHaveLength(0)
  })

  it('将驰的「少摸」加成过得去存盘', () => {
    const game = gameAt('b1-persist-jiangchi-less', ['caozhang', 'zhangfei', 'guanyu', 'zhaoyun', 'huangzhong'])
    grantTurnSlashBonus(game.state, 'p0', { extraUses: 1, ignoreDistance: true })

    const restored = roundTrip(game)
    expect(slashRules(restored.state, 'p0').extraUses, '多的那一次还在').toBe(1)
    expect(slashRules(restored.state, 'p0').ignoreDistance, '无距离限制还在').toBe(true)
  })

  it('权堆、手牌上限和觉醒记账都过得去存盘', () => {
    const game = gameAt('b1-persist-quan', ['zhonghui', 'zhangfei', 'guanyu', 'zhaoyun', 'huangzhong'])
    const owner = playerOf(game, 'p0')
    owner.hp = 2
    const quan = stackQuan(game, 'p0', 3)
    const maxCards = maxCardsOf(game.state, 'p0')
    owner.grantedSkills = [...(owner.grantedSkills ?? []), 'paiyi']
    owner.awakenedSkills = [...(owner.awakenedSkills ?? []), 'zili']

    const restored = roundTrip(game)
    expect(quanCountOf(restored.state, 'p0'), '三张权都在').toBe(3)
    expect(playerOf(restored, 'p0').characterPiles?.[QUAN_PILE], '还是那三张牌').toEqual(quan)
    expect(maxCardsOf(restored.state, 'p0'), '手牌上限加成跟着回来').toBe(maxCards)
    expect(ownedSkillIds(restored.state, 'p0', skillIdsOf), '排异还在').toContain('paiyi')
    expect(playerOf(restored, 'p0').awakenedSkills, '觉醒记账还在，不会再觉醒一次').toContain('zili')
    // 权是公开的，重连之后所有人仍然看得到
    const seat = buildPlayerView(restored.state, 'p1').players.find((player) => player.id === 'p0')!
    expect((seat.characterPiles[QUAN_PILE] ?? []).map((card) => card.id), '权仍然公开').toEqual(quan)
    assertCardConservation(restored.state)
  })

  it('虚拟牌的颜色改写过得去存盘', () => {
    const game = gameAt('b1-persist-color', ['xunyou', 'zhangfei', 'guanyu', 'zhaoyun', 'huangzhong'])
    const cardId = game.state.zones.drawPile[0]
    setCardColorOverride(game.state, cardId, null)

    const restored = roundTrip(game)
    expect(cardColorOverrideOf(restored.state, cardId), '「无色」这一种也要带过来').toBe(null)
  })

  it('王异停在贞烈的发问上：重连之后从同一步接着走', () => {
    const game = gameAt('b1-persist-zhenlie', ['wangyi', 'zhangfei', 'guanyu', 'zhaoyun', 'huangzhong'])
    const owner = playerOf(game, 'p0')
    owner.hp = owner.maxHp
    game.state.currentPlayerId = 'p1'
    game.state.phase = 'play'
    playerOf(game, 'p1').attackRangeBonus = 6
    const slash = Object.values(game.state.cards).find((card) => card.name === '杀'
      && !card.virtual && game.state.zones.drawPile.includes(card.id))!
    moveCard(game.state, slash.id, { kind: 'drawPile' }, { kind: 'hand', playerId: 'p1' })
    const action = game.legalActions('p1').find((candidate) => candidate.kind === 'use-card'
      && candidate.asCardName === '杀' && candidate.cardIds.includes(slash.id) && candidate.targetIds.includes('p0'))!
    game.act('p1', action.id)
    const pending = game.state.pendingRequests[0] as AnyRequest
    expect(pending.prompt, '停在贞烈那一问上').toContain('贞烈')

    const restored = roundTrip(game)
    expect(restored.state.pendingRequests[0]?.id, '还是同一个请求').toBe(pending.id)
    // 接着答完，牌局要能收敛
    drain(restored)
    assertCardConservation(restored.state)
  })
})
