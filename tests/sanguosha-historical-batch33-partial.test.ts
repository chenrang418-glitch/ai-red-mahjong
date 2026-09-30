import { describe, expect, it, vi } from 'vitest'
import { getSkillRuntime } from '@/sanguosha/engine/skills/runtime'
import type { SkillHost } from '@/sanguosha/engine/skills/runtime'
import { GameRng } from '@/sanguosha/engine/rng'
import { SanguoshaGame } from '@/sanguosha/engine/game'
import { getAttackRange } from '@/sanguosha/engine/distance'
import { adjustDamageAmount, hasArmor, hasUnlimitedSlash, isCardIneffective, perfectBagua } from '@/sanguosha/engine/equipment'
import { setChained } from '@/sanguosha/engine/character-state'
import { setEquipmentTransformation } from '@/sanguosha/engine/zones'
import '@/sanguosha/data/characters/historical-batch33'

function pingcaiFixture(characterIds: Record<string, string> = {}) {
  const game = new SanguoshaGame({
    seed: 'pingcai-targeted',
    setup: { mode: 'identity', generalChoices: 1, players: Array.from({ length: 5 }, (_, index) => ({ id: `p${index}`, nickname: `玩家${index}`, isHuman: index === 0 })) },
  })
  const state = game.state as any
  state.status = 'playing'; state.phase = 'play'; state.currentPlayerId = 'p0'; state.normalTurnPlayerId = 'p0'; state.turnNumber = 1
  state.players.forEach((player: any, index: number) => {
    player.characterId = characterIds[player.id] ?? `test-${player.id}`
    player.hp = 3; player.maxHp = 4
  })
  const requests: any[] = []
  const host = {
    state, rng: game.rng,
    dispatch: game.dispatch.bind(game),
    askSkill(request: any) { requests.push({ ...request, request: request.build(`pingcai-${requests.length}`) }) },
  } as any as SkillHost
  return { state, requests, host }
}

function completePingcaiScratch(host: SkillHost, requests: any[], treasure: string) {
  const runtime = getSkillRuntime('pingcai-b35')!
  vi.spyOn(host.rng, 'nextInt').mockReturnValue(0)
  runtime.invokeActive?.(host, 'p0')
  runtime.resume?.(host, 'p0', { step: 'select-treasure', data: {} } as any, { payload: { optionId: treasure } } as any)
  const scratchRequest = requests.at(-1)
  runtime.resume?.(host, 'p0', scratchRequest as any, {
    payload: { optionId: 'scratch-complete', scratchedCells: Array.from({ length: 16 }, (_, index) => index) },
  } as any)
}

