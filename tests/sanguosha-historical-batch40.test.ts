import { describe, expect, it } from 'vitest'
import { ALL_CHARACTERS, skillIdsOf } from '@/sanguosha/data/characters/standard'
import { HISTORICAL_BATCH40_CHARACTERS } from '@/sanguosha/data/characters/historical-batch40'
import { getSkillRuntime } from '@/sanguosha/engine/skills/runtime'
import { SanguoshaGame } from '@/sanguosha/engine/game'
import { moveCard } from '@/sanguosha/engine/zones'
import type { SkillHost } from '@/sanguosha/engine/skills/runtime'

function fixture() {
  const game = new SanguoshaGame({ seed: 'historical-b42-targeted', setup: {
    mode: 'identity', generalChoices: 1,
    players: Array.from({ length: 5 }, (_, index) => ({ id: `p${index}`, nickname: `玩家${index}`, isHuman: index === 0 })),
  } })
  const state = game.state as any
  state.status = 'playing'; state.phase = 'play'; state.currentPlayerId = 'p0'; state.normalTurnPlayerId = 'p0'; state.turnNumber = 2
  state.players.forEach((entry: any, index: number) => {
    entry.characterId = index === 0 ? 'jie-yuanshao-b42' : 'caocao'
    entry.hp = 3; entry.maxHp = 4
  })
  const requests: any[] = [], events: any[] = []
  const host = {
    state, rng: game.rng,
    dispatch(name: string, payload: any, metadata: any) { events.push({ name, payload, metadata }); return game.dispatch(name as any, payload, metadata) },
    askSkill(options: any) { requests.push({ ...options, request: options.build(`b42-${requests.length}`) }) },
    queueSkill(prompt: any) { state.skillQueue.push(prompt) },
    beginVirtualSlash: game.beginVirtualSlash.bind(game), beginVirtualTrick: game.beginVirtualTrick.bind(game),
    resumeCardTarget() {}, enterDying: game.enterDying.bind(game), advancePhase() {}, resumeAfterDying() {},
  } as any as SkillHost
  return { game, state, host, requests, events }
}

