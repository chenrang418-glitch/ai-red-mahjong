import { describe, expect, it } from 'vitest'
import { SanguoshaGame } from '@/sanguosha/engine/game'
import { GameRng } from '@/sanguosha/engine/rng'
import { assertCardConservation, moveCard, type ZoneRef } from '@/sanguosha/engine/zones'
import { assertGameInvariants } from '@/sanguosha/engine/invariants'
import { applySeatPermutation, seatOrderWithFixedLord } from '@/sanguosha/engine/seat-permutation'
import { redistributeHands } from '@/sanguosha/engine/hand-redistribution'
import type { GameSetup, Identity, PlayerId, SanguoshaState } from '@/sanguosha/engine/types'

/**
 * 神·鲁肃。
 *
 * 三个技能各踩一处不同的坑：
 *
 * - 【榻谟】动的是**座位表本身**。座位号在这个引擎里同时也是 `players` 的
 *   数组下标（下家、距离、判定顺序、求桃顺序都按它取模索引），只改字段不动数组
 *   会让全部顺序静默错位。
 * - 【定州】搬的是**场上牌**（装备区 + 判定区），装备离场的时机一个都不能少。
 * - 【智盟】是**真的重新分牌**，不是补数量差；随机必须用牌局自己的种子。
 */

const CAST = ['shenlusu', 'zhangfei', 'guanyu', 'zhaoyun', 'machao']

interface AnyRequest { id: string; playerId: PlayerId; kind: string; prompt?: string }

