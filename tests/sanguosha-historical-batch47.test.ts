import { describe, expect, it } from 'vitest'
import { SanguoshaGame } from '@/sanguosha/engine/game'
import { getSkillRuntime } from '@/sanguosha/engine/skills/runtime'
import { legalPlayActions } from '@/sanguosha/engine/cards/basic'
import { handleEquipmentLost } from '@/sanguosha/engine/equipment'
import { equipmentSkillIdsOf } from '@/sanguosha/engine/skills/runtime'
import { moveCard } from '@/sanguosha/engine/zones'
import { ALL_CHARACTERS } from '@/sanguosha/data/characters/standard'
import { B47_CHEN_QUN, B47_FU_HUANGHOU, B47_GONGSUN_KANG, B47_GUOHUAI, B47_JIANYONG, B47_MANCHONG, B47_NANHUA_LAOXIAN, B47_ZHU_RAN, B47_YU_FAN, B47_WANGFU_ZHAOLEI, HISTORICAL_BATCH47_CHARACTERS } from '@/sanguosha/data/characters/historical-batch47'

function fixture() {
  const game = new SanguoshaGame({ seed: 'historical-b47-targeted', setup: {
    mode: 'identity', generalChoices: 1,
    players: Array.from({ length: 5 }, (_, index) => ({ id: `p${index}`, nickname: `玩家${index}`, isHuman: index === 0 })),
  } })
  const state = game.state as any
  state.status = 'playing'; state.phase = 'finish'; state.currentPlayerId = 'p0'; state.normalTurnPlayerId = 'p0'; state.turnNumber = 7
  state.players.forEach((entry: any, index: number) => {
    entry.characterId = index === 0 ? B47_GUOHUAI.id : 'caocao'
    entry.hp = 2; entry.maxHp = 4
    entry.zones.hand = state.zones.drawPile.splice(0, 4)
  })
  const requests: any[] = []
  const host = {
    state, rng: game.rng, dispatch: game.dispatch.bind(game),
    askSkill(options: any) { requests.push({ ...options, request: options.build(`b47-${requests.length}`) }) },
    queueSkill(prompt: any) { state.skillQueue.push(prompt) },
    beginVirtualSlash: game.beginVirtualSlash.bind(game), beginVirtualTrick: game.beginVirtualTrick.bind(game),
    resumeCardTarget: game.resumeCardTarget.bind(game), enterDying: game.enterDying.bind(game),
    resumeAfterDying: game.resumeAfterDying.bind(game),
  } as any
  return { game, state, host, requests }
}

