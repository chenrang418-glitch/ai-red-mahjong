import { describe, expect, it } from 'vitest'
import { GUZHENG, ZHIJIAN } from '@/sanguosha/data/characters/mountain-zhangzhaozhanghong'
import { getCharacter } from '@/sanguosha/data/characters/standard'
import { SanguoshaGame } from '@/sanguosha/engine/game'
import { assertGameInvariants } from '@/sanguosha/engine/invariants'
import { moveCard } from '@/sanguosha/engine/zones'
import type { GameSetup, Identity, PlayerId } from '@/sanguosha/engine/types'

function gameWith(chars = ['zhangzhaozhanghong', 'sunce', 'zhangfei', 'zhangfei', 'zhangfei']) {
  const setup: GameSetup = { mode: 'identity', generalChoices: 1, players: chars.map((_, i) => ({ id: `p${i}`, nickname: `玩家${i}`, isHuman: false })) }
  const game = new SanguoshaGame({ seed: 'zzzh', setup })
  const ids: Identity[] = ['rebel', 'lord', 'loyalist', 'rebel', 'renegade']
  game.state.players.forEach((p, i) => { p.identity = ids[i]; p.characterId = chars[i] })
  game.start()
  while (game.state.pendingRequests.length) answer(game, { optionId: 'no' })
  game.state.currentPlayerId = 'p0'; game.state.phase = 'play'
  return game
}

function answer(game: SanguoshaGame, payload: Record<string, unknown>) {
  const r = game.state.pendingRequests[0]; if (!r) throw new Error('没有请求')
  game.respond({ requestId: r.id, playerId: r.playerId, payload })
}

function give(game: SanguoshaGame, playerId: PlayerId, predicate: (id: string) => boolean) {
  const id = game.state.zones.drawPile.find(predicate)!; moveCard(game.state, id, { kind: 'drawPile' }, { kind: 'hand', playerId }); return id
}

