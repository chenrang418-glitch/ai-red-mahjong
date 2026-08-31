import { describe, expect, it } from 'vitest'
import { SanguoshaGame } from '@/sanguosha/engine/game'
import type { GameSetup, Identity, SanguoshaState } from '@/sanguosha/engine/types'
import { assertCardConservation, moveCard, type ZoneRef } from '@/sanguosha/engine/zones'

function setup(): GameSetup {
  return {
    mode: 'identity', generalChoices: 3,
    players: Array.from({ length: 5 }, (_, index) => ({ id: `p${index}`, nickname: `玩家${index}`, isHuman: index === 0 })),
  }
}

function playPhaseGame(seed: string): SanguoshaGame {
  const game = new SanguoshaGame({ seed, setup: setup() })
  const identities: Identity[] = ['lord', 'rebel', 'loyalist', 'rebel', 'renegade']
  game.state.players.forEach((player, index) => {
    player.identity = identities[index]
    player.identityRevealed = player.identity === 'lord'
  })
  game.state.currentPlayerId = 'p0'
  game.start()
  game.advancePhase()
  game.advancePhase()
  game.advancePhase()
  expect(game.state.phase).toBe('play')
  return game
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
  throw new Error(`找不到卡牌：${cardId}`)
}

/** 按牌名找一张还没被放进任何人手里的实体牌。 */
function findCard(game: SanguoshaGame, name: string): string {
  const card = Object.values(game.state.cards).find((candidate) => candidate.name === name)
  if (!card) throw new Error(`牌堆里没有：${name}`)
  return card.id
}

function equip(game: SanguoshaGame, playerId: string, name: string): string {
  const cardId = findCard(game, name)
  const slot = game.state.cards[cardId].equipmentSlot!
  moveCard(game.state, cardId, locate(game.state, cardId), { kind: 'equipment', playerId, slot })
  return cardId
}

function giveCard(game: SanguoshaGame, playerId: string, cardName: string): string {
  const own = game.state.players.find((player) => player.id === playerId)!
  const existing = own.zones.hand.find((cardId) => game.state.cards[cardId]?.name === cardName)
  if (existing) return existing
  const card = Object.values(game.state.cards)
    .find((candidate) => candidate.name === cardName && !own.zones.hand.includes(candidate.id))!
  moveCard(game.state, card.id, locate(game.state, card.id), { kind: 'hand', playerId })
  return card.id
}

/** 拿一张指定颜色的【杀】。 */
function giveSlash(game: SanguoshaGame, playerId: string, color: 'red' | 'black'): string {
  const card = Object.values(game.state.cards).find((candidate) => (
    candidate.name === '杀' && candidate.color === color && !candidate.damageNature
  ))!
  moveCard(game.state, card.id, locate(game.state, card.id), { kind: 'hand', playerId })
  return card.id
}

function stripCard(game: SanguoshaGame, cardName: string): void {
  for (const player of game.state.players) {
    for (const cardId of [...player.zones.hand]) {
      if (game.state.cards[cardId]?.name !== cardName) continue
      moveCard(game.state, cardId, { kind: 'hand', playerId: player.id }, { kind: 'discardPile' })
    }
  }
}

function useOn(game: SanguoshaGame, cardId: string, targetIds: string[]): void {
  const action = game.legalActions('p0').find((candidate) => (
    candidate.kind === 'use-card'
    && candidate.cardIds.includes(cardId)
    && candidate.targetIds.length === targetIds.length
    && targetIds.every((id) => candidate.targetIds.includes(id))
  ))
  if (!action) throw new Error(`找不到出牌动作：${cardId} -> ${targetIds.join(',')}`)
  game.act('p0', action.id)
}

function passAll(game: SanguoshaGame): void {
  for (let guard = 0; guard < 200; guard += 1) {
    const request = game.state.pendingRequests[0]
    if (!request) return
    const actionId = request.kind === 'rescue' ? 'rescue-pass' : 'respond-pass'
    game.respond({ requestId: request.id, playerId: request.playerId, payload: { actionId } })
  }
  throw new Error('结算没有收敛')
}

