import { describe, expect, it } from 'vitest'
import { SanguoshaGame } from '@/sanguosha/engine/game'
import { assertCardConservation, moveCard } from '@/sanguosha/engine/zones'
import { assertGameInvariants } from '@/sanguosha/engine/invariants'
import { lockCardColor, lockedColorsOf, cardPlayable } from '@/sanguosha/engine/card-play-lock'
import { recordCardDamage, cardDamageDealt } from '@/sanguosha/engine/card-damage-ledger'
import { slashUsesThisTurn } from '@/sanguosha/engine/slash-rules'
import { usedThisPhase, markUsedThisPhase } from '@/sanguosha/engine/phase-usage'
import { ownedSkillIds } from '@/sanguosha/engine/skills/runtime'
import { replaceTemporarySkills } from '@/sanguosha/engine/skills/runtime'
import { skillIdsOf } from '@/sanguosha/data/characters/standard'
import { CHUN_PILE, chunOf } from '@/sanguosha/data/characters/yjcm2012-chengpu'
import { buildPlayerView } from '@/sanguosha/engine/view'
import type { GameSetup, Identity, PlayerId } from '@/sanguosha/engine/types'

/**
 * 一将成名 2012 第二批带进来的状态**必须能过一遍存盘重建**。
 *
 * Durable Object 随时会休眠。这一批要带过去的是：额外阶段的调度状态、
 * 按出牌阶段实例算的杀次数、父魂的临时授技、潜袭的颜色禁令、
 * 按牌记的伤害账、程普武将牌上的醇。
 *
 * 重连之后不能：重复跑额外阶段、把出杀次数还回去、丢掉禁令或临时技能、
 * 重复失去体力、泄漏暗牌。
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

describe('一将成名 2012 第二批：重连之后状态一模一样', () => {
  it('额外出牌阶段过得去存盘：不会重跑，也不会丢掉后半个回合', () => {
    const game = gameAt('b2-persist-dangxian', ['liaohua', 'zhangfei', 'guanyu', 'zhaoyun', 'huangzhong'])
    expect(game.state.phase, '开局第一个阶段就是额外出牌阶段').toBe('play')
    const extra = game.state.extraPhase!
    expect(extra.skillId).toBe('dangxian')

    const restored = roundTrip(game)
    expect(restored.state.extraPhase, '额外阶段状态原样回来').toEqual(extra)
    expect(restored.state.phase).toBe('play')

    // 接着走完这个回合：额外阶段之后仍然是完整的六个阶段
    const seen: string[] = []
    const startTurn = restored.state.turnNumber
    for (let guard = 0; guard < 12; guard += 1) {
      restored.advancePhase()
      drain(restored)
      if (restored.state.turnNumber !== startTurn) break
      seen.push(restored.state.phase)
    }
    expect(seen, '重连之后回合的其余部分一个阶段都不少').toEqual(['prepare', 'judge', 'draw', 'play', 'discard', 'finish'])
    assertGameInvariants(restored.state)
  })

  it('按出牌阶段实例算的杀次数过得去存盘', () => {
    const game = gameAt('b2-persist-slashuses', ['liaohua', 'zhangfei', 'guanyu', 'zhaoyun', 'huangzhong'])
    game.state.turnUsage.slashUses = 1
    game.state.turnUsage.slashUsesThisTurn = 1
    markUsedThisPhase(game.state, 'p0', 'demo')

    const restored = roundTrip(game)
    expect(restored.state.turnUsage.slashUses, '本阶段已用次数还在').toBe(1)
    expect(slashUsesThisTurn(restored.state), '回合级的账也还在').toBe(1)
    expect(usedThisPhase(restored.state, 'p0', 'demo'), '「出牌阶段限一次」的记号绑在这个阶段实例上').toBe(true)
  })

  it('父魂临时授予的技能过得去存盘，而且只收回这一次授予的', () => {
    const game = gameAt('b2-persist-fuhun', ['guanxingzhangbao', 'zhangfei', 'guanyu', 'zhaoyun', 'huangzhong'])
    const owner = playerOf(game, 'p0')
    owner.grantedSkills = [...(owner.grantedSkills ?? []), 'paoxiao']
    replaceTemporarySkills(game.state, 'p0', 'fuhun:grant', ['wusheng', 'paoxiao'])
    owner.marks['fuhun-granted-turn'] = game.state.turnNumber

    const restored = roundTrip(game)
    const owned = ownedSkillIds(restored.state, 'p0', skillIdsOf)
    expect(owned, '临时的武圣还在').toContain('wusheng')
    expect(owned, '临时的咆哮还在').toContain('paoxiao')
    expect(playerOf(restored, 'p0').marks['fuhun-granted-turn'], '授技回合记号还在').toBe(game.state.turnNumber)

    // 收回之后，别处授予的咆哮不受影响
    replaceTemporarySkills(restored.state, 'p0', 'fuhun:grant', [])
    const after = ownedSkillIds(restored.state, 'p0', skillIdsOf)
    expect(after, '父魂给的武圣被收回').not.toContain('wusheng')
    expect(after, '别处授予的咆哮留着').toContain('paoxiao')
  })

  it('潜袭的颜色禁令过得去存盘', () => {
    const game = gameAt('b2-persist-qianxi', ['madai', 'zhangfei', 'guanyu', 'zhaoyun', 'huangzhong'])
    lockCardColor(game.state, { targetId: 'p1', color: 'red', sourceId: 'p0', skillId: 'qianxi' })
    const red = Object.values(game.state.cards).find((card) => !card.virtual && card.color === 'red'
      && game.state.zones.drawPile.includes(card.id))!
    moveCard(game.state, red.id, { kind: 'drawPile' }, { kind: 'hand', playerId: 'p1' })

    const restored = roundTrip(game)
    expect(lockedColorsOf(restored.state, 'p1'), '禁令原样回来').toEqual(['red'])
    expect(cardPlayable(restored.state, 'p1', red.id), '重连之后仍然用不出红色手牌').toBe(false)
    expect(restored.state.cardColorLocks?.[0]?.turnNumber, '绑定的回合序号也要带过来').toBe(game.state.turnNumber)
  })

  it('按牌记的伤害账过得去存盘：重连之后不会重复失去体力', () => {
    const game = gameAt('b2-persist-ledger', ['chengpu', 'zhangfei', 'guanyu', 'zhaoyun', 'huangzhong'])
    const slash = Object.values(game.state.cards).find((card) => card.name === '杀' && !card.virtual)!
    recordCardDamage(game.state, slash.id, 1)
    game.state.natureConvertedCardIds = [slash.id]

    const restored = roundTrip(game)
    expect(cardDamageDealt(restored.state, slash.id), '这次使用造成过 1 点伤害').toBe(1)
    expect(restored.state.natureConvertedCardIds, '疠火的牌标记原样回来').toEqual([slash.id])
  })

  it('武将牌上的醇过得去存盘，而且仍然公开', () => {
    const game = gameAt('b2-persist-chun', ['chengpu', 'zhangfei', 'guanyu', 'zhaoyun', 'huangzhong'])
    const stored: string[] = []
    for (let index = 0; index < 2; index += 1) {
      const cardId = game.state.zones.drawPile[0]
      moveCard(game.state, cardId, { kind: 'drawPile' }, { kind: 'characterPile', playerId: 'p0', pile: CHUN_PILE })
      stored.push(cardId)
    }

    const restored = roundTrip(game)
    expect(chunOf(restored.state, 'p0'), '两张醇都在').toEqual(stored)
    const seat = buildPlayerView(restored.state, 'p1').players.find((player) => player.id === 'p0')!
    expect((seat.characterPiles[CHUN_PILE] ?? []).map((card) => card.id), '醇仍然公开').toEqual(stored)
    assertCardConservation(restored.state)
  })
})
