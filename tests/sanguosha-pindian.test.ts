import { afterEach, describe, expect, it } from 'vitest'
import { SanguoshaGame } from '@/sanguosha/engine/game'
import { assertGameInvariants } from '@/sanguosha/engine/invariants'
import { assertCardConservation, moveCard } from '@/sanguosha/engine/zones'
import {
  abortPindian, canPindian, claimPindianCards, finishPindianSettlement, pindianRank,
  registerPindianContinuation, startPindian, type PindianResult,
} from '@/sanguosha/engine/pindian'
import type { GameSetup, Identity, PlayerId } from '@/sanguosha/engine/types'

/**
 * 公共拼点。
 *
 * 拼点是个**公共引擎能力**，不是某个武将的私有 helper，所以它的测试也单独放这里，
 * 不藏在荀彧或太史慈的用例里。
 *
 * 三条最容易做错的地方单独钉住：
 * 1. **暗选**：一方交牌之后，另一方的视图里连 cardId 都不能出现；
 * 2. **A 就是 1**：原创武将【牛来】把 A 当 14 是它自己的规则，拼点不能复用；
 * 3. **平局是独立结果**，不能被迫塞进「谁赢」里。
 */

const TAG = 'test-pindian'
const DEFER_TAG = 'test-pindian-defer'
let lastResult: PindianResult | null = null
registerPindianContinuation(TAG, (_host, result) => { lastResult = result })
registerPindianContinuation(DEFER_TAG, (_host, result) => {
  lastResult = result
  return 'defer-settlement'
})

afterEach(() => { lastResult = null })

function gameWith(seed = 'pindian'): SanguoshaGame {
  const setup: GameSetup = {
    mode: 'identity', generalChoices: 1,
    players: Array.from({ length: 5 }, (_, index) => ({ id: `p${index}`, nickname: `玩家${index}`, isHuman: false })),
  }
  const game = new SanguoshaGame({ seed, setup })
  const identities: Identity[] = ['lord', 'rebel', 'loyalist', 'rebel', 'renegade']
  game.state.players.forEach((player, index) => {
    player.identity = identities[index]
    player.characterId = 'zhangfei'
  })
  game.start()
  while (game.state.pendingRequests.length > 0) {
    const request = game.state.pendingRequests[0]
    game.respond({ requestId: request.id, playerId: request.playerId, payload: { optionId: 'no' } })
  }
  return game
}

function clearHand(game: SanguoshaGame, playerId: PlayerId): void {
  const owner = game.state.players.find((player) => player.id === playerId)!
  game.state.zones.discardPile.push(...owner.zones.hand)
  owner.zones.hand = []
}

/** 给某人一张指定点数的牌，返回 cardId。 */
function giveRank(game: SanguoshaGame, playerId: PlayerId, rank: number): string {
  const cardId = game.state.zones.drawPile.find((id) => game.state.cards[id].rank === rank)
  if (!cardId) throw new Error(`牌堆里没有点数 ${rank} 的牌`)
  moveCard(game.state, cardId, { kind: 'drawPile' }, { kind: 'hand', playerId })
  return cardId
}

/** 摆好双方的牌并发起一次拼点。 */
function begin(game: SanguoshaGame, initiatorRank: number, opponentRank: number) {
  clearHand(game, 'p0')
  clearHand(game, 'p1')
  const initiatorCard = giveRank(game, 'p0', initiatorRank)
  const opponentCard = giveRank(game, 'p1', opponentRank)
  startPindian(game, {
    id: `pd-${game.state.seq}`, initiatorId: 'p0', opponentId: 'p1', reason: 'test', continuationTag: TAG,
  })
  return { initiatorCard, opponentCard }
}

function submit(game: SanguoshaGame, playerId: PlayerId, cardId: string): void {
  const request = game.state.pendingRequests.find((candidate) => candidate.playerId === playerId)!
  game.respond({ requestId: request.id, playerId, payload: { cardIds: [cardId] } })
}

