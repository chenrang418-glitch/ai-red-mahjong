import { describe, expect, it } from 'vitest'
import { SanguoshaGame } from '@/sanguosha/engine/game'
import type { GameSetup, Identity, SanguoshaState } from '@/sanguosha/engine/types'
import { assertCardConservation, moveCard, type ZoneRef } from '@/sanguosha/engine/zones'
import { assertGameInvariants } from '@/sanguosha/engine/invariants'

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

function giveCard(game: SanguoshaGame, playerId: string, cardName: string): string {
  const own = game.state.players.find((player) => player.id === playerId)!
  const existing = own.zones.hand.find((cardId) => game.state.cards[cardId]?.name === cardName)
  if (existing) return existing
  const card = Object.values(game.state.cards)
    .find((candidate) => candidate.name === cardName && !own.zones.hand.includes(candidate.id))!
  moveCard(game.state, card.id, locate(game.state, card.id), { kind: 'hand', playerId })
  return card.id
}

/** 把所有人手上的某种牌收走，方便构造「没人能响应」的确定局面。 */
function stripCard(game: SanguoshaGame, cardName: string, except: string[] = []): void {
  for (const player of game.state.players) {
    for (const cardId of [...player.zones.hand]) {
      if (game.state.cards[cardId]?.name !== cardName || except.includes(cardId)) continue
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

function respond(game: SanguoshaGame, actionId: string): void {
  const request = game.state.pendingRequests[0]
  if (!request) throw new Error('当前没有待处理 Request')
  game.respond({ requestId: request.id, playerId: request.playerId, payload: { actionId } })
}

/** 一路放弃，直到这张牌结算完。 */
function passAll(game: SanguoshaGame): void {
  for (let guard = 0; guard < 200; guard += 1) {
    const request = game.state.pendingRequests[0]
    if (!request) return
    if (request.kind === 'rescue') {
      game.respond({ requestId: request.id, playerId: request.playerId, payload: { actionId: 'rescue-pass' } })
      continue
    }
    game.respond({ requestId: request.id, playerId: request.playerId, payload: { actionId: 'respond-pass' } })
  }
  throw new Error('结算没有收敛')
}

describe('即时锦囊', () => {
  it('桃园结义让所有存活角色各回复一点，满体力的人不变', () => {
    const game = playPhaseGame('tricks-peach-garden')
    stripCard(game, '无懈可击')
    const cardId = giveCard(game, 'p0', '桃园结义')
    game.state.players[0].hp = 2
    game.state.players[1].hp = 3
    game.state.players[2].hp = 4 // 满体力
    game.state.players[3].alive = false
    game.state.players[4].hp = 1

    useOn(game, cardId, game.state.players.filter((p) => p.alive).map((p) => p.id))
    passAll(game)

    expect(game.state.players[0].hp).toBe(3)
    expect(game.state.players[1].hp).toBe(4)
    expect(game.state.players[2].hp).toBe(4)
    expect(game.state.players[4].hp).toBe(2)
    expect(game.state.zones.discardPile).toContain(cardId)
    assertCardConservation(game.state)
  })

  it('铁索连环可以横置两名角色，再次使用会重置', () => {
    const game = playPhaseGame('tricks-chain')
    stripCard(game, '无懈可击')
    const first = giveCard(game, 'p0', '铁索连环')
    useOn(game, first, ['p1', 'p2'])
    passAll(game)
    expect(game.state.players[1].chained).toBe(true)
    expect(game.state.players[2].chained).toBe(true)

    const second = giveCard(game, 'p0', '铁索连环')
    useOn(game, second, ['p1'])
    passAll(game)
    expect(game.state.players[1].chained).toBe(false)
    expect(game.state.players[2].chained).toBe(true)
    assertCardConservation(game.state)
  })

  it('南蛮入侵要求每名其他角色打出杀，出不了的掉一点体力', () => {
    const game = playPhaseGame('tricks-invasion')
    stripCard(game, '无懈可击')
    stripCard(game, '杀')
    const cardId = giveCard(game, 'p0', '南蛮入侵')
    const p1Slash = giveCard(game, 'p1', '杀')
    const hpBefore = game.state.players.map((player) => player.hp)

    useOn(game, cardId, ['p1', 'p2', 'p3', 'p4'])
    // p1 打出杀免伤，其余三家放弃
    respond(game, `respond-trick:${p1Slash}`)
    passAll(game)

    expect(game.state.players[1].hp).toBe(hpBefore[1])
    expect(game.state.players[2].hp).toBe(hpBefore[2] - 1)
    expect(game.state.players[3].hp).toBe(hpBefore[3] - 1)
    expect(game.state.players[4].hp).toBe(hpBefore[4] - 1)
    expect(game.state.players[0].hp).toBe(hpBefore[0])
    expect(game.state.zones.discardPile).toEqual(expect.arrayContaining([cardId, p1Slash]))
    assertCardConservation(game.state)
  })

  it('万箭齐发要求打出闪，且只对没出闪的人造成伤害', () => {
    const game = playPhaseGame('tricks-arrows')
    stripCard(game, '无懈可击')
    stripCard(game, '闪')
    const cardId = giveCard(game, 'p0', '万箭齐发')
    const p2Dodge = giveCard(game, 'p2', '闪')
    const hpBefore = game.state.players.map((player) => player.hp)

    useOn(game, cardId, ['p1', 'p2', 'p3', 'p4'])
    respond(game, 'respond-pass')              // p1 不闪
    respond(game, `respond-trick:${p2Dodge}`)  // p2 出闪
    passAll(game)

    expect(game.state.players[1].hp).toBe(hpBefore[1] - 1)
    expect(game.state.players[2].hp).toBe(hpBefore[2])
    expect(game.state.players[3].hp).toBe(hpBefore[3] - 1)
    assertCardConservation(game.state)
  })

  it('单个目标被无懈掉时，其他目标照样要响应', () => {
    const game = playPhaseGame('tricks-partial-nullify')
    stripCard(game, '无懈可击')
    stripCard(game, '闪')
    const cardId = giveCard(game, 'p0', '万箭齐发')
    const wuxie = giveCard(game, 'p1', '无懈可击')
    const hpBefore = game.state.players.map((player) => player.hp)

    useOn(game, cardId, ['p1', 'p2', 'p3', 'p4'])
    // 第一个目标 p1 的效果被 p1 自己无懈掉
    respond(game, `respond-nullification:${wuxie}`)
    passAll(game)

    expect(game.state.players[1].hp).toBe(hpBefore[1])       // 被无懈，不受伤
    expect(game.state.players[2].hp).toBe(hpBefore[2] - 1)   // 其他目标照常结算
    expect(game.state.players[3].hp).toBe(hpBefore[3] - 1)
    expect(game.state.players[4].hp).toBe(hpBefore[4] - 1)
    assertCardConservation(game.state)
  })

  it('决斗轮流出杀，先出不出来的一方受伤', () => {
    const game = playPhaseGame('tricks-duel')
    stripCard(game, '无懈可击')
    stripCard(game, '杀')
    const cardId = giveCard(game, 'p0', '决斗')
    const targetSlash = giveCard(game, 'p1', '杀')
    const hpBefore = game.state.players.map((player) => player.hp)

    useOn(game, cardId, ['p1'])
    // 目标先出杀，轮到使用者；使用者手上没杀只能放弃，于是使用者受伤
    respond(game, `respond-trick:${targetSlash}`)
    passAll(game)

    expect(game.state.players[0].hp).toBe(hpBefore[0] - 1)
    expect(game.state.players[1].hp).toBe(hpBefore[1])
    assertCardConservation(game.state)
  })

  it('决斗中目标直接放弃时由目标受伤', () => {
    const game = playPhaseGame('tricks-duel-instant')
    stripCard(game, '无懈可击')
    stripCard(game, '杀')
    const cardId = giveCard(game, 'p0', '决斗')
    const hpBefore = game.state.players.map((player) => player.hp)

    useOn(game, cardId, ['p1'])
    passAll(game)

    expect(game.state.players[1].hp).toBe(hpBefore[1] - 1)
    expect(game.state.players[0].hp).toBe(hpBefore[0])
    assertCardConservation(game.state)
  })

  it('过河拆桥可以弃掉目标的装备，且不受距离限制', () => {
    const game = playPhaseGame('tricks-dismantle')
    stripCard(game, '无懈可击')
    const cardId = giveCard(game, 'p0', '过河拆桥')
    const armorId = Object.values(game.state.cards).find((card) => card.equipmentSlot === 'armor')!.id
    moveCard(game.state, armorId, locate(game.state, armorId), { kind: 'equipment', playerId: 'p2', slot: 'armor' })

    useOn(game, cardId, ['p2'])
    const request = game.state.pendingRequests[0]
    expect(request).toMatchObject({ kind: 'choose-cards', playerId: 'p0', purpose: 'card-effect' })
    game.respond({ requestId: request.id, playerId: 'p0', payload: { cardIds: [armorId] } })
    passAll(game)

    expect(game.state.players[2].zones.equipment.armor).toBeNull()
    expect(game.state.zones.discardPile).toContain(armorId)
    assertCardConservation(game.state)
  })

  it('顺手牵羊把目标的牌拿进自己手牌，且手牌只以暗槽形式提供', () => {
    const game = playPhaseGame('tricks-snatch')
    stripCard(game, '无懈可击')
    const cardId = giveCard(game, 'p0', '顺手牵羊')
    // 顺手牵羊受距离限制，把 p1 拉到距离 1 之内（相邻座次本来就是 1）
    const victimHandBefore = [...game.state.players[1].zones.hand]
    const ownHandBefore = game.state.players[0].zones.hand.length

    useOn(game, cardId, ['p1'])
    const request = game.state.pendingRequests[0]
    expect(request).toMatchObject({ kind: 'choose-cards', playerId: 'p0' })
    const chooseRequest = request as Extract<typeof request, { kind: 'choose-cards' }>
    // 关键：目标手牌只能以不含牌面信息的暗槽出现，真实 cardId 不能出现在 Request 里
    expect(chooseRequest.hiddenCardSlots.length).toBe(victimHandBefore.length)
    for (const realId of victimHandBefore) {
      expect(chooseRequest.cardIds).not.toContain(realId)
      expect(JSON.stringify(chooseRequest)).not.toContain(realId)
    }

    game.respond({ requestId: request.id, playerId: 'p0', payload: { cardIds: [chooseRequest.hiddenCardSlots[0]] } })
    passAll(game)

    expect(game.state.players[0].zones.hand.length).toBe(ownHandBefore - 1 + 1) // 打出锦囊 -1，拿到一张 +1
    expect(game.state.players[1].zones.hand.length).toBe(victimHandBefore.length - 1)
    assertCardConservation(game.state)
    expect(() => assertGameInvariants(game.state)).not.toThrow()
  })

  it('南蛮入侵造成濒死时暂停，救援结束后继续结算剩余目标', () => {
    const game = playPhaseGame('tricks-invasion-dying')
    stripCard(game, '无懈可击')
    stripCard(game, '杀')
    stripCard(game, '桃')
    const cardId = giveCard(game, 'p0', '南蛮入侵')
    game.state.players[1].hp = 1
    const hpBefore = game.state.players.map((player) => player.hp)

    useOn(game, cardId, ['p1', 'p2', 'p3', 'p4'])
    respond(game, 'respond-pass') // p1 不出杀 → 掉到 0 进入濒死
    expect(game.state.dying).not.toBeNull()
    // 濒死状态必须可序列化，Durable Object 休眠后要能恢复
    expect(() => structuredClone(game.state)).not.toThrow()
    passAll(game)

    expect(game.state.players[1].alive).toBe(false)
    // 救援结束后剩下的目标照样结算
    expect(game.state.players[2].hp).toBe(hpBefore[2] - 1)
    expect(game.state.players[3].hp).toBe(hpBefore[3] - 1)
    expect(game.state.players[4].hp).toBe(hpBefore[4] - 1)
    expect(game.state.cardResolution).toBeNull()
    assertCardConservation(game.state)
  })

  it('五谷丰登亮出等量的牌，每名存活角色依次拿走一张', () => {
    const game = playPhaseGame('tricks-harvest')
    stripCard(game, '无懈可击')
    const cardId = giveCard(game, 'p0', '五谷丰登')
    game.state.players[4].alive = false
    const aliveIds = game.state.players.filter((p) => p.alive).map((p) => p.id)
    const handBefore = Object.fromEntries(game.state.players.map((p) => [p.id, p.zones.hand.length]))

    useOn(game, cardId, aliveIds)
    let revealedCount = 0
    for (let guard = 0; guard < 20; guard += 1) {
      const request = game.state.pendingRequests[0]
      if (!request || request.kind !== 'choose-cards') break
      const choose = request as Extract<typeof request, { kind: 'choose-cards' }>
      revealedCount = Math.max(revealedCount, choose.cardIds.length)
      game.respond({ requestId: request.id, playerId: request.playerId, payload: { cardIds: [choose.cardIds[0]] } })
    }
    passAll(game)

    // 亮出的张数等于存活人数
    expect(revealedCount).toBe(aliveIds.length)
    // 使用者打出了五谷（-1）又拿到一张（+1）
    expect(game.state.players[0].zones.hand.length).toBe(handBefore.p0)
    expect(game.state.players[1].zones.hand.length).toBe(handBefore.p1 + 1)
    expect(game.state.players[2].zones.hand.length).toBe(handBefore.p2 + 1)
    expect(game.state.zones.processingArea).toEqual([])
    assertCardConservation(game.state)
  })

  it('火攻展示手牌后弃同花色牌造成火焰伤害', () => {
    const game = playPhaseGame('tricks-fire')
    stripCard(game, '无懈可击')
    const cardId = giveCard(game, 'p0', '火攻')
    // 给目标一张确定花色的手牌，给使用者一张同花色的牌
    const victimCard = Object.values(game.state.cards).find((c) => c.suit === 'heart' && c.name === '桃')!
    moveCard(game.state, victimCard.id, locate(game.state, victimCard.id), { kind: 'hand', playerId: 'p1' })
    for (const held of [...game.state.players[1].zones.hand]) {
      if (held !== victimCard.id) moveCard(game.state, held, { kind: 'hand', playerId: 'p1' }, { kind: 'discardPile' })
    }
    const payCard = Object.values(game.state.cards).find((c) => c.suit === 'heart' && c.id !== victimCard.id && !game.state.players[1].zones.hand.includes(c.id))!
    moveCard(game.state, payCard.id, locate(game.state, payCard.id), { kind: 'hand', playerId: 'p0' })
    const hpBefore = game.state.players[1].hp

    useOn(game, cardId, ['p1'])
    // 第一步：目标展示手牌
    const reveal = game.state.pendingRequests[0]
    expect(reveal).toMatchObject({ kind: 'choose-cards', playerId: 'p1' })
    game.respond({ requestId: reveal.id, playerId: 'p1', payload: { cardIds: [victimCard.id] } })
    // 第二步：使用者弃同花色牌
    const pay = game.state.pendingRequests[0]
    expect(pay).toMatchObject({ kind: 'choose-cards', playerId: 'p0' })
    game.respond({ requestId: pay.id, playerId: 'p0', payload: { cardIds: [payCard.id] } })
    passAll(game)

    expect(game.state.players[1].hp).toBe(hpBefore - 1)
    expect(game.state.zones.discardPile).toContain(payCard.id)
    // 展示的牌仍留在目标手里
    expect(game.state.players[1].zones.hand).toContain(victimCard.id)
    assertCardConservation(game.state)
  })

  it('火攻中使用者放弃弃牌则不造成伤害', () => {
    const game = playPhaseGame('tricks-fire-decline')
    stripCard(game, '无懈可击')
    const cardId = giveCard(game, 'p0', '火攻')
    const hpBefore = game.state.players[1].hp

    useOn(game, cardId, ['p1'])
    const reveal = game.state.pendingRequests[0]
    const revealChoose = reveal as Extract<typeof reveal, { kind: 'choose-cards' }>
    game.respond({ requestId: reveal.id, playerId: 'p1', payload: { cardIds: [revealChoose.cardIds[0]] } })
    const pay = game.state.pendingRequests[0]
    if (pay) game.respond({ requestId: pay.id, playerId: pay.playerId, payload: { cardIds: [] } })
    passAll(game)

    expect(game.state.players[1].hp).toBe(hpBefore)
    assertCardConservation(game.state)
  })

  it('借刀杀人：目标不出杀就把武器交给使用者', () => {
    const game = playPhaseGame('tricks-knife-decline')
    stripCard(game, '无懈可击')
    stripCard(game, '杀')
    const cardId = giveCard(game, 'p0', '借刀杀人')
    const weapon = Object.values(game.state.cards).find((c) => c.equipmentSlot === 'weapon')!
    moveCard(game.state, weapon.id, locate(game.state, weapon.id), { kind: 'equipment', playerId: 'p1', slot: 'weapon' })

    useOn(game, cardId, ['p1'])
    // 先选受害者
    const pick = game.state.pendingRequests[0]
    expect(pick).toMatchObject({ kind: 'choose-targets', playerId: 'p1' })
    const pickTargets = pick as Extract<typeof pick, { kind: 'choose-targets' }>
    game.respond({ requestId: pick.id, playerId: 'p1', payload: { targetIds: [pickTargets.candidateIds[0]] } })
    // 目标手上没杀，只能放弃
    passAll(game)

    expect(game.state.players[1].zones.equipment.weapon).toBeNull()
    expect(game.state.players[0].zones.hand).toContain(weapon.id)
    assertCardConservation(game.state)
  })

  it('借刀杀人：目标出杀后由受害者响应闪', () => {
    const game = playPhaseGame('tricks-knife-slash')
    stripCard(game, '无懈可击')
    stripCard(game, '杀')
    stripCard(game, '闪')
    const cardId = giveCard(game, 'p0', '借刀杀人')
    const weapon = Object.values(game.state.cards).find((c) => c.equipmentSlot === 'weapon')!
    moveCard(game.state, weapon.id, locate(game.state, weapon.id), { kind: 'equipment', playerId: 'p1', slot: 'weapon' })
    const knifeSlash = giveCard(game, 'p1', '杀')

    useOn(game, cardId, ['p1'])
    const pick = game.state.pendingRequests[0]
    const pickTargets = pick as Extract<typeof pick, { kind: 'choose-targets' }>
    const victimId = pickTargets.candidateIds[0]
    const victimHpBefore = game.state.players.find((p) => p.id === victimId)!.hp
    game.respond({ requestId: pick.id, playerId: 'p1', payload: { targetIds: [victimId] } })
    // 目标打出杀
    respond(game, `respond-trick:${knifeSlash}`)
    // 受害者手上没闪
    passAll(game)

    expect(game.state.players.find((p) => p.id === victimId)!.hp).toBe(victimHpBefore - 1)
    // 出了杀就不用交武器
    expect(game.state.players[1].zones.equipment.weapon).toBe(weapon.id)
    assertCardConservation(game.state)
  })

  it('拒绝伪造的效果响应和已经过期的 Request', () => {
    const game = playPhaseGame('tricks-invalid')
    stripCard(game, '无懈可击')
    stripCard(game, '杀')
    const cardId = giveCard(game, 'p0', '决斗')
    useOn(game, cardId, ['p1'])
    const request = game.state.pendingRequests[0]

    // 换个人来响应
    expect(() => game.respond({ requestId: request.id, playerId: 'p2', payload: { actionId: 'respond-pass' } })).toThrow()
    // 伪造 actionId
    expect(() => game.respond({ requestId: request.id, playerId: request.playerId, payload: { actionId: 'respond-trick:not-a-card' } })).toThrow()
    // 正常响应之后再用同一个 requestId 重放
    game.respond({ requestId: request.id, playerId: request.playerId, payload: { actionId: 'respond-pass' } })
    expect(() => game.respond({ requestId: request.id, playerId: request.playerId, payload: { actionId: 'respond-pass' } })).toThrow()
    assertCardConservation(game.state)
  })
})
