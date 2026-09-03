import { describe, expect, it } from 'vitest'
import { SanguoshaGame } from '@/sanguosha/engine/game'
import { assertGameInvariants } from '@/sanguosha/engine/invariants'
import { NULLIFICATION_TIMEOUT_MS, PASS_ROUND_ACTION } from '@/sanguosha/engine/nullification'
import { moveCard } from '@/sanguosha/engine/zones'
import type { RespondCardRequest } from '@/sanguosha/engine/requests'
import type { GameSetup, Identity, PlayerId } from '@/sanguosha/engine/types'

/**
 * 无懈可击的询问节奏。
 *
 * 用户报的三件事：
 * 1. 手上没有无懈的人也被问，每张牌都要空转一整圈，判定阶段卡很久；
 * 2. 手上有两张无懈时，打出一张之后**还会再问自己一次**——第二张打出去
 *    等于两张都没打，纯粹是多点一次；
 * 3. 五谷丰登每个目标问一轮，一路点「放弃」要点五六次。
 */

function gameWith(characterIds: string[], seed = 'nullify'): SanguoshaGame {
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

function pending(game: SanguoshaGame): RespondCardRequest | undefined {
  return game.state.pendingRequests[0] as RespondCardRequest | undefined
}

/** 把所有人的手牌清空（进弃牌堆，保持牌张守恒）。 */
function stripHands(game: SanguoshaGame): void {
  for (const player of game.state.players) {
    game.state.zones.discardPile.push(...player.zones.hand)
    player.zones.hand = []
  }
}

function giveNamed(game: SanguoshaGame, playerId: PlayerId, cardName: string): string {
  const fromDraw = game.state.zones.drawPile.find((id) => game.state.cards[id].name === cardName)
  if (fromDraw) {
    moveCard(game.state, fromDraw, { kind: 'drawPile' }, { kind: 'hand', playerId })
    return fromDraw
  }
  const fromDiscard = game.state.zones.discardPile.find((id) => game.state.cards[id].name === cardName)
  if (!fromDiscard) throw new Error(`找不到可用的【${cardName}】`)
  moveCard(game.state, fromDiscard, { kind: 'discardPile' }, { kind: 'hand', playerId })
  return fromDiscard
}

/** p0 对 p1 使用一张指定的即时锦囊。 */
function useTrick(game: SanguoshaGame, cardName: string, targetIds: PlayerId[]): void {
  const cardId = giveNamed(game, 'p0', cardName)
  const action = game.legalActions('p0').find((candidate) => candidate.kind === 'use-card'
    && candidate.cardIds.includes(cardId)
    && targetIds.every((id) => candidate.targetIds.includes(id)))
  if (!action) throw new Error(`构造不出【${cardName}】的使用动作`)
  game.act('p0', action.id)
}

const FILLER = ['zhangfei', 'zhangfei', 'zhangfei', 'zhangfei', 'zhangfei']

describe('只问手上真有无懈的人', () => {
  it('首轮跳过锦囊使用者自己的无懈，别人无懈后仍可反无懈', () => {
    const game = gameWith(FILLER)
    stripHands(game)
    const own = giveNamed(game, 'p0', '无懈可击')
    const other = giveNamed(game, 'p2', '无懈可击')

    useTrick(game, '无中生有', ['p0'])
    expect(pending(game)?.playerId, '不能先问使用者要不要无懈自己的锦囊').toBe('p2')
    game.respond({ requestId: pending(game)!.id, playerId: 'p2', payload: { actionId: `respond-nullification:${other}` } })

    expect(pending(game)?.playerId, '别人无懈后，使用者应能用反无懈保护原锦囊').toBe('p0')
    expect(pending(game)?.actionIds).toContain(`respond-nullification:${own}`)
    assertGameInvariants(game.state)
  })

  it('只有使用者自己持有无懈时直接结算，不弹多余询问', () => {
    const game = gameWith(FILLER)
    stripHands(game)
    giveNamed(game, 'p0', '无懈可击')

    useTrick(game, '无中生有', ['p0'])

    expect(pending(game)).toBeUndefined()
    expect(game.state.cardResolution).toBeNull()
    assertGameInvariants(game.state)
  })

  it('全场都没有无懈时，锦囊一路结算完，不发任何询问', () => {
    const game = gameWith(FILLER)
    stripHands(game)
    const before = game.state.players[1].zones.hand.length

    useTrick(game, '无中生有', ['p0'])

    expect(pending(game), '没人有无懈就不该问任何人').toBeUndefined()
    expect(game.state.players[1].zones.hand.length).toBe(before)
    assertGameInvariants(game.state)
  })

  it('只问持有者，一个人有就只问这一个', () => {
    const game = gameWith(FILLER)
    stripHands(game)
    giveNamed(game, 'p2', '无懈可击')

    useTrick(game, '无中生有', ['p0'])

    const request = pending(game)
    expect(request?.playerId, '只有 p2 有无懈').toBe('p2')
    expect(request?.timeoutMs, '无懈窗口收到 3 秒').toBe(NULLIFICATION_TIMEOUT_MS)
    assertGameInvariants(game.state)
  })

  it('延时锦囊的判定阶段同样只问持有者', () => {
    const game = gameWith(FILLER)
    stripHands(game)
    const delayed = giveNamed(game, 'p0', '乐不思蜀')
    moveCard(game.state, delayed, { kind: 'hand', playerId: 'p0' }, { kind: 'judgingArea', playerId: 'p0' })
    game.state.phase = 'prepare'

    game.advancePhase()

    expect(pending(game), '没人有无懈，判定阶段不该问任何人').toBeUndefined()
    expect(game.state.skippedPhases.length + game.state.judgedDelayedCards.length,
      '判定应当已经真的走完了').toBeGreaterThan(0)
    assertGameInvariants(game.state)
  })

  it('死人不会被问', () => {
    const game = gameWith(FILLER)
    stripHands(game)
    giveNamed(game, 'p3', '无懈可击')
    game.state.players[3].alive = false
    game.state.players[3].identityRevealed = true

    useTrick(game, '无中生有', ['p0'])

    expect(pending(game), '死人手里的无懈不算数').toBeUndefined()
  })
})

describe('打出无懈之后不再问他自己', () => {
  it('手里两张无懈，打出一张就不会被追问第二张', () => {
    const game = gameWith(FILLER)
    stripHands(game)
    const first = giveNamed(game, 'p2', '无懈可击')
    giveNamed(game, 'p2', '无懈可击')

    useTrick(game, '无中生有', ['p0'])
    const ask = pending(game)!
    expect(ask.playerId).toBe('p2')
    game.respond({ requestId: ask.id, playerId: 'p2', payload: { actionId: `respond-nullification:${first}` } })

    expect(pending(game)?.playerId, '不能再问 p2 自己——第二张打出去等于两张都没打')
      .not.toBe('p2')
    assertGameInvariants(game.state)
  })

  it('别人接着无懈之后，他又可以出手了', () => {
    const game = gameWith(FILLER)
    stripHands(game)
    const mine = giveNamed(game, 'p2', '无懈可击')
    giveNamed(game, 'p2', '无懈可击')
    const theirs = giveNamed(game, 'p3', '无懈可击')

    useTrick(game, '无中生有', ['p0'])
    game.respond({ requestId: pending(game)!.id, playerId: 'p2', payload: { actionId: `respond-nullification:${mine}` } })
    // 轮到 p3，他也打一张
    const second = pending(game)!
    expect(second.playerId).toBe('p3')
    game.respond({ requestId: second.id, playerId: 'p3', payload: { actionId: `respond-nullification:${theirs}` } })

    expect(pending(game)?.playerId, '换人打过之后 p2 又该被问了').toBe('p2')
    assertGameInvariants(game.state)
  })
})

describe('多目标锦囊的「本轮均不使用」', () => {
  it('单目标锦囊不给这个按钮——只问一轮，多一个按钮是噪音', () => {
    const game = gameWith(FILLER)
    stripHands(game)
    giveNamed(game, 'p2', '无懈可击')

    useTrick(game, '无中生有', ['p0'])

    expect(pending(game)?.actionIds).not.toContain(PASS_ROUND_ACTION)
  })

  it('五谷丰登给这个按钮，点了之后剩下的目标都不再问', () => {
    const game = gameWith(FILLER)
    stripHands(game)
    giveNamed(game, 'p2', '无懈可击')

    useTrick(game, '五谷丰登', ['p0'])
    const ask = pending(game)!
    expect(ask.actionIds, '多目标锦囊才有这个按钮').toContain(PASS_ROUND_ACTION)

    game.respond({ requestId: ask.id, playerId: 'p2', payload: { actionId: PASS_ROUND_ACTION } })

    // 后面每个目标都不该再问 p2 无懈；他仍然要参与选牌
    let nullifyAsks = 0
    for (let guard = 0; guard < 40; guard += 1) {
      const request = game.state.pendingRequests[0]
      if (!request) break
      if (request.kind === 'respond-card' && (request as RespondCardRequest).requiredCardName === '无懈可击') {
        nullifyAsks += 1
        game.respond({ requestId: request.id, playerId: request.playerId, payload: { actionId: 'respond-pass' } })
        continue
      }
      const payload: Record<string, unknown> = { actionId: 'respond-pass', optionId: 'no', targetIds: [] }
      if (request.kind === 'choose-cards') payload.cardIds = [...request.cardIds, ...request.hiddenCardSlots].slice(0, request.min)
      game.respond({ requestId: request.id, playerId: request.playerId, payload })
    }

    expect(nullifyAsks, '声明过之后就不该再问他无懈').toBe(0)
    assertGameInvariants(game.state)
  })
})

describe('AI 的无懈判断看的是当前目标', () => {
  it('视图里带上 currentTargetId，多目标锦囊逐个更新', () => {
    const game = gameWith(FILLER)
    stripHands(game)
    giveNamed(game, 'p2', '无懈可击')

    useTrick(game, '五谷丰登', ['p0'])
    const first = game.viewFor('p2').cardResolution?.currentTargetId
    expect(first, '当前目标必须是具体的某个人').toBeTruthy()
    expect(game.viewFor('p2').cardResolution?.targetIds).toContain(first!)

    // 放弃这一轮，推进到下一个目标
    game.respond({ requestId: pending(game)!.id, playerId: 'p2', payload: { actionId: 'respond-pass' } })
    for (let guard = 0; guard < 20; guard += 1) {
      const request = game.state.pendingRequests[0]
      if (!request) break
      const view = game.viewFor('p2')
      const now = view.cardResolution?.currentTargetId
      if (now && now !== first) {
        expect(view.cardResolution?.targetIds).toContain(now)
        return
      }
      const payload: Record<string, unknown> = { actionId: 'respond-pass', optionId: 'no', targetIds: [] }
      if (request.kind === 'choose-cards') payload.cardIds = [...request.cardIds, ...request.hiddenCardSlots].slice(0, request.min)
      game.respond({ requestId: request.id, playerId: request.playerId, payload })
    }
  })

  it('单目标牌的 currentTargetId 就是那个目标', () => {
    const game = gameWith(FILLER)
    stripHands(game)
    giveNamed(game, 'p2', '无懈可击')
    useTrick(game, '无中生有', ['p0'])
    expect(game.viewFor('p2').cardResolution?.currentTargetId).toBe('p0')
  })
})
