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
  const card = Object.values(game.state.cards).find((candidate) => candidate.name === cardName)!
  moveCard(game.state, card.id, locate(game.state, card.id), { kind: 'hand', playerId })
  return card.id
}

function useAction(game: SanguoshaGame, cardId: string, targetId: string) {
  const action = game.legalActions('p0').find((candidate) => candidate.kind === 'use-card' && candidate.cardIds.includes(cardId) && candidate.targetIds.includes(targetId))
  if (!action) throw new Error(`找不到出牌动作：${cardId}/${targetId}`)
  game.act('p0', action.id)
}

function respond(game: SanguoshaGame, actionId: string): void {
  const request = game.state.pendingRequests[0]
  game.respond({ requestId: request.id, playerId: request.playerId, payload: { actionId } })
}

function passUntilResponder(game: SanguoshaGame, playerId: string): void {
  let guard = 20
  while (game.state.pendingRequests[0]?.playerId !== playerId && guard-- > 0) respond(game, 'respond-pass')
  if (game.state.pendingRequests[0]?.playerId !== playerId) throw new Error(`未轮到响应者：${playerId}`)
}

function passUntilCardResolved(game: SanguoshaGame): void {
  let guard = 50
  while (game.state.cardResolution && guard-- > 0) respond(game, 'respond-pass')
  if (game.state.cardResolution) throw new Error('卡牌结算未能结束')
}

