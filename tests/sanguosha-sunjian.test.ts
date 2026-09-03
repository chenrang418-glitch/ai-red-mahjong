import { describe, expect, it } from 'vitest'
import { SanguoshaGame } from '@/sanguosha/engine/game'
import { assertGameInvariants } from '@/sanguosha/engine/invariants'
import { assertCardConservation } from '@/sanguosha/engine/zones'
import type { GameSetup, Identity, PlayerId, Suit } from '@/sanguosha/engine/types'

/**
 * 林包·孙坚【英魂】。经典首版，没有「魂」标记（那是十周年版）。
 *
 * 两条最容易做错的地方，这里各钉了一组：
 *
 * 1. **决策归属**：发动、选目标、选哪一项都是孙坚的；目标只挑自己弃哪几张牌。
 * 2. **先摸后弃**：弃牌请求必须基于摸完之后的手牌生成，不能反过来。
 */

function gameWith(characterIds: string[], seed = 'sunjian'): SanguoshaGame {
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
  return game
}

function pending(game: SanguoshaGame) {
  return game.state.pendingRequests[0]
}

function playerOf(game: SanguoshaGame, playerId: PlayerId) {
  return game.state.players.find((player) => player.id === playerId)!
}

function detach(game: SanguoshaGame, cardId: string): void {
  game.state.zones.drawPile = game.state.zones.drawPile.filter((id) => id !== cardId)
  game.state.zones.discardPile = game.state.zones.discardPile.filter((id) => id !== cardId)
  for (const player of game.state.players) {
    player.zones.hand = player.zones.hand.filter((id) => id !== cardId)
    player.zones.judgingArea = player.zones.judgingArea.filter((id) => id !== cardId)
  }
}

function findCard(game: SanguoshaGame, match: (card: { id: string; name: string; suit: Suit; category: string }) => boolean): string {
  const card = Object.values(game.state.cards).find((candidate) => match(candidate))
  if (!card) throw new Error('这副牌里找不到符合条件的牌')
  return card.id
}

function clearHand(game: SanguoshaGame, playerId: PlayerId): void {
  const owner = playerOf(game, playerId)
  game.state.zones.discardPile.push(...owner.zones.hand)
  owner.zones.hand = []
}

/** 把回合交给孙坚并进入准备阶段，触发英魂。 */
function enterPrepare(game: SanguoshaGame, playerId: PlayerId): void {
  game.state.currentPlayerId = playerId
  game.state.phase = 'prepare'
  game.state.skippedPhases = []
  game.state.judgedDelayedCards = []
  game.events.emit({
    id: `test-${game.state.seq}`, seq: game.state.seq, name: 'PhaseStart',
    payload: { playerId, phase: 'prepare' },
  })
}

/** 走完「发动 → 选目标 → 选模式」，停在目标的弃牌请求上（或已经结束）。 */
function invokeYinghun(game: SanguoshaGame, targetId: PlayerId, mode: 'draw-many' | 'discard-many'): void {
  const ask = pending(game)
  if (ask?.kind !== 'choose-option') throw new Error('英魂没有弹出发动询问')
  game.respond({ requestId: ask.id, playerId: 'p0', payload: { optionId: 'yes' } })

  const pick = pending(game)
  if (pick?.kind !== 'choose-targets') throw new Error('英魂没有弹出选目标')
  game.respond({ requestId: pick.id, playerId: 'p0', payload: { targetIds: [targetId] } })

  const modeAsk = pending(game)
  if (modeAsk?.kind !== 'choose-option') throw new Error('英魂没有弹出选项')
  const option = modeAsk.options.find((candidate) => candidate.id.startsWith(`yinghun-${mode}`))
  if (!option) throw new Error(`找不到模式 ${mode}`)
  game.respond({ requestId: modeAsk.id, playerId: 'p0', payload: { optionId: option.id } })
}

const FIVE = ['sunjian', 'zhangfei', 'zhangfei', 'zhangfei', 'zhangfei']

