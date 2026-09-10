import { describe, expect, it } from 'vitest'
import { SanguoshaGame } from '@/sanguosha/engine/game'
import { assertCardConservation } from '@/sanguosha/engine/zones'
import { assertGameInvariants } from '@/sanguosha/engine/invariants'
import { livingKingdomCount, livingKingdoms } from '@/sanguosha/engine/living-kingdoms'
import { livingKingdomCount as fuliCounter } from '@/sanguosha/data/characters/yjcm2012-liaohua'
import { maxCardsOf } from '@/sanguosha/engine/phase'
import type { GameSetup, Identity, PlayerId, TurnPhase } from '@/sanguosha/engine/types'

/**
 * 刘表（一将成名 2012）。
 *
 * 逐条有断言的主张：
 *
 * - 现存势力数**去重**、**只数活人**、**神势力单独算一种**、**实时变化**；
 * - 【自守】和【宗室】以及廖化【伏枥】读的是**同一个**计数器；
 * - 自守是「正常摸牌数 **+X**」，不是「改为 X」；
 * - 发动后只跳过**出牌阶段**，判定、弃牌、结束阶段照跑；
 * - 不发动时照常摸正常张数（接管之后必须把牌补回来）；
 * - 摸牌阶段被跳过时自守根本不触发；
 * - 【宗室】手牌上限 +X，而且随势力数**实时**变化。
 */

const CAST = ['zhangfei', 'liubiao', 'zhaoyun', 'huangzhong', 'guojia']
const LIUBIAO_ID = 'p1'

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

