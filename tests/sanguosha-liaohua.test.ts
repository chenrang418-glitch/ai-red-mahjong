import { describe, expect, it } from 'vitest'
import { SanguoshaGame } from '@/sanguosha/engine/game'
import { assertCardConservation, moveCard, type ZoneRef } from '@/sanguosha/engine/zones'
import { assertGameInvariants } from '@/sanguosha/engine/invariants'
import { markUsedThisPhase, usedThisPhase } from '@/sanguosha/engine/phase-usage'
import { slashUsesThisTurn } from '@/sanguosha/engine/slash-rules'
import { livingKingdomCount } from '@/sanguosha/data/characters/yjcm2012-liaohua'
import type { GameSetup, Identity, PlayerId, SanguoshaState, TurnPhase } from '@/sanguosha/engine/types'

/**
 * 廖化（一将成名 2012）。
 *
 * 逐条有断言的主张：
 *
 * - 【当先】给的是**额外的出牌阶段**，不是额外回合：轮次不动、回合数不动，
 *   而且这个回合原有的六个阶段一个不少地照跑；
 * - 它插在**准备阶段之前**，是这个回合的第一个阶段；
 * - 【杀】的次数按**出牌阶段实例**算，所以一个回合出得了两张；
 * - 「出牌阶段限一次」在两个出牌阶段里各有一次；
 * - 回合级的账（酒、本回合使用过几张杀）两个阶段共享；
 * - 武将牌背面朝上时整个回合被跳过，额外阶段也不执行；
 * - 【伏枥】回复**至** X 点，X 是现存势力数（去重、只数活人），然后翻面；
 * - 【伏枥】是限定技，一局只有一次。
 */

const CAST = ['liaohua', 'zhangfei', 'zhaoyun', 'huangzhong', 'guojia']

interface AnyRequest { id: string; playerId: PlayerId; kind: string; prompt?: string }

function defaultResponse(request: AnyRequest) {
  const payload: Record<string, unknown> = (() => {
    switch (request.kind) {
      case 'choose-option': {
        const options = (request as unknown as { options: { id: string }[] }).options
        return { optionId: options[options.length - 1].id }
      }
      case 'choose-options': {
        const pick = request as unknown as { options: { id: string }[]; min: number }
        return { optionIds: pick.options.slice(0, pick.min ?? 0).map((option) => option.id) }
      }
      case 'choose-cards': {
        const pick = request as unknown as { cardIds: string[]; hiddenCardSlots: string[]; min: number }
        return { cardIds: [...pick.cardIds, ...pick.hiddenCardSlots].slice(0, pick.min ?? 0) }
      }
      case 'choose-targets': {
        const pick = request as unknown as { candidateIds: string[]; min: number }
        return { targetIds: pick.candidateIds.slice(0, pick.min ?? 0) }
      }
      case 'arrange-cards': {
        const pick = request as unknown as { cardIds: string[] }
        return { top: [...pick.cardIds], bottom: [] }
      }
      case 'distribute-cards': return { assignments: [] }
      case 'rescue': return { actionId: 'rescue-pass' }
      default: return { actionId: 'respond-pass' }
    }
  })()
  return { requestId: request.id, playerId: request.playerId, payload }
}

function settle(
  game: SanguoshaGame,
  choose: (request: AnyRequest) => Record<string, unknown> | null = () => null,
): void {
  for (let guard = 0; guard < 400; guard += 1) {
    const request = game.state.pendingRequests[0] as AnyRequest | undefined
    if (!request) return
    const custom = choose(request)
    game.respond(custom
      ? { requestId: request.id, playerId: request.playerId, payload: custom }
      : defaultResponse(request))
  }
  throw new Error('结算没有收敛')
}

/** 开局并停在**回合的第一个阶段**上，不往前走——当先的插入点正是这里。 */
function gameAtTurnStart(seed: string, characterIds: string[] = CAST): SanguoshaGame {
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
  settle(game)
  return game
}

function playerOf(game: SanguoshaGame, id: string) {
  return game.state.players.find((candidate) => candidate.id === id)!
}

