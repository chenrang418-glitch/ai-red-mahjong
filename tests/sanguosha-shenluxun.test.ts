import { describe, expect, it } from 'vitest'
import { SanguoshaGame } from '@/sanguosha/engine/game'
import { assertGameInvariants } from '@/sanguosha/engine/invariants'
import { assertCardConservation, moveCard } from '@/sanguosha/engine/zones'
import { setChained } from '@/sanguosha/engine/character-state'
import { JUNLUE_MARK, junlueOf } from '@/sanguosha/data/characters/god-shenluxun'
import type { CardId, GameSetup, Identity, PlayerId } from '@/sanguosha/engine/types'

/**
 * 神陆逊。**三国杀移动版当前官方技能页现行版本**。
 *
 * 四条最容易写错的：
 *
 * 1. **0 是偶数**，军略为 0 时可以发动偶数分支。
 * 2. 奇数分支的目标「一名角色」**包含自己**。
 * 3. **「大于 7」要在奇偶效果结算完之后重新检查**：7 → 打一下 → 军略变 8 → 才够大摧克。
 * 4. 绽火**先全部弃装备，再选其中一名造成火伤**——藤甲此时已经不在了。
 */

function gameWith(characterIds: string[], seed = 'shenluxun'): SanguoshaGame {
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
  drain(game)
  return game
}

function answer(game: SanguoshaGame, request: { kind: string; id: string; playerId: string }): void {
  const ids = (request as unknown as { actionIds?: string[] }).actionIds ?? []
  const payload = request.kind === 'choose-cards'
    ? { cardIds: [] }
    : request.kind === 'choose-targets'
      ? { targetIds: [] }
      : ids.length
        ? { actionId: ids.includes('rescue-pass') ? 'rescue-pass' : 'respond-pass' }
        : { optionId: 'no' }
  game.respond({ requestId: request.id, playerId: request.playerId, payload })
}

function drain(game: SanguoshaGame, limit = 40): void {
  let guard = 0
  while (game.state.pendingRequests.length > 0 && guard < limit) {
    answer(game, game.state.pendingRequests[0] as never)
    guard += 1
  }
}

function playerOf(game: SanguoshaGame, playerId: PlayerId) {
  return game.state.players.find((player) => player.id === playerId)!
}

function pending(game: SanguoshaGame) {
  return game.state.pendingRequests[0]
}

function settle(game: SanguoshaGame): void {
  ;(game as unknown as { settle(): void }).settle()
}

function detach(game: SanguoshaGame, cardId: CardId): void {
  const state = game.state
  state.zones.drawPile = state.zones.drawPile.filter((id) => id !== cardId)
  state.zones.discardPile = state.zones.discardPile.filter((id) => id !== cardId)
  state.zones.processingArea = state.zones.processingArea.filter((id) => id !== cardId)
  for (const player of state.players) {
    player.zones.hand = player.zones.hand.filter((id) => id !== cardId)
    player.zones.judgingArea = player.zones.judgingArea.filter((id) => id !== cardId)
    for (const [slot, equipped] of Object.entries(player.zones.equipment)) {
      if (equipped === cardId) player.zones.equipment[slot as keyof typeof player.zones.equipment] = null
    }
  }
}

function clearHand(game: SanguoshaGame, playerId: PlayerId): void {
  for (const cardId of [...playerOf(game, playerId).zones.hand]) {
    moveCard(game.state, cardId, { kind: 'hand', playerId }, { kind: 'discardPile' })
  }
}

function giveHand(game: SanguoshaGame, playerId: PlayerId, cardIds: CardId[]): void {
  for (const cardId of cardIds) {
    detach(game, cardId)
    playerOf(game, playerId).zones.hand.push(cardId)
  }
}

function findCard(game: SanguoshaGame, match: (card: { name: string; equipmentSlot?: string; id: string }) => boolean): CardId {
  const card = Object.values(game.state.cards).find((candidate) => match(candidate as never))
  if (!card) throw new Error('找不到符合条件的牌')
  return card.id
}

/** 进入 p0 的出牌阶段（触发摧克）。 */
function enterPlayPhase(game: SanguoshaGame): void {
  game.state.currentPlayerId = 'p0'
  game.state.normalTurnPlayerId = 'p0'
  game.state.currentTurnKind = 'normal'
  game.state.phase = 'draw'
  game.state.skippedPhases = []
  game.state.judgedDelayedCards = []
  game.state.pendingRequests = []
  game.advancePhase()
}

function damageAndSettle(game: SanguoshaGame, options: { sourceId: PlayerId | null; targetId: PlayerId; amount: number }): void {
  game.damage({ ...options, cardName: null })
  settle(game)
}

