import { describe, expect, it } from 'vitest'
import { ALL_CHARACTERS } from '@/sanguosha/data/characters/standard'
import { HISTORICAL_BATCH43_CHARACTERS } from '@/sanguosha/data/characters/historical-batch43'
import { HISTORICAL_BATCH45_PART1, HISTORICAL_BATCH45_PART2 } from '@/sanguosha/data/characters/historical-batch45'
import { SanguoshaGame } from '@/sanguosha/engine/game'
import { getSkillRuntime } from '@/sanguosha/engine/skills/runtime'
import { hasTemporaryCardSkillTag, setTemporaryCardSkillTag } from '@/sanguosha/engine/temporary-card-skill-tags'

function fixture() {
  const game = new SanguoshaGame({ seed: 'historical-b45-targeted', setup: {
    mode: 'identity', generalChoices: 1,
    players: Array.from({ length: 5 }, (_, index) => ({ id: `p${index}`, nickname: `玩家${index}`, isHuman: index === 0 })),
  } })
  const state = game.state as any
  state.status = 'playing'; state.phase = 'play'; state.currentPlayerId = 'p0'; state.normalTurnPlayerId = 'p0'; state.turnNumber = 2
  state.players.forEach((entry: any, index: number) => {
    entry.characterId = index === 0 ? 'yangbiao-b45' : 'caocao'
    entry.hp = 3; entry.maxHp = 4
    entry.zones.hand = state.zones.drawPile.splice(0, 4)
  })
  const requests: any[] = []
  const host = {
    state, rng: game.rng,
    dispatch: game.dispatch.bind(game),
    askSkill(options: any) { requests.push({ ...options, request: options.build(`b45-${requests.length}`) }) },
    queueSkill(prompt: any) { state.skillQueue.push(prompt) },
    beginVirtualSlash: game.beginVirtualSlash.bind(game), beginVirtualTrick: game.beginVirtualTrick.bind(game),
    resumeCardTarget: game.resumeCardTarget.bind(game), enterDying: game.enterDying.bind(game),
    resumePhaseEntry() {},
  } as any
  return { game, state, host, requests }
}

const newCharacters = [...HISTORICAL_BATCH43_CHARACTERS, ...HISTORICAL_BATCH45_PART1, ...HISTORICAL_BATCH45_PART2]

