import { describe, expect, it } from 'vitest'
import { SanguoshaGame } from '@/sanguosha/engine/game'
import { moveCard } from '@/sanguosha/engine/zones'
import { getSkillRuntime } from '@/sanguosha/engine/skills/runtime'
import { ALL_CHARACTERS } from '@/sanguosha/data/characters/standard'
import { HISTORICAL_BATCH77_CHARACTERS } from '@/sanguosha/data/characters/historical-batch77'

function gameFor(seed: string): SanguoshaGame {
  const game = new SanguoshaGame({ seed, setup: { mode: 'identity', generalChoices: 1,
    players: Array.from({ length: 5 }, (_, index) => ({ id: `${seed}-${index}`, nickname: `玩家${index}`, isHuman: true })) } })
  game.state.status = 'playing'
  game.state.pendingRequests = []
  game.state.players.forEach((entry) => { entry.characterId = null })
  return game
}

describe('武将册第77批技能接入', () => {
  it('按武将册次序登记十名，全部二十项技能均有运行时', () => {
    expect(HISTORICAL_BATCH77_CHARACTERS.map(({ name }) => name)).toEqual([
      '诸葛若雪', '乐周妃', '马伶俐', '蒯祺', '乐祢衡', '星·曹仁', '武陆逊', '曹轶', '陈式', '孙礼',
    ])
    expect(HISTORICAL_BATCH77_CHARACTERS.every(({ id }) => ALL_CHARACTERS.some((character) => character.id === id))).toBe(true)
    expect(new Set(HISTORICAL_BATCH77_CHARACTERS.map(({ id }) => id)).size).toBe(10)
    expect(HISTORICAL_BATCH77_CHARACTERS.reduce((sum, character) => sum + character.skills.length, 0)).toBe(20)
    for (const character of HISTORICAL_BATCH77_CHARACTERS)
      for (const skill of character.skills) expect(getSkillRuntime(skill.id), `${character.name}【${skill.name}】`).toBeDefined()
  })

  it('【灵箜】开局标记初始手牌，且该牌不计入手牌上限', () => {
    const game = gameFor('b77-lingkong')
    const owner = game.state.players[0]!
    const cardId = game.state.zones.drawPile[0]!
    moveCard(game.state, cardId, { kind: 'drawPile' }, { kind: 'hand', playerId: owner.id })
    const runtime = getSkillRuntime('lingkong-lezhoufei-b77')!
    runtime.onGameStart!(game as never, owner.id)
    expect(runtime.handLimitExempt!(game.state, owner.id, cardId)).toBe(true)
  })

  it('【骊马】按场上坐骑数量修正距离；【雄幕】每回合只检查首次受伤', () => {
    const game = gameFor('b77-horse-damage')
    const owner = game.state.players[0]!
    const other = game.state.players[1]!
    owner.characterId = 'malingli-b77'
    const horse = game.state.zones.drawPile.find((id) => game.state.cards[id]?.equipmentSlot === 'offensiveHorse')!
    moveCard(game.state, horse, { kind: 'drawPile' }, { kind: 'equipment', playerId: other.id, slot: 'offensiveHorse' })
    expect(getSkillRuntime('lima-malingli-b77')!.distanceModifier?.toOthers(game.state, owner.id)).toBe(-1)

    const runtime = getSkillRuntime('xiongmu-wuluxun-b77')!
    const damage = { sourceId: null, amount: 2, nature: 'normal' as const, cardId: null, cardName: null, chainTransfer: false }
    expect(runtime.incomingDamage!(game.state, owner.id, damage)).toEqual({ amount: 1 })
    expect(runtime.incomingDamage!(game.state, owner.id, damage)).toBeNull()
  })

  it('【殉节】可选择手牌调整模式，并由目标亲自弃置差额', () => {
    const game = gameFor('b77-xunjie-discard')
    const owner = game.state.players[0]!
    const target = game.state.players[1]!
    target.hp = 1
    const cards = game.state.zones.drawPile.slice(0, 3)
    for (const cardId of cards) moveCard(game.state, cardId, { kind: 'drawPile' }, { kind: 'hand', playerId: target.id })
    const runtime = getSkillRuntime('xunjie-kuaqi-b77')!
    runtime.resume!(game as never, owner.id, { step: 'mode', data: { targetId: target.id } } as never,
      { playerId: owner.id, payload: { optionId: 'hand-to-hp' } } as never)
    expect(game.state.skillResolution?.step).toBe('discard-to-hp')
    expect(game.state.skillResolution?.requestId).toBe(game.state.pendingRequests[0]?.id)
    game.state.skillResolution = null
    game.state.pendingRequests = []
    runtime.resume!(game as never, owner.id, { step: 'discard-to-hp', data: { count: 2 } } as never,
      { playerId: target.id, payload: { cardIds: cards.slice(0, 2) } } as never)
    expect(target.zones.hand).toHaveLength(1)
    expect(cards.slice(0, 2).every((id) => game.state.zones.discardPile.includes(id))).toBe(true)
  })

  it('【良秀】允许弃置装备区牌，且已用类别在本出牌阶段不能重复作为代价', () => {
    const game = gameFor('b77-liangxiu-cost')
    const owner = game.state.players[0]!
    owner.characterId = 'kuaiqi-b77'
    game.state.currentPlayerId = owner.id
    game.state.phase = 'play'
    const basic = game.state.zones.drawPile.find((id) => game.state.cards[id]?.category === 'basic')!
    const trick = game.state.zones.drawPile.find((id) => game.state.cards[id]?.category === 'trick')!
    const equipment = game.state.zones.drawPile.find((id) => game.state.cards[id]?.equipmentSlot === 'weapon')!
    moveCard(game.state, basic, { kind: 'drawPile' }, { kind: 'hand', playerId: owner.id })
    moveCard(game.state, trick, { kind: 'drawPile' }, { kind: 'hand', playerId: owner.id })
    moveCard(game.state, equipment, { kind: 'drawPile' }, { kind: 'equipment', playerId: owner.id, slot: 'weapon' })
    const runtime = getSkillRuntime('liangxiu-kuaqi-b77')!
    expect(runtime.activeActions!(game.state, owner.id)).toHaveLength(1)
    runtime.invokeActive!(game as never, owner.id, 'liangxiu:activate')
    const costResolution = game.state.skillResolution!
    game.state.skillResolution = null
    game.state.pendingRequests = []
    runtime.resume!(game as never, owner.id, costResolution as never,
      { playerId: owner.id, payload: { cardIds: [basic, equipment] } } as never)
    expect(game.state.zones.discardPile).toEqual(expect.arrayContaining([basic, equipment]))
    expect(runtime.activeActions!(game.state, owner.id)).toEqual([])
  })

  it('【擎北】鎖定所選花色且另計非鎖定花色數', () => {
    const game = gameFor('b77-qingbei')
    const owner = game.state.players[0]!
    ;(game.state as typeof game.state & { b77: Record<string, unknown> }).b77 = {
      qingbei: { [owner.id]: { round: game.state.roundNumber, suits: ['spade', 'heart'] } },
    }
    const runtime = getSkillRuntime('qingbei-chenshi-b77')!
    expect(runtime.locksOwnSuits!(game.state, owner.id)).toEqual(['spade', 'heart'])
  })
})