describe('英魂的发动条件', () => {
  it('满血不触发，也不弹窗', () => {
    const game = gameWith(FIVE)
    enterPrepare(game, 'p0')
    expect(pending(game), '没受伤就不该有任何询问').toBeUndefined()
  })

  it('受伤后弹出发动询问，可以放弃', () => {
    const game = gameWith(FIVE)
    playerOf(game, 'p0').hp = 3
    enterPrepare(game, 'p0')
    const ask = pending(game)
    expect(ask?.kind).toBe('choose-option')
    expect(ask.playerId, '发不发动由孙坚决定').toBe('p0')
    game.respond({ requestId: ask.id, playerId: 'p0', payload: { optionId: 'no' } })
    expect(pending(game), '放弃之后不该留下请求').toBeUndefined()
  })

  it('候选里只有其他角色，孙坚不能选自己', () => {
    const game = gameWith(FIVE)
    playerOf(game, 'p0').hp = 2
    enterPrepare(game, 'p0')
    game.respond({ requestId: pending(game).id, playerId: 'p0', payload: { optionId: 'yes' } })
    const pick = pending(game)
    expect(pick.kind).toBe('choose-targets')
    expect(pick.candidateIds).not.toContain('p0')
    expect(pick.candidateIds.sort()).toEqual(['p1', 'p2', 'p3', 'p4'])
  })

  it('阵亡的角色不在候选里', () => {
    const game = gameWith(FIVE)
    playerOf(game, 'p0').hp = 2
    const dead = playerOf(game, 'p2')
    dead.alive = false
    dead.hp = 0
    enterPrepare(game, 'p0')
    game.respond({ requestId: pending(game).id, playerId: 'p0', payload: { optionId: 'yes' } })
    expect(pending(game).candidateIds).not.toContain('p2')
  })

  it('选项文案写明具体数量，不是「模式一 / 模式二」', () => {
    const game = gameWith(FIVE)
    playerOf(game, 'p0').hp = 1
    enterPrepare(game, 'p0')
    game.respond({ requestId: pending(game).id, playerId: 'p0', payload: { optionId: 'yes' } })
    game.respond({ requestId: pending(game).id, playerId: 'p0', payload: { targetIds: ['p1'] } })
    const modeAsk = pending(game)
    expect(modeAsk.playerId, '选哪一项也是孙坚决定，不是目标').toBe('p0')
    expect(modeAsk.options.map((option) => option.label)).toEqual([
      '摸 3 张牌，然后弃置 1 张牌',
      '摸 1 张牌，然后弃置 3 张牌',
    ])
  })
})

describe('X 按已损失体力值变化', () => {
  for (const [hp, x] of [[3, 1], [2, 2], [1, 3]] as const) {
    it(`${hp}/4 血时 X = ${x}`, () => {
      const game = gameWith(FIVE)
      playerOf(game, 'p0').hp = hp
      clearHand(game, 'p1')
      enterPrepare(game, 'p0')
      invokeYinghun(game, 'p1', 'draw-many')

      // 摸 X 张之后弃 1 张，净增 X-1
      const discard = pending(game)
      expect(playerOf(game, 'p1').zones.hand.length, `应该先摸 ${x} 张`).toBe(x)
      if (x > 1) {
        expect(discard?.kind).toBe('choose-cards')
        expect(discard.min, '摸 X 弃 1，弃的是 1 张').toBe(1)
      }
      assertCardConservation(game.state)
    })
  }

  it('摸 1 弃 X：X = 3 时真的弃三张', () => {
    const game = gameWith(FIVE)
    playerOf(game, 'p0').hp = 1
    clearHand(game, 'p1')
    // 先给目标塞满，确认弃的是 3 张而不是「有多少弃多少」
    for (let index = 0; index < 5; index += 1) {
      const cardId = game.state.zones.drawPile.shift()!
      playerOf(game, 'p1').zones.hand.push(cardId)
    }
    enterPrepare(game, 'p0')
    invokeYinghun(game, 'p1', 'discard-many')

    const discard = pending(game)
    expect(playerOf(game, 'p1').zones.hand.length, '先摸 1 张：5 + 1').toBe(6)
    expect(discard.min, 'X = 3').toBe(3)
    expect(discard.max).toBe(3)
    game.respond({ requestId: discard.id, playerId: 'p1', payload: { cardIds: playerOf(game, 'p1').zones.hand.slice(0, 3) } })
    expect(playerOf(game, 'p1').zones.hand.length, '摸 1 弃 3，净减 2').toBe(3)
    assertCardConservation(game.state)
    assertGameInvariants(game.state)
  })
})

