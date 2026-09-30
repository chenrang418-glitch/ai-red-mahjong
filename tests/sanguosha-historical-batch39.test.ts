import { describe, expect, it } from 'vitest'
import { ALL_CHARACTERS, getCharacter, skillIdsOf } from '@/sanguosha/data/characters/standard'
import { HISTORICAL_BATCH39_CHARACTERS } from '@/sanguosha/data/characters/historical-batch39'
import { getSkillRuntime } from '@/sanguosha/engine/skills/runtime'
import { SanguoshaGame } from '@/sanguosha/engine/game'
import { moveCard } from '@/sanguosha/engine/zones'
import type { SkillHost } from '@/sanguosha/engine/skills/runtime'

function fixture() {
  const game = new SanguoshaGame({ seed: 'historical-b41-targeted', setup: {
    mode: 'identity', generalChoices: 1,
    players: Array.from({ length: 5 }, (_, index) => ({ id: `p${index}`, nickname: `玩家${index}`, isHuman: index === 0 })),
  } })
  const state = game.state as any
  state.status = 'playing'; state.phase = 'play'; state.currentPlayerId = 'p0'; state.normalTurnPlayerId = 'p0'; state.turnNumber = 2
  state.players.forEach((entry: any, index: number) => {
    entry.characterId = index === 0 ? 'jie-dianwei-b41' : 'caocao'
    entry.hp = 3; entry.maxHp = 4
  })
  const requests: any[] = [], events: any[] = []
  const host = {
    state, rng: game.rng,
    dispatch(name: string, payload: any, metadata: any) { events.push({ name, payload, metadata }); return game.dispatch(name as any, payload, metadata) },
    askSkill(options: any) { requests.push({ ...options, request: options.build(`b41-${requests.length}`) }) },
    queueSkill(prompt: any) { state.skillQueue.push(prompt) },
    beginVirtualSlash: game.beginVirtualSlash.bind(game), beginVirtualTrick: game.beginVirtualTrick.bind(game),
    resumeCardTarget() {}, enterDying: game.enterDying.bind(game), advancePhase() {},
  } as any as SkillHost
  return { game, state, host, requests, events }
}

