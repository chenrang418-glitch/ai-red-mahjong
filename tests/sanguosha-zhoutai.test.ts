import { describe, expect, it } from 'vitest'
import { SanguoshaGame } from '@/sanguosha/engine/game'
import { assertGameInvariants } from '@/sanguosha/engine/invariants'
import { resolveDamage } from '@/sanguosha/engine/damage'
import { loseHp } from '@/sanguosha/engine/hp'
import { BUQU } from '@/sanguosha/data/characters/wind-zhoutai'
import type { GameSetup, Identity, PlayerId } from '@/sanguosha/engine/types'

/**
 * 周泰【不屈】与武将专属牌堆。
 *
 * 要钉住的重点：
 * 1. 「创」是**真实的牌**，从牌堆真移动过去——牌张守恒把专属牌堆算在内；
 * 2. 不屈撑住时周泰**不进求桃**，体力保持 0 或更低仍然存活；
 * 3. 点数重复时不屈失效，照常走濒死；
 * 4. 引擎里不存在 `characterId === 'zhoutai'` 这种特判——所以这里也测
 *    「没有不屈的人在同样局面下会正常濒死」。
 */

function gameWith(characterIds: string[], seed = 'zhoutai'): SanguoshaGame {
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
  game.state.currentPlayerId = 'p1'
  game.state.phase = 'play'
  return game
}

function pile(game: SanguoshaGame, playerId: PlayerId) {
  return game.state.players.find((player) => player.id === playerId)!.characterPiles[BUQU] ?? []
}

/** 把牌堆顶换成一张指定点数的牌，返回牌 id。 */
function stackRank(game: SanguoshaGame, rank: number): string {
  const cardId = game.state.zones.drawPile.find((id) => game.state.cards[id].rank === rank)
  if (!cardId) throw new Error(`牌堆里没有点数 ${rank} 的牌`)
  game.state.zones.drawPile = [cardId, ...game.state.zones.drawPile.filter((id) => id !== cardId)]
  return cardId
}

/** 把所有人的手牌清进弃牌堆，免得有人出桃把用例搅乱。 */
function stripHands(game: SanguoshaGame): void {
  for (const player of game.state.players) {
    game.state.zones.discardPile.push(...player.zones.hand)
    player.zones.hand = []
  }
}

function hit(game: SanguoshaGame, targetId: PlayerId, amount: number): void {
  resolveDamage(game, { sourceId: 'p1', targetId, amount, cardName: '杀' })
}

const FILLER = ['zhoutai', 'zhangfei', 'zhangfei', 'zhangfei', 'zhangfei']

describe('不屈撑住时', () => {
  it('把牌堆顶的牌置于武将牌上，且不进求桃', () => {
    const game = gameWith(FILLER)
    stripHands(game)
    const owner = game.state.players[0]
    owner.hp = 1
    const wound = stackRank(game, 5)

    hit(game, 'p0', 1)

    expect(pile(game, 'p0'), '「创」应当就是牌堆顶那张真牌').toEqual([wound])
    expect(owner.alive, '不屈撑住，不死').toBe(true)
    expect(owner.hp, '体力保持 0，不回复').toBe(0)
    expect(game.state.dying, '撑住就不该停在濒死').toBeNull()
    expect(game.state.pendingRequests, '也不该向任何人求桃').toHaveLength(0)
    assertGameInvariants(game.state)
  })

  it('多次濒死会不断累积「创」', () => {
    const game = gameWith(FILLER)
    stripHands(game)
    game.state.players[0].hp = 1

    stackRank(game, 5)
    hit(game, 'p0', 1)
    stackRank(game, 6)
    hit(game, 'p0', 1)
    stackRank(game, 7)
    hit(game, 'p0', 1)

    expect(pile(game, 'p0')).toHaveLength(3)
    expect(game.state.players[0].hp, '每次都掉一点').toBe(-2)
    expect(game.state.players[0].alive).toBe(true)
    assertGameInvariants(game.state)
  })

  it('一次多点伤害只翻一张「创」', () => {
    const game = gameWith(FILLER)
    stripHands(game)
    game.state.players[0].hp = 1
    stackRank(game, 5)

    hit(game, 'p0', 3)

    expect(pile(game, 'p0'), '濒死是一次，「创」也只有一张').toHaveLength(1)
    expect(game.state.players[0].hp).toBe(-2)
    expect(game.state.players[0].alive).toBe(true)
    assertGameInvariants(game.state)
  })

  it('失去体力（苦肉这类）走同一条路', () => {
    const game = gameWith(FILLER)
    stripHands(game)
    game.state.players[0].hp = 1
    stackRank(game, 5)

    loseHp(game, 'p0', 1, '测试')

    expect(pile(game, 'p0')).toHaveLength(1)
    expect(game.state.players[0].alive).toBe(true)
    assertGameInvariants(game.state)
  })
})