describe('武将册第42批注册与定向规则', () => {
  it('登记序号536–545的十名角色且每项自带技能均有运行时', () => {
    expect(HISTORICAL_BATCH40_CHARACTERS).toHaveLength(10)
    for (const character of HISTORICAL_BATCH40_CHARACTERS) {
      expect(ALL_CHARACTERS).toContain(character)
      expect(skillIdsOf(character.id)).toEqual(character.skills.filter(skill => !skill.granted).map(skill => skill.id))
      for (const skill of character.skills.filter(skill => !skill.granted)) {
        expect(getSkillRuntime(skill.id), `${character.name}/${skill.name}`).toBeDefined()
      }
    }
    expect(new Set(ALL_CHARACTERS.map(character => character.id)).size).toBe(ALL_CHARACTERS.length)
  })

  it('界袁绍血裔按当前存活的其他群势力角色数实时加倍计算手牌上限', () => {
    const { state } = fixture()
    state.players[0].identity = 'lord'
    state.players[1].characterId = 'dongzhuo'
    state.players[2].characterId = 'huaxiong'
    state.players[3].characterId = 'dongzhuo'
    state.players[3].alive = false
    const bonus = getSkillRuntime('jie-xueyi-b42')!.maxCardsBonus!
    expect(bonus(state, 'p0')).toBe(4)
    state.players[2].alive = false
    expect(bonus(state, 'p0')).toBe(2)
  })

  it('界庞统额外目标仅加给铁索连环，涅槃为出牌阶段限定技', () => {
    const { state } = fixture()
    const lianhuan = getSkillRuntime('jie-lianhuan-b42')!
    expect(lianhuan.extraTargetsForTrick!(state, 'p0', '铁索连环')).toBe(1)
    expect(lianhuan.extraTargetsForTrick!(state, 'p0', '顺手牵羊')).toBe(0)
    state.players[0].characterId = 'jie-pangtong-b42'
    expect(getSkillRuntime('jie-niepan-b42')!.activeActions!(state, 'p0')).toHaveLength(1)
    state.players[0].usedLimitedSkills.push('jie-niepan-b42')
    expect(getSkillRuntime('jie-niepan-b42')!.activeActions!(state, 'p0')).toHaveLength(0)
  })

  it('界庞统出牌阶段涅槃弃牌摸三并准确回复至3点体力，技能只使用一次', () => {
    const { state, host, requests } = fixture()
    state.players[0].characterId = 'jie-pangtong-b42'
    state.players[0].hp = 1
    const runtime = getSkillRuntime('jie-niepan-b42')!
    runtime.resume!(host, 'p0', { step: 'play', data: {} } as any, { payload: { optionId: 'yes' } } as any)
    expect(state.players[0].hp).toBe(3)
    expect(state.players[0].usedLimitedSkills).toContain('jie-niepan-b42')
    expect(requests.at(-1).request.prompt).toContain('选择获得一项技能')
    runtime.resume!(host, 'p0', { step: 'skill', data: { dying: false } } as any, { payload: { optionId: 'huoji' } } as any)
    expect(state.players[0].grantedSkills).toContain('huoji')
  })

  it('界颜良文丑可拒绝替换摸牌；同意后展示两张并获得所选一张，记住其颜色', () => {
    const { state, host, requests } = fixture()
    state.players[0].characterId = 'jie-yanliangwenchou-b42'
    const runtime = getSkillRuntime('jie-shuangxiong-b42')!
    const phaseStart = runtime.triggers!.find(item => item.event === 'PhaseStart')!
    phaseStart.handle(host, 'p0', { event: { payload: { playerId: 'p0', phase: 'draw' } } } as any)
    expect(requests.at(-1).request.optional).toBe(true)
    runtime.resume!(host, 'p0', { step: 'replace-draw', data: {} } as any, { payload: { optionId: 'yes' } } as any)
    let cancelled = false
    const drawPhase = runtime.triggers!.find(item => item.event === 'DrawPhase')!
    drawPhase.handle(host, 'p0', { event: { payload: { playerId: 'p0' } }, cancel() { cancelled = true } } as any)
    expect(cancelled).toBe(true)
    const revealed = requests.at(-1).request.cardIds as string[]
    expect(revealed).toHaveLength(2)
    Object.assign(state.cards[revealed[0]], { color: 'red' })
    runtime.resume!(host, 'p0', { step: 'gain', data: { cardIds: revealed } } as any, { payload: { cardIds: [revealed[0]] } } as any)
    expect(state.players[0].zones.hand).toContain(revealed[0])
    expect(state.b42Shuangxiong.p0.color).toBe('red')
    expect(state.zones.discardPile).toContain(revealed[1])
  })

  it('界徐晃截辎只响应其他角色跳过摸牌阶段并摸牌', () => {
    const { host, state, events } = fixture()
    state.players[0].characterId = 'jie-xuhuang-b42'
    const trigger = getSkillRuntime('jie-jiezi-b42')!.triggers!.find(item => item.event === 'PhaseSkipped')!
    const before = state.players[0].zones.hand.length
    trigger.handle(host, 'p0', { event: { payload: { playerId: 'p1', phase: 'draw' } } } as any)
    expect(state.players[0].zones.hand.length).toBe(before + 1)
    expect(events.some(event => event.name === 'GainCard' && event.payload.reason === 'jie-jiezi-b42')).toBe(true)
    trigger.handle(host, 'p0', { event: { payload: { playerId: 'p1', phase: 'play' } } } as any)
    expect(state.players[0].zones.hand.length).toBe(before + 1)
  })

  it('界祝融烈刃拼点胜利后由玩家选择获得目标的一张牌', () => {
    const { state, host, requests, events } = fixture()
    state.players[0].characterId = 'jie-zhurong-b42'
    const targetCard = state.zones.drawPile[0]
    moveCard(state, targetCard, { kind: 'drawPile' }, { kind: 'hand', playerId: 'p1' })
    const runtime = getSkillRuntime('jie-lieren-b42')!
    runtime.resume!(host, 'p0', { step: 'gain', data: { targetId: 'p1' } } as any,
      { payload: { cardIds: [targetCard] } } as any)
    expect(state.players[0].zones.hand).toContain(targetCard)
    expect(state.players[1].zones.hand).not.toContain(targetCard)
    expect(events.some(event => event.name === 'GainCard' && event.payload.reason === 'jie-lieren-b42')).toBe(true)
  })

  it('曹婴凌人猜对至少一类时只对相应牌与目标增加伤害', () => {
    const { state } = fixture()
    const runtime = getSkillRuntime('lingren-b42')!
    state.b42LingrenBonus = { [`${state.turnNumber}:card-1:p1`]: 1 }
    expect(runtime.outgoingDamage!(state, 'p0', { targetId: 'p1', amount: 1, nature: 'normal', cardId: 'card-1', cardName: '杀', chainTransfer: false })).toEqual({ amount: 2 })
    expect(runtime.outgoingDamage!(state, 'p0', { targetId: 'p2', amount: 1, nature: 'normal', cardId: 'card-1', cardName: '杀', chainTransfer: false })).toBeNull()
    expect(runtime.outgoingDamage!(state, 'p0', { targetId: 'p1', amount: 1, nature: 'normal', cardId: 'card-2', cardName: '杀', chainTransfer: false })).toBeNull()
  })

  it('曹婴凌人先询问是否发动，猜对三类才临时获得奸雄与行殇', () => {
    const { state, host, requests } = fixture()
    state.players[0].characterId = 'caoying-b42'
    const target = state.players[1]
    for (const [category, index] of [['basic', 0], ['trick', 1], ['equipment', 2]] as const) {
      const cardId = state.zones.drawPile[index]
      Object.assign(state.cards[cardId], { category })
      moveCard(state, cardId, { kind: 'drawPile' }, { kind: 'hand', playerId: target.id })
    }
    const runtime = getSkillRuntime('lingren-b42')!
    const phase = runtime.triggers!.find(item => item.event === 'PhaseStart')!
    phase.handle(host, 'p0', { event: { seq: 90, payload: { playerId: 'p0', phase: 'play' } } } as any)
    const targetSpecified = runtime.triggers!.find(item => item.event === 'TargetSpecified')!
    targetSpecified.handle(host, 'p0', { event: { sourceId: 'p0', payload: { cardName: '杀', cardId: 'virtual:lingren-test', targetIds: ['p1'] } } } as any)
    const queued = state.skillQueue.pop()
    runtime.startQueued!(host, 'p0', queued)
    expect(requests.at(-1).request.optional).toBe(true)
    runtime.resume!(host, 'p0', { step: 'invoke', data: { candidates: ['p1'], cardId: 'virtual:lingren-test', phaseInstanceId: '90' } } as any, { payload: { optionId: 'yes' } } as any)
    const guesses = ['yes', 'yes', 'yes']
    for (const optionId of guesses) {
      const request = requests.at(-1)
      runtime.resume!(host, 'p0', { step: 'guess', data: request.data } as any, { payload: { optionId } } as any)
    }
    expect(state.players[0].temporaryGrantedSkills).toContainEqual(expect.objectContaining({ source: 'lingren-b42', skillId: 'jianxiong' }))
    expect(state.players[0].temporaryGrantedSkills).toContainEqual(expect.objectContaining({ source: 'lingren-b42', skillId: 'xingshang' }))
    expect(state.b42LingrenBonus[`${state.turnNumber}:virtual:lingren-test:p1`]).toBe(1)
  })

  it('红色牌进入弃牌堆的公共账本每张实体牌只记一次', () => {
    const { state } = fixture()
    const cardId = state.zones.drawPile[0]
    Object.assign(state.cards[cardId], { color: 'red' })
    moveCard(state, cardId, { kind: 'drawPile' }, { kind: 'discardPile' })
    expect(state.turnRedDiscardCount).toEqual({ turnNumber: state.turnNumber, count: 1 })
    moveCard(state, cardId, { kind: 'discardPile' }, { kind: 'hand', playerId: 'p0' })
    expect(state.turnRedDiscardCount.count).toBe(1)
  })

  it('酒强化的杀实际造成伤害后，本回合崩坏失效', () => {
    const { state, host, requests } = fixture()
    state.players[0].characterId = 'jie-dongzhuo-b42'
    state.wineBoostedSlashCardIds = ['slash-card']
    const jiuchi = getSkillRuntime('jie-jiuchi-b42')!
    jiuchi.triggers![0].handle(host, 'p0', { event: { sourceId: 'p0', cardIds: ['slash-card'] } } as any)
    expect(state.b42BenghuaiDisabled.p0).toBe(state.turnNumber)
    const benghuai = getSkillRuntime('jie-benghuai-b42')!
    benghuai.triggers![0].handle(host, 'p0', { event: { payload: { playerId: 'p0', phase: 'finish' } } } as any)
    expect(requests).toHaveLength(0)
  })
})
