import { describe, expect, it } from 'vitest'
import { ALL_CHARACTERS } from '@/sanguosha/data/characters/standard'
import { HISTORICAL_BATCH46_PART1, HISTORICAL_BATCH46_PART2 } from '@/sanguosha/data/characters/historical-batch46'
import { SanguoshaGame } from '@/sanguosha/engine/game'
import { getSkillRuntime } from '@/sanguosha/engine/skills/runtime'
import { moveCard } from '@/sanguosha/engine/zones'

function fixture() {
  const game = new SanguoshaGame({ seed: 'historical-b46-targeted', setup: {
    mode: 'identity', generalChoices: 1,
    players: Array.from({ length: 5 }, (_, index) => ({ id: `p${index}`, nickname: `玩家${index}`, isHuman: index === 0 })),
  } })
  const state = game.state as any
  state.status = 'playing'; state.phase = 'play'; state.currentPlayerId = 'p0'; state.normalTurnPlayerId = 'p0'; state.turnNumber = 3
  state.players.forEach((entry: any, index: number) => {
    entry.characterId = index === 0 ? 'jie-gongsunzan-b46' : 'caocao'
    entry.hp = 3; entry.maxHp = 4
    entry.zones.hand = state.zones.drawPile.splice(0, 4)
  })
  const requests: any[] = []
  const host = {
    state, rng: game.rng, dispatch: game.dispatch.bind(game),
    askSkill(options: any) { requests.push({ ...options, request: options.build(`b46-${requests.length}`) }) },
    queueSkill(prompt: any) { state.skillQueue.push(prompt) },
    beginVirtualSlash: game.beginVirtualSlash.bind(game), beginVirtualTrick: game.beginVirtualTrick.bind(game),
    resumeCardTarget: game.resumeCardTarget.bind(game), enterDying: game.enterDying.bind(game),
    resumeAfterDying: game.resumeAfterDying.bind(game),
  } as any
  return { game, state, host, requests }
}

const batch46 = [...HISTORICAL_BATCH46_PART1, ...HISTORICAL_BATCH46_PART2]