describe('不屈没撑住时', () => {
  it('点数与已有「创」重复，照常进入求桃', () => {
    const game = gameWith(FILLER)
    stripHands(game)
    game.state.players[0].hp = 1

    stackRank(game, 5)
    hit(game, 'p0', 1)
    // 再来一张同点数
    stackRank(game, 5)
    hit(game, 'p0', 1)

    expect(pile(game, 'p0'), '牌照样置于武将牌上').toHaveLength(2)
    const dyingNow = game.state.dying !== null
      || game.state.pendingRequests.some((request) => request.kind === 'rescue')
      || !game.state.players[0].alive
    expect(dyingNow, '点数重复就撑不住了').toBe(true)
    assertGameInvariants(game.state)
  })

  it('无人出桃则死亡，「创」留在武将牌上不影响牌张守恒', () => {
    const game = gameWith(FILLER)
    stripHands(game)
    game.state.players[0].hp = 1
    stackRank(game, 5)
    hit(game, 'p0', 1)
    stackRank(game, 5)
    hit(game, 'p0', 1)

    // 走完求桃流程，没人有桃
    for (let guard = 0; guard < 10 && game.state.pendingRequests.length > 0; guard += 1) {
      const request = game.state.pendingRequests[0]
      game.respond({ requestId: request.id, playerId: request.playerId, payload: { actionId: 'rescue-pass' } })
    }

    expect(game.state.players[0].alive).toBe(false)
    assertGameInvariants(game.state)
  })
})

describe('不屈不是死亡流程里的特判', () => {
  it('没有不屈的角色在同样局面下会正常濒死', () => {
    const game = gameWith(['zhangfei', 'zhangfei', 'zhangfei', 'zhangfei', 'zhangfei'])
    stripHands(game)
    game.state.players[0].hp = 1

    hit(game, 'p0', 1)

    expect(pile(game, 'p0'), '不该凭空多出专属牌堆').toHaveLength(0)
    const dyingNow = game.state.dying !== null || !game.state.players[0].alive
    expect(dyingNow).toBe(true)
    assertGameInvariants(game.state)
  })

  it('零体力存活只对不屈放行，其他人仍然违反不变量', () => {
    const game = gameWith(['zhangfei', 'zhangfei', 'zhangfei', 'zhangfei', 'zhangfei'])
    game.state.players[0].hp = 0
    expect(() => assertGameInvariants(game.state)).toThrow(/非正体力/)
  })

  it('「创」点数一旦重复，零体力存活的豁免立即失效', () => {
    const game = gameWith(FILLER)
    const owner = game.state.players[0]
    owner.hp = 0
    // 手工塞两张同点数的「创」
    const first = stackRank(game, 5)
    game.state.zones.drawPile = game.state.zones.drawPile.filter((id) => id !== first)
    const second = game.state.zones.drawPile.find((id) => game.state.cards[id].rank === 5 && id !== first)!
    game.state.zones.drawPile = game.state.zones.drawPile.filter((id) => id !== second)
    owner.characterPiles[BUQU] = [first, second]

    expect(() => assertGameInvariants(game.state), '点数重复就不该再豁免').toThrow(/非正体力/)
  })
})

describe('专属牌堆的守恒与持久化', () => {
  it('「创」计入牌张守恒——不是复制出来的牌面', () => {
    const game = gameWith(FILLER)
    stripHands(game)
    game.state.players[0].hp = 1
    const wound = stackRank(game, 5)
    hit(game, 'p0', 1)

    expect(game.state.zones.drawPile, '牌真的离开了牌堆').not.toContain(wound)
    expect(game.state.zones.discardPile).not.toContain(wound)
    expect(pile(game, 'p0')).toContain(wound)
    assertGameInvariants(game.state)
  })

  it('过一遍 JSON 之后「创」还在——断线重连要靠它', () => {
    const game = gameWith(FILLER)
    stripHands(game)
    game.state.players[0].hp = 1
    const wound = stackRank(game, 5)
    hit(game, 'p0', 1)

    const restored = SanguoshaGame.restore(JSON.parse(JSON.stringify(game.state)))
    expect(restored.state.players[0].characterPiles[BUQU]).toEqual([wound])
    expect(restored.state.players[0].hp).toBe(0)
    expect(restored.state.players[0].alive).toBe(true)
    assertGameInvariants(restored.state)
  })

  it('「创」对所有人公开——牌是亮出来的', () => {
    const game = gameWith(FILLER)
    stripHands(game)
    game.state.players[0].hp = 1
    const wound = stackRank(game, 5)
    hit(game, 'p0', 1)

    const view = game.viewFor('p2')
    const piles = view.players.find((player) => player.id === 'p0')?.characterPiles ?? {}
    expect(piles[BUQU]?.map((card) => card.id)).toEqual([wound])
  })
})