describe('先摸后弃与弃牌区域', () => {
  it('弃牌请求是发给目标的，不是发给孙坚的', () => {
    const game = gameWith(FIVE)
    playerOf(game, 'p0').hp = 2
    enterPrepare(game, 'p0')
    invokeYinghun(game, 'p1', 'draw-many')
    const discard = pending(game)
    expect(discard.playerId, '弃自己哪几张牌由目标决定').toBe('p1')
  })

  it('候选里包含摸到的新牌——弃牌基于摸完之后的手牌', () => {
    const game = gameWith(FIVE)
    playerOf(game, 'p0').hp = 1
    clearHand(game, 'p1')
    enterPrepare(game, 'p0')
    invokeYinghun(game, 'p1', 'draw-many')

    const discard = pending(game)
    const hand = playerOf(game, 'p1').zones.hand
    expect(hand.length, '空手摸 3 张').toBe(3)
    for (const cardId of hand) expect(discard.cardIds, '刚摸到的牌必须在可弃候选里').toContain(cardId)
  })

  it('装备区的牌也能弃——技能文本写的是「牌」不是「手牌」', () => {
    const game = gameWith(FIVE)
    playerOf(game, 'p0').hp = 2
    clearHand(game, 'p1')
    const lion = findCard(game, (card) => card.name === '白银狮子')
    detach(game, lion)
    const target = playerOf(game, 'p1')
    target.zones.equipment.armor = lion
    target.hp = 2

    enterPrepare(game, 'p0')
    invokeYinghun(game, 'p1', 'draw-many')

    const discard = pending(game)
    expect(discard.cardIds, '装备区的牌应当在候选里').toContain(lion)
    game.respond({ requestId: discard.id, playerId: 'p1', payload: { cardIds: [lion] } })

    expect(target.zones.equipment.armor, '装备应该真的离场').toBeNull()
    expect(target.hp, '失去白银狮子照常回一点体力').toBe(3)
    assertCardConservation(game.state)
    assertGameInvariants(game.state)
  })

  it('判定区的牌不算可弃的牌', () => {
    const game = gameWith(FIVE)
    playerOf(game, 'p0').hp = 2
    clearHand(game, 'p1')
    const le = findCard(game, (card) => card.name === '乐不思蜀')
    detach(game, le)
    playerOf(game, 'p1').zones.judgingArea.push(le)

    enterPrepare(game, 'p0')
    invokeYinghun(game, 'p1', 'draw-many')

    expect(pending(game).cardIds, '判定区的牌不在候选里').not.toContain(le)
  })
})

describe('牌不足的边界', () => {
  it('要弃 X 张但牌不够时弃光，不发一个永远满足不了的请求', () => {
    const game = gameWith(FIVE)
    playerOf(game, 'p0').hp = 1
    clearHand(game, 'p1')
    enterPrepare(game, 'p0')
    invokeYinghun(game, 'p1', 'discard-many')

    const discard = pending(game)
    // 空手摸 1 张之后只有 1 张牌，X 是 3
    expect(discard.min, '有多少弃多少').toBe(1)
    expect(discard.max).toBe(1)
    game.respond({ requestId: discard.id, playerId: 'p1', payload: { cardIds: [playerOf(game, 'p1').zones.hand[0]] } })
    expect(playerOf(game, 'p1').zones.hand).toEqual([])
    assertCardConservation(game.state)
  })

  it('牌堆空、目标摸不到牌时不弹空的弃牌窗口', () => {
    const game = gameWith(FIVE)
    playerOf(game, 'p0').hp = 2
    clearHand(game, 'p1')
    // 牌堆和弃牌堆都清空，谁也摸不到牌
    game.state.zones.discardPile = [...game.state.zones.discardPile, ...game.state.zones.drawPile]
    game.state.zones.drawPile = []
    const stash = [...game.state.zones.discardPile]
    game.state.zones.discardPile = []

    enterPrepare(game, 'p0')
    invokeYinghun(game, 'p1', 'draw-many')

    expect(playerOf(game, 'p1').zones.hand, '一张都摸不到').toEqual([])
    expect(pending(game), '没有牌可弃就不该弹空窗口').toBeUndefined()
    // 把牌放回去再校验守恒
    game.state.zones.discardPile.push(...stash)
    assertCardConservation(game.state)
  })
})

describe('可序列化', () => {
  it('选完模式待弃牌时存档重载，不会重复摸牌', () => {
    const game = gameWith(FIVE)
    playerOf(game, 'p0').hp = 1
    clearHand(game, 'p1')
    enterPrepare(game, 'p0')
    invokeYinghun(game, 'p1', 'draw-many')

    const handBefore = [...playerOf(game, 'p1').zones.hand]
    const snapshot = game.serialize()
    const restored = SanguoshaGame.restore(snapshot)

    const discard = restored.state.pendingRequests[0]
    expect(discard?.kind, '重载后仍停在弃牌请求上').toBe('choose-cards')
    const target = restored.state.players.find((player) => player.id === 'p1')!
    expect(target.zones.hand, '重载不会再摸一次').toEqual(handBefore)

    restored.respond({ requestId: discard.id, playerId: 'p1', payload: { cardIds: [target.zones.hand[0]] } })
    expect(target.zones.hand.length).toBe(handBefore.length - 1)
    assertCardConservation(restored.state)
    assertGameInvariants(restored.state)
  })
})