const FIVE = ['shenluxun', 'zhangfei', 'zhangfei', 'zhangfei', 'zhangfei']

describe('军略', () => {
  it('造成 1 点得 1 枚，造成 3 点得 3 枚', () => {
    const game = gameWith(FIVE)
    playerOf(game, 'p1').hp = 9
    playerOf(game, 'p1').maxHp = 9
    damageAndSettle(game, { sourceId: 'p0', targetId: 'p1', amount: 1 })
    expect(junlueOf(game.state, 'p0')).toBe(1)
    damageAndSettle(game, { sourceId: 'p0', targetId: 'p1', amount: 3 })
    expect(junlueOf(game.state, 'p0'), '按点数').toBe(4)
  })

  it('受到 2 点得 2 枚', () => {
    const game = gameWith(FIVE)
    playerOf(game, 'p0').hp = 9
    playerOf(game, 'p0').maxHp = 9
    damageAndSettle(game, { sourceId: 'p1', targetId: 'p0', amount: 2 })
    expect(junlueOf(game.state, 'p0')).toBe(2)
  })

  it('军略进序列化，重连不丢', () => {
    const game = gameWith(FIVE)
    playerOf(game, 'p0').marks[JUNLUE_MARK] = 6
    const restored = SanguoshaGame.restore(JSON.parse(JSON.stringify(game.serialize())))
    expect(junlueOf(restored.state, 'p0')).toBe(6)
  })
})

describe('摧克：奇偶分支', () => {
  it('军略 0 视为偶数，照样能发动', () => {
    const game = gameWith(FIVE)
    playerOf(game, 'p0').marks[JUNLUE_MARK] = 0
    enterPlayPhase(game)
    const request = pending(game)
    expect(String(request?.prompt), '0 是偶数').toContain('偶数')
  })

  it('奇数：对一名角色造成 1 点伤害，目标包含自己', () => {
    const game = gameWith(FIVE)
    playerOf(game, 'p0').marks[JUNLUE_MARK] = 1
    playerOf(game, 'p1').hp = 4
    playerOf(game, 'p1').maxHp = 4
    enterPlayPhase(game)
    const request = pending(game)
    expect(String(request?.prompt)).toContain('奇数')
    expect((request as unknown as { candidateIds: string[] }).candidateIds, '候选里有自己').toContain('p0')

    game.respond({ requestId: request.id, playerId: 'p0', payload: { targetIds: ['p1'] } })
    drain(game)
    expect(playerOf(game, 'p1').hp, '造成 1 点伤害').toBe(3)
  })

  it('偶数：令目标进入连环并弃其区域里一张牌，不是切换', () => {
    const game = gameWith(FIVE)
    playerOf(game, 'p0').marks[JUNLUE_MARK] = 2
    setChained(game as never, 'p1', 'setup', true)
    clearHand(game, 'p1')
    giveHand(game, 'p1', [findCard(game, (card) => card.name === '杀')])
    enterPlayPhase(game)

    const request = pending(game)
    expect(String(request?.prompt)).toContain('偶数')
    game.respond({ requestId: request.id, playerId: 'p0', payload: { targetIds: ['p1'] } })

    expect(playerOf(game, 'p1').chained, '已连环的不会被解除').toBe(true)
    const discard = pending(game)
    expect(String(discard?.prompt)).toContain('弃置')
    const pool = [...(discard as unknown as { cardIds: string[] }).cardIds,
      ...(discard as unknown as { hiddenCardSlots: string[] }).hiddenCardSlots]
    game.respond({ requestId: discard.id, playerId: 'p0', payload: { cardIds: [pool[0]] } })
    expect(playerOf(game, 'p1').zones.hand, '牌被弃掉').toHaveLength(0)
    assertCardConservation(game.state)
  })

  it('目标没有牌时，进入连环照样完成，弃置部分跳过', () => {
    const game = gameWith(FIVE)
    playerOf(game, 'p0').marks[JUNLUE_MARK] = 2
    clearHand(game, 'p1')
    setChained(game as never, 'p1', 'setup', false)
    enterPlayPhase(game)
    game.respond({ requestId: pending(game).id, playerId: 'p0', payload: { targetIds: ['p1'] } })
    expect(playerOf(game, 'p1').chained, '照样进入连环').toBe(true)
  })

  it('出牌阶段被真正跳过时不触发', () => {
    const game = gameWith(FIVE)
    playerOf(game, 'p0').marks[JUNLUE_MARK] = 3
    game.state.currentPlayerId = 'p0'
    game.state.normalTurnPlayerId = 'p0'
    game.state.currentTurnKind = 'normal'
    game.state.phase = 'draw'
    game.state.skippedPhases = ['play']
    game.state.judgedDelayedCards = []
    game.state.pendingRequests = []
    game.advancePhase()
    const request = pending(game)
    expect(request && String(request.prompt).includes('摧克'), '不该问').toBeFalsy()
  })
})

