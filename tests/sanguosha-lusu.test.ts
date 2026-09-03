import { describe, expect, it } from 'vitest'
import { SanguoshaGame } from '@/sanguosha/engine/game'
import { assertGameInvariants } from '@/sanguosha/engine/invariants'
import { assertCardConservation } from '@/sanguosha/engine/zones'
import type { GameSetup, Identity, PlayerId } from '@/sanguosha/engine/types'

/**
 * 林包·鲁肃【好施】【缔盟】。经典首版。
 *
 * 两条最容易做错的地方各钉了一组：
 *
 * 1. **交给 ≠ 弃置**。好施交出去的牌、缔盟交换的手牌都不能路过弃牌堆，
 *    否则会触发一批本不该触发的弃牌时机。
 * 2. **交换手牌必须原子**。天真写法「A 的牌给 B，再把 B 的牌给 A」会让
 *    A 拿走全部牌、B 空手——这一条单独有用例守着。
 */

function gameWith(characterIds: string[], seed = 'lusu'): SanguoshaGame {
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

function pending(game: SanguoshaGame) {
  return game.state.pendingRequests[0]
}

function playerOf(game: SanguoshaGame, playerId: PlayerId) {
  return game.state.players.find((player) => player.id === playerId)!
}

/** 把某人的手牌调整成正好 n 张，多退少补，牌都从牌堆里拿。 */
function setHand(game: SanguoshaGame, playerId: PlayerId, count: number): void {
  const owner = playerOf(game, playerId)
  while (owner.zones.hand.length > count) {
    game.state.zones.discardPile.push(owner.zones.hand.pop()!)
  }
  while (owner.zones.hand.length < count) {
    const cardId = game.state.zones.drawPile.shift()
    if (!cardId) throw new Error('牌堆空了')
    owner.zones.hand.push(cardId)
  }
}

/** 把回合交给某人并进入摸牌阶段。 */
function enterDrawPhase(game: SanguoshaGame, playerId: PlayerId): void {
  game.state.currentPlayerId = playerId
  game.state.phase = 'judge'
  game.state.skippedPhases = []
  game.state.judgedDelayedCards = []
  game.advancePhase()
}

const FIVE = ['lusu', 'zhangfei', 'zhangfei', 'zhangfei', 'zhangfei']

describe('好施：摸牌阶段多摸两张', () => {
  it('放弃发动就正常摸两张，不问后续', () => {
    const game = gameWith(FIVE)
    setHand(game, 'p0', 0)
    enterDrawPhase(game, 'p0')
    const ask = pending(game)
    expect(ask?.kind).toBe('choose-option')
    game.respond({ requestId: ask.id, playerId: 'p0', payload: { optionId: 'no' } })
    expect(playerOf(game, 'p0').zones.hand.length).toBe(2)
    expect(pending(game), '没发动就不该有交牌询问').toBeUndefined()
    assertCardConservation(game.state)
  })

  it('发动后一共摸四张', () => {
    const game = gameWith(FIVE)
    setHand(game, 'p0', 0)
    enterDrawPhase(game, 'p0')
    game.respond({ requestId: pending(game).id, playerId: 'p0', payload: { optionId: 'yes' } })
    expect(playerOf(game, 'p0').zones.hand.length, '2 + 2').toBe(4)
    expect(pending(game), '手牌没超过 5 张就不用交牌').toBeUndefined()
    assertCardConservation(game.state)
  })

  it('摸牌阶段被跳过时根本不会问好施', () => {
    const game = gameWith(FIVE)
    setHand(game, 'p0', 0)
    game.state.currentPlayerId = 'p0'
    game.state.phase = 'judge'
    game.state.skippedPhases = ['draw']
    game.state.judgedDelayedCards = []
    game.advancePhase()

    expect(game.state.phase, '摸牌阶段被跳过，直接进出牌阶段').toBe('play')
    expect(pending(game), '跳过的阶段不该凭空发动好施').toBeUndefined()
    expect(playerOf(game, 'p0').zones.hand.length, '一张都没摸').toBe(0)
  })

  it('摸完手牌恰好 5 张时不用交牌——阈值是「大于 5」', () => {
    const game = gameWith(FIVE)
    setHand(game, 'p0', 1)
    enterDrawPhase(game, 'p0')
    game.respond({ requestId: pending(game).id, playerId: 'p0', payload: { optionId: 'yes' } })
    expect(playerOf(game, 'p0').zones.hand.length).toBe(5)
    expect(pending(game)).toBeUndefined()
  })

  it('摸完超过 5 张就要把一半（向下取整）交出去', () => {
    const game = gameWith(FIVE)
    setHand(game, 'p0', 3)
    // 让 p2 成为唯一手牌最少的人
    setHand(game, 'p1', 4)
    setHand(game, 'p2', 0)
    setHand(game, 'p3', 4)
    setHand(game, 'p4', 4)

    enterDrawPhase(game, 'p0')
    game.respond({ requestId: pending(game).id, playerId: 'p0', payload: { optionId: 'yes' } })

    const give = pending(game)
    expect(give?.kind, '唯一最少时直接问交哪几张，不多问一步选人').toBe('choose-cards')
    expect(playerOf(game, 'p0').zones.hand.length, '3 + 4').toBe(7)
    expect(give.min, '7 的一半向下取整是 3').toBe(3)
    expect(give.max).toBe(3)

    const chosen = playerOf(game, 'p0').zones.hand.slice(0, 3)
    game.respond({ requestId: give.id, playerId: 'p0', payload: { cardIds: chosen } })

    expect(playerOf(game, 'p0').zones.hand.length).toBe(4)
    expect(playerOf(game, 'p2').zones.hand.sort(), '牌直接到了 p2 手上').toEqual([...chosen].sort())
    for (const cardId of chosen) {
      expect(game.state.zones.discardPile, '交给不是弃置，不能路过弃牌堆').not.toContain(cardId)
    }
    assertCardConservation(game.state)
    assertGameInvariants(game.state)
  })

  it('多人并列手牌最少时由鲁肃选一个', () => {
    const game = gameWith(FIVE)
    setHand(game, 'p0', 3)
    setHand(game, 'p1', 1)
    setHand(game, 'p2', 1)
    setHand(game, 'p3', 4)
    setHand(game, 'p4', 4)

    enterDrawPhase(game, 'p0')
    game.respond({ requestId: pending(game).id, playerId: 'p0', payload: { optionId: 'yes' } })

    const pick = pending(game)
    expect(pick?.kind, '并列时先问交给谁').toBe('choose-targets')
    expect(pick.candidateIds.sort()).toEqual(['p1', 'p2'])
    game.respond({ requestId: pick.id, playerId: 'p0', payload: { targetIds: ['p2'] } })

    const give = pending(game)
    expect(give.kind).toBe('choose-cards')
    game.respond({ requestId: give.id, playerId: 'p0', payload: { cardIds: playerOf(game, 'p0').zones.hand.slice(0, give.min) } })
    expect(playerOf(game, 'p2').zones.hand.length).toBe(1 + 3)
    assertCardConservation(game.state)
  })

  it('鲁肃自己手牌最少也不参与候选——文本写的是「其他角色」', () => {
    const game = gameWith(FIVE)
    setHand(game, 'p0', 2)
    for (const id of ['p1', 'p2', 'p3', 'p4']) setHand(game, id, 8)

    enterDrawPhase(game, 'p0')
    game.respond({ requestId: pending(game).id, playerId: 'p0', payload: { optionId: 'yes' } })

    // 摸完 6 张，鲁肃自己远不是最少，但候选里仍然只有其他四人
    const request = pending(game)
    expect(request?.kind).toBe('choose-targets')
    expect(request.candidateIds).not.toContain('p0')
    expect(request.candidateIds.sort()).toEqual(['p1', 'p2', 'p3', 'p4'])
  })

  it('只有鲁肃活着时不交牌', () => {
    const game = gameWith(FIVE)
    setHand(game, 'p0', 4)
    for (const id of ['p1', 'p2', 'p3', 'p4']) {
      const other = playerOf(game, id)
      other.alive = false
      other.hp = 0
      game.state.zones.discardPile.push(...other.zones.hand)
      other.zones.hand = []
    }
    enterDrawPhase(game, 'p0')
    game.respond({ requestId: pending(game).id, playerId: 'p0', payload: { optionId: 'yes' } })
    expect(pending(game), '没有其他角色就没得交').toBeUndefined()
    assertCardConservation(game.state)
  })
})

describe('缔盟：令两名其他角色交换手牌', () => {
  function dimengAction(game: SanguoshaGame) {
    return game.legalActions('p0').find((action) => action.id === 'skill:dimeng')
  }

  it('出牌阶段限一次', () => {
    const game = gameWith(FIVE)
    setHand(game, 'p1', 3)
    setHand(game, 'p2', 3)
    expect(dimengAction(game), '一开始能发动').toBeTruthy()

    game.act('p0', dimengAction(game)!.id)
    game.respond({ requestId: pending(game).id, playerId: 'p0', payload: { targetIds: ['p1', 'p2'] } })
    expect(dimengAction(game), '用过之后本回合不能再用').toBeFalsy()
  })

  it('放弃选人不消耗本回合这一次', () => {
    const game = gameWith(FIVE)
    game.act('p0', dimengAction(game)!.id)
    game.respond({ requestId: pending(game).id, playerId: 'p0', payload: { targetIds: [] } })
    expect(dimengAction(game), '没真的发动，还能再点').toBeTruthy()
  })

  it('候选里没有鲁肃自己', () => {
    const game = gameWith(FIVE)
    game.act('p0', dimengAction(game)!.id)
    const request = pending(game)
    expect(request.kind).toBe('choose-targets')
    expect(request.candidateIds).not.toContain('p0')
    // min 为 0 是「放弃发动」的出口（choose-targets 的校验不看 optional）；
    // 「必须选满两个」由技能续接把关，不足两个一律当作放弃
    expect(request.min).toBe(0)
    expect(request.max).toBe(2)
  })

  it('两人手牌相同时 X = 0，不弹空的弃牌窗口，直接交换', () => {
    const game = gameWith(FIVE)
    setHand(game, 'p1', 3)
    setHand(game, 'p2', 3)
    const before1 = [...playerOf(game, 'p1').zones.hand]
    const before2 = [...playerOf(game, 'p2').zones.hand]
    const lusuHand = playerOf(game, 'p0').zones.hand.length

    game.act('p0', dimengAction(game)!.id)
    game.respond({ requestId: pending(game).id, playerId: 'p0', payload: { targetIds: ['p1', 'p2'] } })

    expect(pending(game), 'X 为 0 就不该有弃牌请求').toBeUndefined()
    expect(playerOf(game, 'p0').zones.hand.length, '不用付代价').toBe(lusuHand)
    expect(playerOf(game, 'p1').zones.hand).toEqual(before2)
    expect(playerOf(game, 'p2').zones.hand).toEqual(before1)
    assertCardConservation(game.state)
  })

  it('X > 0 时按手牌差弃牌，然后交换', () => {
    const game = gameWith(FIVE)
    setHand(game, 'p0', 5)
    setHand(game, 'p1', 5)
    setHand(game, 'p2', 2)
    const before1 = [...playerOf(game, 'p1').zones.hand]
    const before2 = [...playerOf(game, 'p2').zones.hand]

    game.act('p0', dimengAction(game)!.id)
    game.respond({ requestId: pending(game).id, playerId: 'p0', payload: { targetIds: ['p1', 'p2'] } })

    const cost = pending(game)
    expect(cost?.kind).toBe('choose-cards')
    expect(cost.min, '5 与 2 的差是 3').toBe(3)
    const paid = playerOf(game, 'p0').zones.hand.slice(0, 3)
    game.respond({ requestId: cost.id, playerId: 'p0', payload: { cardIds: paid } })

    expect(playerOf(game, 'p0').zones.hand.length).toBe(2)
    for (const cardId of paid) {
      expect(game.state.zones.discardPile, '鲁肃付的代价是真弃置').toContain(cardId)
    }
    expect(playerOf(game, 'p1').zones.hand).toEqual(before2)
    expect(playerOf(game, 'p2').zones.hand).toEqual(before1)
    assertCardConservation(game.state)
    assertGameInvariants(game.state)
  })

  it('代价可以用装备区的牌付——文本写的是「弃置 X 张牌」', () => {
    const game = gameWith(FIVE)
    setHand(game, 'p0', 1)
    setHand(game, 'p1', 3)
    setHand(game, 'p2', 1)
    const lion = Object.values(game.state.cards).find((card) => card.name === '白银狮子')!.id
    game.state.zones.drawPile = game.state.zones.drawPile.filter((id) => id !== lion)
    game.state.zones.discardPile = game.state.zones.discardPile.filter((id) => id !== lion)
    for (const player of game.state.players) player.zones.hand = player.zones.hand.filter((id) => id !== lion)
    const lusu = playerOf(game, 'p0')
    lusu.zones.equipment.armor = lion
    lusu.hp = 2

    game.act('p0', dimengAction(game)!.id)
    game.respond({ requestId: pending(game).id, playerId: 'p0', payload: { targetIds: ['p1', 'p2'] } })

    const cost = pending(game)
    expect(cost.cardIds, '装备区的牌应当在可弃候选里').toContain(lion)
    expect(cost.min, '3 与 1 的差是 2').toBe(2)
    game.respond({ requestId: cost.id, playerId: 'p0', payload: { cardIds: [lion, ...lusu.zones.hand.slice(0, 1)] } })

    expect(lusu.zones.equipment.armor, '装备真的离场了').toBeNull()
    expect(lusu.hp, '失去白银狮子照常回一点体力').toBe(3)
    assertCardConservation(game.state)
  })

  it('付不起代价时不发动，本回合仍可重来', () => {
    const game = gameWith(FIVE)
    setHand(game, 'p0', 1)
    setHand(game, 'p1', 8)
    setHand(game, 'p2', 0)

    game.act('p0', dimengAction(game)!.id)
    game.respond({ requestId: pending(game).id, playerId: 'p0', payload: { targetIds: ['p1', 'p2'] } })

    expect(pending(game), '付不起就不该弹弃牌窗口').toBeUndefined()
    expect(playerOf(game, 'p1').zones.hand.length, '没有发生交换').toBe(8)
    expect(dimengAction(game), '没消耗掉本回合这一次').toBeTruthy()
  })
})

describe('交换手牌必须原子', () => {
  it('一方空手时也正确对调，而不是把牌全堆到一边', () => {
    const game = gameWith(FIVE)
    setHand(game, 'p0', 3)
    setHand(game, 'p1', 3)
    setHand(game, 'p2', 0)
    const before1 = [...playerOf(game, 'p1').zones.hand]

    game.act('p0', game.legalActions('p0').find((action) => action.id === 'skill:dimeng')!.id)
    game.respond({ requestId: pending(game).id, playerId: 'p0', payload: { targetIds: ['p1', 'p2'] } })
    const cost = pending(game)
    game.respond({ requestId: cost.id, playerId: 'p0', payload: { cardIds: playerOf(game, 'p0').zones.hand.slice(0, cost.min) } })

    expect(playerOf(game, 'p1').zones.hand, 'p1 换到了空手').toEqual([])
    expect(playerOf(game, 'p2').zones.hand, 'p2 拿到了 p1 原来的三张').toEqual(before1)
    assertCardConservation(game.state)
  })

  it('双方都空手时什么也不会坏掉', () => {
    const game = gameWith(FIVE)
    setHand(game, 'p1', 0)
    setHand(game, 'p2', 0)

    game.act('p0', game.legalActions('p0').find((action) => action.id === 'skill:dimeng')!.id)
    game.respond({ requestId: pending(game).id, playerId: 'p0', payload: { targetIds: ['p1', 'p2'] } })

    expect(playerOf(game, 'p1').zones.hand).toEqual([])
    expect(playerOf(game, 'p2').zones.hand).toEqual([])
    assertCardConservation(game.state)
    assertGameInvariants(game.state)
  })

  it('交换不是弃牌，不触发连营这类「失去手牌」技能', () => {
    // 陆逊【连营】：失去最后一张手牌时摸一张。交换手牌不该把它触发起来
    const game = gameWith(['lusu', 'luxun', 'zhangfei', 'zhangfei', 'zhangfei'])
    setHand(game, 'p1', 1)
    setHand(game, 'p2', 1)
    const luxunHand = playerOf(game, 'p1').zones.hand.length

    game.act('p0', game.legalActions('p0').find((action) => action.id === 'skill:dimeng')!.id)
    game.respond({ requestId: pending(game).id, playerId: 'p0', payload: { targetIds: ['p1', 'p2'] } })

    expect(playerOf(game, 'p1').zones.hand.length, '换完还是一张，没有因为连营多摸').toBe(luxunHand)
    expect(pending(game), '交换不该产生任何弃牌类询问').toBeUndefined()
    assertCardConservation(game.state)
  })
})