describe('点数比较', () => {
  it('K 大于 7：发起者赢（矩阵 1）', () => {
    const game = gameWith()
    const { initiatorCard, opponentCard } = begin(game, 13, 7)
    submit(game, 'p0', initiatorCard)
    submit(game, 'p1', opponentCard)
    expect(lastResult?.outcome).toBe('initiator-win')
    expect(lastResult?.initiatorRank).toBe(13)
    expect(lastResult?.opponentRank).toBe(7)
  })

  it('3 小于 Q：对手赢（矩阵 2）', () => {
    const game = gameWith()
    const { initiatorCard, opponentCard } = begin(game, 3, 12)
    submit(game, 'p0', initiatorCard)
    submit(game, 'p1', opponentCard)
    expect(lastResult?.outcome).toBe('opponent-win')
  })

  it('同点数是平局，不是谁赢（矩阵 3）', () => {
    const game = gameWith()
    const { initiatorCard, opponentCard } = begin(game, 8, 8)
    submit(game, 'p0', initiatorCard)
    submit(game, 'p1', opponentCard)
    expect(lastResult?.outcome).toBe('tie')
  })

  it('A 就是 1，不是 14（矩阵 4）', () => {
    expect(pindianRank({ rank: 1 })).toBe(1)
    const game = gameWith()
    const { initiatorCard, opponentCard } = begin(game, 1, 2)
    submit(game, 'p0', initiatorCard)
    submit(game, 'p1', opponentCard)
    expect(lastResult?.outcome, 'A 拼 2 要输').toBe('opponent-win')
  })

  it('K 是 13（矩阵 5）', () => {
    expect(pindianRank({ rank: 13 })).toBe(13)
  })
})

describe('暗选与揭示', () => {
  it('发起者先交牌时，对手看不到那张牌（矩阵 8 / 安全）', () => {
    const game = gameWith()
    const { initiatorCard } = begin(game, 13, 7)
    submit(game, 'p0', initiatorCard)

    const card = game.state.cards[initiatorCard]
    const opponentView = JSON.stringify(game.viewFor('p1'))
    expect(opponentView, '不能出现 cardId').not.toContain(initiatorCard)
    // 点数、花色、牌名都不能借由这张牌泄露给对手
    expect(game.state.privateZones.some((zone) => zone.cards.includes(initiatorCard) && zone.ownerId === 'p0'))
      .toBe(true)
    for (const viewerId of ['p1', 'p2', 'p3']) {
      expect(JSON.stringify(game.viewFor(viewerId)), `${viewerId} 不该看到`).not.toContain(initiatorCard)
    }
    // 自己看得到——刷新之后要知道自己交了什么
    expect(JSON.stringify(game.viewFor('p0'))).toContain(initiatorCard)
    expect(card.rank).toBe(13)
    assertGameInvariants(game.state)
  })

  it('对手先交牌时，发起者同样看不到（矩阵 9）', () => {
    const game = gameWith()
    const { opponentCard } = begin(game, 13, 7)
    submit(game, 'p1', opponentCard)

    expect(JSON.stringify(game.viewFor('p0')), '发起者不能偷看').not.toContain(opponentCard)
    expect(JSON.stringify(game.viewFor('p1')), '自己看得到').toContain(opponentCard)
    assertGameInvariants(game.state)
  })

  it('第三方只知道有人在拼点，看不到任何一张牌', () => {
    const game = gameWith()
    const { initiatorCard, opponentCard } = begin(game, 13, 7)
    submit(game, 'p0', initiatorCard)
    submit(game, 'p1', opponentCard)
    // 揭示之后两张牌才公开，这里是揭示前的检查放在上面两条；
    // 这条确认揭示后确实进了公共区域
    expect(game.state.zones.discardPile).toEqual(expect.arrayContaining([initiatorCard, opponentCard]))
  })

  it('揭示之后两张牌都进弃牌堆，不留在手里也不复制（矩阵 6 / 7）', () => {
    const game = gameWith()
    const { initiatorCard, opponentCard } = begin(game, 13, 7)
    submit(game, 'p0', initiatorCard)
    submit(game, 'p1', opponentCard)

    expect(game.state.players[0].zones.hand, '牌真的花掉了').not.toContain(initiatorCard)
    expect(game.state.players[1].zones.hand).not.toContain(opponentCard)
    expect(game.state.zones.discardPile).toContain(initiatorCard)
    expect(game.state.zones.discardPile).toContain(opponentCard)
    expect(game.state.privateZones, '私有区已经清干净').toEqual([])
    expect(game.state.zones.processingArea, '不能一张留处理区').toEqual([])
    assertCardConservation(game.state)
    assertGameInvariants(game.state)
  })
})