describe('武将册第45批定向规则', () => {
  it('10名武将均唯一注册，且每个技能均有运行时', () => {
    expect(newCharacters).toHaveLength(10)
    for (const character of newCharacters) {
      expect(ALL_CHARACTERS).toContain(character)
      for (const skill of character.skills) expect(getSkillRuntime(skill.id), `${character.name}/${skill.name}`).toBeDefined()
    }
    expect(new Set(ALL_CHARACTERS.map(character => character.id)).size).toBe(ALL_CHARACTERS.length)
  })

  it('杨彪昭汉前四次准备阶段增上限并回复，且第八次不再增长', () => {
    const { state, host } = fixture()
    const runtime = getSkillRuntime(HISTORICAL_BATCH45_PART1[0].skills[0].id)!
    const trigger = runtime.triggers?.find((entry) => entry.event === 'PhaseStart')!
    for (let n = 0; n < 4; n += 1) {
      state.players[0].hp = state.players[0].maxHp - 1
      trigger.handle(host, 'p0', { event: { payload: { playerId: 'p0', phase: 'prepare' } } } as any)
    }
    expect(state.players[0].maxHp).toBe(8)
    expect(state.players[0].hp).toBe(7)
    for (let n = 0; n < 4; n += 1) trigger.handle(host, 'p0', { event: { payload: { playerId: 'p0', phase: 'prepare' } } } as any)
    expect(state.players[0].maxHp).toBe(5)
  })

  it('杨彪义争拼点赢时排期跳过对方下个摸牌阶段，平局按未赢扣上限', () => {
    const { game, state, host, requests } = fixture()
    state.players[0].characterId = 'yangbiao-b45'
    const runtime = getSkillRuntime(HISTORICAL_BATCH45_PART1[0].skills[2].id)!
    runtime.resume?.(host, 'p0', { step: 'target', data: {} } as any, { payload: { targetIds: ['p1'] } } as any)
    const pindianRequests = [...state.pendingRequests]
    expect(pindianRequests.map((request: any) => request.playerId)).toEqual(['p0', 'p1'])
    const high = state.players[0].zones.hand[0]
    const low = state.players[1].zones.hand[0]
    expect(high).toBeTruthy(); expect(low).toBeTruthy()
    state.cards[high].rank = 13; state.cards[low].rank = 1
    game.respond({ requestId: pindianRequests.find((r: any) => r.playerId === 'p0').id, playerId: 'p0', payload: { cardIds: [high] } })
    game.respond({ requestId: pindianRequests.find((r: any) => r.playerId === 'p1').id, playerId: 'p1', payload: { cardIds: [low] } })
    expect(state.scheduledSkippedPhasesByPlayer?.p1).toContain('draw')
    expect(requests.length).toBe(0)
  })

  it('界于禁仅在结束阶段开启节钺，且目标自己收到选择请求', () => {
    const { state, host, requests } = fixture()
    state.players[0].characterId = 'jie-yujin-b45'
    const runtime = getSkillRuntime(HISTORICAL_BATCH45_PART2[0].skills[0].id)!
    runtime.triggers?.[0].handle(host, 'p0', { event: { payload: { playerId: 'p0', phase: 'finish' } } } as any)
    runtime.resume?.(host, 'p0', { step: 'target', data: {} } as any, { payload: { targetIds: ['p1'] } } as any)
    const request = requests.at(-1)?.request
    expect(request.playerId).toBe('p0')
    expect(request.cardIds.length).toBeGreaterThan(0)
  })

  it('界于禁目标选择摸三张时于禁本人获得牌，保留分支由目标选定保留牌', () => {
    const { state, host, requests } = fixture()
    state.players[0].characterId = 'jie-yujin-b45'
    const runtime = getSkillRuntime(HISTORICAL_BATCH45_PART2[0].skills[0].id)!
    const target = state.players[1]
    target.zones.hand.push(...state.zones.drawPile.splice(0, 2))
    target.zones.equipment.weapon = state.zones.drawPile.shift()
    runtime.resume?.(host, 'p0', { step: 'choice', data: { targetId: 'p1' } } as any, { payload: { optionId: 'draw' } } as any)
    expect(state.players[0].zones.hand.length).toBe(7)
    runtime.resume?.(host, 'p0', { step: 'choice', data: { targetId: 'p1' } } as any, { payload: { optionId: 'keep' } } as any)
    expect(requests.at(-1)?.request.playerId).toBe('p1')
    expect(requests.at(-1)?.request.prompt).toContain('保留一张手牌')
  })

  it('界凌统按弃牌阶段账本至少两张触发，装备移动只提供可移动的其他人装备', () => {
    const { state, host } = fixture()
    state.players[0].characterId = 'jie-lingtong-b45'
    state.discardPhaseLedger = { ownerPlayerId: 'p0', phaseInstanceId: 'test', records: [
      { sourcePlayerId: 'p0', cardId: 'a', originalZone: 'hand', moveReason: 'discard', enteredDiscardAt: 1 },
      { sourcePlayerId: 'p0', cardId: 'b', originalZone: 'equipment', moveReason: 'discard', enteredDiscardAt: 2 },
    ] }
    const runtime = getSkillRuntime(HISTORICAL_BATCH45_PART2[1].skills[0].id)!
    runtime.triggers?.find((entry) => entry.event === 'PhaseEnd')?.handle(host, 'p0', { event: { payload: { playerId: 'p0', phase: 'discard' } } } as any)
    expect(state.skillQueue.at(-1)?.step).toBe('mode')
  })

  it('界韩当坐骑存在时攻击范围覆盖、解烦仍为限定技且申请多名角色选择', () => {
    const { state, host, requests } = fixture()
    state.players[0].characterId = 'jie-handang-b45'
    state.players[0].zones.equipment.offensiveHorse = 'horse'
    const runtime = getSkillRuntime(HISTORICAL_BATCH45_PART2[2].skills[0].id)!
    expect(runtime.overridesAttackRange?.(state, 'p0')).toBe(Number.POSITIVE_INFINITY)
    const jiefan = getSkillRuntime(HISTORICAL_BATCH45_PART2[2].skills[1].id)!
    expect(jiefan.limited).toBe(true)
    jiefan.invokeActive?.(host, 'p0', jiefan.id)
    jiefan.resume?.(host, 'p0', { step: 'target', data: {} } as any, { payload: { targetIds: ['p1'] } } as any)
    expect(state.groupDecision?.playerIds.length).toBeGreaterThan(0)
    expect(requests.length).toBe(1)
    expect(Object.keys(state.groupDecision.responses)).toHaveLength(0)
  })

  it('界程普只对技能改成火杀且未传导的连环目标加伤，火杀结算按总伤害每两点失去体力', () => {
    const { state, host } = fixture()
    state.players[0].characterId = 'jie-chengpu-b45'
    state.players[1].chained = true
    const runtime = getSkillRuntime(HISTORICAL_BATCH45_PART2[3].skills[0].id)!
    setTemporaryCardSkillTag(state, 'converted', HISTORICAL_BATCH45_PART2[3].skills[0].id)
    expect(runtime.outgoingDamage?.(state, 'p0', { targetId: 'p1', amount: 1, nature: 'fire', cardId: 'converted', cardName: '杀', chainTransfer: false })).toEqual({ amount: 2 })
    expect(runtime.outgoingDamage?.(state, 'p0', { targetId: 'p1', amount: 1, nature: 'fire', cardId: 'converted', cardName: '杀', chainTransfer: true })).toBeNull()
    state.cards.converted = { id: 'converted', name: '杀', category: 'basic', suit: 'heart', rank: 1, color: 'red', damageNature: 'fire' }
    state.cardDamageLedger = { converted: 2 }
    runtime.triggers?.find((entry) => entry.event === 'AfterCardUse')?.handle(host, 'p0', {
      event: { sourceId: 'p0', payload: { cardId: 'converted', cardName: '杀' } },
    } as any)
    expect(state.players[0].hp).toBe(2)
    expect(hasTemporaryCardSkillTag(state, 'converted', HISTORICAL_BATCH45_PART2[3].skills[0].id)).toBe(false)
  })

  it('界钟会权计上限随权堆变化，三权满足自立觉醒并授予排异', () => {
    const { state, host, requests } = fixture()
    state.players[0].characterId = 'jie-zhonghui-b45'
    state.players[0].characterPiles = { 'quan-b45': ['q1', 'q2', 'q3'] }
    const [quanji, zili, paiyi] = HISTORICAL_BATCH45_PART2[4].skills.map((skill) => getSkillRuntime(skill.id)!)
    expect(quanji.maxCardsBonus?.(state, 'p0')).toBe(3)
    expect(zili.awakening?.ready(state, 'p0')).toBe(true)
    zili.awakening?.invoke(host, 'p0')
    expect(requests.at(-1)?.request.options).toHaveLength(2)
    zili.resume?.(host, 'p0', { step: 'choice', data: {} } as any, { payload: { optionId: 'draw' } } as any)
    expect(state.players[0].grantedSkills).toContain(paiyi.id)
  })
})