describe('基础牌的合法动作与可恢复结算', () => {
  it('杀的目标由统一距离计算生成，非当前玩家没有出牌动作', () => {
    const game = playPhaseGame('slash-distance')
    const slashId = giveCard(game, 'p0', '杀')
    const slashActions = game.legalActions('p0').filter((action) => action.kind === 'use-card' && action.cardIds.includes(slashId))
    expect(slashActions.map((action) => action.targetIds[0]).sort()).toEqual(['p1', 'p4'])
    expect(game.legalActions('p1')).toEqual([])
    expect(() => game.act('p0', `play:${slashId}:p2`)).toThrow('操作不存在')
  })

  it('目标使用闪后不受伤，杀和闪均进入弃牌堆', () => {
    const game = playPhaseGame('slash-dodge')
    const slashId = giveCard(game, 'p0', '杀')
    const dodgeId = giveCard(game, 'p1', '闪')
    useAction(game, slashId, 'p1')
    const request = game.state.pendingRequests[0]
    expect(request).toMatchObject({ kind: 'respond-card', playerId: 'p1', requiredCardName: '闪' })
    expect(request.kind === 'respond-card' && request.actionIds).toContain(`respond-dodge:${dodgeId}`)
    respond(game, `respond-dodge:${dodgeId}`)
    expect(game.state.players[1].hp).toBe(4)
    expect(game.state.cardResolution).toBeNull()
    expect(game.state.zones.discardPile).toEqual(expect.arrayContaining([slashId, dodgeId]))
    expect(game.state.decisions.map((decision) => decision.kind)).toEqual(['play-action', 'respond-card'])
    assertCardConservation(game.state)
  })

  it('结算视图公开已使用的杀，但只给出牌者自己的合法操作和响应者自己的 Request', () => {
    const game = playPhaseGame('slash-player-views')
    const slashId = giveCard(game, 'p0', '杀')
    expect(game.viewFor('p0').legalActions.some((action) => action.kind === 'use-card' && action.cardIds.includes(slashId))).toBe(true)
    expect(game.viewFor('p1').legalActions).toEqual([])
    useAction(game, slashId, 'p1')
    expect(() => assertGameInvariants(game.state)).not.toThrow()
    const sourceView = game.viewFor('p0')
    const targetView = game.viewFor('p1')
    const observerView = game.viewFor('p2')
    expect(sourceView.pendingRequest).toBeNull()
    expect(targetView.pendingRequest).toMatchObject({ kind: 'respond-card', requiredCardName: '闪' })
    expect(observerView.pendingRequest).toBeNull()
    expect(observerView.cardResolution).toMatchObject({ kind: 'slash', sourceId: 'p0', targetIds: ['p1'], card: { id: slashId } })
    expect(JSON.stringify(observerView)).not.toContain(targetView.pendingRequest!.id)
  })

  it('放弃出闪后受到对应属性的一点伤害', () => {
    const game = playPhaseGame('slash-hit')
    const slashId = giveCard(game, 'p0', '杀')
    useAction(game, slashId, 'p1')
    respond(game, 'respond-pass')
    expect(game.state.players[1].hp).toBe(3)
    expect(game.state.cardResolution).toBeNull()
    expect(game.state.zones.discardPile).toContain(slashId)
  })

  it('错误玩家、非法 actionId 与重复响应均被拒绝且不会提前改变状态', () => {
    const game = playPhaseGame('invalid-card-response')
    const slashId = giveCard(game, 'p0', '杀')
    useAction(game, slashId, 'p1')
    const request = game.state.pendingRequests[0]
    const before = JSON.stringify(game.state)
    expect(() => game.respond({ requestId: request.id, playerId: 'p2', payload: { actionId: 'respond-pass' } })).toThrow('响应玩家')
    expect(() => game.respond({ requestId: request.id, playerId: 'p1', payload: { actionId: 'forged' } })).toThrow('actionId')
    expect(JSON.stringify(game.state)).toBe(before)
    respond(game, 'respond-pass')
    expect(() => game.respond({ requestId: request.id, playerId: 'p1', payload: { actionId: 'respond-pass' } })).toThrow('不存在')
  })

  it('酒强化下一张杀且在结算时消费，出牌阶段仍限一次杀', () => {
    const game = playPhaseGame('wine-slash')
    const wineId = giveCard(game, 'p0', '酒')
    const secondWineId = Object.values(game.state.cards).find((card) => card.name === '酒' && card.id !== wineId)!.id
    moveCard(game.state, secondWineId, locate(game.state, secondWineId), { kind: 'hand', playerId: 'p0' })
    const slashId = giveCard(game, 'p0', '杀')
    useAction(game, wineId, 'p0')
    expect(game.state.turnUsage.wineDamageBonus).toBe(1)
    useAction(game, slashId, 'p1')
    respond(game, 'respond-pass')
    expect(game.state.players[1].hp).toBe(2)
    expect(game.state.turnUsage).toEqual({ slashUses: 1, wineUses: 1, wineDamageBonus: 0 })
    expect(game.legalActions('p0').some((action) => action.kind === 'use-card' && action.asCardName === '杀')).toBe(false)
    expect(game.legalActions('p0').some((action) => action.kind === 'use-card' && action.cardIds.includes(secondWineId))).toBe(false)
  })

  it('桃只在受伤时生成合法动作并回复一点体力', () => {
    const game = playPhaseGame('peach-play')
    const peachId = giveCard(game, 'p0', '桃')
    expect(game.legalActions('p0').some((action) => action.kind === 'use-card' && action.cardIds.includes(peachId))).toBe(false)
    game.state.players[0].hp = 2
    useAction(game, peachId, 'p0')
    expect(game.state.players[0].hp).toBe(3)
    expect(game.state.zones.discardPile).toContain(peachId)
  })

  it('装备牌通过同一用牌入口进入明确槽位，替换旧装备时保持牌张守恒', () => {
    const game = playPhaseGame('equipment-play')
    const weapons = Object.values(game.state.cards).filter((card) => card.equipmentSlot === 'weapon').slice(0, 2)
    for (const weapon of weapons) {
      moveCard(game.state, weapon.id, locate(game.state, weapon.id), { kind: 'hand', playerId: 'p0' })
      useAction(game, weapon.id, 'p0')
    }
    expect(game.state.players[0].zones.equipment.weapon).toBe(weapons[1].id)
    expect(game.state.zones.discardPile).toContain(weapons[0].id)
    expect(game.state.zones.discardPile).not.toContain(weapons[1].id)
    assertCardConservation(game.state)
  })

  it('回合结束时重置杀和酒的使用状态', () => {
    const game = playPhaseGame('turn-usage-reset')
    game.state.turnUsage = { slashUses: 1, wineUses: 1, wineDamageBonus: 1 }
    game.act('p0', 'play:pass')
    const discard = game.state.pendingRequests[0]
    if (discard) {
      expect(discard.kind).toBe('choose-cards')
      const count = discard.kind === 'choose-cards' ? discard.min : 0
      game.respond({ requestId: discard.id, playerId: 'p0', payload: { cardIds: game.state.players[0].zones.hand.slice(0, count) } })
    }
    game.advancePhase()
    game.advancePhase()
    expect(game.state.phase).toBe('prepare')
    expect(game.state.turnUsage).toEqual({ slashUses: 0, wineUses: 0, wineDamageBonus: 0 })
  })

  it('锦囊→无懈后效果取消，响应 Request 只发送给当前响应者', () => {
    const game = playPhaseGame('nullification-once')
    const trickId = giveCard(game, 'p0', '无中生有')
    const nullificationId = giveCard(game, 'p1', '无懈可击')
    const handBefore = game.state.players[0].zones.hand.length
    useAction(game, trickId, 'p0')
    passUntilResponder(game, 'p1')
    const responderView = game.viewFor('p1')
    expect(responderView.pendingRequest).toMatchObject({ kind: 'respond-card', requiredCardName: '无懈可击' })
    expect(game.viewFor('p2').pendingRequest).toBeNull()
    respond(game, `respond-nullification:${nullificationId}`)
    passUntilCardResolved(game)
    expect(game.state.players[0].zones.hand).toHaveLength(handBefore - 1)
    expect(game.state.zones.discardPile).toEqual(expect.arrayContaining([trickId, nullificationId]))
    assertGameInvariants(game.state)
  })

  it('锦囊→无懈→再无懈后恢复生效并摸两张牌', () => {
    const game = playPhaseGame('nullification-twice')
    const trickId = giveCard(game, 'p0', '无中生有')
    const firstId = giveCard(game, 'p1', '无懈可击')
    const secondCandidate = Object.values(game.state.cards).find((card) => card.name === '无懈可击' && card.id !== firstId)!
    moveCard(game.state, secondCandidate.id, locate(game.state, secondCandidate.id), { kind: 'hand', playerId: 'p2' })
    const handBefore = game.state.players[0].zones.hand.length
    useAction(game, trickId, 'p0')
    passUntilResponder(game, 'p1')
    respond(game, `respond-nullification:${firstId}`)
    passUntilResponder(game, 'p2')
    respond(game, `respond-nullification:${secondCandidate.id}`)
    // 两张无懈都打完之后场上再没人拿得出无懈，引擎不会再去问一圈，直接把效果结掉。
    // 断言最终结果而不是中间态：无懈两次相互抵消，无中生有必须真的生效。
    passUntilCardResolved(game)
    expect(game.state.cardResolution).toBeNull()
    expect(game.state.players[0].zones.hand).toHaveLength(handBefore + 1)
    expect(game.state.zones.discardPile).toEqual(expect.arrayContaining([trickId, firstId, secondCandidate.id]))
    assertCardConservation(game.state)
  })

  it('杀造成濒死时保留结算状态，救援结束后再收束卡牌', () => {
    const game = playPhaseGame('slash-dying-resume')
    const slashId = giveCard(game, 'p0', '杀')
    game.state.players[1].hp = 1
    useAction(game, slashId, 'p1')
    respond(game, 'respond-pass')
    expect(game.state.cardResolution).toMatchObject({ kind: 'slash', stage: 'awaiting-dying', cardId: slashId })
    expect(game.state.zones.processingArea).toContain(slashId)
    while (game.state.dying) respond(game, 'rescue-pass')
    expect(game.state.players[1].alive).toBe(false)
    expect(game.state.cardResolution).toBeNull()
    expect(game.state.zones.discardPile).toContain(slashId)
    assertCardConservation(game.state)
  })

  it('属性杀首个目标濒死时暂停铁索传播，救援结束后继续传播并收束原卡牌', () => {
    const game = playPhaseGame('elemental-slash-chain-resume')
    const fireSlash = Object.values(game.state.cards).find((card) => card.name === '杀' && card.damageNature === 'fire')!
    moveCard(game.state, fireSlash.id, locate(game.state, fireSlash.id), { kind: 'hand', playerId: 'p0' })
    game.state.players[1].chained = true
    game.state.players[3].chained = true
    game.state.players[1].hp = 1
    useAction(game, fireSlash.id, 'p1')
    respond(game, 'respond-pass')
    expect(game.state.dying?.playerId).toBe('p1')
    expect(game.state.damageChain?.remainingTargetIds).toEqual(['p3'])
    expect(game.state.players[3].hp).toBe(4)
    expect(game.state.cardResolution).toMatchObject({ cardId: fireSlash.id, stage: 'awaiting-dying' })
    while (game.state.dying) respond(game, 'rescue-pass')
    expect(game.state.players[1].alive).toBe(false)
    expect(game.state.players[3].hp).toBe(3)
    expect(game.state.damageChain).toBeNull()
    expect(game.state.cardResolution).toBeNull()
    expect(game.state.zones.discardPile).toContain(fireSlash.id)
    assertGameInvariants(game.state)
  })
})
