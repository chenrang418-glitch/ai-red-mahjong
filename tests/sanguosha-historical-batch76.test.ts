import { describe, expect, it } from 'vitest'
import { SanguoshaGame } from '@/sanguosha/engine/game'
import { moveCard } from '@/sanguosha/engine/zones'
import { getSkillRuntime } from '@/sanguosha/engine/skills/runtime'
import { findMultiViewAsSpec } from '@/sanguosha/engine/multi-card-viewas'
import { ALL_CHARACTERS } from '@/sanguosha/data/characters/standard'
import { HISTORICAL_BATCH76_CHARACTERS } from '@/sanguosha/data/characters/historical-batch76'

function gameFor(seed: string): SanguoshaGame {
  const game = new SanguoshaGame({ seed, setup: { mode: 'identity', generalChoices: 1,
    players: Array.from({ length: 5 }, (_, index) => ({ id: `${seed}-${index}`, nickname: `玩家${index}`, isHuman: true })) } })
  game.state.status = 'playing'
  game.state.pendingRequests = []
  game.state.players.forEach((player) => { player.characterId = null })
  return game
}

describe('武将册第76批技能接入', () => {
  it('按武将册次序登记十名，全部二十项技能均有运行时', () => {
    expect(HISTORICAL_BATCH76_CHARACTERS.map(({ name }) => name)).toEqual([
      '柏灵筠', '郑浑', '乐蔡文姬', '董绾', '管宁', '孟节', '桓范', '孟优', '周不疑', '诸葛梦雪',
    ])
    expect(HISTORICAL_BATCH76_CHARACTERS.every(({ id }) => ALL_CHARACTERS.some((character) => character.id === id))).toBe(true)
    expect(new Set(HISTORICAL_BATCH76_CHARACTERS.map(({ id }) => id)).size).toBe(10)
    expect(HISTORICAL_BATCH76_CHARACTERS.reduce((sum, character) => sum + character.skills.length, 0)).toBe(20)
    for (const character of HISTORICAL_BATCH76_CHARACTERS)
      for (const skill of character.skills) expect(getSkillRuntime(skill.id), `${character.name}【${skill.name}】`).toBeDefined()
  })

  it('【强峙】统计双方手牌与装备区，合计三张时可发动', () => {
    const game = gameFor('b76-qiangzhi-zones')
    const owner = game.state.players[0]!
    const target = game.state.players[1]!
    owner.characterId = 'zhenghun-b76'
    game.state.currentPlayerId = owner.id
    game.state.phase = 'play'
    const cards = game.state.zones.drawPile.filter((id) => game.state.cards[id]?.category === 'equipment'
      && game.state.cards[id]?.equipmentSlot).slice(0, 3)
    for (const [index, cardId] of cards.entries()) {
      const player = index === 0 ? owner : target
      const slot = game.state.cards[cardId]!.equipmentSlot!
      moveCard(game.state, cardId, { kind: 'drawPile' }, { kind: 'equipment', playerId: player.id, slot })
    }
    const actions = getSkillRuntime('qiangzhi-zhenghun-b76')!.activeActions!(game.state, owner.id)
    expect(actions.map(({ id }) => id)).toContain('qiangzhi:activate')
  })

  it('【介绫】只开放本出牌阶段尚未消耗的不同花色', () => {
    const game = gameFor('b76-jieling-suits')
    const owner = game.state.players[0]!
    owner.characterId = 'dongwan-b76'
    game.state.currentPlayerId = owner.id
    game.state.phase = 'play'
    for (const suit of ['spade', 'heart', 'club', 'diamond'] as const) {
      const cardId = game.state.zones.drawPile.find((id) => game.state.cards[id]?.suit === suit)!
      moveCard(game.state, cardId, { kind: 'drawPile' }, { kind: 'hand', playerId: owner.id })
    }
    const runtime = getSkillRuntime('jieling-dongwan-b76')!
    const first = runtime.multiCardViewAs!(game.state, owner.id)!
    expect(first.allowedSuits).toHaveLength(4)
    first.onConvert!(game.state, owner.id, owner.zones.hand[0]!, owner.zones.hand.slice(0, 2), '杀')
    const spent = (game.state as typeof game.state & { b76: { jielingConvertedSuit: { suits: string[] } } }).b76.jielingConvertedSuit.suits
    expect(new Set(spent).size).toBe(2)
    ;(game.state as typeof game.state & { b76: { jielingSuits: Record<string, string[]> } }).b76.jielingSuits = {
      [owner.id]: spent,
    }
    expect(findMultiViewAsSpec(game.state, owner.id, '杀')?.suits).toEqual(['club', 'diamond'])
    game.state.phase = 'discard'
    expect(runtime.multiCardViewAs!(game.state, owner.id)).toBeNull()
  })
})