describe('合法性', () => {
  it('任一方没有手牌就不能拼点（矩阵 17 相关）', () => {
    const game = gameWith()
    clearHand(game, 'p1')
    expect(canPindian(game.state, 'p1')).toBe(false)
    expect(() => startPindian(game, {
      id: 'pd-x', initiatorId: 'p0', opponentId: 'p1', reason: 'test', continuationTag: TAG,
    })).toThrow(/手牌/)
  })

  it('不能交非手牌的 cardId（矩阵 16）', () => {
    const game = gameWith()
    begin(game, 13, 7)
    const someoneElsesCard = game.state.players[2].zones.hand[0]
    const request = game.state.pendingRequests.find((candidate) => candidate.playerId === 'p0')!
    expect(() => game.respond({ requestId: request.id, playerId: 'p0', payload: { cardIds: [someoneElsesCard] } }))
      .toThrow()
  })

  it('装备区的牌不能用来拼点', () => {
    const game = gameWith()
    clearHand(game, 'p0')
    clearHand(game, 'p1')
    const weapon = game.state.zones.drawPile.find((id) => game.state.cards[id].equipmentSlot === 'weapon')!
    moveCard(game.state, weapon, { kind: 'drawPile' }, { kind: 'equipment', playerId: 'p0', slot: 'weapon' })
    giveRank(game, 'p0', 5)
    giveRank(game, 'p1', 5)
    startPindian(game, { id: 'pd-eq', initiatorId: 'p0', opponentId: 'p1', reason: 'test', continuationTag: TAG })

    const request = game.state.pendingRequests.find((candidate) => candidate.playerId === 'p0')!
    expect(request.kind === 'choose-cards' && request.cardIds, '候选里只有手牌').not.toContain(weapon)
    expect(() => game.respond({ requestId: request.id, playerId: 'p0', payload: { cardIds: [weapon] } })).toThrow()
  })

  it('交过之后不能再交一次（矩阵 15）', () => {
    const game = gameWith()
    const { initiatorCard } = begin(game, 13, 7)
    const requestId = game.state.pendingRequests.find((candidate) => candidate.playerId === 'p0')!.id
    submit(game, 'p0', initiatorCard)
    expect(() => game.respond({ requestId, playerId: 'p0', payload: { cardIds: [initiatorCard] } }))
      .toThrow(/已经处理|不存在/)
  })

  it('非参与者提交会被拒（矩阵 14）', () => {
    const game = gameWith()
    begin(game, 13, 7)
    const request = game.state.pendingRequests.find((candidate) => candidate.playerId === 'p0')!
    const outsiderCard = game.state.players[2].zones.hand[0]
    expect(() => game.respond({ requestId: request.id, playerId: 'p2', payload: { cardIds: [outsiderCard] } }))
      .toThrow()
  })

  it('同一时刻只能有一次拼点', () => {
    const game = gameWith()
    begin(game, 13, 7)
    expect(() => startPindian(game, {
      id: 'pd-2', initiatorId: 'p0', opponentId: 'p2', reason: 'test', continuationTag: TAG,
    })).toThrow(/还没结束/)
  })

  it('未注册的续接不能发起拼点', () => {
    const game = gameWith()
    clearHand(game, 'p0')
    clearHand(game, 'p1')
    giveRank(game, 'p0', 5)
    giveRank(game, 'p1', 5)
    expect(() => startPindian(game, {
      id: 'pd-3', initiatorId: 'p0', opponentId: 'p1', reason: 'test', continuationTag: 'nope',
    })).toThrow(/未注册/)
  })
})

describe('可序列化与中止', () => {
  it('一方已交、另一方没交时刷新，拼点能接着走（矩阵 10）', () => {
    const game = gameWith()
    const { initiatorCard, opponentCard } = begin(game, 13, 7)
    submit(game, 'p0', initiatorCard)

    const restored = SanguoshaGame.restore(JSON.parse(JSON.stringify(game.serialize())))
    expect(restored.state.pindian?.initiatorCardId, '自己交过的记录还在').toBe(initiatorCard)
    expect(restored.state.pendingRequests, '只剩对手那一个请求').toHaveLength(1)
    expect(restored.state.pendingRequests[0].playerId).toBe('p1')
    // 刷新之后发起者不能重新选
    expect(restored.state.pendingRequests.some((request) => request.playerId === 'p0')).toBe(false)
    expect(JSON.stringify(restored.viewFor('p1')), '刷新也不会泄露').not.toContain(initiatorCard)

    submit(restored, 'p1', opponentCard)
    expect(restored.state.pindian, '拼点走完了').toBeNull()
    expect(restored.state.zones.discardPile).toEqual(expect.arrayContaining([initiatorCard, opponentCard]))
    assertCardConservation(restored.state)
    assertGameInvariants(restored.state)
  })

  it('中止时已交的牌进弃牌堆，不会卡在私有区', () => {
    const game = gameWith()
    const { initiatorCard } = begin(game, 13, 7)
    submit(game, 'p0', initiatorCard)
    abortPindian(game)

    expect(game.state.pindian).toBeNull()
    expect(game.state.privateZones).toEqual([])
    expect(game.state.zones.discardPile).toContain(initiatorCard)
    expect(game.state.pendingRequests, '对手那条请求也撤掉').toEqual([])
    assertCardConservation(game.state)
    assertGameInvariants(game.state)
  })
})