function locate(state: SanguoshaState, cardId: string): ZoneRef {
  if (state.zones.drawPile.includes(cardId)) return { kind: 'drawPile' }
  if (state.zones.discardPile.includes(cardId)) return { kind: 'discardPile' }
  if (state.zones.processingArea.includes(cardId)) return { kind: 'processingArea' }
  for (const owner of state.players) {
    if (owner.zones.hand.includes(cardId)) return { kind: 'hand', playerId: owner.id }
    if (owner.zones.judgingArea.includes(cardId)) return { kind: 'judgingArea', playerId: owner.id }
    for (const [slot, equipped] of Object.entries(owner.zones.equipment)) {
      if (equipped === cardId) return { kind: 'equipment', playerId: owner.id, slot: slot as never }
    }
  }
  throw new Error('找不到卡牌：' + cardId)
}

function giveCard(game: SanguoshaGame, playerId: string, cardName: string): string {
  const card = Object.values(game.state.cards).find((candidate) => candidate.name === cardName
    && !candidate.virtual
    && (game.state.zones.drawPile.includes(candidate.id) || game.state.zones.discardPile.includes(candidate.id)))
  if (!card) throw new Error(`牌堆里没有闲置的【${cardName}】`)
  moveCard(game.state, card.id, locate(game.state, card.id), { kind: 'hand', playerId })
  return card.id
}

/** 走完整个回合，记下依次跑过的阶段。 */
function walkTurn(game: SanguoshaGame, limit = 20): TurnPhase[] {
  const seen: TurnPhase[] = [game.state.phase]
  const startTurn = game.state.turnNumber
  for (let guard = 0; guard < limit; guard += 1) {
    game.advancePhase()
    settle(game)
    assertGameInvariants(game.state)
    if (game.state.turnNumber !== startTurn) break
    seen.push(game.state.phase)
  }
  return seen
}

function useSlashAt(game: SanguoshaGame, sourceId: string, targetId: string): boolean {
  const action = game.legalActions(sourceId).find((candidate) => candidate.kind === 'use-card'
    && candidate.asCardName === '杀' && candidate.targetIds.includes(targetId))
  if (!action) return false
  game.act(sourceId, action.id)
  settle(game)
  return true
}

describe('廖化【当先】：回合开始时的额外出牌阶段', () => {
  it('回合的第一个阶段就是额外出牌阶段，然后才是准备阶段', () => {
    const game = gameAtTurnStart('liaohua-dangxian-order')
    expect(game.state.phase, '回合的第一个阶段是出牌阶段').toBe('play')
    expect(game.state.extraPhase?.skillId, '这是当先给的额外阶段').toBe('dangxian')
    expect(game.state.extraPhase?.playerId).toBe('p0')
    expect(game.state.extraPhase?.resumeSlot, '走完之后回到准备阶段位').toBe('prepare')

    const seen = walkTurn(game)
    expect(seen, '额外出牌阶段在前，六个正常阶段一个不少').toEqual([
      'play', 'prepare', 'judge', 'draw', 'play', 'discard', 'finish',
    ])
  })

  it('是额外阶段不是额外回合：回合数和轮次都不动', () => {
    const game = gameAtTurnStart('liaohua-dangxian-not-a-turn')
    const turnNumber = game.state.turnNumber
    const roundNumber = game.state.roundNumber
    expect(game.state.extraTurns ?? [], '没有往额外回合队列里塞东西').toHaveLength(0)
    game.advancePhase()
    settle(game)
    expect(game.state.phase, '额外阶段之后是准备阶段').toBe('prepare')
    expect(game.state.turnNumber, '还是同一个回合').toBe(turnNumber)
    expect(game.state.roundNumber, '轮次没有被推进').toBe(roundNumber)
    expect(game.state.currentPlayerId, '还是廖化的回合').toBe('p0')
    expect(game.state.extraPhase, '额外阶段状态已经收走').toBeUndefined()
  })

  it('别人的回合没有额外阶段', () => {
    const game = gameAtTurnStart('liaohua-dangxian-others', ['zhangfei', 'liaohua', 'zhaoyun', 'huangzhong', 'guojia'])
    expect(game.state.phase, '张飞的回合从准备阶段开始').toBe('prepare')
    expect(game.state.extraPhase).toBeUndefined()
  })

  it('武将牌背面朝上时整个回合被跳过，额外阶段也不执行', () => {
    const game = gameAtTurnStart('liaohua-dangxian-facedown', ['zhangfei', 'liaohua', 'zhaoyun', 'huangzhong', 'guojia'])
    playerOf(game, 'p1').faceDown = true
    // 走到廖化的回合
    for (let guard = 0; guard < 20; guard += 1) {
      game.advancePhase()
      settle(game)
      if (game.state.currentPlayerId === 'p1') break
    }
    expect(game.state.currentPlayerId, '轮到廖化了').toBe('p1')
    expect(playerOf(game, 'p1').faceDown, '武将牌被翻回正面').toBe(false)
    expect(game.state.extraPhase, '被跳过的回合里不执行额外阶段').toBeUndefined()
    expect(game.state.phase, '停在结束阶段位，整个回合被跳过').toBe('finish')
  })
})

