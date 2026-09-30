import { describe, expect, it } from 'vitest'
import { beginSkillCardUseFromProcessingAs, declaredCardActions, withNextCardTargetChoices } from '@/sanguosha/engine/cards/basic'
import { advanceToNextTarget } from '@/sanguosha/engine/cards/tricks'
import { moveCard } from '@/sanguosha/engine/zones'
import { getSkillRuntime } from '@/sanguosha/engine/skills/runtime'
import { SanguoshaGame } from '@/sanguosha/engine/game'
import { ALL_CHARACTERS } from '@/sanguosha/data/characters/standard'
import { HISTORICAL_BATCH73_CHARACTERS } from '@/sanguosha/data/characters/historical-batch73'

function gameFor(seed: string): SanguoshaGame {
  const game = new SanguoshaGame({ seed, setup: { mode: 'identity', generalChoices: 1,
    players: Array.from({ length: 5 }, (_, index) => ({ id: `${seed}-${index}`, nickname: `玩家${index}`, isHuman: true })) } })
  game.state.status = 'playing'
  game.state.pendingRequests = []
  game.state.players.forEach((player) => { player.characterId = null })
  return game
}

describe('武将册第73批技能接入', () => {
  it('按武将册次序新增十名，每项技能均有运行时', () => {
    expect(HISTORICAL_BATCH73_CHARACTERS.map(({ name }) => name)).toEqual([
      '王悦', '赵嫣', '张嫙', '陈矫', '糜芳傅士仁', '李采薇', '吴范', '郝萌', '王威', '穆顺',
    ])
    expect(HISTORICAL_BATCH73_CHARACTERS.every(({ id }) => ALL_CHARACTERS.some((character) => character.id === id))).toBe(true)
    expect(new Set(HISTORICAL_BATCH73_CHARACTERS.map(({ id }) => id)).size).toBe(10)
    for (const character of HISTORICAL_BATCH73_CHARACTERS)
      for (const skill of character.skills) expect(getSkillRuntime(skill.id), `${character.name}【${skill.name}】`).toBeDefined()
  })

  it('【锦绘】从处理区让指定角色使用牌时仍走普通的恢复结算', () => {
    const game = gameFor('b73-jinhui-processing-use')
    const actor = game.state.players[0]!
    actor.hp = actor.maxHp - 1
    const peach = game.state.zones.drawPile.find((id) => game.state.cards[id]?.name === '桃')!
    moveCard(game.state, peach, { kind: 'drawPile' }, { kind: 'processingArea' })
    const started = beginSkillCardUseFromProcessingAs(game as never, {
      playerId: actor.id, cardId: peach, targetIds: [actor.id], sourceSkillId: 'jinhui-zhaoyan-b73',
      ignoreDistance: true, ignoreUsageLimits: true,
    })
    expect(started).toBe(true)
    expect(actor.hp).toBe(actor.maxHp)
    expect(game.state.zones.discardPile).toContain(peach)
  })

  it('【同礼】记录的是指定目标的额外完整效果次数', () => {
    const game = gameFor('b73-tongli-repeat-count')
    const owner = game.state.players[0]!
    const target = game.state.players[1]!
    const cardId = game.state.zones.drawPile[0]!
    const runtime = getSkillRuntime('tongli-zhangxuan-b73')!
    ;(game.state as typeof game.state & { b73: Record<string, any> }).b73 = {
      tongliRepeats: { [cardId]: { targetIds: [target.id], count: 3 } },
    }
    expect(runtime.repeatTargetEffectCount?.(game.state, owner.id, target.id, cardId)).toBe(3)
    expect(runtime.repeatTargetEffectCount?.(game.state, owner.id, owner.id, cardId)).toBe(0)
  })

  it('【同礼】按阶段累计已使用的实体牌张数后才建立可选重复记录', () => {
    const game = gameFor('b73-tongli-use-count')
    const owner = game.state.players[0]!
    const target = game.state.players[1]!
    owner.characterId = 'zhangxuan-b73'
    game.state.phase = 'play'
    const suitIds = ['spade', 'heart'].map((suit) => game.state.zones.drawPile.find((id) =>
      game.state.cards[id]?.suit === suit)!).filter(Boolean)
    owner.zones.hand = []
    for (const id of suitIds) moveCard(game.state, id, { kind: 'drawPile' }, { kind: 'hand', playerId: owner.id })
    const runtime = getSkillRuntime('tongli-zhangxuan-b73')!
    const cardId = game.state.zones.drawPile.find((id) => id !== suitIds[0] && id !== suitIds[1])!
    const event = (name: 'CardUsed' | 'TargetSpecified', payload: Record<string, unknown>) => ({
      event: { id: `b73-${name}`, seq: game.state.seq++, name, sourceId: owner.id, payload }, cancelled: false,
      cancel() { this.cancelled = true },
    })
    runtime.triggers!.find((trigger) => trigger.event === 'CardUsed')!.handle(game, owner.id,
      event('CardUsed', { cardIds: suitIds }))
    runtime.triggers!.find((trigger) => trigger.event === 'TargetSpecified')!.handle(game, owner.id,
      event('TargetSpecified', { cardId, targetIds: [target.id] }))
    expect(game.state.skillQueue.some((prompt) => prompt.skillId === runtime.id && prompt.step === 'offer')).toBe(true)
  })

  it('【同礼】令普通锦囊对当前目标的完整效果额外结算一次', () => {
    const game = gameFor('b73-tongli-trick-repeat')
    const owner = game.state.players[0]!
    const target = game.state.players[1]!
    owner.characterId = 'zhangxuan-b73'
    const cardId = game.state.zones.drawPile.find((id) => game.state.cards[id]?.name === '无中生有')!
    moveCard(game.state, cardId, { kind: 'drawPile' }, { kind: 'processingArea' })
    const before = target.zones.hand.length
    ;(game.state as typeof game.state & { b73: Record<string, any> }).b73 = {
      tongliRepeats: { [cardId]: { targetIds: [target.id], count: 1 } },
    }
    game.state.cardResolution = {
      kind: 'trick', cardId, cardName: '无中生有', sourceId: owner.id, targetIds: [target.id], targetIndex: 0,
      nullifiedTargetIds: [], cancelledTargetIds: [], unresponsiveTargetIds: [], interceptsDone: [], responderOrder: [],
      responderIndex: 0, nullificationCount: 0, declinedAllIds: [], lastNullifierId: null, requestId: null,
      effect: null, stage: 'awaiting-effect',
    }
    advanceToNextTarget(game as never)
    expect(target.zones.hand.length - before).toBe(2)
    expect(game.state.cardResolution).toBeNull()
    expect(game.state.zones.discardPile).toContain(cardId)
  })

  it('郝萌的【雄莽】成功伤害次数可累加，不被覆盖成固定一次', () => {
    const game = gameFor('b73-xiongmang-repeat-use')
    const owner = game.state.players[0]!
    owner.characterId = 'haomeng-b73'
    game.state.currentPlayerId = owner.id
    game.state.phase = 'play'
    ;(game.state as typeof game.state & { b73: Record<string, any> }).b73 = {
      xiongmangExtraUse: { [owner.id]: { turn: game.state.turnNumber, count: 3 } },
    }
    expect(getSkillRuntime('xiongmang-haomeng-b73')!.globalSlashUses?.(game.state, owner.id, owner.id)).toBe(3)
  })

  it('郝萌【雄莽】将多张不同花色材料映射为等量的【杀】目标数', () => {
    const game = gameFor('b73-xiongmang-target-count')
    const owner = game.state.players[0]!
    owner.characterId = 'haomeng-b73'
    game.state.currentPlayerId = owner.id
    game.state.phase = 'play'
    const materials = ['spade', 'heart'].map((suit) => game.state.zones.drawPile.find((id) =>
      game.state.cards[id]?.suit === suit)!).filter(Boolean)
    owner.zones.hand = []
    for (const id of materials) moveCard(game.state, id, { kind: 'drawPile' }, { kind: 'hand', playerId: owner.id })
    ;(game.state as typeof game.state & { b73: Record<string, any> }).b73 = {
      xiongmangMaterials: { [materials[0]!]: materials.length },
    }
    const actions = withNextCardTargetChoices(game.state, owner.id,
      declaredCardActions(game.state, owner.id, materials[0]!, '杀', '【雄莽】'))
      .filter((action) => action.kind === 'use-card' && action.targetIds.length === materials.length)
    expect(actions.length).toBeGreaterThan(0)
  })

  it('多名李采薇同时对同一角色发动【异教】时，牌点和每次只累计一次', () => {
    const game = gameFor('b73-yijiao-multi-owner')
    const [first, second, target] = game.state.players
    first!.characterId = 'licaiwei-b73'
    second!.characterId = 'licaiwei-b73'
    const cardId = game.state.zones.drawPile[0]!
    const cardRank = game.state.cards[cardId]!.rank
    const runtime = getSkillRuntime('yijiao-licaiwei-b73')!
    ;(game.state as typeof game.state & { b73: Record<string, any> }).b73 = {
      yijiao: {
        [first!.id]: { targetId: target!.id, threshold: 10, sum: 0, turn: game.state.turnNumber },
        [second!.id]: { targetId: target!.id, threshold: 20, sum: 0, turn: game.state.turnNumber },
      },
    }
    const context = { event: { id: 'b73-yijiao-use', seq: game.state.seq++, name: 'CardUsed' as const,
      sourceId: target!.id, payload: { cardId, cardIds: [cardId] } }, cancelled: false, cancel() { this.cancelled = true } }
    runtime.triggers!.find((trigger) => trigger.event === 'CardUsed')!.handle(game, first!.id, context)
    runtime.triggers!.find((trigger) => trigger.event === 'CardUsed')!.handle(game, second!.id, context)
    const entries = (game.state as typeof game.state & { b73: { yijiao: Record<string, { sum: number }> } }).b73.yijiao
    expect(entries[first!.id]!.sum).toBe(cardRank)
    expect(entries[second!.id]!.sum).toBe(cardRank)
  })

  it('吴范【天运】在选将后起始手牌发放完成时补齐缺失花色', () => {
    const game = gameFor('b73-tianyun-opening-hand')
    const owner = game.state.players[0]!
    owner.characterId = 'wufan-b73'
    const first = game.state.zones.drawPile[0]!
    moveCard(game.state, first, { kind: 'drawPile' }, { kind: 'hand', playerId: owner.id })
    const runtime = getSkillRuntime('tianyun-wufan-b73')!
    runtime.onGameStart!(game, owner.id)
    expect(new Set(owner.zones.hand.map((id) => game.state.cards[id]!.suit)).size).toBe(4)
  })
})
