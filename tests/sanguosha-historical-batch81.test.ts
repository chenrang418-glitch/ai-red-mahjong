import { describe, expect, it } from 'vitest'
import { SanguoshaGame } from '@/sanguosha/engine/game'
import { getSkillRuntime } from '@/sanguosha/engine/skills/runtime'
import { ALL_CHARACTERS } from '@/sanguosha/data/characters/standard'
import { HISTORICAL_BATCH81_CHARACTERS } from '@/sanguosha/data/characters/historical-batch81'
import { pushCardUseTargets } from '@/sanguosha/engine/card-use-targets'
import { moveCard } from '@/sanguosha/engine/zones'

function gameFor(seed: string): SanguoshaGame {
  const game = new SanguoshaGame({ seed, setup: { mode: 'identity', generalChoices: 1,
    players: Array.from({ length: 5 }, (_, index) => ({ id: `${seed}-${index}`, nickname: `玩家${index}`, isHuman: true })) } })
  game.state.status = 'playing'
  game.state.pendingRequests = []
  game.state.players.forEach((entry) => { entry.characterId = null })
  return game
}

function pendingOriginalTrick(game: SanguoshaGame, ownerId: string, targetIds: string[]) {
  const cardId = game.state.zones.drawPile.find((id) => game.state.cards[id]?.name === '决斗')!
  moveCard(game.state, cardId, { kind: 'drawPile' }, { kind: 'processingArea' })
  pushCardUseTargets(game.state, { cardId, sourceId: ownerId, targetIds })
  game.state.cardResolution = {
    kind: 'trick', cardId, cardName: '决斗', sourceId: ownerId, targetIds, targetIndex: 0,
    nullifiedTargetIds: [], cancelledTargetIds: [], unresponsiveTargetIds: [], interceptsDone: [],
    stage: 'awaiting-intercept', responderOrder: [], responderIndex: 0, nullificationCount: 0,
    declinedAllIds: [], lastNullifierId: null, requestId: null, effect: null,
  }
  return cardId
}

function pendingOriginalSlash(game: SanguoshaGame, ownerId: string, targetIds: string[]) {
  const cardId = game.state.zones.drawPile.find((id) => game.state.cards[id]?.name === '杀')!
  moveCard(game.state, cardId, { kind: 'drawPile' }, { kind: 'processingArea' })
  pushCardUseTargets(game.state, { cardId, sourceId: ownerId, targetIds })
  const [targetId, ...remainingTargetIds] = targetIds
  game.state.cardResolution = {
    kind: 'slash', cardId, sourceId: ownerId, targetId: targetId!, remainingTargetIds,
    damageNature: 'normal', damageAmount: 1, usageCounted: true, stage: 'awaiting-intercept',
    interceptsDone: [], extraCardIds: [], requestId: null, dodgeRemaining: 1,
    noDodge: false, targetCancelled: false, surrogate: null,
  }
  return cardId
}

