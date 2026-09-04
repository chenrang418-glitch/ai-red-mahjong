import { describe, expect, it } from 'vitest'
import { getCharacter, skillIdsOf } from '@/sanguosha/data/characters/standard'
import { SanguoshaGame } from '@/sanguosha/engine/game'
import { ownedSkillIds } from '@/sanguosha/engine/skills/runtime'
import { moveCard } from '@/sanguosha/engine/zones'
import { getAttackRange } from '@/sanguosha/engine/distance'
import type { GameSetup, Identity, Suit } from '@/sanguosha/engine/types'

const BEIGE = 'beige'
const DUANCHANG = 'duanchang'

function gameWith() {
  const chars = ['caiwenji', 'zhangfei', 'sunce', 'zhangfei', 'zhangfei']
  const setup: GameSetup = { mode: 'identity', generalChoices: 1, players: chars.map((_, i) => ({ id: `p${i}`, nickname: `玩家${i}`, isHuman: false })) }
  const game = new SanguoshaGame({ seed: 'caiwenji', setup }); const identities: Identity[] = ['rebel', 'lord', 'loyalist', 'rebel', 'renegade']
  game.state.players.forEach((p, i) => { p.identity = identities[i]; p.characterId = chars[i] }); game.start()
  while (game.state.pendingRequests.length) answer(game, { optionId: 'no' })
  return game
}
function answer(game: SanguoshaGame, payload: Record<string, unknown>) { const r = game.state.pendingRequests[0]; game.respond({ requestId: r.id, playerId: r.playerId, payload }) }
function topSuit(game: SanguoshaGame, suit: Suit) {
  const id = game.state.zones.drawPile.find((cardId) => game.state.cards[cardId].suit === suit)!
  game.state.zones.drawPile = [id, ...game.state.zones.drawPile.filter((cardId) => cardId !== id)]
}
function triggerBeige(game: SanguoshaGame, suit: Suit) {
  topSuit(game, suit)
  game.dispatch('Damaged', { amount: 1, cardName: '杀', cardId: null }, { sourceId: 'p2', targetId: 'p1' })
  ;(game as unknown as { settle(): void }).settle()
  const cost = game.state.players[0].zones.hand[0]; answer(game, { cardIds: [cost] })
}

describe('蔡文姬', () => {
  it('注册群势力女性3体力及悲歌、断肠', () => {
    const c = getCharacter('caiwenji')!
    expect([c.kingdom, c.gender, c.maxHp, c.pack]).toEqual(['qun', 'female', 3, 'mountain'])
    expect(skillIdsOf(c.id)).toEqual([BEIGE, DUANCHANG])
  })
  it('非杀伤害与没有可弃牌时不问悲歌', () => {
    const game = gameWith(); game.dispatch('Damaged', { amount: 1, cardName: '决斗' }, { sourceId: 'p2', targetId: 'p1' }); (game as unknown as { settle(): void }).settle()
    expect(game.state.pendingRequests).toHaveLength(0)
    const owner = game.state.players[0]; for (const id of [...owner.zones.hand]) moveCard(game.state, id, { kind: 'hand', playerId: 'p0' }, { kind: 'discardPile' })
    game.dispatch('Damaged', { amount: 1, cardName: '杀' }, { sourceId: 'p2', targetId: 'p1' }); (game as unknown as { settle(): void }).settle()
    expect(game.state.pendingRequests).toHaveLength(0)
  })
  it('红桃回复、方块摸二，均作用于实际受伤角色', () => {
    const heart = gameWith(); heart.state.players[1].hp = 2; triggerBeige(heart, 'heart'); expect(heart.state.players[1].hp).toBe(3)
    const diamond = gameWith(); const before = diamond.state.players[1].zones.hand.length; triggerBeige(diamond, 'diamond'); expect(diamond.state.players[1].zones.hand.length).toBe(before + 2)
  })
  it('黑桃令伤害来源翻面，梅花令其弃两张牌', () => {
    const spade = gameWith(); triggerBeige(spade, 'spade'); expect(spade.state.players[2].faceDown).toBe(true)
    const club = gameWith(); const before = club.state.players[2].zones.hand.length; triggerBeige(club, 'club'); const ids = club.state.pendingRequests[0].cardIds.slice(0, 2); answer(club, { cardIds: ids }); expect(club.state.players[2].zones.hand.length).toBe(before - 2)
  })
  it('断肠永久关闭凶手武将技能；无来源死亡不影响他人', () => {
    const game = gameWith(); game.state.players[0].alive = false; game.dispatch('Death', { playerId: 'p0', sourceId: 'p2' }, { sourceId: 'p2', targetId: 'p0' })
    expect(game.state.players[2].characterSkillsDisabled).toBe(true)
    expect(ownedSkillIds(game.state, 'p2', skillIdsOf)).toEqual([])
    const noSource = gameWith(); noSource.dispatch('Death', { playerId: 'p0', sourceId: null }, { targetId: 'p0' }); expect(noSource.state.players[2].characterSkillsDisabled).toBe(false)
  })

  it('断肠同时关闭自带、永久授予和临时技能，但装备距离仍生效且重连保持', () => {
    const game = gameWith()
    const killer = game.state.players[2]
    killer.grantedSkills = ['yingzi']
    killer.temporaryGrantedSkills = [{ source: 'test', skillId: 'mashu' }]
    const weapon = game.state.zones.drawPile.find((id) => (game.state.cards[id].attackRange ?? 0) > 1)!
    moveCard(game.state, weapon, { kind: 'drawPile' }, { kind: 'equipment', playerId: 'p2', slot: 'weapon' })
    const range = getAttackRange(game.state, 'p2')
    game.state.players[0].alive = false
    game.dispatch('Death', { playerId: 'p0', sourceId: 'p2' }, { sourceId: 'p2', targetId: 'p0' })
    expect(ownedSkillIds(game.state, 'p2', skillIdsOf)).toEqual([])
    expect(getAttackRange(game.state, 'p2')).toBe(range)
    const restored = SanguoshaGame.restore(game.serialize())
    expect(restored.state.players[2].characterSkillsDisabled).toBe(true)
    expect(ownedSkillIds(restored.state, 'p2', skillIdsOf)).toEqual([])
    expect(getAttackRange(restored.state, 'p2')).toBe(range)
  })

  it('悲歌可以放弃，也能弃装备作为代价；无伤害来源的梅花和黑桃安全结束', () => {
    const declined = gameWith(); declined.dispatch('Damaged', { amount: 1, cardName: '杀' }, { sourceId: 'p2', targetId: 'p1' }); (declined as unknown as { settle(): void }).settle(); answer(declined, { cardIds: [] })
    expect(declined.state.judgment).toBeNull()

    for (const suit of ['club', 'spade'] as const) {
      const game = gameWith(); const owner = game.state.players[0]
      for (const id of [...owner.zones.hand]) moveCard(game.state, id, { kind: 'hand', playerId: 'p0' }, { kind: 'discardPile' })
      const armor = game.state.zones.drawPile.find((id) => game.state.cards[id].equipmentSlot === 'armor')!
      moveCard(game.state, armor, { kind: 'drawPile' }, { kind: 'equipment', playerId: 'p0', slot: 'armor' })
      topSuit(game, suit)
      game.dispatch('Damaged', { amount: 1, cardName: '杀' }, { targetId: 'p1' }); (game as unknown as { settle(): void }).settle()
      answer(game, { cardIds: [armor] })
      expect(owner.zones.equipment.armor).toBeNull()
      expect(game.state.pendingRequests).toHaveLength(0)
    }
  })
})