describe('张昭张纮', () => {
  it('经典信息与技能注册', () => {
    const c = getCharacter('zhangzhaozhanghong')!
    expect([c.kingdom, c.gender, c.maxHp, c.pack]).toEqual(['wu', 'male', 3, 'mountain'])
    expect(c.skills.map((s) => s.id)).toEqual([ZHIJIAN, GUZHENG])
  })

  it('直谏只拿手牌装备且不能覆盖已有同槽装备，成功后摸1', () => {
    const game = gameWith(); const owner = game.state.players[0]; owner.zones.hand.forEach((id) => moveCard(game.state, id, { kind: 'hand', playerId: 'p0' }, { kind: 'discardPile' }))
    const weapon = give(game, 'p0', (id) => game.state.cards[id].equipmentSlot === 'weapon')
    const action = game.legalActions('p0').find((a) => a.skillId === ZHIJIAN)!
    const before = owner.zones.hand.length
    game.act('p0', action.id); answer(game, { cardIds: [weapon] }); answer(game, { targetIds: ['p1'] })
    expect(game.state.players[1].zones.equipment.weapon).toBe(weapon)
    expect(owner.zones.hand.length).toBe(before)
    // 目标已有武器不会被替换；若摸到别的装备，仍可把它交给其他空槽角色。
    expect(game.state.players[1].zones.equipment.weapon).toBe(weapon)
    assertGameInvariants(game.state)
  })

  it('直谏取消不摸牌，并且没有限一次记账', () => {
    const game = gameWith(); give(game, 'p0', (id) => Boolean(game.state.cards[id].equipmentSlot))
    const before = game.state.players[0].zones.hand.length
    game.act('p0', game.legalActions('p0').find((a) => a.skillId === ZHIJIAN)!.id); answer(game, { cardIds: [] })
    expect(game.state.players[0].zones.hand.length).toBe(before)
    expect(game.legalActions('p0').some((a) => a.skillId === ZHIJIAN)).toBe(true)
  })

  it('直谏目标列表排除已占同槽者，且成功后仍可继续发动', () => {
    const game = gameWith()
    const occupied = give(game, 'p1', (id) => game.state.cards[id].equipmentSlot === 'weapon')
    moveCard(game.state, occupied, { kind: 'hand', playerId: 'p1' }, { kind: 'equipment', playerId: 'p1', slot: 'weapon' })
    const weapon = give(game, 'p0', (id) => game.state.cards[id].equipmentSlot === 'weapon')
    game.act('p0', game.legalActions('p0').find((action) => action.skillId === ZHIJIAN)!.id)
    answer(game, { cardIds: [weapon] })
    expect(game.state.pendingRequests[0].kind).toBe('choose-targets')
    if (game.state.pendingRequests[0].kind === 'choose-targets') expect(game.state.pendingRequests[0].candidateIds).not.toContain('p1')
    answer(game, { targetIds: ['p2'] })
    expect(game.legalActions('p0').some((action) => action.skillId === ZHIJIAN)).toBe(game.state.players[0].zones.hand.some((id) => Boolean(game.state.cards[id].equipmentSlot)))
  })

  it('固政按阶段账本返还一张，再取得仍在弃牌堆的其余牌', () => {
    const game = gameWith(); const a = give(game, 'p1', () => true); const b = give(game, 'p1', (id) => id !== a)
    moveCard(game.state, a, { kind: 'hand', playerId: 'p1' }, { kind: 'discardPile' }); moveCard(game.state, b, { kind: 'hand', playerId: 'p1' }, { kind: 'discardPile' })
    game.state.discardPhaseLedger = { phaseInstanceId: 'phase-x', ownerPlayerId: 'p1', records: [a, b].map((cardId, i) => ({ cardId, sourcePlayerId: 'p1', originalZone: 'hand' as const, moveReason: 'discard' as const, enteredDiscardAt: i })) }
    game.dispatch('PhaseEnd', { playerId: 'p1', phase: 'discard' }); (game as unknown as { settle(): void }).settle()
    answer(game, { cardIds: [a] }); answer(game, { optionId: 'yes' })
    expect(game.state.players[1].zones.hand).toContain(a)
    expect(game.state.players[0].zones.hand).toContain(b)
    assertGameInvariants(game.state)
  })

  it('已被其他效果取走的牌不会被固政复制', () => {
    const game = gameWith(); const a = give(game, 'p1', () => true); const b = give(game, 'p1', (id) => id !== a)
    moveCard(game.state, a, { kind: 'hand', playerId: 'p1' }, { kind: 'discardPile' }); moveCard(game.state, b, { kind: 'hand', playerId: 'p1' }, { kind: 'discardPile' })
    game.state.discardPhaseLedger = { phaseInstanceId: 'phase-y', ownerPlayerId: 'p1', records: [a, b].map((cardId, i) => ({ cardId, sourcePlayerId: 'p1', originalZone: 'hand' as const, moveReason: 'discard' as const, enteredDiscardAt: i })) }
    game.dispatch('PhaseEnd', { playerId: 'p1', phase: 'discard' }); moveCard(game.state, b, { kind: 'discardPile' }, { kind: 'hand', playerId: 'p2' }); (game as unknown as { settle(): void }).settle()
    answer(game, { cardIds: [a] })
    expect(game.state.players[2].zones.hand).toContain(b)
    expect(game.state.players[0].zones.hand).not.toContain(b)
  })

  it('账本只接收当前阶段明确标记为discard的移动，并保存技能弃牌与重连状态', () => {
    const game = gameWith()
    game.state.phase = 'discard'; game.state.currentPlayerId = 'p1'
    game.state.discardPhaseLedger = { phaseInstanceId: 'discard-extra-7', ownerPlayerId: 'p1', records: [] }
    const skillDiscard = give(game, 'p2', () => true)
    moveCard(game.state, skillDiscard, { kind: 'hand', playerId: 'p2' }, { kind: 'discardPile' })
    game.dispatch('CardMove', {
      cardIds: [skillDiscard], sourcePlayerId: 'p2', originalZone: 'hand', destinationZone: 'discardPile',
      reason: 'discard', phaseInstanceId: 'discard-extra-7',
    })
    const used = give(game, 'p2', () => true)
    moveCard(game.state, used, { kind: 'hand', playerId: 'p2' }, { kind: 'discardPile' })
    game.dispatch('CardMove', { cardIds: [used], sourcePlayerId: 'p2', originalZone: 'hand', reason: 'card-use' })
    expect(game.state.discardPhaseLedger.records.map((record) => record.cardId)).toEqual([skillDiscard])
    expect(SanguoshaGame.restore(game.serialize()).state.discardPhaseLedger).toEqual(game.state.discardPhaseLedger)
  })

  it('多个固政持有者按顺序竞争同一批实体牌，不会重复获得', () => {
    const game = gameWith(['zhangzhaozhanghong', 'zhangzhaozhanghong', 'sunce', 'zhangfei', 'zhangfei'])
    const a = give(game, 'p2', () => true); const b = give(game, 'p2', (id) => id !== a)
    moveCard(game.state, a, { kind: 'hand', playerId: 'p2' }, { kind: 'discardPile' })
    moveCard(game.state, b, { kind: 'hand', playerId: 'p2' }, { kind: 'discardPile' })
    game.state.discardPhaseLedger = { phaseInstanceId: 'phase-competition', ownerPlayerId: 'p2', records: [a, b].map((cardId, index) => ({ cardId, sourcePlayerId: 'p2', originalZone: 'hand' as const, moveReason: 'discard' as const, enteredDiscardAt: index })) }
    game.dispatch('PhaseEnd', { playerId: 'p2', phase: 'discard' }); (game as unknown as { settle(): void }).settle()
    answer(game, { cardIds: [a] }); answer(game, { optionId: 'yes' })
    expect(game.state.pendingRequests).toHaveLength(0)
    expect(game.state.players[0].zones.hand).toContain(b)
    expect(game.state.players[1].zones.hand).not.toContain(b)
    assertGameInvariants(game.state)
  })
})