describe('摧克：大于 7 要重新检查', () => {
  it('军略 7 → 奇数分支打一下变 8 → 这时才够大摧克', () => {
    const game = gameWith(FIVE)
    playerOf(game, 'p0').marks[JUNLUE_MARK] = 7
    for (const playerId of ['p1', 'p2', 'p3', 'p4'] as const) {
      playerOf(game, playerId).hp = 5
      playerOf(game, playerId).maxHp = 5
    }
    enterPlayPhase(game)

    const odd = pending(game)
    expect(String(odd?.prompt), '7 是奇数').toContain('奇数')
    game.respond({ requestId: odd.id, playerId: 'p0', payload: { targetIds: ['p1'] } })
    // 这 1 点伤害是神陆逊造成的，军略 +1 → 8
    expect(junlueOf(game.state, 'p0'), '伤害本身让军略变 8').toBe(8)

    const big = pending(game)
    expect(String(big?.prompt), '重新检查之后够得上大摧克').toContain('大于 7')
  })

  it('军略 7 且放弃奇数分支时，不够大摧克', () => {
    const game = gameWith(FIVE)
    playerOf(game, 'p0').marks[JUNLUE_MARK] = 7
    enterPlayPhase(game)
    game.respond({ requestId: pending(game).id, playerId: 'p0', payload: { targetIds: [] } })
    const next = pending(game)
    expect(next && String(next.prompt).includes('大于 7'), '还是 7，够不上').toBeFalsy()
  })

  it('初始就是 8：偶数分支和大摧克是同一技能内两段独立结算', () => {
    const game = gameWith(FIVE)
    playerOf(game, 'p0').marks[JUNLUE_MARK] = 8
    clearHand(game, 'p1')
    enterPlayPhase(game)

    const even = pending(game)
    expect(String(even?.prompt), '8 是偶数').toContain('偶数')
    game.respond({ requestId: even.id, playerId: 'p0', payload: { targetIds: ['p1'] } })

    const big = pending(game)
    expect(String(big?.prompt), '偶数之后还能再来大摧克').toContain('大于 7')
  })

  it('大摧克移去全部军略，之后的伤害产生新军略', () => {
    const game = gameWith(FIVE)
    playerOf(game, 'p0').marks[JUNLUE_MARK] = 8
    for (const playerId of ['p1', 'p2', 'p3', 'p4'] as const) {
      playerOf(game, playerId).hp = 5
      playerOf(game, playerId).maxHp = 5
      clearHand(game, playerId)
    }
    enterPlayPhase(game)
    game.respond({ requestId: pending(game).id, playerId: 'p0', payload: { targetIds: [] } })
    const big = pending(game)
    expect(String(big?.prompt)).toContain('大于 7')
    game.respond({ requestId: big.id, playerId: 'p0', payload: { optionId: 'yes' } })
    drain(game)

    for (const playerId of ['p1', 'p2', 'p3', 'p4'] as const) {
      expect(playerOf(game, playerId).hp, `${playerId} 各受 1 点`).toBe(4)
    }
    // 清空 8 枚之后，对 4 名角色造成伤害又各得 1 枚
    expect(junlueOf(game.state, 'p0'), '之后的伤害产生新军略，不是保持 0').toBe(4)
    assertGameInvariants(game.state)
  })
})