describe('武将册第81批运行时', () => {
  it('十名武将均注册，且每项技能均绑定运行时', () => {
    expect(HISTORICAL_BATCH81_CHARACTERS).toHaveLength(10)
    expect(new Set(HISTORICAL_BATCH81_CHARACTERS.map(({ id }) => id)).size).toBe(10)
    for (const character of HISTORICAL_BATCH81_CHARACTERS) {
      expect(ALL_CHARACTERS.some(({ id }) => id === character.id), character.name).toBe(true)
      for (const skill of character.skills) expect(getSkillRuntime(skill.id), `${character.name}/${skill.name}`).toBeDefined()
    }
  })

  it('【乘烟】展示【杀】时以原目标集合完整替换原锦囊效果，并只收束原实体牌一次', () => {
    const game = gameFor('b81-chengyan-slash')
    const owner = game.state.players[0]!
    const firstTarget = game.state.players[1]!
    const secondTarget = game.state.players[2]!
    owner.characterId = 'le-zhugeguo-b81'
    game.state.currentPlayerId = owner.id
    game.state.phase = 'play'
    const originalCardId = pendingOriginalTrick(game, owner.id, [firstTarget.id, secondTarget.id])
    const slashId = game.state.zones.drawPile.find((id) => game.state.cards[id]?.name === '杀')!
    game.state.zones.drawPile = [slashId, ...game.state.zones.drawPile.filter((id) => id !== slashId)]

    const runtime = getSkillRuntime('chengyan-le-zhugeguo-b81')!
    expect(runtime.interceptSourceTarget!(game as never, owner.id, {
      sourceId: owner.id, targetId: firstTarget.id, cardId: originalCardId, cardName: '决斗', category: 'trick',
    })).toBe(true)
    const invoke = game.state.pendingRequests[0]!
    game.respond({ requestId: invoke.id, playerId: owner.id, payload: { optionId: 'invoke' } })
    expect(game.state.cardResolution).toMatchObject({ kind: 'slash', effectReplacement: true,
      cardId: originalCardId, sourceId: owner.id, targetId: firstTarget.id, remainingTargetIds: [secondTarget.id], usageCounted: false })
    expect(game.state.suspendedCardEffectResolution).toMatchObject({ kind: 'trick', cardId: originalCardId, cardName: '决斗' })

    for (let guard = 0; game.state.cardResolution?.effectReplacement && guard < 4; guard += 1) {
      const request = game.state.pendingRequests[0]
      if (!request) break
      game.respond({ requestId: request.id, playerId: request.playerId, payload: { actionId: 'respond-pass' } })
    }
    expect(game.state.cardResolution).toBeNull()
    expect(game.state.suspendedCardEffectResolution).toBeNull()
    expect(game.state.zones.discardPile).toContain(originalCardId)
    expect(game.state.turnUsage.slashUses).toBe(0)
    expect(firstTarget.hp).toBeLessThan(firstTarget.maxHp)
    expect(secondTarget.hp).toBeLessThan(secondTarget.maxHp)
  })

  it('【乘烟】在全场锦囊首先指定自身时，也会在首个目标效果前询问一次', () => {
    const game = gameFor('b81-chengyan-self-first')
    const owner = game.state.players[0]!
    const other = game.state.players[1]!
    owner.characterId = 'le-zhugeguo-b81'
    game.state.currentPlayerId = owner.id
    game.state.phase = 'play'
    const originalCardId = pendingOriginalTrick(game, owner.id, [owner.id, other.id])
    const runtime = getSkillRuntime('chengyan-le-zhugeguo-b81')!
    expect(runtime.interceptSourceTarget!(game as never, owner.id, {
      sourceId: owner.id, targetId: owner.id, cardId: originalCardId, cardName: '桃园结义', category: 'trick',
    })).toBe(true)
    expect(game.state.pendingRequests[0]?.prompt).toContain('乘烟')
    expect(game.state.cardResolution).toMatchObject({ kind: 'trick', cardId: originalCardId, targetIndex: 0 })
  })

  it('【乘烟】展示普通锦囊时也能替换【杀】效果，锦囊只作用于原目标集合', () => {
    const game = gameFor('b81-chengyan-trick')
    const owner = game.state.players[0]!
    const firstTarget = game.state.players[1]!
    const secondTarget = game.state.players[2]!
    owner.characterId = 'le-zhugeguo-b81'
    game.state.currentPlayerId = owner.id
    game.state.phase = 'play'
    owner.hp -= 1
    firstTarget.hp -= 1
    secondTarget.hp -= 1
    const originalCardId = pendingOriginalSlash(game, owner.id, [firstTarget.id, secondTarget.id])
    const peachGardenId = game.state.zones.drawPile.find((id) => game.state.cards[id]?.name === '桃园结义')!
    game.state.zones.drawPile = [peachGardenId, ...game.state.zones.drawPile.filter((id) => id !== peachGardenId)]
    const runtime = getSkillRuntime('chengyan-le-zhugeguo-b81')!
    runtime.interceptSourceTarget!(game as never, owner.id, {
      sourceId: owner.id, targetId: firstTarget.id, cardId: originalCardId, cardName: '杀', category: 'basic',
    })
    const invoke = game.state.pendingRequests[0]!
    game.respond({ requestId: invoke.id, playerId: owner.id, payload: { optionId: 'invoke' } })

    expect(game.state.cardResolution).toBeNull()
    expect(firstTarget.hp).toBe(firstTarget.maxHp)
    expect(secondTarget.hp).toBe(secondTarget.maxHp)
    expect(owner.hp).toBeLessThan(owner.maxHp)
    expect(game.state.zones.discardPile).toContain(originalCardId)
  })

  it('【乘烟】展示非【杀】且非普通锦囊后额外摸一张并将后者记为“笛”', () => {
    const game = gameFor('b81-chengyan-mark')
    const owner = game.state.players[0]!
    const target = game.state.players[1]!
    owner.characterId = 'le-zhugeguo-b81'
    game.state.currentPlayerId = owner.id
    game.state.phase = 'play'
    const originalCardId = pendingOriginalTrick(game, owner.id, [target.id])
    const invalidId = game.state.zones.drawPile.find((id) => game.state.cards[id]?.name === '闪')!
    const taggedId = game.state.zones.drawPile.find((id) => id !== invalidId && game.state.cards[id]?.name !== '杀'
      && game.state.cards[id]?.category !== 'trick')!
    game.state.zones.drawPile = [invalidId, taggedId, ...game.state.zones.drawPile.filter((id) => id !== invalidId && id !== taggedId)]
    const runtime = getSkillRuntime('chengyan-le-zhugeguo-b81')!
    runtime.interceptSourceTarget!(game as never, owner.id, {
      sourceId: owner.id, targetId: target.id, cardId: originalCardId, cardName: '决斗', category: 'trick',
    })
    const invoke = game.state.pendingRequests[0]!
    game.respond({ requestId: invoke.id, playerId: owner.id, payload: { optionId: 'invoke' } })

    expect(owner.zones.hand).toContain(invalidId)
    expect(owner.zones.hand).toContain(taggedId)
    expect((game.state as never as { b81: { xidiCards: Record<string, string[]> } }).b81.xidiCards[owner.id]).toContain(taggedId)
    expect((game.state as never as { b81: { xidiCards: Record<string, string[]> } }).b81.xidiCards[owner.id]).not.toContain(invalidId)
    expect(game.state.cardResolution?.cardId).toBe(originalCardId)
  })

  it('【乘烟】展示【无懈可击】时不生成无效替代牌效，也不触发失败补摸', () => {
    const game = gameFor('b81-chengyan-nullification')
    const owner = game.state.players[0]!
    const target = game.state.players[1]!
    owner.characterId = 'le-zhugeguo-b81'
    game.state.currentPlayerId = owner.id
    game.state.phase = 'play'
    const originalCardId = pendingOriginalTrick(game, owner.id, [target.id])
    const nullificationId = game.state.zones.drawPile.find((id) => game.state.cards[id]?.name === '无懈可击')!
    const nextId = game.state.zones.drawPile.find((id) => id !== nullificationId)!
    game.state.zones.drawPile = [nullificationId, nextId, ...game.state.zones.drawPile.filter((id) => id !== nullificationId && id !== nextId)]
    const runtime = getSkillRuntime('chengyan-le-zhugeguo-b81')!
    runtime.interceptSourceTarget!(game as never, owner.id, {
      sourceId: owner.id, targetId: target.id, cardId: originalCardId, cardName: '决斗', category: 'trick',
    })
    const invoke = game.state.pendingRequests[0]!
    game.respond({ requestId: invoke.id, playerId: owner.id, payload: { optionId: 'invoke' } })

    expect(owner.zones.hand).toContain(nullificationId)
    expect(game.state.zones.drawPile[0]).toBe(nextId)
    expect((game.state as never as { b81?: { xidiCards?: Record<string, string[]> } }).b81?.xidiCards?.[owner.id] ?? []).not.toContain(nextId)
    expect(game.state.cardResolution?.cardId).toBe(originalCardId)
  })

  it('【荡尘】能在普通锦囊的每个目标处发动，且上一出牌阶段状态不会泄漏到额外阶段', () => {
    const game = gameFor('b81-dangchen-phase')
    const owner = game.state.players[0]!
    const target = game.state.players[2]!
    owner.characterId = 'xing-dingfeng-b81'
    game.state.currentPlayerId = owner.id
    game.state.phase = 'play'
    const runtime = getSkillRuntime('dangchen-xing-dingfeng-b81')!
    const phaseStart = runtime.triggers!.find(({ event }) => event === 'PhaseStart')!
    phaseStart.handle(game as never, owner.id, { event: { seq: 700, payload: { playerId: owner.id, phase: 'play' } } } as never)
    ;(game.state as never as { b81: Record<string, any> }).b81.dangchen = {
      [owner.id]: { turn: game.state.turnNumber, phaseId: 700, targetId: target.id, count: 2 },
    }
    const context = { sourceId: owner.id, targetId: target.id, cardId: 'test-card', cardName: '决斗', category: 'trick' as const }
    expect(runtime.interceptSourceTargetEach!(game as never, owner.id, context)).toBe(true)
    const invocation = game.state.pendingRequests.at(-1)!
    expect(invocation.prompt).toContain('荡尘')

    phaseStart.handle(game as never, owner.id, { event: { seq: 701, payload: { playerId: owner.id, phase: 'play' } } } as never)
    ;(game.state as never as { b81: Record<string, any> }).b81.dangchen[owner.id].phaseId = 700
    expect(runtime.interceptSourceTargetEach!(game as never, owner.id, context)).toBe(false)
  })

  it('【御麾】不会在【斡衡】本回合失效后再发起交牌邀请', () => {
    const game = gameFor('b81-yuhui-disabled')
    const owner = game.state.players[0]!
    const target = game.state.players[1]!
    owner.characterId = 'wei-sunquan-b81'
    game.state.currentPlayerId = target.id
    game.state.phase = 'play'
    ;(game.state as never as { b81: Record<string, any> }).b81 = {
      yuhuiTarget: { [target.id]: [owner.id] },
      wohengDisabled: { [owner.id]: game.state.turnNumber },
    }
    const runtime = getSkillRuntime('yuhui-wei-sunquan-b81')!
    runtime.triggers!.find(({ event }) => event === 'PhaseStart')!.handle(game as never, owner.id,
      { event: { seq: 800, payload: { playerId: target.id, phase: 'play' } } } as never)
    expect(game.state.skillQueue.some(({ skillId }) => skillId === 'yuhui-wei-sunquan-b81')).toBe(false)
    expect((game.state as never as { b81: Record<string, any> }).b81.yuhuiTarget[target.id]).toBeUndefined()
  })
})