describe('拼点牌去向', () => {
  function beginDeferred(game: SanguoshaGame, initiatorRank = 13, opponentRank = 7) {
    clearHand(game, 'p0')
    clearHand(game, 'p1')
    const initiatorCard = giveRank(game, 'p0', initiatorRank)
    const opponentCard = giveRank(game, 'p1', opponentRank)
    startPindian(game, {
      id: `defer-${game.state.seq}`, initiatorId: 'p0', opponentId: 'p1', reason: 'test', continuationTag: DEFER_TAG,
    })
    submit(game, 'p0', initiatorCard)
    submit(game, 'p1', opponentCard)
    return { initiatorCard, opponentCard }
  }

  it('续接明确延后时两张实体牌留在处理区，认领者可直接获得', () => {
    const game = gameWith('pindian-claim')
    const { initiatorCard, opponentCard } = beginDeferred(game)
    expect(game.state.pindian).toBeNull()
    expect(game.state.pindianSettlement?.cardIds).toEqual([initiatorCard, opponentCard])
    expect(game.state.zones.processingArea).toEqual(expect.arrayContaining([initiatorCard, opponentCard]))
    expect(game.state.zones.discardPile).not.toEqual(expect.arrayContaining([initiatorCard, opponentCard]))

    expect(claimPindianCards(game, 'p2', [initiatorCard, opponentCard])).toEqual([initiatorCard, opponentCard])
    expect(game.state.players[2].zones.hand).toEqual(expect.arrayContaining([initiatorCard, opponentCard]))
    expect(game.state.pindianSettlement).toBeNull()
    assertGameInvariants(game.state)
  })

  it('延后状态可序列化恢复，放弃认领后才进入弃牌堆', () => {
    const game = gameWith('pindian-defer-restore')
    const { initiatorCard, opponentCard } = beginDeferred(game)
    const restored = SanguoshaGame.restore(JSON.parse(JSON.stringify(game.serialize())))
    expect(restored.state.pindianSettlement?.cardIds).toEqual([initiatorCard, opponentCard])
    finishPindianSettlement(restored)
    expect(restored.state.zones.discardPile).toEqual(expect.arrayContaining([initiatorCard, opponentCard]))
    expect(restored.state.zones.processingArea).not.toEqual(expect.arrayContaining([initiatorCard, opponentCard]))
    assertGameInvariants(restored.state)
  })
})

describe('AI 选牌', () => {
  it('想赢就出手上点数最大的那张（矩阵 11）', async () => {
    const { choosePindianCard } = await import('@/sanguosha/ai/index')
    const { emptySuspicion } = await import('@/sanguosha/ai/belief')
    const { GameRng } = await import('@/sanguosha/engine/rng')

    const game = gameWith()
    clearHand(game, 'p0')
    const small = giveRank(game, 'p0', 3)
    const big = giveRank(game, 'p0', 12)
    const view = game.viewFor('p0')
    const context = { view, difficulty: 'normal' as const, rng: new GameRng('ai'), suspicion: emptySuspicion(view) }

    expect(choosePindianCard(context, [small, big], 'win')).toBe(big)
    expect(choosePindianCard(context, [small, big], 'lose')).toBe(small)
  })

  it('AI 全自动也能把拼点走完（矩阵 11 / 12）', async () => {
    const { decideResponse } = await import('@/sanguosha/ai/index')
    const { emptySuspicion } = await import('@/sanguosha/ai/belief')
    const { GameRng } = await import('@/sanguosha/engine/rng')

    const game = gameWith()
    begin(game, 13, 7)
    const rng = new GameRng('ai')
    let guard = 0
    while (game.state.pendingRequests.length > 0) {
      if (guard++ > 6) throw new Error('拼点没有收敛')
      const request = game.state.pendingRequests[0]
      const view = game.viewFor(request.playerId)
      game.respond(decideResponse({ view, difficulty: 'normal', rng, suspicion: emptySuspicion(view) }, request))
    }
    expect(lastResult?.outcome).toBe('initiator-win')
    assertCardConservation(game.state)
    assertGameInvariants(game.state)
  })
})
