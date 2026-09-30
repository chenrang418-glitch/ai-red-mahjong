import { describe, expect, it } from 'vitest'
import { SanguoshaGame } from '@/sanguosha/engine/game'
import { getSkillRuntime } from '@/sanguosha/engine/skills/runtime'
import { ALL_CHARACTERS } from '@/sanguosha/data/characters/standard'
import { HISTORICAL_BATCH80_CHARACTERS } from '@/sanguosha/data/characters/historical-batch80'
import { moveCard } from '@/sanguosha/engine/zones'

function gameFor(seed: string): SanguoshaGame {
  const game = new SanguoshaGame({ seed, setup: { mode: 'identity', generalChoices: 1,
    players: Array.from({ length: 5 }, (_, index) => ({ id: `${seed}-${index}`, nickname: `玩家${index}`, isHuman: true })) } })
  game.state.status = 'playing'
  game.state.pendingRequests = []
  game.state.players.forEach((entry) => { entry.characterId = null })
  return game
}

describe('武将册第80批运行时', () => {
  it('十名武将均进入注册表且每项技能均绑定运行时', () => {
    expect(HISTORICAL_BATCH80_CHARACTERS).toHaveLength(10)
    expect(new Set(HISTORICAL_BATCH80_CHARACTERS.map(({ id }) => id)).size).toBe(10)
    for (const character of HISTORICAL_BATCH80_CHARACTERS) {
      expect(ALL_CHARACTERS.some(({ id }) => id === character.id), character.name).toBe(true)
      for (const skill of character.skills) expect(getSkillRuntime(skill.id), `${character.name}/${skill.name}`).toBeDefined()
    }
    expect(HISTORICAL_BATCH80_CHARACTERS.find(({ id }) => id === 'zhang-huai-b80')).toMatchObject({ gender: 'female', maxHp: 3 })
  })

  it('【驭袭】造成或受到伤害后摸牌并只赋予刚获得的手牌免次数限制', () => {
    const game = gameFor('b80-yuxi')
    const owner = game.state.players[0]!
    owner.characterId = 'wei-zhangliao-b80'
    const runtime = getSkillRuntime('yuxi-wei-zhangliao-b80')!
    runtime.triggers!.find(({ event }) => event === 'DamageSettled')!.handle(game as never, owner.id,
      { event: { name: 'DamageSettled', sourceId: owner.id, targetId: game.state.players[1]!.id, payload: {} } } as never)
    const drawn = owner.zones.hand.at(-1)!
    expect(owner.zones.hand).toContain(drawn)
    expect(runtime.unlimitedCardUses!(game.state, owner.id, drawn)).toBe(true)
    expect(runtime.unlimitedCardUses!(game.state, owner.id, game.state.zones.drawPile[0]!)).toBe(false)
  })

  it('【顾音】初始化规则对乐周瑜本人清空起始手牌、其他角色加一张', () => {
    const game = gameFor('b80-guyin')
    const owner = game.state.players[0]!
    owner.characterId = 'le-zhouyu-b80'
    const runtime = getSkillRuntime('guyin-le-zhouyu-b80')!
    expect(runtime.globalInitialHandModifier!(game.state, owner.id, game.state.players[1]!.id)).toBe(1)
    expect(runtime.initialHandCount!(game.state, owner.id, 4)).toBe(0)
  })

  it('【鸾锁】只将与本回合弃牌花色及其余手牌花色均不同的牌转为铁索连环', () => {
    const game = gameFor('b80-luansuo')
    const owner = game.state.players[0]!
    const actor = game.state.players[1]!
    owner.characterId = 'shen-pangtong-b80'
    game.state.currentPlayerId = owner.id
    ;(game.state as never as { b80: Record<string, unknown> }).b80 = { luansuoDiscardSuits: { ownerId: owner.id, turn: game.state.turnNumber, suits: [] } }
    const [first, duplicate] = game.state.zones.drawPile.filter((id) => game.state.cards[id]?.suit === 'heart').slice(0, 2)
    const other = game.state.zones.drawPile.find((id) => game.state.cards[id]?.suit !== 'heart')!
    moveCard(game.state, first!, { kind: 'drawPile' }, { kind: 'hand', playerId: owner.id })
    moveCard(game.state, duplicate!, { kind: 'drawPile' }, { kind: 'hand', playerId: owner.id })
    moveCard(game.state, other, { kind: 'drawPile' }, { kind: 'hand', playerId: actor.id })
    const runtime = getSkillRuntime('luansuo-shen-pangtong-b80')!
    expect(runtime.viewAs!(game.state, owner.id).some(({ cardId }) => cardId === first)).toBe(false)
    moveCard(game.state, duplicate!, { kind: 'hand', playerId: owner.id }, { kind: 'characterPile', playerId: owner.id, pile: 'test' })
    expect(runtime.viewAs!(game.state, owner.id).some(({ cardId }) => cardId === first)).toBe(true)
    expect(runtime.globalViewAs!(game.state, owner.id, actor.id).some(({ cardId }) => cardId === other)).toBe(true)
  })

  it('【献酿】只允许被技能获得或交出的基础手牌转化为【酒】', () => {
    const game = gameFor('b80-xianliang')
    const owner = game.state.players[0]!
    owner.characterId = 'hou-cheng-b80'
    const basic = game.state.zones.drawPile.find((id) => game.state.cards[id]?.category === 'basic')!
    const trick = game.state.zones.drawPile.find((id) => game.state.cards[id]?.category === 'trick')!
    moveCard(game.state, basic, { kind: 'drawPile' }, { kind: 'hand', playerId: owner.id })
    moveCard(game.state, trick, { kind: 'drawPile' }, { kind: 'hand', playerId: owner.id })
    ;(game.state as never as { b80: Record<string, unknown> }).b80 = { houWineCards: [basic] }
    const runtime = getSkillRuntime('xianliang-houcheng-b80')!
    expect(runtime.viewAs!(game.state, owner.id).map(({ cardId, asCardName }) => [cardId, asCardName])).toEqual([[basic, '酒']])
    expect(runtime.globalViewAs!(game.state, owner.id, owner.id).map(({ cardId }) => cardId)).toContain(basic)
  })
})