describe('武将册第41批注册及定向玩法', () => {
  it('登记武将册序号526–535十将，所有技能均有运行时且角色ID不重复', () => {
    expect(HISTORICAL_BATCH39_CHARACTERS).toHaveLength(10)
    for (const character of HISTORICAL_BATCH39_CHARACTERS) {
      expect(getCharacter(character.id)).toBe(character)
      expect(skillIdsOf(character.id)).toEqual(character.skills.filter(skill => !skill.granted).map(skill => skill.id))
      for (const skill of character.skills.filter(skill => !skill.granted)) expect(getSkillRuntime(skill.id), `${character.name}/${skill.id}`).toBeDefined()
    }
    expect(new Set(ALL_CHARACTERS.map(character => character.id)).size).toBe(ALL_CHARACTERS.length)
  })

  it('界强袭同一出牌阶段最多两次、每回合不重复目标且代价为实际伤害', () => {
    const { state, host, requests, events } = fixture()
    const runtime = getSkillRuntime('jie-qiangxi-b41')!
    runtime.invokeActive!(host, 'p0', 'skill:jie-qiangxi-b41')
    expect(state.players[0].hp).toBe(2)
    expect(events.some(event => event.name === 'Damaged' && event.metadata.targetId === 'p0')).toBe(true)
    const targetRequest = requests.at(-1)
    runtime.resume!(host, 'p0', targetRequest, { payload: { targetIds: ['p1'] } } as any)
    expect(runtime.activeActions!(state, 'p0')).toHaveLength(1)
    runtime.invokeActive!(host, 'p0', 'skill:jie-qiangxi-b41')
    expect(requests.at(-1).request.candidateIds).not.toContain('p1')
  })

  it('界节命按目标体力上限（最多5）先摸X张，再弃至X张；伤害和死亡时均可触发', () => {
    const { state, host, requests } = fixture()
    state.players[0].characterId = 'jie-xunyu-b41'
    state.players[1].maxHp = 3
    const target = state.players[1]
    const first = state.zones.drawPile[0]
    moveCard(state, first, { kind: 'drawPile' }, { kind: 'hand', playerId: target.id })
    const runtime = getSkillRuntime('jie-jieming-b41')!
    runtime.resume!(host, 'p0', { step: 'target', data: {} } as any, { payload: { targetIds: [target.id] } } as any)
    const discard = requests.at(-1)
    expect(discard.request).toMatchObject({ kind: 'choose-cards', min: 1, max: 1, playerId: target.id })
    runtime.resume!(host, 'p0', discard, { payload: { cardIds: [first] } } as any)
    expect(target.zones.hand).toHaveLength(3)
    const trigger = runtime.triggers!.find(item => item.event === 'Death')!
    trigger.handle(host, 'p0', { event: { payload: { playerId: 'p0' } } as any } as any)
    expect(state.skillQueue.at(-1)).toMatchObject({ skillId: 'jie-jieming-b41', allowDeadOwner: true })
  })

  it('界火计可以使用红色装备牌，界看破将黑色牌转化的无懈标为不可响应', () => {
    const { state } = fixture()
    state.players[0].characterId = 'jie-wolongzhuge-b41'
    const equip = state.zones.drawPile[0]
    Object.assign(state.cards[equip], { name: '赤兔', category: 'equipment', equipmentSlot: 'offensiveHorse', color: 'red', suit: 'heart' })
    moveCard(state, equip, { kind: 'drawPile' }, { kind: 'equipment', playerId: 'p0', slot: 'offensiveHorse' })
    expect(getSkillRuntime('jie-huoji-b41')!.viewAs!(state, 'p0')).toContainEqual(expect.objectContaining({ asCardName: '火攻', cardId: equip }))
    expect(getSkillRuntime('jie-kanpo-b41')!.unanswerableResponses).toContain('无懈可击')
  })

  it('界卧龙火计随机展示目标手牌，改为弃置同色手牌造成火焰伤害', () => {
    const { game, state } = fixture()
    state.players[0].characterId = 'jie-wolongzhuge-b41'
    const payment = state.zones.drawPile[0], reveal = state.zones.drawPile[1]
    Object.assign(state.cards[payment], { name: '杀', category: 'basic', color: 'red', suit: 'heart' })
    Object.assign(state.cards[reveal], { name: '闪', category: 'basic', color: 'red', suit: 'diamond' })
    moveCard(state, payment, { kind: 'drawPile' }, { kind: 'hand', playerId: 'p0' })
    moveCard(state, reveal, { kind: 'drawPile' }, { kind: 'hand', playerId: 'p1' })
    expect(game.beginVirtualTrick({ sourceId: 'p0', targetId: 'p1', cardName: '火攻', sourceSkillId: 'jie-huoji-b41' })).toBe(true)
    expect(state.cardResolution.effect).toMatchObject({ kind: 'jie-fire-discard', targetId: 'p1', revealedCardId: reveal, color: 'red' })
    const request = state.pendingRequests.find((item: any) => item.playerId === 'p0' && item.kind === 'choose-cards')!
    expect(request.cardIds).toContain(payment)
    game.respond({ requestId: request.id, playerId: 'p0', payload: { cardIds: [payment] } })
    expect(state.players[1].hp).toBe(2)
    expect(state.zones.discardPile).toContain(payment)
  })

  it('界卧龙可将黑色装备牌当无懈使用且该无懈不可被反无懈', () => {
    const { game, state } = fixture()
    state.players[2].characterId = 'jie-wolongzhuge-b41'
    const black = state.zones.drawPile[0]
    Object.assign(state.cards[black], { name: '诸葛连弩', category: 'equipment', equipmentSlot: 'weapon', color: 'black', suit: 'spade' })
    moveCard(state, black, { kind: 'drawPile' }, { kind: 'equipment', playerId: 'p2', slot: 'weapon' })
    expect(getSkillRuntime('jie-kanpo-b41')!.viewAs!(state, 'p2')).toContainEqual(expect.objectContaining({ asCardName: '无懈可击', cardId: black }))
    game.beginVirtualTrick({ sourceId: 'p0', targetId: 'p1', cardName: '决斗', sourceSkillId: 'test-attack' })
    const response = state.pendingRequests.find((item: any) => item.playerId === 'p2')!
    expect(response.actionIds).toContain(`respond-nullification:${black}`)
    game.respond({ requestId: response.id, playerId: 'p2', payload: { actionId: `respond-nullification:${black}` } })
    expect(state.players[1].hp).toBe(3)
    expect(state.pendingRequests).toHaveLength(0)
    expect(state.cardResolution).toBeNull()
  })

  it('界貂蝉离间生成的决斗不可被无懈可击抵消', () => {
    const { game, state } = fixture()
    state.players[0].characterId = 'jie-diaochan-b41'
    const cost = state.zones.drawPile[0], nullification = state.zones.drawPile[1]
    moveCard(state, cost, { kind: 'drawPile' }, { kind: 'hand', playerId: 'p0' })
    Object.assign(state.cards[nullification], { name: '无懈可击', category: 'trick', color: 'black', suit: 'spade' })
    moveCard(state, nullification, { kind: 'drawPile' }, { kind: 'hand', playerId: 'p3' })
    game.act('p0', 'skill:lijian')
    let request = state.pendingRequests[0]
    game.respond({ requestId: request.id, playerId: 'p0', payload: { cardIds: [cost] } })
    request = state.pendingRequests[0]
    game.respond({ requestId: request.id, playerId: 'p0', payload: { targetIds: ['p1', 'p2'] } })
    request = state.pendingRequests[0]
    expect(request.playerId).toBe('p2')
    expect(request.prompt).toContain('决斗')
  })

  it('界庞德鞬出：弃装备令杀不可闪，弃非装备则把结算中的杀交给目标并取消本次目标', () => {
    const { state, host, requests } = fixture()
    const slash = state.zones.drawPile[0]
    state.cards[slash].name = '杀'; state.cards[slash].category = 'basic'
    moveCard(state, slash, { kind: 'drawPile' }, { kind: 'processingArea' })
    const equipment = state.zones.drawPile[0]
    Object.assign(state.cards[equipment], { name: '八卦阵', category: 'equipment', equipmentSlot: 'armor' })
    moveCard(state, equipment, { kind: 'drawPile' }, { kind: 'equipment', playerId: 'p1', slot: 'armor' })
    state.cardResolution = { kind: 'slash', cardId: slash, sourceId: 'p0', targetId: 'p1', stage: 'awaiting-intercept', damageNature: 'normal', damageAmount: 1, requestId: null, surrogate: null, interceptsDone: [], remainingTargetIds: [], noDodgeTargetIds: [], dodgeRemaining: 1 }
    const runtime = getSkillRuntime('jianchu-jie-b41')!
    const context = { sourceId: 'p0', targetId: 'p1', cardId: slash, cardName: '杀', category: 'basic' } as any
    expect(runtime.interceptSourceTargetEach!(host, 'p0', context)).toBe(true)
    runtime.resume!(host, 'p0', requests.at(-1), { payload: { cardIds: [equipment] } } as any)
    expect(state.cardResolution.noDodge).toBe(true)

    const other = state.zones.drawPile[0]
    moveCard(state, other, { kind: 'drawPile' }, { kind: 'hand', playerId: 'p1' })
    state.cardResolution.noDodge = false
    state.cardResolution.targetCancelled = false
    expect(runtime.interceptSourceTargetEach!(host, 'p0', context)).toBe(true)
    runtime.resume!(host, 'p0', requests.at(-1), { payload: { cardIds: [other] } } as any)
    expect(state.players[1].zones.hand).toContain(slash)
    expect(state.cardResolution.targetCancelled).toBe(true)
  })

  it('蒯越蒯良审时阳交牌后造成伤害并转阴；阴交牌记录到当前回合结束且仅牌未失去时补至4', () => {
    const { state, host, requests } = fixture()
    state.players[0].characterId = 'kuai-yue-liang-b41'
    const ownerCard = state.zones.drawPile[0]
    moveCard(state, ownerCard, { kind: 'drawPile' }, { kind: 'hand', playerId: 'p0' })
    const runtime = getSkillRuntime('shenshi-b41')!
    runtime.invokeActive!(host, 'p0', 'skill:shenshi-b41')
    runtime.resume!(host, 'p0', requests.at(-1), { payload: { cardIds: [ownerCard] } } as any)
    runtime.resume!(host, 'p0', requests.at(-1), { payload: { targetIds: ['p1'] } } as any)
    expect(state.players[1].hp).toBe(2)
    expect(state.players[1].zones.hand).toContain(ownerCard)
    expect((state as any).b41['shenshi:p0'].polarity).toBe('yin')

    state.currentPlayerId = 'p1'
    ;(state as any).b41['shenshi:p0'].polarity = 'yin'
    const targetCard = state.zones.drawPile[0], giftCard = state.zones.drawPile[1]
    moveCard(state, targetCard, { kind: 'drawPile' }, { kind: 'hand', playerId: 'p1' })
    moveCard(state, giftCard, { kind: 'drawPile' }, { kind: 'hand', playerId: 'p0' })
    runtime.triggers!.find(item => item.event === 'Damaged')!.handle(host, 'p0', {
      event: { sourceId: 'p1', targetId: 'p0', payload: { amount: 1 } } as any,
    } as any)
    runtime.startQueued!(host, 'p0', { step: 'yin-offer', data: { targetId: 'p1' } } as any)
    runtime.resume!(host, 'p0', requests.at(-1), { payload: { optionId: 'yes' } } as any)
    runtime.resume!(host, 'p0', requests.at(-1), { payload: {} } as any)
    runtime.resume!(host, 'p0', requests.at(-1), { payload: { cardIds: [giftCard] } } as any)
    expect(state.players[1].zones.hand).toContain(giftCard)
    const finish = runtime.triggers!.find(item => item.event === 'PhaseStart')!
    finish.handle(host, 'p0', { event: { payload: { phase: 'finish', playerId: 'p1' } } as any } as any)
    expect(state.players[0].zones.hand).toHaveLength(4)
  })

  it('界卧龙藏拙在本回合未用锦囊时豁免手牌上限，使用锦囊后不豁免', () => {
    const { state, host } = fixture()
    state.players[0].characterId = 'jie-wolongzhuge-b41'; state.phase = 'discard'
    const trick = state.zones.drawPile[0]
    state.cards[trick].name = '无中生有'; state.cards[trick].category = 'trick'
    const runtime = getSkillRuntime('cangzhuo-b41')!
    expect(runtime.handLimitExempt!(state, 'p0', trick)).toBe(true)
    runtime.triggers![0].handle(host, 'p0', { event: { sourceId: 'p0', payload: { cardName: '无中生有', cardId: trick } } as any } as any)
    expect(runtime.handLimitExempt!(state, 'p0', trick)).toBe(false)
  })
})