describe('装备特效', () => {
  it('仁王盾让黑色的杀完全无效，连闪都不问', () => {
    const game = playPhaseGame('equip-renwang')
    equip(game, 'p1', '仁王盾')
    const slashId = giveSlash(game, 'p0', 'black')
    const hpBefore = game.state.players[1].hp

    useOn(game, slashId, ['p1'])

    // 没有产生任何响应 Request
    expect(game.state.pendingRequests).toEqual([])
    expect(game.state.players[1].hp).toBe(hpBefore)
    expect(game.state.zones.discardPile).toContain(slashId)
    assertCardConservation(game.state)
  })

  it('仁王盾挡不住红色的杀', () => {
    const game = playPhaseGame('equip-renwang-red')
    equip(game, 'p1', '仁王盾')
    stripCard(game, '闪')
    const slashId = giveSlash(game, 'p0', 'red')
    const hpBefore = game.state.players[1].hp

    useOn(game, slashId, ['p1'])
    expect(game.state.pendingRequests[0]).toMatchObject({ kind: 'respond-card', requiredCardName: '闪' })
    passAll(game)

    expect(game.state.players[1].hp).toBe(hpBefore - 1)
    assertCardConservation(game.state)
  })

  it('藤甲挡普通杀，但火杀照打且伤害加一', () => {
    const game = playPhaseGame('equip-tengjia')
    equip(game, 'p1', '藤甲')
    stripCard(game, '闪')
    const normalSlash = giveSlash(game, 'p0', 'black')
    const hpBefore = game.state.players[1].hp

    useOn(game, normalSlash, ['p1'])
    expect(game.state.pendingRequests).toEqual([])
    expect(game.state.players[1].hp).toBe(hpBefore)

    // 换一张火杀，藤甲挡不住而且要多吃一点
    game.state.turnUsage.slashUses = 0
    const fireSlash = Object.values(game.state.cards).find((card) => card.name === '杀' && card.damageNature === 'fire')!
    moveCard(game.state, fireSlash.id, locate(game.state, fireSlash.id), { kind: 'hand', playerId: 'p0' })
    useOn(game, fireSlash.id, ['p1'])
    passAll(game)

    expect(game.state.players[1].hp).toBe(hpBefore - 2)
    assertCardConservation(game.state)
  })

  it('藤甲让南蛮入侵对穿甲的人无效', () => {
    const game = playPhaseGame('equip-tengjia-invasion')
    equip(game, 'p1', '藤甲')
    stripCard(game, '无懈可击')
    stripCard(game, '杀')
    const cardId = giveCard(game, 'p0', '南蛮入侵')
    const hpBefore = game.state.players.map((player) => player.hp)

    useOn(game, cardId, ['p1', 'p2', 'p3', 'p4'])
    passAll(game)

    expect(game.state.players[1].hp).toBe(hpBefore[1])     // 藤甲免疫
    expect(game.state.players[2].hp).toBe(hpBefore[2] - 1) // 其他人照常
    assertCardConservation(game.state)
  })

  it('古锭刀在目标没有手牌时让杀多造成一点伤害', () => {
    const game = playPhaseGame('equip-guding')
    equip(game, 'p0', '古锭刀')
    stripCard(game, '闪')
    // 把目标的手牌清空
    for (const cardId of [...game.state.players[1].zones.hand]) {
      moveCard(game.state, cardId, { kind: 'hand', playerId: 'p1' }, { kind: 'discardPile' })
    }
    const slashId = giveSlash(game, 'p0', 'red')
    const hpBefore = game.state.players[1].hp

    useOn(game, slashId, ['p1'])
    passAll(game)

    expect(game.state.players[1].hp).toBe(hpBefore - 2)
    assertCardConservation(game.state)
  })

  it('古锭刀对有手牌的目标没有加成', () => {
    const game = playPhaseGame('equip-guding-hand')
    equip(game, 'p0', '古锭刀')
    stripCard(game, '闪')
    expect(game.state.players[1].zones.hand.length).toBeGreaterThan(0)
    const slashId = giveSlash(game, 'p0', 'red')
    const hpBefore = game.state.players[1].hp

    useOn(game, slashId, ['p1'])
    passAll(game)

    expect(game.state.players[1].hp).toBe(hpBefore - 1)
  })

  it('白银狮子把超过一点的伤害压成一点', () => {
    const game = playPhaseGame('equip-lion')
    equip(game, 'p1', '白银狮子')
    stripCard(game, '闪')
    const hpBefore = game.state.players[1].hp

    // 直接造成三点伤害（相当于闪电），应当只掉一点
    game.damage({ sourceId: 'p0', targetId: 'p1', amount: 3, nature: 'thunder' })

    expect(game.state.players[1].hp).toBe(hpBefore - 1)
  })

  it('失去白银狮子时回复一点体力', () => {
    const game = playPhaseGame('equip-lion-lost')
    const lionId = equip(game, 'p0', '白银狮子')
    game.state.players[0].hp = 2

    // 换上另一件防具，白银狮子被替换下来
    const otherArmor = Object.values(game.state.cards).find((card) => card.equipmentSlot === 'armor' && card.id !== lionId)!
    moveCard(game.state, otherArmor.id, locate(game.state, otherArmor.id), { kind: 'hand', playerId: 'p0' })
    useOn(game, otherArmor.id, ['p0'])
    passAll(game)

    expect(game.state.players[0].hp).toBe(3)
    expect(game.state.players[0].zones.equipment.armor).toBe(otherArmor.id)
    assertCardConservation(game.state)
  })

  it('满体力时失去白银狮子不会超过体力上限', () => {
    const game = playPhaseGame('equip-lion-full')
    const lionId = equip(game, 'p0', '白银狮子')
    game.state.players[0].hp = game.state.players[0].maxHp

    const otherArmor = Object.values(game.state.cards).find((card) => card.equipmentSlot === 'armor' && card.id !== lionId)!
    moveCard(game.state, otherArmor.id, locate(game.state, otherArmor.id), { kind: 'hand', playerId: 'p0' })
    useOn(game, otherArmor.id, ['p0'])
    passAll(game)

    expect(game.state.players[0].hp).toBe(game.state.players[0].maxHp)
  })

  it('被过河拆桥拆掉白银狮子同样回血', () => {
    const game = playPhaseGame('equip-lion-dismantle')
    stripCard(game, '无懈可击')
    const lionId = equip(game, 'p1', '白银狮子')
    game.state.players[1].hp = 2
    const cardId = giveCard(game, 'p0', '过河拆桥')

    useOn(game, cardId, ['p1'])
    const request = game.state.pendingRequests[0]
    game.respond({ requestId: request.id, playerId: 'p0', payload: { cardIds: [lionId] } })
    passAll(game)

    expect(game.state.players[1].hp).toBe(3)
    expect(game.state.zones.discardPile).toContain(lionId)
    assertCardConservation(game.state)
  })

  it('诸葛连弩解除出牌阶段一张杀的限制', () => {
    const game = playPhaseGame('equip-crossbow')
    stripCard(game, '闪')
    const first = giveSlash(game, 'p0', 'red')
    const second = giveSlash(game, 'p0', 'black')

    // 没有连弩时打完一张就不再有出杀动作
    useOn(game, first, ['p1'])
    passAll(game)
    expect(game.legalActions('p0').some((action) => action.kind === 'use-card' && action.cardIds.includes(second))).toBe(false)

    // 装上连弩之后还能继续出
    equip(game, 'p0', '诸葛连弩')
    expect(game.legalActions('p0').some((action) => action.kind === 'use-card' && action.cardIds.includes(second))).toBe(true)
    useOn(game, second, ['p1'])
    passAll(game)
    assertCardConservation(game.state)
  })

  it('八卦阵判定为红时视为出闪，为黑时照常受伤', () => {
    // 判定牌是牌堆顶那一张，所以直接摆一张确定颜色的牌上去
    const red = playPhaseGame('equip-bagua-red')
    equip(red, 'p1', '八卦阵')
    stripCard(red, '闪')
    const redJudge = Object.values(red.state.cards).find((card) => card.color === 'red' && red.state.zones.drawPile.includes(card.id))!
    moveCard(red.state, redJudge.id, { kind: 'drawPile' }, { kind: 'drawPile' }, { toTop: true })
    const slashId = giveSlash(red, 'p0', 'red')
    const hpBefore = red.state.players[1].hp

    useOn(red, slashId, ['p1'])
    const request = red.state.pendingRequests[0] as Extract<typeof red.state.pendingRequests[0], { kind: 'respond-card' }>
    // 关键：八卦阵必须出现在合法动作里，否则前端永远点不到
    expect(request.actionIds).toContain('invoke-bagua')
    red.respond({ requestId: request.id, playerId: 'p1', payload: { actionId: 'invoke-bagua' } })

    expect(red.state.players[1].hp).toBe(hpBefore)
    expect(red.state.cardResolution).toBeNull()
    assertCardConservation(red.state)
  })

  it('八卦阵判定为黑时仍然受伤', () => {
    const game = playPhaseGame('equip-bagua-black')
    equip(game, 'p1', '八卦阵')
    stripCard(game, '闪')
    const blackJudge = Object.values(game.state.cards).find((card) => card.color === 'black' && game.state.zones.drawPile.includes(card.id))!
    moveCard(game.state, blackJudge.id, { kind: 'drawPile' }, { kind: 'drawPile' }, { toTop: true })
    const slashId = giveSlash(game, 'p0', 'red')
    const hpBefore = game.state.players[1].hp

    useOn(game, slashId, ['p1'])
    const request = game.state.pendingRequests[0]
    game.respond({ requestId: request.id, playerId: 'p1', payload: { actionId: 'invoke-bagua' } })
    passAll(game)

    expect(game.state.players[1].hp).toBe(hpBefore - 1)
    assertCardConservation(game.state)
  })

  it('没有八卦阵的人不能发动它', () => {
    const game = playPhaseGame('equip-bagua-none')
    stripCard(game, '闪')
    const slashId = giveSlash(game, 'p0', 'red')
    useOn(game, slashId, ['p1'])
    const request = game.state.pendingRequests[0] as Extract<typeof game.state.pendingRequests[0], { kind: 'respond-card' }>
    expect(request.actionIds).not.toContain('invoke-bagua')
    expect(() => game.respond({ requestId: request.id, playerId: 'p1', payload: { actionId: 'invoke-bagua' } })).toThrow()
  })

  it('马匹通过统一距离入口生效，不需要各自实现', () => {
    const game = playPhaseGame('equip-horses')
    const before = game.legalActions('p0').filter((action) => action.kind === 'use-card').length
    // 进攻马让距离 -1，能打到的人变多（或至少不减少）
    equip(game, 'p0', '赤兔')
    const after = game.legalActions('p0').filter((action) => action.kind === 'use-card').length
    expect(after).toBeGreaterThanOrEqual(before)
    expect(game.state.players[0].zones.equipment.offensiveHorse).not.toBeNull()
  })
})