describe('武将册第46批定向规则', () => {
  it('恰好登记10名且每个技能都有运行时', () => {
    expect(batch46).toHaveLength(10)
    expect(batch46.map((character) => character.name)).toEqual([
      '界·廖化', '界·步练师', '界·刘表', '郑玄', '星·张辽', '星·甘宁', '星·徐晃',
      'SP·公孙瓒', '星·张郃', '界·公孙瓒',
    ])
    for (const character of batch46) {
      expect(ALL_CHARACTERS).toContain(character)
      for (const skill of character.skills) expect(getSkillRuntime(skill.id), `${character.name}/${skill.name}`).toBeDefined()
    }
  })

  it('SP公孙瓒义从随体力切换距离修正，界公孙瓒按体力与已损失体力计算', () => {
    const spRuntime = getSkillRuntime(HISTORICAL_BATCH46_PART2[0].skills[0].id)!
    const jieRuntime = getSkillRuntime(HISTORICAL_BATCH46_PART2[2].skills[0].id)!
    const { state } = fixture()
    state.players[0].characterId = 'sp-gongsunzan-b46'
    expect(spRuntime.distanceModifier?.toOthers?.(state, 'p0')).toBe(-1)
    expect(spRuntime.distanceModifier?.fromOthers?.(state, 'p0')).toBe(0)
    state.players[0].hp = 2
    expect(spRuntime.distanceModifier?.toOthers?.(state, 'p0')).toBe(0)
    expect(spRuntime.distanceModifier?.fromOthers?.(state, 'p0')).toBe(1)
    expect(jieRuntime.distanceModifier?.toOthers?.(state, 'p0')).toBe(-1)
    expect(jieRuntime.distanceModifier?.fromOthers?.(state, 'p0')).toBe(1)
  })

  it('星张郃知略扣体力后进入明确分支，并记录本回合手牌上限加成', () => {
    const { state, host, requests } = fixture()
    state.players[0].characterId = 'star-zhanghe-b46'
    const fieldCardId = state.zones.drawPile.shift()
    state.players[1].zones.equipment.weapon = fieldCardId
    const runtime = getSkillRuntime(HISTORICAL_BATCH46_PART2[1].skills[0].id)!
    runtime.invokeActive?.(host, 'p0', HISTORICAL_BATCH46_PART2[1].skills[0].id)
    expect(state.players[0].hp).toBe(2)
    expect(runtime.maxCardsBonus?.(state, 'p0')).toBe(1)
    expect(requests.at(-1)?.request.options.map((option: any) => option.id)).toEqual(['move', 'slash'])
    runtime.resume?.(host, 'p0', { step: 'mode', data: {} } as any, { payload: { optionId: 'slash' } } as any)
    expect(state.players[0].zones.hand.length).toBe(5)
    expect(requests.at(-1)?.request.kind).toBe('choose-targets')
  })

  it('界公孙瓒趫猛只在黑杀实际造成伤害后询问并能弃置坐骑后获得该牌', () => {
    const { state, host, requests } = fixture()
    const cardId = state.zones.drawPile.find((id: string) => state.cards[id].equipmentSlot === 'offensiveHorse')
    const blackSlash = state.zones.drawPile.find((id: string) => state.cards[id].name === '杀' && state.cards[id].color === 'black')
    expect(cardId).toBeTruthy()
    expect(blackSlash).toBeTruthy()
    state.players[1].zones.equipment.offensiveHorse = cardId
    state.zones.drawPile = state.zones.drawPile.filter((id: string) => id !== cardId)
    const runtime = getSkillRuntime(HISTORICAL_BATCH46_PART2[2].skills[1].id)!
    const trigger = runtime.triggers?.find((entry) => entry.event === 'DamageSettled')!
    trigger.handle(host, 'p0', { event: { sourceId: 'p0', targetId: 'p1', payload: { cardName: '杀', cardId: blackSlash, finalAmount: 1 } }, sourceId: 'p0', targetId: 'p1' } as any)
    const prompt = state.skillQueue.pop()
    runtime.startQueued?.(host, 'p0', prompt)
    expect(requests.at(-1)?.request.cardIds).toContain(cardId)
    runtime.resume?.(host, 'p0', { step: 'choose-equipment', data: { targetId: 'p1' } } as any, { payload: { cardIds: [cardId] } } as any)
    expect(state.players[1].zones.equipment.offensiveHorse).toBeNull()
    expect(state.players[0].zones.hand).toContain(cardId)
    expect(state.zones.discardPile).not.toContain(cardId)
  })

  it('郑玄整经通过专属划牌请求分置选择牌，并在承载者准备阶段收回且跳过判定和摸牌', () => {
    const { state, host, requests } = fixture()
    state.players[0].characterId = 'zhengxuan-b46'
    const runtime = getSkillRuntime(HISTORICAL_BATCH46_PART1[3].skills[0].id)!
    runtime.invokeActive?.(host, 'p0', HISTORICAL_BATCH46_PART1[3].skills[0].id)
    const selectRequest = requests.at(-1)?.request
    expect(selectRequest.interaction).toEqual({ kind: 'zhengxuan-slice' })
    expect(selectRequest.cardIds).toHaveLength(5)
    const selectedId = selectRequest.cardIds[0]
    runtime.resume?.(host, 'p0', { step: 'select', data: { cards: selectRequest.cardIds } } as any, { payload: { cardIds: [selectedId] } } as any)
    expect(state.players[0].zones.hand).toContain(selectRequest.cardIds[1])
    runtime.resume?.(host, 'p0', { step: 'target', data: { selected: [selectedId] } } as any, { payload: { targetIds: ['p1'] } } as any)
    expect(state.players[1].characterPiles['jing-b46']).toEqual([selectedId])
    const prepare = runtime.triggers?.find((entry) => entry.event === 'PhaseStart')!
    prepare.handle(host, 'p0', { event: { payload: { playerId: 'p1', phase: 'prepare' } } } as any)
    expect(state.players[1].characterPiles['jing-b46']).toEqual([])
    expect(state.players[1].zones.hand).toContain(selectedId)
    expect(state.skippedPhases).toEqual(expect.arrayContaining(['judge', 'draw']))
  })

  it('星张辽威风清理所有持有者可见惧标记', () => {
    const { state, host } = fixture()
    const runtime = getSkillRuntime(HISTORICAL_BATCH46_PART1[4].skills[0].id)!
    const afterUse = runtime.triggers?.find((entry) => entry.event === 'AfterCardUse')!
    afterUse.handle(host, 'p0', { event: { sourceId: 'p0', payload: { cardName: '杀', targetIds: ['p1'] } }, sourceId: 'p0' } as any)
    const prompt = state.skillQueue.pop()
    expect(prompt).toBeTruthy()
    runtime.resume?.(host, 'p0', { step: 'target', data: { cardName: '杀' } } as any, { payload: { targetIds: ['p1'] } } as any)
    expect(state.players[1].marks['fear:p0']).toBeTruthy()
    expect(runtime.globalOutgoingDamage?.(state, 'p0', 'p0', { targetId: 'p1', cardId: 'slash-test', cardName: '杀', amount: 1 } as any)).toEqual({ amount: 2 })
    const settled = runtime.triggers?.find((entry) => entry.event === 'DamageSettled')!
    settled.handle(host, 'p0', { event: { targetId: 'p1', payload: { finalAmount: 2, cardName: '杀' } }, targetId: 'p1' } as any)
    expect(state.players[1].marks['fear:p0']).toBeUndefined()
    expect(state.skillQueue).toHaveLength(0)
    runtime.resume?.(host, 'p0', { step: 'target', data: { cardName: '决斗' } } as any, { payload: { targetIds: ['p1'] } } as any)
    expect(state.skillQueue).toHaveLength(0)
    // 已消费本出牌阶段的首次指定，不会因“惧”被移除而再次触发。
    afterUse.handle(host, 'p0', { event: { sourceId: 'p0', payload: { cardName: '决斗', targetIds: ['p2'] } }, sourceId: 'p0' } as any)
    expect(state.skillQueue).toHaveLength(0)
  })

  it('星张辽威风在准备阶段清理仍存续的惧状态', () => {
    const { state, host } = fixture()
    const runtime = getSkillRuntime(HISTORICAL_BATCH46_PART1[4].skills[0].id)!
    runtime.resume?.(host, 'p0', { step: 'target', data: { cardName: '杀' } } as any, { payload: { targetIds: ['p1'] } } as any)
    expect(state.players[1].marks['fear:p0']).toBeTruthy()
    const prepare = runtime.triggers?.find((entry) => entry.event === 'PhaseStart')!
    prepare.handle(host, 'p0', { event: { payload: { playerId: 'p0', phase: 'prepare' } } } as any)
    expect(state.players[1].marks['fear:p0']).toBeUndefined()
  })

  it('星甘宁锦帆逐次存铃、提供手牌转化，并在离开武将牌后获得同花色牌', () => {
    const { state, host } = fixture()
    state.players[0].characterId = 'star-ganning-b46'
    const bell = state.zones.drawPile.find((id: string) => state.cards[id].suit === 'heart')
    expect(bell).toBeTruthy()
    state.zones.drawPile.splice(state.zones.drawPile.indexOf(bell), 1)
    state.players[0].zones.hand = [bell]
    const skill = HISTORICAL_BATCH46_PART1[5].skills[0]
    const runtime = getSkillRuntime(skill.id)!
    runtime.startQueued?.(host, 'p0', { step: 'store', data: {} } as any)
    runtime.resume?.(host, 'p0', { step: 'choose-store', data: {} } as any, { payload: { cardIds: [bell] } } as any)
    expect(state.players[0].characterPiles[skill.id]).toContain(bell)
    expect(runtime.viewAs?.(state, 'p0')?.some((entry: any) => entry.cardId === bell)).toBe(true)
    const matchingBefore = state.players[0].zones.hand.filter((id: string) => state.cards[id].suit === 'heart').length
    moveCard(state, bell, { kind: 'characterPile', playerId: 'p0', pile: skill.id }, { kind: 'discardPile' })
    const moved = runtime.triggers?.find((entry) => entry.event === 'CardMove')!
    moved.handle(host, 'p0', { event: { payload: { cardIds: [bell] } } } as any)
    expect(state.players[0].zones.hand.filter((id: string) => state.cards[id].suit === 'heart').length).toBe(matchingBefore + 1)
  })

  it('星徐晃治严的摸牌封锁与交牌分支分别按手牌条件正确执行', () => {
    const drawCase = fixture()
    drawCase.state.players[0].characterId = 'star-xuhuang-b46'
    drawCase.state.players[0].zones.hand.splice(1)
    const runtime = getSkillRuntime(HISTORICAL_BATCH46_PART1[6].skills[0].id)!
    const drawAction = runtime.activeActions?.(drawCase.state, 'p0')?.[0]
    expect(drawAction).toBeTruthy()
    runtime.invokeActive?.(drawCase.host, 'p0', drawAction!.id)
    expect(drawCase.state.players[0].zones.hand).toHaveLength(drawCase.state.players[0].maxHp)
    expect(runtime.prohibitsSourceTarget?.(drawCase.state, 'p0', 'p1')).toBe(true)

    const giveCase = fixture()
    giveCase.state.players[0].characterId = 'star-xuhuang-b46'
    giveCase.state.players[0].hp = 3
    giveCase.state.players[0].zones.hand.push(...giveCase.state.zones.drawPile.splice(0, 2))
    const giveAction = runtime.activeActions?.(giveCase.state, 'p0')?.find((action) => action.id.endsWith(':give'))
    expect(giveAction).toBeTruthy()
    runtime.invokeActive?.(giveCase.host, 'p0', giveAction!.id)
    runtime.resume?.(giveCase.host, 'p0', { step: 'give-target', data: { count: 3 } } as any, { payload: { targetIds: ['p1'] } } as any)
    const chosen = giveCase.state.players[0].zones.hand.slice(0, 3)
    runtime.resume?.(giveCase.host, 'p0', { step: 'give-cards', data: { targetId: 'p1', count: 3 } } as any, { payload: { cardIds: chosen } } as any)
    expect(giveCase.state.players[0].zones.hand).toHaveLength(3)
    expect(giveCase.state.players[1].zones.hand.filter((id: string) => chosen.includes(id))).toHaveLength(3)
  })
})