describe('廖化【当先】：按出牌阶段实例记账', () => {
  it('一个回合出得了两张【杀】，每个出牌阶段各一张', () => {
    const game = gameAtTurnStart('liaohua-two-slashes')
    playerOf(game, 'p0').attackRangeBonus = 6
    giveCard(game, 'p0', '杀')
    giveCard(game, 'p0', '杀')

    expect(game.state.phase).toBe('play')
    expect(useSlashAt(game, 'p0', 'p1'), '额外出牌阶段里出第一张【杀】').toBe(true)
    expect(useSlashAt(game, 'p0', 'p1'), '同一个阶段里出不了第二张').toBe(false)
    expect(game.state.turnUsage.slashUses, '这个阶段已经用掉一次').toBe(1)

    // 走到这个回合正常的出牌阶段
    for (let guard = 0; guard < 10; guard += 1) {
      game.advancePhase()
      settle(game)
      if (game.state.phase === 'play') break
    }
    expect(game.state.phase, '到了正常的出牌阶段').toBe('play')
    expect(game.state.extraPhase, '这次不是额外阶段').toBeUndefined()
    expect(game.state.turnUsage.slashUses, '新的出牌阶段，已用次数归零').toBe(0)
    expect(slashUsesThisTurn(game.state), '回合级的账记得前一张').toBe(1)
    expect(useSlashAt(game, 'p0', 'p1'), '正常出牌阶段里还能再出一张').toBe(true)
    expect(slashUsesThisTurn(game.state), '这个回合一共出了两张【杀】').toBe(2)
    assertCardConservation(game.state)
    assertGameInvariants(game.state)
  })

  it('「出牌阶段限一次」在两个出牌阶段里各有一次', () => {
    const game = gameAtTurnStart('liaohua-once-per-phase')
    expect(usedThisPhase(game.state, 'p0', 'demo'), '额外阶段一开始没用过').toBe(false)
    markUsedThisPhase(game.state, 'p0', 'demo')
    expect(usedThisPhase(game.state, 'p0', 'demo'), '额外阶段里已经用过了').toBe(true)

    for (let guard = 0; guard < 10; guard += 1) {
      game.advancePhase()
      settle(game)
      if (game.state.phase === 'play' && !game.state.extraPhase) break
    }
    expect(game.state.phase).toBe('play')
    expect(usedThisPhase(game.state, 'p0', 'demo'), '正常出牌阶段是另一个阶段实例，又有一次').toBe(false)
  })

  it('回合级的账两个阶段共享：酒仍然是一回合一次', () => {
    const game = gameAtTurnStart('liaohua-wine-per-turn')
    game.state.turnUsage.wineUses = 1
    for (let guard = 0; guard < 10; guard += 1) {
      game.advancePhase()
      settle(game)
      if (game.state.phase === 'play' && !game.state.extraPhase) break
    }
    expect(game.state.turnUsage.wineUses, '进入第二个出牌阶段不会把酒的次数还回来').toBe(1)
  })
})

