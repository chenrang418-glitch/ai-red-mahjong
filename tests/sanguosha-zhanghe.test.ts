import { describe, expect, it } from 'vitest'
import { SanguoshaGame } from '@/sanguosha/engine/game'
import { assertGameInvariants } from '@/sanguosha/engine/invariants'
import { assertCardConservation } from '@/sanguosha/engine/zones'
import type { GameSetup, Identity, PlayerId, Suit, TurnPhase } from '@/sanguosha/engine/types'

/**
 * 山包·张郃【巧变】。本项目自研表述。。
 *
 * 这一组守的重点不是「技能能发动」，而是**跳过必须是真跳过**：
 * 走公共 `skippedPhases`，被跳过的阶段既不发 `PhaseStart` 也不跑阶段内容，
 * 判定区的延时锦囊因此原样留着而不是被结算掉。
 * 假跳过（摸 0 张、手牌上限设无穷、AI 直接 pass）在这里全都会被抓出来。
 */

function gameWith(characterIds: string[], seed = 'zhanghe'): SanguoshaGame {
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

function findCard(game: SanguoshaGame, match: (card: { id: string; name: string; suit: Suit; category: string }) => boolean): string {
  const card = Object.values(game.state.cards).find((candidate) => match(candidate))
  if (!card) throw new Error('这副牌里找不到符合条件的牌')
  return card.id
}

function detach(game: SanguoshaGame, cardId: string): void {
  game.state.zones.drawPile = game.state.zones.drawPile.filter((id) => id !== cardId)
  game.state.zones.discardPile = game.state.zones.discardPile.filter((id) => id !== cardId)
  game.state.zones.processingArea = game.state.zones.processingArea.filter((id) => id !== cardId)
  for (const player of game.state.players) {
    player.zones.hand = player.zones.hand.filter((id) => id !== cardId)
    player.zones.judgingArea = player.zones.judgingArea.filter((id) => id !== cardId)
    for (const slot of Object.keys(player.zones.equipment) as Array<keyof typeof player.zones.equipment>) {
      if (player.zones.equipment[slot] === cardId) player.zones.equipment[slot] = null
    }
  }
}

function giveHand(game: SanguoshaGame, playerId: PlayerId, cardIds: string[]): void {
  for (const cardId of cardIds) {
    detach(game, cardId)
    playerOf(game, playerId).zones.hand.push(cardId)
  }
}

function clearHand(game: SanguoshaGame, playerId: PlayerId): void {
  const owner = playerOf(game, playerId)
  game.state.zones.discardPile.push(...owner.zones.hand)
  owner.zones.hand = []
}

/**
 * 把回合交给张郃并停在 `before` 的**前一个**阶段，
 * 然后用真正的阶段状态机推进过去——巧变的窗口在 `advancePhase` 里，
 * 伪造一条 PhaseStart 是测不到它的。
 */
const ORDER: readonly TurnPhase[] = ['prepare', 'judge', 'draw', 'play', 'discard', 'finish']

function advanceTo(game: SanguoshaGame, playerId: PlayerId, phase: TurnPhase): void {
  game.state.currentPlayerId = playerId
  game.state.phase = ORDER[ORDER.indexOf(phase) - 1]
  game.state.skippedPhases = []
  game.state.judgedDelayedCards = []
  game.advancePhase()
}

/**
 * 断言「这次巧变没有后续步骤」。
 *
 * 注意不能直接断言「没有任何 pendingRequest」：跳过一个阶段之后牌局立刻
 * 进入下一个阶段，而下一个阶段**自己也会弹一次巧变窗口**。
 * 所以这里要区分的是「本次巧变的后续（偷牌 / 移动场上牌）」和
 * 「下一个阶段的新窗口」——后者出现是对的。
 */
function expectNoQiaobianFollowUp(game: SanguoshaGame): void {
  const request = pending(game)
  if (!request) return
  expect(request.kind, '只应该剩下新阶段的巧变窗口，不该有本次巧变的后续请求').toBe('choose-option')
  expect(String(request.prompt)).toContain('发动【巧变】')
}

/** 走完「发动 → 弃一张手牌」，停在跳过之后的后续询问上（或已经结束）。 */
function invokeQiaobian(game: SanguoshaGame, ownerId: PlayerId): void {
  const ask = pending(game)
  if (ask?.kind !== 'choose-option') throw new Error('巧变没有弹出发动询问')
  game.respond({ requestId: ask.id, playerId: ownerId, payload: { optionId: 'yes' } })
  const cost = pending(game)
  if (cost?.kind !== 'choose-cards') throw new Error('巧变没有弹出弃牌代价')
  game.respond({ requestId: cost.id, playerId: ownerId, payload: { cardIds: [cost.cardIds[0]] } })
}

const FIVE = ['zhanghe', 'zhangfei', 'zhangfei', 'zhangfei', 'zhangfei']

describe('巧变的发动窗口', () => {
  it('四个阶段各有窗口，准备和结束阶段没有', () => {
    for (const phase of ['judge', 'draw', 'play', 'discard'] as TurnPhase[]) {
      const game = gameWith(FIVE)
      advanceTo(game, 'p0', phase)
      const ask = pending(game)
      expect(ask?.kind, `${phase} 应该有巧变窗口`).toBe('choose-option')
      expect(ask.playerId).toBe('p0')
    }

    const game = gameWith(FIVE)
    // 结束阶段：从弃牌阶段推进过去，不该弹窗
    game.state.currentPlayerId = 'p0'
    game.state.phase = 'discard'
    game.state.skippedPhases = []
    clearHand(game, 'p0')
    giveHand(game, 'p0', [findCard(game, (card) => card.name === '桃')])
    game.advancePhase()
    expect(game.state.phase).toBe('finish')
    expect(pending(game), '结束阶段不该有巧变窗口').toBeUndefined()
  })

  it('没有手牌不弹窗，直接正常进入该阶段', () => {
    const game = gameWith(FIVE)
    clearHand(game, 'p0')
    advanceTo(game, 'p0', 'draw')
    expect(pending(game), '付不起代价就不该弹一个只能拒绝的窗口').toBeUndefined()
    expect(game.state.phase).toBe('draw')
    // 正常摸了两张
    expect(playerOf(game, 'p0').zones.hand.length).toBe(2)
  })

  it('放弃发动时阶段照常进行，手牌不减少', () => {
    const game = gameWith(FIVE)
    const before = playerOf(game, 'p0').zones.hand.length
    advanceTo(game, 'p0', 'draw')
    const ask = pending(game)
    game.respond({ requestId: ask.id, playerId: 'p0', payload: { optionId: 'no' } })
    expect(game.state.skippedPhases).not.toContain('draw')
    expect(playerOf(game, 'p0').zones.hand.length, '放弃之后应该正常摸两张').toBe(before + 2)
  })

  it('代价只能是手牌，装备和判定区牌不在候选里', () => {
    const game = gameWith(FIVE)
    const owner = playerOf(game, 'p0')
    const weapon = findCard(game, (card) => card.name === '诸葛连弩')
    detach(game, weapon)
    owner.zones.equipment.weapon = weapon
    const lebu = findCard(game, (card) => card.name === '乐不思蜀')
    detach(game, lebu)
    owner.zones.judgingArea.push(lebu)

    advanceTo(game, 'p0', 'discard')
    const ask = pending(game)
    game.respond({ requestId: ask.id, playerId: 'p0', payload: { optionId: 'yes' } })
    const cost = pending(game)
    expect(cost.kind).toBe('choose-cards')
    expect(cost.cardIds).not.toContain(weapon)
    expect(cost.cardIds).not.toContain(lebu)
    expect(cost.cardIds.every((cardId: string) => owner.zones.hand.includes(cardId))).toBe(true)
  })
})

describe('判定阶段巧变', () => {
  it('跳过判定阶段：延时锦囊留在判定区，本回合不判定', () => {
    const game = gameWith(FIVE)
    const owner = playerOf(game, 'p0')
    const lebu = findCard(game, (card) => card.name === '乐不思蜀')
    detach(game, lebu)
    owner.zones.judgingArea.push(lebu)

    advanceTo(game, 'p0', 'judge')
    invokeQiaobian(game, 'p0')

    expect(game.state.skippedPhases, '必须走公共 skippedPhases').toContain('judge')
    expect(owner.zones.judgingArea, '跳过判定不等于弃掉延时锦囊').toContain(lebu)
    // 判定阶段被跳过，直接进了摸牌阶段（摸牌阶段自己的巧变窗口会再弹一次）
    expect(game.state.phase).toBe('draw')
    assertCardConservation(game.state)
    assertGameInvariants(game.state)
  })

  it('被跳过的判定阶段不发 PhaseStart', () => {
    const game = gameWith(FIVE)
    const seen: string[] = []
    game.events.on('PhaseStart', (context) => {
      const payload = context.event.payload as { phase?: string }
      if (payload.phase) seen.push(payload.phase)
    })
    advanceTo(game, 'p0', 'judge')
    invokeQiaobian(game, 'p0')
    expect(seen, '阶段被跳过就不该开始过').not.toContain('judge')
  })
})

describe('摸牌阶段巧变', () => {
  it('跳过摸牌阶段：不摸牌，改为获得至多两名其他角色各一张手牌', () => {
    const game = gameWith(FIVE)
    clearHand(game, 'p1')
    clearHand(game, 'p2')
    const a = findCard(game, (card) => card.name === '杀')
    const b = findCard(game, (card) => card.name === '闪')
    giveHand(game, 'p1', [a])
    giveHand(game, 'p2', [b])
    const owner = playerOf(game, 'p0')

    advanceTo(game, 'p0', 'draw')
    const handAfterCost = owner.zones.hand.length - 1
    invokeQiaobian(game, 'p0')

    const targets = pending(game)
    expect(targets?.kind).toBe('choose-targets')
    expect(targets.max, '至多两名').toBe(2)
    expect(targets.min, '可以一个都不选').toBe(0)
    game.respond({ requestId: targets.id, playerId: 'p0', payload: { targetIds: ['p1', 'p2'] } })

    // 逐个结算：先 p1，后 p2
    const first = pending(game)
    expect(first.kind).toBe('choose-cards')
    expect(first.cardIds, '暗手牌只给占位槽，不能先看牌面').toEqual([])
    expect(first.hiddenCardSlots.length).toBe(1)
    game.respond({ requestId: first.id, playerId: 'p0', payload: { cardIds: [first.hiddenCardSlots[0]] } })

    const second = pending(game)
    expect(second.kind).toBe('choose-cards')
    game.respond({ requestId: second.id, playerId: 'p0', payload: { cardIds: [second.hiddenCardSlots[0]] } })

    expect(playerOf(game, 'p1').zones.hand.length).toBe(0)
    expect(playerOf(game, 'p2').zones.hand.length).toBe(0)
    expect(owner.zones.hand).toContain(a)
    expect(owner.zones.hand).toContain(b)
    // 弃了 1 张代价、拿了 2 张，**没有摸牌阶段那两张**
    expect(owner.zones.hand.length).toBe(handAfterCost + 2)
    expect(game.state.skippedPhases).toContain('draw')
    assertCardConservation(game.state)
  })

  it('只选一名目标只拿一张；一名都不选则什么都不拿', () => {
    const game = gameWith(FIVE)
    clearHand(game, 'p1')
    giveHand(game, 'p1', [findCard(game, (card) => card.name === '杀')])
    const owner = playerOf(game, 'p0')

    advanceTo(game, 'p0', 'draw')
    const before = owner.zones.hand.length - 1
    invokeQiaobian(game, 'p0')
    const targets = pending(game)
    game.respond({ requestId: targets.id, playerId: 'p0', payload: { targetIds: [] } })
    expectNoQiaobianFollowUp(game)
    expect(owner.zones.hand.length).toBe(before)
    assertCardConservation(game.state)
  })

  it('无手牌的角色不进候选，同一人也拿不到两张', () => {
    const game = gameWith(FIVE)
    for (const id of ['p1', 'p2', 'p3', 'p4']) clearHand(game, id)
    giveHand(game, 'p1', [findCard(game, (card) => card.name === '杀')])

    advanceTo(game, 'p0', 'draw')
    invokeQiaobian(game, 'p0')
    const targets = pending(game)
    expect(targets.candidateIds, '只有 p1 有手牌').toEqual(['p1'])
    // choose-targets 的候选是集合，同一个人不可能被选两次，
    // 所以「同一人两张」在协议层面就不存在
    expect(new Set(targets.candidateIds).size).toBe(targets.candidateIds.length)
  })

  it('全场其他角色都没有手牌时，跳过之后直接结束，不弹空窗口', () => {
    const game = gameWith(FIVE)
    for (const id of ['p1', 'p2', 'p3', 'p4']) clearHand(game, id)
    advanceTo(game, 'p0', 'draw')
    invokeQiaobian(game, 'p0')
    expectNoQiaobianFollowUp(game)
    expect(game.state.skippedPhases).toContain('draw')
  })
})

describe('出牌阶段巧变', () => {
  function setupMove(game: SanguoshaGame): void {
    advanceTo(game, 'p0', 'play')
    invokeQiaobian(game, 'p0')
  }

  it('移动装备：保留同一张 Card ID，进入对方同名装备槽', () => {
    const game = gameWith(FIVE)
    const weapon = findCard(game, (card) => card.name === '诸葛连弩')
    detach(game, weapon)
    playerOf(game, 'p1').zones.equipment.weapon = weapon

    setupMove(game)
    const pick = pending(game)
    expect(pick?.kind).toBe('choose-cards')
    expect(pick.cardIds, '场上的牌是公开的，直接列出来').toContain(weapon)
    game.respond({ requestId: pick.id, playerId: 'p0', payload: { cardIds: [weapon] } })

    const dest = pending(game)
    expect(dest?.kind).toBe('choose-targets')
    expect(dest.candidateIds, '原主不是自己的合法落点').not.toContain('p1')
    game.respond({ requestId: dest.id, playerId: 'p0', payload: { targetIds: ['p2'] } })

    expect(playerOf(game, 'p1').zones.equipment.weapon).toBeNull()
    expect(playerOf(game, 'p2').zones.equipment.weapon, '必须是同一张牌，不是先弃再造一张').toBe(weapon)
    expect(game.state.zones.discardPile, '直接移动不路过弃牌堆').not.toContain(weapon)
    assertCardConservation(game.state)
    assertGameInvariants(game.state)
  })

  it('装备槽已被占用的角色不是合法落点', () => {
    const game = gameWith(FIVE)
    const weaponA = findCard(game, (card) => card.name === '诸葛连弩')
    const weaponB = findCard(game, (card) => card.name === '青釭剑')
    detach(game, weaponA)
    detach(game, weaponB)
    playerOf(game, 'p1').zones.equipment.weapon = weaponA
    playerOf(game, 'p2').zones.equipment.weapon = weaponB

    setupMove(game)
    const pick = pending(game)
    game.respond({ requestId: pick.id, playerId: 'p0', payload: { cardIds: [weaponA] } })
    const dest = pending(game)
    expect(dest.candidateIds, '一个人不能同时装两把武器').not.toContain('p2')
  })

  it('移动装备触发装备离场时机：白银狮子让原主回血', () => {
    const game = gameWith(FIVE)
    const lion = findCard(game, (card) => card.name === '白银狮子')
    detach(game, lion)
    const source = playerOf(game, 'p1')
    source.zones.equipment.armor = lion
    source.hp = source.maxHp - 2

    setupMove(game)
    const pick = pending(game)
    game.respond({ requestId: pick.id, playerId: 'p0', payload: { cardIds: [lion] } })
    const dest = pending(game)
    game.respond({ requestId: dest.id, playerId: 'p0', payload: { targetIds: ['p2'] } })

    expect(source.hp, '白银狮子失去时回复一点体力').toBe(source.maxHp - 1)
    expect(playerOf(game, 'p2').zones.equipment.armor).toBe(lion)
  })

  it('移动延时锦囊：同名延时锦囊的角色不是合法落点', () => {
    const game = gameWith(FIVE)
    const lebuA = findCard(game, (card) => card.name === '乐不思蜀')
    const lebuB = findCard(game, (card) => card.name === '乐不思蜀' && card.id !== lebuA)
    detach(game, lebuA)
    detach(game, lebuB)
    playerOf(game, 'p1').zones.judgingArea.push(lebuA)
    playerOf(game, 'p2').zones.judgingArea.push(lebuB)

    setupMove(game)
    const pick = pending(game)
    expect(pick.cardIds).toContain(lebuA)
    game.respond({ requestId: pick.id, playerId: 'p0', payload: { cardIds: [lebuA] } })
    const dest = pending(game)
    expect(dest.candidateIds, '判定区里已经有同名延时锦囊').not.toContain('p2')
    game.respond({ requestId: dest.id, playerId: 'p0', payload: { targetIds: [dest.candidateIds[0]] } })
    expect(playerOf(game, 'p1').zones.judgingArea).not.toContain(lebuA)
    assertCardConservation(game.state)
  })

  it('移动兵粮寸断和闪电走同一条判定区合法性', () => {
    for (const name of ['兵粮寸断', '闪电']) {
      const game = gameWith(FIVE)
      const card = findCard(game, (candidate) => candidate.name === name)
      detach(game, card)
      playerOf(game, 'p1').zones.judgingArea.push(card)

      setupMove(game)
      const pick = pending(game)
      expect(pick.cardIds, `${name} 应该可以被移动`).toContain(card)
      game.respond({ requestId: pick.id, playerId: 'p0', payload: { cardIds: [card] } })
      const dest = pending(game)
      game.respond({ requestId: dest.id, playerId: 'p0', payload: { targetIds: ['p2'] } })
      expect(playerOf(game, 'p2').zones.judgingArea, `${name} 应该落在 p2 的判定区`).toContain(card)
      assertCardConservation(game.state)
    }
  })

  it('场上没有可移动的牌时跳过之后直接结束，不弹空窗口', () => {
    const game = gameWith(FIVE)
    setupMove(game)
    expectNoQiaobianFollowUp(game)
    expect(game.state.skippedPhases).toContain('play')
  })

  it('跳过出牌阶段之后不能再出牌', () => {
    const game = gameWith(FIVE)
    setupMove(game)
    expect(game.state.skippedPhases).toContain('play')
    expect(game.state.phase, '直接进了弃牌阶段').not.toBe('play')
  })
})

describe('弃牌阶段巧变', () => {
  it('跳过弃牌阶段：手牌超过上限也不弃', () => {
    const game = gameWith(FIVE)
    const owner = playerOf(game, 'p0')
    owner.hp = 1
    clearHand(game, 'p0')
    const spare = game.state.zones.drawPile.slice(0, 5)
    giveHand(game, 'p0', spare)

    advanceTo(game, 'p0', 'discard')
    invokeQiaobian(game, 'p0')

    expect(game.state.skippedPhases).toContain('discard')
    // 弃了 1 张代价，剩下 4 张，远超 1 点体力的上限却一张都没被弃
    expect(owner.zones.hand.length).toBe(4)
    expect(pending(game), '被跳过的弃牌阶段不该生成弃牌请求').toBeUndefined()
    assertCardConservation(game.state)
  })

  it('不发动时正常按手牌上限弃牌', () => {
    const game = gameWith(FIVE)
    const owner = playerOf(game, 'p0')
    owner.hp = 1
    clearHand(game, 'p0')
    giveHand(game, 'p0', game.state.zones.drawPile.slice(0, 5))

    advanceTo(game, 'p0', 'discard')
    const ask = pending(game)
    game.respond({ requestId: ask.id, playerId: 'p0', payload: { optionId: 'no' } })
    const discard = pending(game)
    expect(discard?.kind, '放弃巧变就要正常弃牌').toBe('choose-cards')
    expect(discard.min).toBe(4)
  })
})

describe('重连与序列化', () => {
  it('巧变窗口挂起时可以序列化恢复，恢复后接着问同一步', () => {
    const game = gameWith(FIVE)
    advanceTo(game, 'p0', 'draw')
    const ask = pending(game)
    game.respond({ requestId: ask.id, playerId: 'p0', payload: { optionId: 'yes' } })

    const restored = SanguoshaGame.restore(JSON.parse(JSON.stringify(game.serialize())))
    const cost = restored.state.pendingRequests[0]
    expect(cost?.kind, '恢复后仍停在弃牌代价这一步').toBe('choose-cards')
    expect(restored.state.phaseEntry?.phase, '阶段进入窗口本身也要能恢复').toBe('draw')

    restored.respond({ requestId: cost.id, playerId: 'p0', payload: { cardIds: [cost.cardIds[0]] } })
    expect(restored.state.skippedPhases).toContain('draw')
    assertCardConservation(restored.state)
  })

  it('偷第二个人时刷新，不会把第一个人重复偷一次', () => {
    const game = gameWith(FIVE)
    for (const id of ['p1', 'p2']) clearHand(game, id)
    const a = findCard(game, (card) => card.name === '杀')
    const b = findCard(game, (card) => card.name === '闪')
    giveHand(game, 'p1', [a])
    giveHand(game, 'p2', [b])

    advanceTo(game, 'p0', 'draw')
    invokeQiaobian(game, 'p0')
    const targets = pending(game)
    game.respond({ requestId: targets.id, playerId: 'p0', payload: { targetIds: ['p1', 'p2'] } })
    const first = pending(game)
    game.respond({ requestId: first.id, playerId: 'p0', payload: { cardIds: [first.hiddenCardSlots[0]] } })

    // 此时已经偷完 p1，停在 p2 的请求上
    const restored = SanguoshaGame.restore(JSON.parse(JSON.stringify(game.serialize())))
    const second = restored.state.pendingRequests[0]
    expect(second.kind).toBe('choose-cards')
    restored.respond({ requestId: second.id, playerId: 'p0', payload: { cardIds: [second.hiddenCardSlots[0]] } })

    expect(restored.state.players.find((p) => p.id === 'p0')!.zones.hand.filter((id) => id === a).length)
      .toBe(1)
    expect(restored.state.players.find((p) => p.id === 'p1')!.zones.hand.length, 'p1 只该被偷一张').toBe(0)
    assertCardConservation(restored.state)
  })
})