describe('武将册第47批定向规则（持续开发）', () => {
  it('公孙康【讨灭】由自身运行时完整接管标记、夺牌和转交流程', () => {
    const { state, host, requests } = fixture()
    state.players[0].characterId = B47_GONGSUN_KANG.id
    const [julia, taomie] = B47_GONGSUN_KANG.skills.map((skill) => getSkillRuntime(skill.id))
    expect(julia?.distanceModifier).toBeDefined()
    expect(taomie, '【讨灭】必须有独立运行时以接续其排队交互').toBeDefined()

    const runtime = taomie!
    const afterDamage = runtime.triggers?.find((trigger) => trigger.event === 'AfterDamage')!
    afterDamage.handle(host, 'p0', { event: { sourceId: 'p0', targetId: 'p1', payload: {} } } as any)
    const markPrompt = state.skillQueue.pop()!
    expect(markPrompt.skillId).toBe(B47_GONGSUN_KANG.skills[1].id)
    runtime.startQueued?.(host, 'p0', markPrompt)
    runtime.resume?.(host, 'p0', { step: 'set-mark', data: { targetId: 'p1' } } as any,
      { payload: { optionId: 'yes' } } as any)
    expect(state.players[1].marks[`${B47_GONGSUN_KANG.skills[1].id}:mark`]).toBe(1)

    const gainedId = state.players[1].zones.hand[0]
    const pickedId = state.cards[gainedId].id
    state.players[0].marks[`${B47_GONGSUN_KANG.skills[1].id}:pending:p1:followup`] = 1
    afterDamage.handle(host, 'p0', { event: { sourceId: 'p0', targetId: 'p1', payload: { cardId: 'followup' } } } as any)
    const gainPrompt = state.skillQueue.pop()!
    expect(gainPrompt).toMatchObject({ skillId: B47_GONGSUN_KANG.skills[1].id, step: 'gain-card' })
    runtime.startQueued?.(host, 'p0', gainPrompt)
    runtime.resume?.(host, 'p0', { step: 'gain-card', data: { targetId: 'p1' } } as any,
      { payload: { cardIds: [pickedId] } } as any)
    expect(state.players[0].zones.hand).toContain(gainedId)
    expect(requests.at(-1)?.request.kind).toBe('choose-targets')
    runtime.resume?.(host, 'p0', { step: 'give-card', data: { cardId: gainedId } } as any,
      { payload: { targetIds: ['p2'] } } as any)
    expect(state.players[0].zones.hand).not.toContain(gainedId)
    expect(state.players[2].zones.hand).toContain(gainedId)
  })

  it('界郭淮精策只累计本回合因使用或响应进入弃牌堆的牌，并在结束阶段按当前体力检查', () => {
    const { state, host, requests } = fixture()
    const runtime = getSkillRuntime(B47_GUOHUAI.skills[0].id)!
    const physicalCardId = state.zones.drawPile.shift()
    state.cards[physicalCardId].virtual = false
    state.zones.discardPile.push(physicalCardId)
    runtime.triggers?.find((trigger) => trigger.event === 'CardResolved')?.handle(host, 'p0', {
      event: { sourceId: 'p0', payload: { cardId: physicalCardId, virtual: false } }, sourceId: 'p0',
    } as any)
    const responseCardId = state.zones.drawPile.shift()
    state.zones.discardPile.push(responseCardId)
    runtime.triggers?.find((trigger) => trigger.event === 'CardEnteredDiscard')?.handle(host, 'p0', {
      event: { payload: { playerId: 'p0', cardId: responseCardId, reason: 'response' } },
    } as any)
    runtime.triggers?.find((trigger) => trigger.event === 'PhaseEnd')?.handle(host, 'p0', {
      event: { payload: { playerId: 'p0', phase: 'finish' } },
    } as any)
    expect(requests.at(-1)?.request.kind).toBe('choose-option')
    const handBefore = state.players[0].zones.hand.length
    runtime.resume?.(host, 'p0', { step: 'draw', data: {} } as any, { payload: { optionId: 'yes' } } as any)
    expect(state.players[0].zones.hand.length).toBe(handBefore + 2)
  })

  it('界朱然记录每次成为他人牌目标的次数；计数为零时结束阶段摸牌', () => {
    const { state, host } = fixture()
    state.players[0].characterId = B47_ZHU_RAN.id
    state.currentPlayerId = 'p1'
    const runtime = getSkillRuntime(B47_ZHU_RAN.skills[0].id)!
    const before = state.players[0].zones.hand.length
    runtime.triggers?.find((trigger) => trigger.event === 'PhaseEnd')?.handle(host, 'p0', {
      event: { payload: { playerId: 'p1', phase: 'finish' } },
    } as any)
    expect(state.players[0].zones.hand.length).toBe(before + 1)
  })

  it('界满宠峻刑允许零张弃牌，并按目标选择执行失去体力分支', () => {
    const { state, host, requests } = fixture()
    const runtime = getSkillRuntime(B47_MANCHONG.skills[0].id)!
    runtime.invokeActive?.(host, 'p0', B47_MANCHONG.skills[0].id)
    runtime.resume?.(host, 'p0', { step: 'cost', data: {} } as any, { payload: { cardIds: [] } } as any)
    runtime.resume?.(host, 'p0', { step: 'target', data: { cardCount: 0 } } as any, { payload: { targetIds: ['p1'] } } as any)
    expect(requests.at(-1)?.request.options.map((option: any) => option.id)).toEqual(['discard-lose-hp', 'turn-draw'])
    runtime.resume?.(host, 'p0', { step: 'choice', data: { targetId: 'p1', cardCount: 0 } } as any, { payload: { optionId: 'discard-lose-hp' } } as any)
    runtime.resume?.(host, 'p0', { step: 'target-discard', data: { targetId: 'p1', cardCount: 0 } } as any, { payload: { cardIds: [] } } as any)
    expect(state.players[1].hp).toBe(1)
  })

  it('界虞翻出牌阶段纵玄摸牌后必须将手牌置于牌堆顶', () => {
    const { state, host, requests } = fixture()
    state.phase = 'play'
    const runtime = getSkillRuntime(B47_YU_FAN.skills[0].id)!
    runtime.invokeActive?.(host, 'p0', B47_YU_FAN.skills[0].id)
    expect(requests.at(-1)?.request.min).toBe(1)
    const chosen = requests.at(-1)?.request.cardIds[0]
    runtime.resume?.(host, 'p0', { step: 'place-top', data: {} } as any, { payload: { cardIds: [chosen] } } as any)
    expect(state.zones.drawPile[0]).toBe(chosen)
    expect(state.players[0].zones.hand).not.toContain(chosen)
  })

  it('王甫赵累殉义开局选义标记；受伤按伤害点数逐张弃牌，标记者死亡可移标', () => {
    const { state, host, requests } = fixture()
    const runtime = getSkillRuntime(B47_WANGFU_ZHAOLEI.skills[0].id)!
    runtime.triggers?.find((trigger) => trigger.event === 'GameStart')?.handle(host, 'p0', { event: { payload: {} } } as any)
    const initial = state.skillQueue.pop()
    runtime.startQueued?.(host, 'p0', initial)
    runtime.resume?.(host, 'p0', { step: 'choose-partner', data: {} } as any, { payload: { targetIds: ['p1'] } } as any)
    expect(state.players[1].marks['xunyi-mark-b47']).toBe(1)

    const before = state.players[1].zones.hand.length
    runtime.triggers?.find((trigger) => trigger.event === 'AfterDamage')?.handle(host, 'p0', {
      event: { sourceId: 'p2', targetId: 'p0', payload: { amount: 2 } }, sourceId: 'p2', targetId: 'p0',
    } as any)
    const queued = state.skillQueue.pop()
    runtime.startQueued?.(host, 'p0', queued)
    for (let index = 0; index < 2; index += 1) {
      const currentRequest = requests.at(-1)?.request
      expect(currentRequest.playerId).toBe('p1')
      const cardId = state.players[1].zones.hand[0]
      runtime.resume?.(host, 'p0', { step: 'discard-partner-card', data: { playerId: 'p1', remaining: 2 - index } } as any,
        { payload: { cardIds: [cardId] } } as any)
    }
    expect(state.players[1].zones.hand.length).toBe(before - 2)

    state.players[1].alive = false
    runtime.triggers?.find((trigger) => trigger.event === 'Death')?.handle(host, 'p0', { event: { targetId: 'p1', payload: {} }, targetId: 'p1' } as any)
    const movePrompt = state.skillQueue.pop()
    runtime.startQueued?.(host, 'p0', movePrompt)
    runtime.resume?.(host, 'p0', { step: 'move-mark', data: { candidateIds: ['p2', 'p3', 'p4'] } } as any, { payload: { targetIds: ['p2'] } } as any)
    expect(state.players[2].marks['xunyi-mark-b47']).toBe(1)
  })

  it('界陈群没有本回合可选目标时不先弃置定品成本牌', () => {
    const { state, host, requests } = fixture()
    state.players[0].characterId = B47_CHEN_QUN.id
    const costCardId = state.players[0].zones.hand[0]
    for (const target of state.players) state.players[0].marks[`dingpin-b47:black-target:${target.id}`] = state.turnNumber
    const runtime = getSkillRuntime(B47_CHEN_QUN.skills[0].id)!
    runtime.invokeActive?.(host, 'p0', B47_CHEN_QUN.skills[0].id)
    expect(requests).toHaveLength(0)
    expect(state.players[0].zones.hand).toContain(costCardId)
    expect(state.zones.discardPile).not.toContain(costCardId)
  })

  it('界简雍巧说获胜状态为下一张基本牌生成无距离额外目标动作', () => {
    const { state } = fixture()
    state.players[0].characterId = B47_JIANYONG.id
    state.phase = 'play'
    state.players[0].marks['qiaoshuo-b47:bonus'] = 1
    const slashId = state.players[0].zones.hand[0]
    state.cards[slashId] = { ...state.cards[slashId], id: slashId, name: '杀', category: 'basic',
      suit: 'spade', rank: 7, color: 'black' }
    const actions = legalPlayActions(state, 'p0')
    expect(actions.some((action: any) => action.kind === 'use-card' && action.asCardName === '杀'
      && action.targetIds.length === 2 && action.label.includes('巧说') && action.targetIds.includes('p1'))).toBe(true)
  })

  it('界伏皇后求援可选择攻击范围外的援助角色', () => {
    const { state, host, requests } = fixture()
    state.players[1].characterId = B47_FU_HUANGHOU.id
    const cardId = state.zones.drawPile[0]
    state.cardResolution = { kind: 'slash', sourceId: 'p0', targetId: 'p1', cardId,
      remainingTargetIds: [], resolvedTargetIds: [], damageNature: 'normal', damageAmount: 1,
      stage: 'awaiting-dodge', interceptsDone: [], extraCardIds: [], requestId: null, dodgeRemaining: 1, surrogate: null }
    const runtime = getSkillRuntime(B47_FU_HUANGHOU.skills[1].id)!
    expect(runtime.interceptTarget?.(host, 'p1', { sourceId: 'p0', targetId: 'p1', cardName: '杀', cardId } as any)).toBe(true)
    expect(requests.at(-1)?.request.candidateIds).toContain('p3')
  })

  it('南华老仙御风由服务器记分；碰撞失败摸当前已取得的分数', () => {
    const { state, host, requests } = fixture()
    state.players[0].characterId = B47_NANHUA_LAOXIAN.id
    state.phase = 'play'
    const runtime = getSkillRuntime(B47_NANHUA_LAOXIAN.skills[0].id)!
    runtime.invokeActive?.(host, 'p0', B47_NANHUA_LAOXIAN.skills[0].id)
    expect(requests.at(-1)?.request.interaction.kind).toBe('nanhua-flight')
    const before = state.players[0].zones.hand.length
    runtime.resume?.(host, 'p0', { step: 'flight', data: {
      frame: 17, y: 2, velocity: 0, score: 1, maxScore: 1, gaps: { '18': 0 }, stars: {}, obstacles: [18],
    } } as any, { payload: { optionId: 'glide' } } as any)
    expect(state.players[0].zones.hand.length).toBe(before + 1)
    expect(state.players[0].marks['yufeng-nanhua-b47:level']).toBe(1)
  })

  it('南华老仙飞行成功后按未分配分数补摸牌', () => {
    const { state, host, requests } = fixture()
    state.players[0].characterId = B47_NANHUA_LAOXIAN.id
    state.phase = 'play'
    const runtime = getSkillRuntime(B47_NANHUA_LAOXIAN.skills[0].id)!
    const before = state.players[0].zones.hand.length
    runtime.resume?.(host, 'p0', { step: 'flight', data: {
      frame: 17, y: 2, velocity: 0, score: 1, maxScore: 1, gaps: { '18': 2 }, stars: {}, obstacles: [18],
    } } as any, { payload: { optionId: 'glide' } } as any)
    expect(requests.at(-1)?.request.kind).toBe('choose-targets')
    runtime.resume?.(host, 'p0', { step: 'targets', data: { score: 1 } } as any, { payload: { targetIds: [] } } as any)
    expect(state.players[0].zones.hand.length).toBe(before + 1)
  })

  it('南华老仙御风成功可将判定标记延迟到所选角色的下个准备阶段', () => {
    const { state, host } = fixture()
    state.players[0].characterId = B47_NANHUA_LAOXIAN.id
    const runtime = getSkillRuntime(B47_NANHUA_LAOXIAN.skills[0].id)!
    runtime.resume?.(host, 'p0', { step: 'targets', data: { score: 1 } } as any, { payload: { targetIds: ['p1'] } } as any)
    expect(state.players[1].marks['yufeng-nanhua-b47:skip:p0']).toBe(1)
  })

  it('南华老仙目标下次准备阶段判红跳过摸牌、判黑跳过出牌和弃牌', () => {
    for (const [suit, expected] of [['heart', ['draw']], ['spade', ['play', 'discard']]] as const) {
      const { game, state } = fixture()
      state.players[0].characterId = B47_NANHUA_LAOXIAN.id
      state.players[1].marks['yufeng-nanhua-b47:skip:p0'] = 1
      state.phase = 'judge'; state.currentPlayerId = 'p1'
      const judgmentCardId = state.zones.drawPile[0]
      state.cards[judgmentCardId].suit = suit
      state.cards[judgmentCardId].color = suit === 'heart' ? 'red' : 'black'
      game.dispatch('PhaseStart', { playerId: 'p1', phase: 'judge' })
      expect(state.skippedPhases).toEqual(expected)
      expect(state.players[1].marks['yufeng-nanhua-b47:skip:p0']).toBe(0)
    }
  })

  it('武将册第47批恰好登记十名角色，且均进入正式选择池', () => {
    expect(HISTORICAL_BATCH47_CHARACTERS).toHaveLength(10)
    for (const character of HISTORICAL_BATCH47_CHARACTERS) {
      expect(ALL_CHARACTERS.some((registered) => registered.id === character.id)).toBe(true)
    }
  })

  it('太平要术提供本势力存活人数手牌上限、防止属性伤害，离装备区后摸二失一', () => {
    const { game, state } = fixture()
    state.players[0].characterId = B47_NANHUA_LAOXIAN.id
    state.players[1].characterId = B47_GONGSUN_KANG.id
    const runtime = getSkillRuntime('taiping-yaoshu')!
    expect(runtime.maxCardsBonus?.(state, 'p0')).toBe(2)
    expect(runtime.preventsDamage?.(state, 'p0', 'target', { targetId: 'p0', sourceId: 'p1', amount: 1, nature: 'fire', cardId: null, cardName: '杀', chainTransfer: false })).toBe(true)
    expect(runtime.preventsDamage?.(state, 'p0', 'target', { targetId: 'p0', sourceId: 'p1', amount: 1, nature: 'normal', cardId: null, cardName: '杀', chainTransfer: false })).toBe(false)

    const armorId = state.players[0].zones.hand[0]
    state.cards[armorId] = { ...state.cards[armorId], name: '太平要术', category: 'equipment', equipmentSlot: 'armor', specialEquipment: 'taiping-yaoshu' }
    moveCard(state, armorId, { kind: 'hand', playerId: 'p0' }, { kind: 'equipment', playerId: 'p0', slot: 'armor' })
    expect(equipmentSkillIdsOf(state, 'p0')).toContain('taiping-yaoshu')
    const handBefore = state.players[0].zones.hand.length
    moveCard(state, armorId, { kind: 'equipment', playerId: 'p0', slot: 'armor' }, { kind: 'discardPile' })
    handleEquipmentLost(game as any, 'p0', armorId)
    expect(state.players[0].zones.hand.length).toBe(handBefore + 2)
    expect(state.players[0].hp).toBe(1)
    expect(state.specialEquipmentRemoval?.[armorId]).toBeUndefined()
  })

  it('南华老仙天书弃牌后生成唯一太平要术并由所选角色实际装备', () => {
    const { state, host } = fixture()
    state.players[0].characterId = B47_NANHUA_LAOXIAN.id
    state.phase = 'play'
    const runtime = getSkillRuntime(B47_NANHUA_LAOXIAN.skills[1].id)!
    runtime.triggers?.find((trigger) => trigger.event === 'PhaseStart')?.handle(host, 'p0', {
      event: { payload: { playerId: 'p0', phase: 'play' } },
    } as any)
    const prompt = state.skillQueue.pop()!
    runtime.startQueued?.(host, 'p0', prompt)
    runtime.resume?.(host, 'p0', { step: 'confirm', data: {} } as any, { payload: { optionId: 'yes' } } as any)
    const costCardId = state.players[0].zones.hand[0]
    runtime.resume?.(host, 'p0', { step: 'cost', data: {} } as any, { payload: { cardIds: [costCardId] } } as any)
    runtime.resume?.(host, 'p0', { step: 'recipient', data: {} } as any, { payload: { targetIds: ['p1'] } } as any)
    expect(state.players[1].zones.equipment.armor).toBeTruthy()
    const equipped = state.players[1].zones.equipment.armor!
    expect(state.cards[equipped].name).toBe('太平要术')
    expect(state.cards[equipped].specialEquipment).toBe('taiping-yaoshu')
  })

  it('天书不在游戏内或牌堆/弃牌堆时不能复制仍在角色区域中的太平要术', () => {
    const { state, host, requests } = fixture()
    state.players[0].characterId = B47_NANHUA_LAOXIAN.id
    state.phase = 'play'
    const existingId = state.players[1].zones.hand[0]
    state.cards[existingId] = { ...state.cards[existingId], name: '太平要术', category: 'equipment',
      equipmentSlot: 'armor', specialEquipment: 'taiping-yaoshu' }
    const runtime = getSkillRuntime(B47_NANHUA_LAOXIAN.skills[1].id)!
    runtime.triggers?.find((trigger) => trigger.event === 'PhaseStart')?.handle(host, 'p0', {
      event: { payload: { playerId: 'p0', phase: 'play' } },
    } as any)
    expect(state.skillQueue).toHaveLength(0)
    expect(requests).toHaveLength(0)
  })
})