describe('廖化【伏枥】', () => {
  it('X 是现存势力数：去重、只数活着的人', () => {
    const game = gameAtTurnStart('liaohua-fuli-count', ['liaohua', 'zhangfei', 'zhaoyun', 'huangzhong', 'guojia'])
    // 廖化、张飞、赵云、黄忠都是蜀，郭嘉是魏 → 两个势力
    expect(livingKingdomCount(game.state), '蜀 + 魏').toBe(2)
    playerOf(game, 'p4').alive = false
    expect(livingKingdomCount(game.state), '魏国的人死了，只剩蜀').toBe(1)
  })

  it('濒死时回复至 X 点并把武将牌翻面', () => {
    const game = gameAtTurnStart('liaohua-fuli-invoke', ['liaohua', 'zhangfei', 'caocao', 'sunquan', 'guojia'])
    const owner = playerOf(game, 'p0')
    // 蜀（廖化、张飞）+ 魏（曹操、郭嘉）+ 吴（孙权）= 3
    expect(livingKingdomCount(game.state)).toBe(3)
    owner.hp = 1
    playerOf(game, 'p1').attackRangeBonus = 6
    giveCard(game, 'p1', '杀')
    game.state.currentPlayerId = 'p1'
    game.state.phase = 'play'
    delete game.state.extraPhase

    const action = game.legalActions('p1').find((candidate) => candidate.kind === 'use-card'
      && candidate.asCardName === '杀' && candidate.targetIds.includes('p0'))!
    game.act('p1', action.id)
    settle(game, (request) => {
      if (request.playerId === 'p0' && request.kind === 'choose-option' && request.prompt?.includes('伏枥')) {
        return { optionId: 'fuli-invoke' }
      }
      return null
    })

    expect(owner.alive, '没有阵亡').toBe(true)
    expect(owner.hp, '体力回复至 3（现存势力数），不超过体力上限 4').toBe(3)
    expect(owner.faceDown, '武将牌翻面').toBe(true)
    expect(owner.usedLimitedSkills, '限定技记账').toContain('fuli')
    expect(game.state.dying, '已经脱离濒死').toBeNull()
    assertCardConservation(game.state)
    assertGameInvariants(game.state)
  })

  it('限定技一局只有一次：第二次濒死不再问', () => {
    const game = gameAtTurnStart('liaohua-fuli-limited', ['liaohua', 'zhangfei', 'caocao', 'sunquan', 'guojia'])
    const owner = playerOf(game, 'p0')
    owner.usedLimitedSkills.push('fuli')
    owner.hp = 1
    playerOf(game, 'p1').attackRangeBonus = 6
    giveCard(game, 'p1', '杀')
    game.state.currentPlayerId = 'p1'
    game.state.phase = 'play'
    delete game.state.extraPhase

    const prompts: string[] = []
    const action = game.legalActions('p1').find((candidate) => candidate.kind === 'use-card'
      && candidate.asCardName === '杀' && candidate.targetIds.includes('p0'))!
    game.act('p1', action.id)
    settle(game, (request) => {
      if (request.prompt) prompts.push(request.prompt)
      return null
    })
    expect(prompts.some((prompt) => prompt.includes('伏枥')), '用过的限定技不再开窗口').toBe(false)
  })

  it('不发动就照常求桃，牌局不卡在濒死上', () => {
    const game = gameAtTurnStart('liaohua-fuli-decline', ['liaohua', 'zhangfei', 'caocao', 'sunquan', 'guojia'])
    const owner = playerOf(game, 'p0')
    owner.hp = 1
    playerOf(game, 'p1').attackRangeBonus = 6
    giveCard(game, 'p1', '杀')
    game.state.currentPlayerId = 'p1'
    game.state.phase = 'play'
    delete game.state.extraPhase

    const action = game.legalActions('p1').find((candidate) => candidate.kind === 'use-card'
      && candidate.asCardName === '杀' && candidate.targetIds.includes('p0'))!
    game.act('p1', action.id)
    // defaultResponse 对 choose-option 取最后一项，也就是「不发动，继续求桃」
    settle(game)
    expect(game.state.dying, '濒死流程已经收束').toBeNull()
    expect(owner.usedLimitedSkills, '没发动就不记账').not.toContain('fuli')
    assertCardConservation(game.state)
    assertGameInvariants(game.state)
  })
})