function defaultResponse(request: AnyRequest) {
  const payload: Record<string, unknown> = (() => {
    switch (request.kind) {
      case 'choose-option': {
        const options = (request as unknown as { options: { id: string }[] }).options
        return { optionId: options[options.length - 1].id }
      }
      case 'choose-cards': {
        const pick = request as unknown as { cardIds: string[]; hiddenCardSlots: string[]; min: number }
        return { cardIds: [...pick.cardIds, ...pick.hiddenCardSlots].slice(0, pick.min ?? 0) }
      }
      case 'choose-targets': {
        const pick = request as unknown as { candidateIds: string[]; min: number }
        return { targetIds: pick.candidateIds.slice(0, pick.min ?? 0) }
      }
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
  for (let guard = 0; guard < 300; guard += 1) {
    const request = game.state.pendingRequests[0] as AnyRequest | undefined
    if (!request) return
    const custom = choose(request)
    game.respond(custom
      ? { requestId: request.id, playerId: request.playerId, payload: custom }
      : defaultResponse(request))
  }
  throw new Error('结算没有收敛')
}

function gameAt(seed: string, characterIds: string[] = CAST): SanguoshaGame {
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
  while (game.state.phase !== 'play') game.advancePhase()
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
      if (equipped === cardId) return { kind: 'equipment', playerId: owner.id, slot: slot as keyof typeof owner.zones.equipment }
    }
  }
  throw new Error('找不到卡牌：' + cardId)
}

function giveCard(game: SanguoshaGame, playerId: string, cardName: string): string {
  const own = playerOf(game, playerId)
  const card = Object.values(game.state.cards)
    .find((candidate) => candidate.name === cardName && !own.zones.hand.includes(candidate.id))
  if (!card) throw new Error('牌堆里没有【' + cardName + '】')
  moveCard(game.state, card.id, locate(game.state, card.id), { kind: 'hand', playerId })
  return card.id
}

/**
 * 把手牌裁到指定张数。
 *
 * **不能直接 `hand = hand.slice(0, n)`**：那是把多出来的牌凭空丢掉，
 * 牌张守恒立刻就崩。多的牌要正经弃进弃牌堆。
 */
function trimHand(game: SanguoshaGame, playerId: string, count: number): void {
  const player = playerOf(game, playerId)
  for (const cardId of player.zones.hand.slice(count)) {
    moveCard(game.state, cardId, { kind: 'hand', playerId }, { kind: 'discardPile' })
  }
}

describe('公共机制：座次重排', () => {
  it('座位号和数组下标必须一起动', () => {
    const game = gameAt('lusu-seat')
    applySeatPermutation(game.state, ['p2', 'p0', 'p4', 'p1', 'p3'])
    expect(game.state.players.map((player) => player.id)).toEqual(['p2', 'p0', 'p4', 'p1', 'p3'])
    /*
     * 引擎里有五处是 `players[(某人.seat + offset) % n]` 这样找下家的——
     * 座位号就是数组下标。只改字段不动数组，全部顺序会静默错位。
     */
    game.state.players.forEach((player, index) => expect(player.seat, player.id).toBe(index))
    assertGameInvariants(game.state)
  })

  it('必须是双射：重复、遗漏、陌生人一律拒绝', () => {
    const game = gameAt('lusu-seat-bijection')
    expect(() => applySeatPermutation(game.state, ['p0', 'p0', 'p1', 'p2', 'p3'])).toThrow('重复')
    expect(() => applySeatPermutation(game.state, ['p0', 'p1', 'p2'])).toThrow('每一名角色')
    expect(() => applySeatPermutation(game.state, ['p0', 'p1', 'p2', 'p3', 'px'])).toThrow('不存在')
  })

  it('主公位置锁死，其余角色依次填空位', () => {
    const game = gameAt('lusu-seat-lord')
    // p0 是主公，坐 0 号位
    const order = seatOrderWithFixedLord(game.state, 'p0', ['p4', 'p3', 'p2', 'p1'])
    expect(order, '主公留在原位，其余按给定顺序填').toEqual(['p0', 'p4', 'p3', 'p2', 'p1'])
  })

  it('主公不在 0 号位时同样只锁他自己那一格', () => {
    const game = gameAt('lusu-seat-lord-mid')
    applySeatPermutation(game.state, ['p1', 'p0', 'p2', 'p3', 'p4'])
    // 现在主公 p0 坐 1 号位
    const order = seatOrderWithFixedLord(game.state, 'p0', ['p4', 'p3', 'p2', 'p1'])
    expect(order).toEqual(['p4', 'p0', 'p3', 'p2', 'p1'])
  })

  it('重排之后下家、距离都按新座次算，而标记仍然跟着人走', () => {
    const game = gameAt('lusu-seat-follow')
    playerOf(game, 'p3').marks['test-token'] = 2
    applySeatPermutation(game.state, ['p3', 'p1', 'p0', 'p4', 'p2'])
    expect(playerOf(game, 'p3').marks['test-token'], '标记按角色记，不按座位记').toBe(2)
    expect(playerOf(game, 'p3').seat).toBe(0)
    assertGameInvariants(game.state)
    assertCardConservation(game.state)
  })
})

describe('公共机制：手牌重新分配', () => {
  it('总数为偶数时对半分', () => {
    const game = gameAt('lusu-split-even')
    const owner = playerOf(game, 'p0')
    const target = playerOf(game, 'p1')
    trimHand(game, 'p0', 3)
    trimHand(game, 'p1', 3)
    const before = new Set([...owner.zones.hand, ...target.zones.hand])

    const result = redistributeHands(game.state, new GameRng('split-even'), 'p0', 'p1')
    expect(result.initiatorCards).toHaveLength(3)
    expect(result.targetCards).toHaveLength(3)
    expect(new Set([...result.initiatorCards, ...result.targetCards]), '牌的集合不变，只是重新分配').toEqual(before)
    assertCardConservation(game.state)
  })

  it('总数为奇数时发起者多拿一张', () => {
    const game = gameAt('lusu-split-odd')
    trimHand(game, 'p0', 3)
    trimHand(game, 'p1', 2)
    const result = redistributeHands(game.state, new GameRng('split-odd'), 'p0', 'p1')
    expect([result.initiatorCards.length, result.targetCards.length], '五张分成三比二').toEqual([3, 2])
  })

  it('牌数相同也要真的重新随机，不是只补差额', () => {
    const game = gameAt('lusu-split-reshuffle')
    const owner = playerOf(game, 'p0')
    const target = playerOf(game, 'p1')
    trimHand(game, 'p0', 4)
    trimHand(game, 'p1', 4)
    const ownerBefore = [...owner.zones.hand]

    redistributeHands(game.state, new GameRng('reshuffle'), 'p0', 'p1')
    expect(owner.zones.hand, '张数不变').toHaveLength(4)
    /*
     * 四比四仍然是四比四，但**具体是哪四张必须重新随机**。
     * 做成「只交换数量差」的话，牌数相同就等于什么都没发生。
     */
    expect(owner.zones.hand, '手牌内容应当被重新洗过').not.toEqual(ownerBefore)
  })

  it('同一个种子必须得到完全一致的结果', () => {
    const runOnce = (): string[] => {
      const game = gameAt('lusu-split-deterministic')
      trimHand(game, 'p0', 4)
      trimHand(game, 'p1', 3)
      return redistributeHands(game.state, new GameRng('fixed-seed'), 'p0', 'p1').initiatorCards
    }
    expect(runOnce(), '同种子同结果，否则压测不可复现、联机两端会分叉').toEqual(runOnce())
  })
})

describe('神·鲁肃：定州', () => {
  /** 给目标装上一件装备，返回那张牌。 */
  function equip(game: SanguoshaGame, playerId: string, cardName: string, slot: 'weapon' | 'armor'): string {
    const cardId = giveCard(game, playerId, cardName)
    moveCard(game.state, cardId, { kind: 'hand', playerId }, { kind: 'equipment', playerId, slot })
    return cardId
  }

  it('X 是装备区加判定区，手牌不算', () => {
    const game = gameAt('lusu-dingzhou-x')
    const weapon = equip(game, 'p1', '青龙偃月刀', 'weapon')
    const armor = equip(game, 'p1', '八卦阵', 'armor')
    const indulgence = giveCard(game, 'p1', '乐不思蜀')
    moveCard(game.state, indulgence, { kind: 'hand', playerId: 'p1' }, { kind: 'judgingArea', playerId: 'p1' })

    const action = game.legalActions('p0').find((candidate) => candidate.kind === 'invoke-skill' && candidate.skillId === 'dingzhou')!
    game.act('p0', action.id)
    const request = game.state.pendingRequests[0] as AnyRequest
    game.respond({ requestId: request.id, playerId: 'p0', payload: { targetIds: ['p1'] } })
    const pay = game.state.pendingRequests[0] as unknown as { min: number; max: number }
    expect([pay.min, pay.max], '两件装备加一张判定牌 = 3').toEqual([3, 3])

    settle(game)
    const owner = playerOf(game, 'p0')
    for (const cardId of [weapon, armor, indulgence]) {
      expect(owner.zones.hand, '场上牌全部进神鲁肃手里').toContain(cardId)
    }
    expect(playerOf(game, 'p1').zones.judgingArea).toHaveLength(0)
    expect(playerOf(game, 'p1').zones.equipment.weapon).toBeFalsy()
    assertCardConservation(game.state)
  })

  it('场上没有牌的人不是合法目标', () => {
    const game = gameAt('lusu-dingzhou-empty')
    for (const player of game.state.players) {
      for (const slot of ['weapon', 'armor', 'offensiveHorse', 'defensiveHorse'] as const) {
        const cardId = player.zones.equipment[slot]
        if (cardId) moveCard(game.state, cardId, { kind: 'equipment', playerId: player.id, slot }, { kind: 'discardPile' })
      }
      player.zones.judgingArea = []
    }
    const action = game.legalActions('p0').find((candidate) => candidate.kind === 'invoke-skill' && candidate.skillId === 'dingzhou')
    expect(action, '全场都没有场上牌时不该给入口').toBeUndefined()
  })

  it('手牌不够付 X 张时，那个人就不是合法目标', () => {
    const game = gameAt('lusu-dingzhou-poor')
    equip(game, 'p1', '青龙偃月刀', 'weapon')
    equip(game, 'p1', '八卦阵', 'armor')
    // 神鲁肃只剩一张手牌，付不起两张
    trimHand(game, 'p0', 1)

    const action = game.legalActions('p0').find((candidate) => candidate.kind === 'invoke-skill' && candidate.skillId === 'dingzhou')
    if (action) {
      game.act('p0', action.id)
      const request = game.state.pendingRequests[0] as unknown as { candidateIds: string[] }
      expect(request.candidateIds, '付不起就不该让人点进去才发现').not.toContain('p1')
      settle(game)
    }
  })

  it('出牌阶段限一次', () => {
    const game = gameAt('lusu-dingzhou-once')
    equip(game, 'p1', '青龙偃月刀', 'weapon')
    const action = game.legalActions('p0').find((candidate) => candidate.kind === 'invoke-skill' && candidate.skillId === 'dingzhou')!
    game.act('p0', action.id)
    settle(game, (request) => (request.kind === 'choose-targets' && request.playerId === 'p0' ? { targetIds: ['p1'] } : null))
    const again = game.legalActions('p0').find((candidate) => candidate.kind === 'invoke-skill' && candidate.skillId === 'dingzhou')
    expect(again).toBeUndefined()
  })
})

describe('神·鲁肃：智盟', () => {
  it('回合结束后混合双方手牌并重新分配，战报不说是哪几张', () => {
    const game = gameAt('lusu-zhimeng')
    const owner = playerOf(game, 'p0')
    const target = playerOf(game, 'p1')
    trimHand(game, 'p0', 2)
    trimHand(game, 'p1', 3)
    const pool = new Set([...owner.zones.hand, ...target.zones.hand])

    const logs: string[] = []
    game.events.on('SkillActivated', (handled) => {
      const payload = handled.event.payload as { skillId?: string; logText?: string }
      if (payload.skillId === 'zhimeng' && payload.logText) logs.push(payload.logText)
    })

    game.dispatch('TurnEnd', { playerId: 'p0' }, { sourceId: 'p0' })
    ;(game as unknown as { settle(): void }).settle()
    settle(game, (request) => (request.kind === 'choose-targets' && request.playerId === 'p0' ? { targetIds: ['p1'] } : null))

    expect([owner.zones.hand.length, target.zones.hand.length], '五张分成三比二').toEqual([3, 2])
    expect(new Set([...owner.zones.hand, ...target.zones.hand]), '牌的集合不变').toEqual(pool)
    for (const line of logs) {
      for (const cardId of pool) {
        expect(line, '战报只说张数，不能说是哪几张').not.toContain(cardId)
      }
    }
    assertCardConservation(game.state)
  })

  it('重新分配之后，第三方仍然看不到任何一方的手牌', () => {
    const game = gameAt('lusu-zhimeng-privacy')
    game.dispatch('TurnEnd', { playerId: 'p0' }, { sourceId: 'p0' })
    ;(game as unknown as { settle(): void }).settle()
    settle(game, (request) => (request.kind === 'choose-targets' && request.playerId === 'p0' ? { targetIds: ['p1'] } : null))

    const outsider = game.viewFor('p2')
    expect(outsider.players.find((player) => player.id === 'p0')!.hand).toBeNull()
    expect(outsider.players.find((player) => player.id === 'p1')!.hand).toBeNull()
    const serialized = JSON.stringify(outsider)
    for (const cardId of playerOf(game, 'p0').zones.hand) {
      expect(serialized, '重新分配后的手牌同样是暗信息').not.toContain(`"${cardId}"`)
    }
  })
})
