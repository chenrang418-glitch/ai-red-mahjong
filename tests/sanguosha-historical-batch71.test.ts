import { describe, expect, it } from 'vitest'
import { SanguoshaGame } from '@/sanguosha/engine/game'
import { characterPileCardUseActions, skillOtherHandCardUseActions } from '@/sanguosha/engine/cards/basic'
import { getSkillRuntime } from '@/sanguosha/engine/skills/runtime'
import { moveCard } from '@/sanguosha/engine/zones'
import { ALL_CHARACTERS } from '@/sanguosha/data/characters/standard'
import { HISTORICAL_BATCH71_CHARACTERS } from '@/sanguosha/data/characters/historical-batch71'

function gameFor(seed: string): SanguoshaGame {
  const game = new SanguoshaGame({ seed, setup: { mode: 'identity', generalChoices: 1,
    players: Array.from({ length: 5 }, (_, index) => ({ id: `${seed}-${index}`, nickname: `玩家${index}`, isHuman: true })) } })
  game.state.status = 'playing'
  game.state.pendingRequests = []
  game.state.players.forEach((player) => { player.characterId = null })
  return game
}

describe('武将册第71批技能接入', () => {
  it('正式武将池按武将册顺序接入10人，且每个登记技能都有运行时', () => {
    expect(HISTORICAL_BATCH71_CHARACTERS.map(({ name }) => name)).toEqual([
      '周夷', '张宁', '来莺儿', '吉平', '曹华', '刘徽', '卢弈', '孙翎鸾', '张横', '冯方',
    ])
    expect(HISTORICAL_BATCH71_CHARACTERS.every((character) => ALL_CHARACTERS.some((entry) => entry.id === character.id))).toBe(true)
    expect(new Set(HISTORICAL_BATCH71_CHARACTERS.map(({ id }) => id)).size).toBe(10)
    for (const character of HISTORICAL_BATCH71_CHARACTERS) {
      for (const skill of character.skills) expect(getSkillRuntime(skill.id), `${character.name}【${skill.name}】`).toBeDefined()
    }
  })

  it('吉平【烈医】临时忽略指定目标的距离和杀次数，并保留实体牌的普通使用管线', () => {
    const game = gameFor('b71-lieyi-distance')
    const owner = game.state.players[0]!
    const target = game.state.players[2]!
    owner.characterId = 'jiping-b71'
    game.state.currentPlayerId = owner.id
    game.state.phase = 'play'
    const slashId = game.state.zones.drawPile.find((id) => game.state.cards[id]?.name === '杀')!
    moveCard(game.state, slashId, { kind: 'drawPile' }, { kind: 'characterPile', playerId: owner.id, pile: 'xunli-jiping-b71' })
    ;(game.state as typeof game.state & { b71: { lieyi: Record<string, unknown> } }).b71 = {
      lieyi: { [owner.id]: { targetId: target.id, cardIds: [slashId], index: 0, enteredDying: false } },
    }
    const actions = characterPileCardUseActions(game.state, owner.id, owner.id, slashId, 'lieyi-jiping-b71')
    expect(actions.some((action) => action.targetIds.includes(target.id))).toBe(true)
    expect(getSkillRuntime('lieyi-jiping-b71')!.ignoresDistanceTo?.(game.state, owner.id, target.id)).toBe(true)
  })

  it('吉平【询疠】只收纳因弃置进入弃牌堆的黑色牌，且容量封顶9张', () => {
    const game = gameFor('b71-xunli-cap')
    const owner = game.state.players[0]!
    const runtime = getSkillRuntime('xunli-jiping-b71')!
    const trigger = runtime.triggers!.find(({ event }) => event === 'CardEnteredDiscardByMove')!
    const blackIds = game.state.zones.drawPile.filter((id) => game.state.cards[id]?.color === 'black').slice(0, 10)
    for (const cardId of blackIds) {
      moveCard(game.state, cardId, { kind: 'drawPile' }, { kind: 'discardPile' })
      trigger.handle(game, owner.id, { event: { id: `b71-${cardId}`, seq: game.state.seq++, name: 'CardEnteredDiscardByMove',
        payload: { cardId, reason: 'discard' } }, cancelled: false, cancel() { this.cancelled = true } })
    }
    expect(owner.characterPiles['xunli-jiping-b71']).toHaveLength(9)
    expect(game.state.zones.discardPile).toContain(blackIds[9])
  })

  it('孙翎鸾【盻睇】可把多材料牌重定归属给所选角色使用，不依赖对方拥有原转化装备', () => {
    const game = gameFor('b71-xidi-multi-material')
    const owner = game.state.players[0]!
    const user = game.state.players[1]!
    game.state.currentPlayerId = owner.id
    game.state.phase = 'play'
    const materials = game.state.zones.drawPile.slice(0, 2)
    for (const id of materials) moveCard(game.state, id, { kind: 'drawPile' }, { kind: 'hand', playerId: owner.id })
    const targetActions = skillOtherHandCardUseActions(game.state, user.id, owner.id, materials,
      '杀', 'xidi-sunlingluan-b71')
    expect(targetActions.length).toBeGreaterThan(0)
    expect(targetActions.every((action) => action.cardIds.length === 2 && action.cardIds.every((id) => materials.includes(id)))).toBe(true)
    expect(game.beginSkillCardUseFromOtherHand(user.id, owner.id, materials, 'xidi-sunlingluan-b71', targetActions[0]!.id, '杀')).toBe(true)
    expect(game.state.cardResolution).toMatchObject({ kind: 'slash', sourceId: user.id })
  })

  it('周夷【玉殒】代价为必选，且可以从目标判定区获得牌', () => {
    const game = gameFor('b71-yuyun-take-judgment')
    const owner = game.state.players[0]!
    const target = game.state.players[1]!
    owner.characterId = 'zhouyi-b71'
    const runtime = getSkillRuntime('yuyun-zhouyi-b71')!
    runtime.startQueued?.(game, owner.id, { skillId: runtime.id, ownerId: owner.id, step: 'cost', data: {} })
    expect(game.state.pendingRequests.at(-1)).toMatchObject({ kind: 'choose-option', optional: false })

    const delayedTrickId = game.state.zones.drawPile.find((id) => game.state.cards[id]?.category === 'trick'
      && game.state.cards[id]?.name !== '无懈可击')!
    moveCard(game.state, delayedTrickId, { kind: 'drawPile' }, { kind: 'judgingArea', playerId: target.id })
    game.state.skillResolution = null
    game.state.pendingRequests = []
    runtime.resume?.(game, owner.id, { kind: 'skill', skillId: runtime.id, ownerId: owner.id, step: 'take-target',
      requestId: 'b71-yuyun-target', data: { remaining: 0, selectedEffects: ['take'] }, announced: true },
    { requestId: 'b71-yuyun-target', playerId: owner.id, payload: { targetIds: [target.id] } })
    expect(game.state.pendingRequests.at(-1)).toMatchObject({ kind: 'choose-cards', cardIds: expect.arrayContaining([delayedTrickId]) })
    game.state.skillResolution = null
    game.state.pendingRequests = []
    runtime.resume?.(game, owner.id, { kind: 'skill', skillId: runtime.id, ownerId: owner.id, step: 'take-card',
      requestId: 'b71-yuyun-card', data: { targetId: target.id, remaining: 0, selectedEffects: ['take'] }, announced: true },
    { requestId: 'b71-yuyun-card', playerId: owner.id, payload: { cardIds: [delayedTrickId] } })
    expect(owner.zones.hand).toContain(delayedTrickId)
    expect(target.zones.judgingArea).not.toContain(delayedTrickId)
  })

  it('来莺儿【绡舞】选择自己摸牌时由该角色实际摸一张', () => {
    const game = gameFor('b71-xiaowu-self-draw')
    const owner = game.state.players[0]!
    const voter = game.state.players[1]!
    const before = voter.zones.hand.length
    ;(game.state as typeof game.state & { b71: { xiaowu: Record<string, unknown> } }).b71 = {
      xiaowu: { [owner.id]: { targets: [voter.id], index: 0, ownerChoices: 0, selfChoices: 0, selfTargets: [] } },
    }
    const runtime = getSkillRuntime('xiaowu-laiying-b71')!
    runtime.resume?.(game, owner.id, { kind: 'skill', skillId: runtime.id, ownerId: owner.id, step: 'vote',
      requestId: 'b71-xiaowu-vote', data: { voterId: voter.id }, announced: true },
    { requestId: 'b71-xiaowu-vote', playerId: voter.id, payload: { optionId: 'self' } })
    expect(voter.zones.hand).toHaveLength(before + 1)
  })
})