/** 开局并跑完 p0 的回合；停在刘表回合开始之前。 */
function gameBeforeLiubiaoTurn(seed: string, characterIds: string[] = CAST): SanguoshaGame {
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

/**
 * 一路走到刘表的回合并按 `invoke` 回答自守；记下他跑过哪些阶段、摸了几张。
 */
function runLiubiaoTurn(game: SanguoshaGame, invoke: boolean): { phases: TurnPhase[]; drawn: number; asked: boolean; skippedDuringTurn: string[] } {
  const result = { phases: [] as TurnPhase[], drawn: 0, asked: false, skippedDuringTurn: [] as string[] }
  let handBeforeDraw = -1
  const answer = (request: AnyRequest): Record<string, unknown> | null => {
    if (request.playerId === LIUBIAO_ID && request.kind === 'choose-option' && request.prompt?.includes('自守')) {
      result.asked = true
      handBeforeDraw = playerOf(game, LIUBIAO_ID).zones.hand.length
      return { optionId: invoke ? 'zishou-invoke' : 'cancel' }
    }
    return null
  }
  for (let guard = 0; guard < 30; guard += 1) {
    game.advancePhase()
    settle(game, answer)
    if (game.state.currentPlayerId === LIUBIAO_ID) {
      result.phases.push(game.state.phase)
      // 跳过标记在**下一个回合开始时**就被清掉了，所以要在回合内抓
      for (const phase of game.state.skippedPhases) {
        if (!result.skippedDuringTurn.includes(phase)) result.skippedDuringTurn.push(phase)
      }
      if (game.state.phase === 'draw' && handBeforeDraw >= 0) {
        result.drawn = playerOf(game, LIUBIAO_ID).zones.hand.length - handBeforeDraw
      }
    }
    // 刘表的回合已经走完
    if (result.phases.length > 0 && game.state.currentPlayerId !== LIUBIAO_ID) break
  }
  return result
}

describe('现存势力数：公共计数器', () => {
  it('去重、只数活人、神势力单独算一种', () => {
    const game = gameBeforeLiubiaoTurn('kingdoms-count',
      ['zhangfei', 'liubiao', 'zhaoyun', 'caocao', 'shenzhaoyun'])
    // 蜀（张飞、赵云）+ 群（刘表）+ 魏（曹操）+ 神（神赵云）= 4
    expect(livingKingdoms(game.state), '四种势力，蜀去重成一个').toEqual(new Set(['shu', 'qun', 'wei', 'shen']))
    expect(livingKingdomCount(game.state)).toBe(4)

    playerOf(game, 'p4').alive = false
    expect(livingKingdomCount(game.state), '神赵云死了，神势力消失').toBe(3)
    playerOf(game, 'p0').alive = false
    expect(livingKingdomCount(game.state), '张飞死了但赵云还在，蜀仍然算一个').toBe(3)
    playerOf(game, 'p2').alive = false
    expect(livingKingdomCount(game.state), '赵云也死了，蜀才消失').toBe(2)
  })

  it('自守 / 宗室 和廖化【伏枥】读的是同一个计数器', () => {
    const game = gameBeforeLiubiaoTurn('kingdoms-shared',
      ['liaohua', 'liubiao', 'caocao', 'sunquan', 'guojia'])
    expect(fuliCounter(game.state), '伏枥导出的就是公共计数器').toBe(livingKingdomCount(game.state))
    playerOf(game, 'p3').alive = false
    expect(fuliCounter(game.state), '变化之后仍然一致').toBe(livingKingdomCount(game.state))
  })
})

describe('刘表【自守】', () => {
  it('额外摸 X 张：是正常张数 + X，不是改为 X', () => {
    const game = gameBeforeLiubiaoTurn('zishou-extra')
    const expected = livingKingdomCount(game.state)
    const result = runLiubiaoTurn(game, true)
    expect(result.asked, '摸牌阶段问了自守').toBe(true)
    expect(result.drawn, `正常 2 张 + X(${expected}) 张`).toBe(2 + expected)
    assertCardConservation(game.state)
    assertGameInvariants(game.state)
  })

  it('发动后只跳过出牌阶段，其余阶段照跑', () => {
    const game = gameBeforeLiubiaoTurn('zishou-skip')
    const result = runLiubiaoTurn(game, true)
    expect(result.phases, '出牌阶段被跳过，其余四个照跑').toEqual(['prepare', 'judge', 'draw', 'discard', 'finish'])
    expect(result.skippedDuringTurn, '跳的是公共的阶段位（回合内抓，之后会被清掉）').toContain('play')
  })

  it('不发动：照常摸正常张数，出牌阶段照跑', () => {
    const game = gameBeforeLiubiaoTurn('zishou-decline')
    const result = runLiubiaoTurn(game, false)
    expect(result.asked).toBe(true)
    expect(result.drawn, '接管之后必须把正常的两张补回来').toBe(2)
    expect(result.phases, '六个阶段一个不少').toEqual(['prepare', 'judge', 'draw', 'play', 'discard', 'finish'])
    assertCardConservation(game.state)
  })

  it('摸牌阶段被跳过时自守根本不触发', () => {
    const game = gameBeforeLiubiaoTurn('zishou-draw-skipped')
    let asked = false
    for (let guard = 0; guard < 30; guard += 1) {
      // 轮到刘表时先把摸牌阶段标记为跳过
      if (game.state.currentPlayerId === LIUBIAO_ID && game.state.phase === 'prepare') {
        game.state.skippedPhases.push('draw')
      }
      game.advancePhase()
      settle(game, (request) => {
        if (request.prompt?.includes('自守')) asked = true
        return null
      })
      if (asked) break
      if (game.state.currentPlayerId !== LIUBIAO_ID && game.state.skippedPhases.includes('draw')) break
    }
    expect(asked, '摸牌阶段不跑，自守就没有触发点').toBe(false)
  })
})

describe('刘表【宗室】', () => {
  it('手牌上限 = 体力 + X', () => {
    const game = gameBeforeLiubiaoTurn('zongshi-bonus',
      ['zhangfei', 'liubiao', 'caocao', 'sunquan', 'shenzhaoyun'])
    const owner = playerOf(game, LIUBIAO_ID)
    owner.hp = 2
    // 蜀 + 群 + 魏 + 吴 + 神 = 5
    expect(livingKingdomCount(game.state)).toBe(5)
    expect(maxCardsOf(game.state, LIUBIAO_ID), '2 体力 + 5 势力').toBe(7)
  })

  it('势力数变化时上限实时跟着变', () => {
    const game = gameBeforeLiubiaoTurn('zongshi-dynamic',
      ['zhangfei', 'liubiao', 'caocao', 'sunquan', 'shenzhaoyun'])
    const owner = playerOf(game, LIUBIAO_ID)
    owner.hp = 2
    expect(maxCardsOf(game.state, LIUBIAO_ID)).toBe(7)

    playerOf(game, 'p4').alive = false
    expect(maxCardsOf(game.state, LIUBIAO_ID), '神势力没了，上限当场 -1').toBe(6)
    playerOf(game, 'p3').alive = false
    expect(maxCardsOf(game.state, LIUBIAO_ID), '吴也没了，再 -1').toBe(5)
    // 不是开局缓存：体力变化也照常叠加
    owner.hp = 1
    expect(maxCardsOf(game.state, LIUBIAO_ID), '基数是当前体力').toBe(4)
  })

  it('是**加成**不是「固定为 N」：基数仍然是体力', () => {
    const game = gameBeforeLiubiaoTurn('zongshi-stack')
    const owner = playerOf(game, LIUBIAO_ID)
    owner.hp = 2
    const withZongshi = maxCardsOf(game.state, LIUBIAO_ID)
    const expected = livingKingdomCount(game.state)

    // 对照：同一个座位换成没有宗室的武将，上限正好少 X
    owner.characterId = 'zhangfei'
    const withoutZongshi = maxCardsOf(game.state, LIUBIAO_ID)
    expect(withZongshi - withoutZongshi, '宗室给的正是 X').toBe(expected)
    expect(withoutZongshi, '没有宗室时上限就是体力').toBe(2)
  })
})