describe('武将册第35批当前可验证的公共技能入口', () => {
  it('庞德公【隐世】在阶段进入前跳过准备、判定、结束，并禁止成为延时锦囊目标', () => {
    const state = { players: [{ id: 'pang', alive: true }], skippedPhases: [] } as any
    const runtime = getSkillRuntime('yinshi-b35')!
    const host = { state } as SkillHost
    expect(runtime.offerPhaseSkip?.(host, 'pang', 'prepare')).toBe(false)
    expect(runtime.offerPhaseSkip?.(host, 'pang', 'judge')).toBe(false)
    expect(runtime.offerPhaseSkip?.(host, 'pang', 'finish')).toBe(false)
    expect(runtime.offerPhaseSkip?.(host, 'pang', 'draw')).toBe(false)
    expect(state.skippedPhases).toEqual(['prepare', 'judge', 'finish'])
    expect(runtime.prohibitsTarget?.(state, 'pang', 'other', '兵粮寸断')).toBe(true)
    expect(runtime.prohibitsTarget?.(state, 'pang', 'other', '杀')).toBe(false)
  })

  it('庞德公【评才】只有提交完整擦拭格后才进入宝物效果，未完成时不生效', () => {
    const { state, requests, host } = pingcaiFixture()
    const runtime = getSkillRuntime('pingcai-b35')!
    runtime.invokeActive?.(host, 'p0')
    runtime.resume?.(host, 'p0', { step: 'select-treasure', data: {} } as any, { payload: { optionId: 'fengchu' } } as any)
    expect(requests.at(-1).request.interaction).toEqual({ kind: 'pingcai-scratch', treasure: 'fengchu', cellCount: 16, success: true })
    runtime.resume?.(host, 'p0', { step: 'scratch', data: { treasure: 'fengchu' } } as any, {
      payload: { optionId: 'scratch-complete', scratchedCells: Array.from({ length: 15 }, (_, index) => index) },
    } as any)
    expect(requests).toHaveLength(2)
    expect(state.players[0].turnUsedSkills.some((entry: string) => entry.startsWith('pingcai-b35@'))).toBe(true)
  })

  it('庞德公【评才】由引擎随机结果判定成功，完整擦开也不能伪造失败结果为成功', () => {
    const { requests, host } = pingcaiFixture()
    const runtime = getSkillRuntime('pingcai-b35')!
    vi.spyOn(host.rng, 'nextInt').mockReturnValue(1)
    runtime.invokeActive?.(host, 'p0')
    runtime.resume?.(host, 'p0', { step: 'select-treasure', data: {} } as any, { payload: { optionId: 'xuanjian' } } as any)
    expect(requests.at(-1).request.interaction).toMatchObject({ success: false })
    runtime.resume?.(host, 'p0', { step: 'scratch', data: { treasure: 'xuanjian', success: false } } as any, {
      payload: { optionId: 'scratch-complete', success: true, scratchedCells: Array.from({ length: 16 }, (_, index) => index) },
    } as any)
    expect(requests).toHaveLength(2)
  })

  it('庞德公【评才·卧龙】按存活诸葛亮扩展到两名目标并逐一造成火焰伤害', () => {
    const { state, requests, host } = pingcaiFixture({ p1: 'zhugeliang' })
    const runtime = getSkillRuntime('pingcai-b35')!
    completePingcaiScratch(host, requests, 'wolong')
    expect(requests.at(-1).request).toMatchObject({ kind: 'choose-targets', min: 1, max: 2 })
    runtime.resume?.(host, 'p0', { step: 'effect-targets', data: { treasure: 'wolong' } } as any, { payload: { targetIds: ['p2', 'p3'] } } as any)
    expect(state.players[2].hp).toBe(2)
    expect(state.players[3].hp).toBe(2)
  })

  it('庞德公【评才·凤雏】只将未横置角色横置，庞统存活时上限为四名', () => {
    const { state, requests, host } = pingcaiFixture({ p1: 'pangtong' })
    state.players[4].chained = true
    const runtime = getSkillRuntime('pingcai-b35')!
    completePingcaiScratch(host, requests, 'fengchu')
    expect(requests.at(-1).request).toMatchObject({ kind: 'choose-targets', min: 0, max: 4 })
    expect(requests.at(-1).request.candidateIds).not.toContain('p4')
    runtime.resume?.(host, 'p0', { step: 'effect-targets', data: { treasure: 'fengchu' } } as any, { payload: { targetIds: ['p2', 'p3'] } } as any)
    expect(state.players[2].chained).toBe(true)
    expect(state.players[3].chained).toBe(true)
    expect(state.players[4].chained).toBe(true)
  })

  it('庞德公【评才·水镜】有司马徽时可移动任意装备到对应栏并正常触发装备离开', () => {
    const { state, requests, host } = pingcaiFixture({ p1: 'simahui' })
    const weapon = Object.values(state.cards).find((card: any) => card.name === '青釭剑') as any
    expect(weapon).toBeTruthy()
    state.zones.drawPile = state.zones.drawPile.filter((cardId: string) => cardId !== weapon.id)
    state.players[2].zones.equipment.weapon = weapon.id
    const runtime = getSkillRuntime('pingcai-b35')!
    completePingcaiScratch(host, requests, 'shuijing')
    runtime.resume?.(host, 'p0', { step: 'equipment-source', data: {} } as any, { payload: { optionId: 'p2' } } as any)
    expect(requests.at(-1).request.cardIds).toContain(weapon.id)
    runtime.resume?.(host, 'p0', { step: 'equipment-card', data: { sourceId: 'p2' } } as any, { payload: { cardIds: [weapon.id] } } as any)
    runtime.resume?.(host, 'p0', { step: 'equipment-destination', data: { sourceId: 'p2', cardId: weapon.id } } as any, { payload: { targetIds: ['p3'] } } as any)
    expect(state.players[2].zones.equipment.weapon).toBeNull()
    expect(state.players[3].zones.equipment.weapon).toBe(weapon.id)
  })

  it('庞德公【评才·玄剑】令目标摸牌并回复，徐庶存活时庞德公额外摸牌', () => {
    const { state, requests, host } = pingcaiFixture({ p1: 'xushu' })
    const runtime = getSkillRuntime('pingcai-b35')!
    completePingcaiScratch(host, requests, 'xuanjian')
    runtime.resume?.(host, 'p0', { step: 'effect-targets', data: { treasure: 'xuanjian' } } as any, { payload: { targetIds: ['p2'] } } as any)
    expect(state.players[2].hp).toBe(4)
    expect(state.players[2].zones.hand).toHaveLength(1)
    expect(state.players[0].zones.hand).toHaveLength(1)
  })

  it('笮融失去【浮图】后仍由独立【佛宗】运行时提供手牌上限、伤害和回复修正', () => {
    const state = {
      b35: { 'fozong-b35:zherong:colors': ['red'] },
      cards: { red: { color: 'red' }, black: { color: 'black' } },
      players: [{ id: 'zherong', alive: true, grantedSkills: ['fozong-b35'] }],
    } as any
    const runtime = getSkillRuntime('fozong-b35')!
    expect(runtime.handLimitExempt?.(state, 'zherong', 'red')).toBe(true)
    expect(runtime.handLimitExempt?.(state, 'zherong', 'black')).toBe(false)
    expect(runtime.outgoingDamage?.(state, 'zherong', { amount: 1 } as any)).toEqual({ amount: 2 })
    expect(runtime.recoverAmountBonus?.(state, 'zherong')).toBe(1)
  })

  it('马良【自书】只在对应角色回合结束时弃置仍由马良持有的回合外所得牌', () => {
    const state = {
      turnNumber: 7, currentPlayerId: 'other', b35: {}, cardAliases: {}, cardNatures: {}, cardSuitOverrides: {},
      zones: { discardPile: [], drawPile: [], processingArea: [] },
      cards: { outside: { id: 'outside', name: '杀', suit: 'spade', color: 'black', category: 'basic' } },
      players: [
        { id: 'ma-liang', alive: true, zones: { hand: ['outside'], equipment: {}, judgingArea: [] } },
        { id: 'other', alive: true, zones: { hand: [], equipment: {}, judgingArea: [] } },
      ],
    } as any
    const host = { state, dispatch: () => ({ cancelled: false }) } as any as SkillHost
    const runtime = getSkillRuntime('zishu-b35')!
    const gain = runtime.triggers?.find(trigger => trigger.event === 'GainCard')!
    const end = runtime.triggers?.find(trigger => trigger.event === 'TurnEnd')!
    gain.handle(host, 'ma-liang', { event: { payload: { playerId: 'ma-liang', cardIds: ['outside'] } } } as any)
    expect(state.b35['zishu-b35:cleanup:7:other']).toEqual(['outside'])
    end.handle(host, 'ma-liang', { event: { payload: { playerId: 'other', turnNumber: 7 } } } as any)
    expect(state.players[0].zones.hand).toEqual([])
    expect(state.zones.discardPile).toEqual(['outside'])
  })

  it('马良【自书】回合内获得牌后额外摸一张，且不会递归触发', () => {
    const state = {
      seed: 'batch35-test', rngState: 1, turnNumber: 2, currentPlayerId: 'ma-liang', phase: 'play', b35: {}, cardAliases: {}, cardNatures: {}, cardSuitOverrides: {},
      zones: { discardPile: [], drawPile: ['drawn'], processingArea: [] },
      cards: {
        gained: { id: 'gained', name: '桃', suit: 'heart', color: 'red', category: 'basic' },
        drawn: { id: 'drawn', name: '杀', suit: 'spade', color: 'black', category: 'basic' },
      },
      players: [{ id: 'ma-liang', alive: true, zones: { hand: ['gained'], equipment: {}, judgingArea: [] } }],
    } as any
    const runtime = getSkillRuntime('zishu-b35')!
    const trigger = runtime.triggers?.find(item => item.event === 'GainCard')!
    const host = {
      state, rng: new GameRng('batch35-test'), dispatch(name: string, payload: any) {
        if (name === 'GainCard') trigger.handle(host as any, 'ma-liang', { event: { payload } } as any)
        return { cancelled: false }
      },
    } as any as SkillHost
    trigger.handle(host, 'ma-liang', { event: { payload: { playerId: 'ma-liang', cardIds: ['gained'], reason: 'effect' } } } as any)
    expect(state.players[0].zones.hand).toEqual(['gained', 'drawn'])
    expect(state.zones.drawPile).toEqual([])
  })

  it('马钧的精械装备变更贯通防具、武器、攻击范围和连环规则', () => {
    const state = {
      cards: {
        crossbow: { id: 'crossbow', name: '诸葛连弩', category: 'equipment', attackRange: 1 },
        armor: { id: 'armor', name: '藤甲', category: 'equipment' },
        shield: { id: 'shield', name: '仁王盾', category: 'equipment' },
        horse: { id: 'horse', name: '八卦阵', category: 'equipment' },
        slash: { id: 'slash', name: '杀', category: 'basic', suit: 'heart' },
      },
      cardAliases: {}, cardNatures: {}, equipmentTransformations: {},
      players: [{
        id: 'ma-jun', alive: true, seat: 0, chained: false, distanceToOthers: 0, distanceFromOthers: 0,
        attackRangeBonus: 0, zones: { hand: [], judgingArea: [], equipment: { weapon: 'crossbow', armor: 'armor', offensiveHorse: null, defensiveHorse: null } },
      }, { id: 'target', alive: true, zones: { hand: [], judgingArea: [], equipment: { armor: 'shield' } } }],
    } as any
    setEquipmentTransformation(state, 'crossbow', '元戎精械弩')
    setEquipmentTransformation(state, 'armor', '桐油百韧甲')
    setEquipmentTransformation(state, 'shield', '仁王金刚盾')
    setEquipmentTransformation(state, 'horse', '先天八卦阵')
    expect(hasUnlimitedSlash(state, 'ma-jun')).toBe(true)
    expect(getAttackRange(state, 'ma-jun')).toBe(3)
    expect(hasArmor(state, 'ma-jun', '桐油百韧甲')).toBe(true)
    expect(adjustDamageAmount(state, 'target', 'ma-jun', 1, 'fire', '杀')).toBe(2)
    expect(isCardIneffective(state, 'target', '杀', 'red', 'normal', 'ma-jun', 'heart')).toBe(true)
    expect(perfectBagua({ ...state, players: [{ ...state.players[0], zones: { ...state.players[0].zones, equipment: { ...state.players[0].zones.equipment, armor: 'horse' } } }] } as any, 'ma-jun')).toBe(true)
    const host = { state, dispatch: () => ({ cancelled: false }) } as any
    setChained(host, 'ma-jun', 'iron-chain', true)
    expect(state.players[0].chained).toBe(false)
  })

  it('马钧【精械】把选中的实体装备永久改造成对应装备', () => {
    const state = {
      players: [{ id: 'ma-jun', alive: true, zones: { hand: ['weapon'], equipment: {}, judgingArea: [] } }],
      cards: { weapon: { id: 'weapon', name: '诸葛连弩', category: 'equipment', equipmentSlot: 'weapon' } },
      equipmentTransformations: {}, phase: 'play', currentPlayerId: 'ma-jun',
    } as any
    const runtime = getSkillRuntime('jingxie-b35')!
    const host = { state, dispatch: () => ({ cancelled: false }) } as any as SkillHost
    runtime.resume?.(host, 'ma-jun', { step: 'cards', data: {} } as any, { payload: { cardIds: ['weapon'] } } as any)
    expect(state.equipmentTransformations.weapon).toBe('元戎精械弩')
    expect(hasUnlimitedSlash({ ...state, players: [{ ...state.players[0], zones: { hand: [], equipment: { weapon: 'weapon' }, judgingArea: [] } }] } as any, 'ma-jun')).toBe(true)
  })

  it('马钧【巧思】最多点亮三个水阀，按对应牌类取牌并完成等量交付', () => {
    const card = (id: string, category: string) => ({ id, name: id, category, suit: 'heart', color: 'red', rank: 1 })
    const state = {
      phase: 'play', currentPlayerId: 'ma-jun', turnNumber: 1, b35: {},
      cardAliases: {}, cardNatures: {}, cardSuitOverrides: {}, cardColorOverrides: {},
      zones: { drawPile: ['trick-a', 'trick-b', 'equipment-a', 'equipment-b', 'basic-a'], discardPile: [], processingArea: [] },
      cards: {
        'trick-a': card('trick-a', 'trick'), 'trick-b': card('trick-b', 'trick'),
        'equipment-a': card('equipment-a', 'equipment'), 'equipment-b': card('equipment-b', 'equipment'),
        'basic-a': { ...card('basic-a', 'basic'), name: '闪' },
      },
      players: [
        { id: 'ma-jun', name: '马钧', alive: true, seat: 0, zones: { hand: [], equipment: {}, judgingArea: [] }, turnUsedSkills: [] },
        { id: 'ally', name: '友方', alive: true, seat: 1, zones: { hand: [], equipment: {}, judgingArea: [] } },
      ],
    } as any
    const pending: any[] = []
    const host = { state, rng: new GameRng('ma-jun-qiaosi'), dispatch: () => ({ cancelled: false }), askSkill: (request: any) => pending.push({ ...request, request: request.build(`req-${pending.length}`) }) } as any as SkillHost
    const runtime = getSkillRuntime('qiaosi-b35')!
    runtime.invokeActive?.(host, 'ma-jun')
    const answer = (step: string, optionId: string, data = {}) => runtime.resume?.(host, 'ma-jun', { step, data } as any, { payload: { optionId } } as any)
    answer('waterwheel', 'valve:0') // 王：第一次
    answer('waterwheel', 'valve:0') // 第二次
    answer('waterwheel', 'valve:0') // 第三次点亮，获得两张锦囊
    answer('waterwheel', 'valve:3') // 农：一次点亮，获得一张防御基本牌
    answer('waterwheel', 'valve:5') // 将：第三次点亮，获得两张装备
    answer('waterwheel', 'valve:5')
    answer('waterwheel', 'valve:5') // 第三个偶人点亮后立即结算
    expect(pending.at(-1).step).toBe('payment-mode')
    expect(state.players[0].zones.hand).toHaveLength(5)
    expect(state.zones.drawPile).toHaveLength(0)
    answer('payment-mode', 'give', { gainedCount: 5 })
    expect(pending.at(-1).step).toBe('payment-target')
    runtime.resume?.(host, 'ma-jun', { step: 'payment-target', data: { count: 5 } } as any, { payload: { targetIds: ['ally'] } } as any)
    expect(pending.at(-1).step).toBe('payment-give')
    const ids = [...state.players[0].zones.hand]
    runtime.resume?.(host, 'ma-jun', { step: 'payment-give', data: { targetId: 'ally' } } as any, { payload: { cardIds: ids } } as any)
    expect(state.players[0].zones.hand).toEqual([])
    expect(state.players[1].zones.hand).toHaveLength(5)
    expect(runtime.activeActions?.(state, 'ma-jun')).toEqual([])
  })

  it('马钧【巧思】到达10秒期限后不再接受水阀操作并结束小游戏', () => {
    const state = {
      phase: 'play', currentPlayerId: 'ma-jun', turnNumber: 1, b35: {}, cardAliases: {}, cardNatures: {}, cardSuitOverrides: {},
      zones: { drawPile: [], discardPile: [], processingArea: [] }, cards: {},
      players: [{ id: 'ma-jun', alive: true, seat: 0, zones: { hand: [], equipment: {}, judgingArea: [] }, turnUsedSkills: [] }],
    } as any
    const requests: any[] = []
    const events: any[] = []
    const host = { state, rng: new GameRng('ma-jun-timeout'), dispatch(name: string, payload: any) { events.push({ name, payload }); return { cancelled: false } }, askSkill: (request: any) => requests.push(request.build('waterwheel')) } as any as SkillHost
    const runtime = getSkillRuntime('qiaosi-b35')!
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000)
    try {
      runtime.invokeActive?.(host, 'ma-jun')
      expect(requests[0]).toMatchObject({ timeoutMs: 10_000, interaction: { kind: 'waterwheel' } })
      now.mockReturnValue(11_001)
      runtime.resume?.(host, 'ma-jun', { step: 'waterwheel', data: {} } as any, { payload: { optionId: 'valve:2' } } as any)
      expect(state.b35['ma-jun-waterwheel-b35:ma-jun']).toBeUndefined()
      expect(requests).toHaveLength(1)
      expect(events.find(event => event.name === 'SkillActivated')?.payload.cardIds).toEqual([])
    } finally {
      now.mockRestore()
    }
  })

  it('来敏【乱群】要求有手牌的角色秘密展示一张，无手牌角色可空选', () => {
    const state = {
      phase: 'play', currentPlayerId: 'lai-min', seq: 4, turnNumber: 2,
      groupCardDecision: null, pendingRequests: [], decisions: [],
      players: [
        { id: 'lai-min', alive: true, zones: { hand: ['owner-card'] }, turnUsedSkills: [] },
        { id: 'with-card', alive: true, zones: { hand: ['other-card'] } },
        { id: 'empty', alive: true, zones: { hand: [] } },
      ],
    } as any
    const runtime = getSkillRuntime('luanqun-b35')!
    runtime.invokeActive?.({ state } as any, 'lai-min')
    const requests = Object.fromEntries(state.pendingRequests.map((request: any) => [request.playerId, request]))
    expect(requests['lai-min']).toMatchObject({ min: 1, max: 1, optional: false, cardIds: ['owner-card'] })
    expect(requests['with-card']).toMatchObject({ min: 1, max: 1, optional: false, cardIds: ['other-card'] })
    expect(requests.empty).toMatchObject({ min: 0, max: 1, optional: true, cardIds: [] })
  })

  it('界李儒【灭计】把“选择执行方式”和“提交牌”分开续接，并允许弃置装备牌', () => {
    const state = {
      phase: 'play', turnNumber: 1, currentPlayerId: 'li-ru', seq: 1, cardAliases: {}, cardNatures: {}, cardSuitOverrides: {}, equipmentTransformations: {},
      zones: { drawPile: [], discardPile: [], processingArea: [] },
      cards: {
        blackTrick: { id: 'blackTrick', name: '无中生有', category: 'trick', color: 'black', suit: 'spade' },
        redBasic: { id: 'redBasic', name: '杀', category: 'basic', color: 'red', suit: 'heart' },
        armor: { id: 'armor', name: '藤甲', category: 'equipment', color: 'black', suit: 'club' },
      },
      players: [
        { id: 'li-ru', alive: true, seat: 0, zones: { hand: ['blackTrick'], equipment: {}, judgingArea: [] }, turnUsedSkills: [] },
        { id: 'target', alive: true, seat: 1, zones: { hand: ['redBasic'], equipment: { armor: 'armor' }, judgingArea: [] }, hp: 3, maxHp: 4 },
      ],
    } as any
    const requests: any[] = []
    const host = { state, dispatch: () => ({ cancelled: false }), askSkill: (request: any) => requests.push(request) } as any as SkillHost
    const runtime = getSkillRuntime('mieji-jie-b35')!
    runtime.resume?.(host, 'li-ru', { step: 'cards', data: {} } as any, { payload: { cardIds: ['blackTrick'] } } as any)
    runtime.resume?.(host, 'li-ru', { step: 'target', data: {} } as any, { payload: { targetIds: ['target'] } } as any)
    runtime.resume?.(host, 'li-ru', { step: 'choice', data: { targetId: 'target' } } as any, { payload: { optionId: 'discard' } } as any)
    expect(requests.at(-1).step).toBe('resolve-cards')
    expect(requests.at(-1).build('req')).toMatchObject({ kind: 'choose-cards', playerId: 'target', cardIds: ['redBasic', 'armor'], min: 2, max: 2 })
    runtime.resume?.(host, 'li-ru', { step: 'resolve-cards', data: { targetId: 'target', mode: 'discard' } } as any, { payload: { cardIds: ['redBasic', 'armor'] } } as any)
    expect(state.players[1].zones.hand).toEqual([])
    expect(state.players[1].zones.equipment.armor).toBeNull()
    expect(state.zones.discardPile).toEqual(['redBasic', 'armor'])
  })
})