describe('绽火', () => {
  function zhanhuoAction(game: SanguoshaGame) {
    return game.legalActions('p0').find((action) => action.kind === 'invoke-skill' && action.skillId === 'zhanhuo')
  }

  /** 摆好场面并跳过摧克，停在出牌阶段。 */
  function readyPlayPhase(game: SanguoshaGame): void {
    playerOf(game, 'p0').marks[JUNLUE_MARK] = 0
    enterPlayPhase(game)
    // 摧克偶数分支：放弃
    if (pending(game)) game.respond({ requestId: pending(game).id, playerId: 'p0', payload: { targetIds: [] } })
    drain(game)
  }

  it('军略为 0 或没有连环角色时没有这个动作', () => {
    const game = gameWith(FIVE)
    readyPlayPhase(game)
    playerOf(game, 'p0').marks[JUNLUE_MARK] = 0
    expect(zhanhuoAction(game), '0 军略不能发动').toBeUndefined()

    playerOf(game, 'p0').marks[JUNLUE_MARK] = 3
    for (const player of game.state.players) player.chained = false
    expect(zhanhuoAction(game), '没有连环角色不能发动').toBeUndefined()
  })

  it('先全部弃装备，再对其中一名造成火焰伤害', () => {
    const game = gameWith(FIVE)
    readyPlayPhase(game)
    playerOf(game, 'p0').marks[JUNLUE_MARK] = 3
    const vine = findCard(game, (card) => card.name === '藤甲')
    detach(game, vine)
    playerOf(game, 'p1').zones.equipment.armor = vine
    setChained(game as never, 'p1', 'setup', true)
    setChained(game as never, 'p2', 'setup', true)
    playerOf(game, 'p1').hp = 4
    playerOf(game, 'p1').maxHp = 4

    const order: string[] = []
    game.events.on('LoseEquipment', (ctx) => { order.push(`equip:${ctx.event.targetId}`) })
    game.events.on('Damaged', (ctx) => { order.push(`damage:${ctx.event.targetId}`) })

    game.act('p0', zhanhuoAction(game)!.id)
    game.respond({ requestId: pending(game).id, playerId: 'p0', payload: { targetIds: ['p1', 'p2'] } })
    // 两名目标弃完装备之后才问火伤打谁
    const fire = pending(game)
    expect(String(fire?.prompt)).toContain('火焰伤害')
    game.respond({ requestId: fire.id, playerId: 'p0', payload: { targetIds: ['p1'] } })
    drain(game)

    expect(junlueOf(game.state, 'p0') >= 0, '军略非负').toBe(true)
    expect(playerOf(game, 'p1').zones.equipment.armor, '藤甲被弃掉了').toBeNull()
    const firstDamage = order.findIndex((entry) => entry.startsWith('damage:'))
    const lastEquip = order.map((entry) => entry.startsWith('equip:')).lastIndexOf(true)
    expect(lastEquip, '有弃装备').toBeGreaterThan(-1)
    expect(lastEquip, '弃装备全部先于火伤').toBeLessThan(firstDamage)
    assertCardConservation(game.state)
  })

  it('藤甲先离场，所以火伤不再被它加成', () => {
    const game = gameWith(FIVE)
    readyPlayPhase(game)
    playerOf(game, 'p0').marks[JUNLUE_MARK] = 2
    const vine = findCard(game, (card) => card.name === '藤甲')
    detach(game, vine)
    playerOf(game, 'p1').zones.equipment.armor = vine
    setChained(game as never, 'p1', 'setup', true)
    for (const player of game.state.players) { if (player.id !== 'p1') player.chained = false }
    playerOf(game, 'p1').hp = 5
    playerOf(game, 'p1').maxHp = 5

    game.act('p0', zhanhuoAction(game)!.id)
    game.respond({ requestId: pending(game).id, playerId: 'p0', payload: { targetIds: ['p1'] } })
    drain(game)
    // 藤甲还在的话火伤会 +1 变成 2 点
    expect(playerOf(game, 'p1').hp, '只掉 1 点：藤甲已经不在了').toBe(4)
  })

  it('取消不消耗限定技', () => {
    const game = gameWith(FIVE)
    readyPlayPhase(game)
    playerOf(game, 'p0').marks[JUNLUE_MARK] = 3
    setChained(game as never, 'p1', 'setup', true)
    game.act('p0', zhanhuoAction(game)!.id)
    game.respond({ requestId: pending(game).id, playerId: 'p0', payload: { targetIds: [] } })
    expect(junlueOf(game.state, 'p0'), '取消不清军略').toBe(3)
    expect(zhanhuoAction(game), '限定技还在').toBeTruthy()
  })

  it('绽火的火伤照常产生新军略', () => {
    const game = gameWith(FIVE)
    readyPlayPhase(game)
    playerOf(game, 'p0').marks[JUNLUE_MARK] = 2
    setChained(game as never, 'p1', 'setup', true)
    for (const player of game.state.players) { if (player.id !== 'p1') player.chained = false }
    playerOf(game, 'p1').hp = 5
    playerOf(game, 'p1').maxHp = 5

    game.act('p0', zhanhuoAction(game)!.id)
    game.respond({ requestId: pending(game).id, playerId: 'p0', payload: { targetIds: ['p1'] } })
    drain(game)
    expect(junlueOf(game.state, 'p0'), '移去全部之后，火伤又给了 1 枚').toBe(1)
  })
})
