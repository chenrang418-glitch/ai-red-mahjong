import { describe, expect, it, vi } from 'vitest'
import { getCharacter } from '../src/sanguosha/data/characters/standard'
import { getSkillRuntime } from '../src/sanguosha/engine/skills/runtime'
import type { SkillHost } from '../src/sanguosha/engine/skills/runtime'
import type { SanguoshaState } from '../src/sanguosha/engine/types'

const FEIDUDAI = getCharacter('feidudai-kangaroo')!
const skill = (name: string) => FEIDUDAI.skills.find((entry) => entry.name === name)!
const runtime = (name: string) => getSkillRuntime(skill(name).id)!

function player(id: string, seat: number, hand: string[] = []) {
  return {
    id, seat, alive: true, hp: 4, maxHp: 4, distanceToOthers: 0, distanceFromOthers: 0, turnUsedSkills: [], marks: {},
    zones: { hand, equipment: {}, judgingArea: [] },
  }
}

describe('娱乐自定义武将·肥嘟袋鼠', () => {
  it('注册4体力乐势力武将，且三项技能均接入运行时', () => {
    expect(FEIDUDAI).toMatchObject({ name: '肥嘟袋鼠', kingdom: 'le', maxHp: 4, pack: 'entertainment' })
    for (const entry of FEIDUDAI.skills) expect(getSkillRuntime(entry.id), entry.name).toBeDefined()
  })

  it('【肥胆】只在本回合中该角色第二次以牌指定自己时触发一次询问', () => {
    const state = {
      turnNumber: 7, currentPlayerId: 'attacker', phase: 'play',
      players: [player('bag', 0), player('attacker', 1)],
    } as unknown as SanguoshaState
    const asks: unknown[] = []
    const host = { state, askSkill: (request: unknown) => asks.push(request) } as unknown as SkillHost
    const intercept = runtime('肥胆').interceptTarget!
    const context = { sourceId: 'attacker', targetId: 'bag', cardId: 'card', cardName: '杀', category: 'basic' } as const
    expect(intercept(host, 'bag', context)).toBe(false)
    expect(intercept(host, 'bag', { ...context, cardId: 'card-2' })).toBe(true)
    expect(intercept(host, 'bag', { ...context, cardId: 'card-3' })).toBe(false)
    expect(asks).toHaveLength(1)
  })

  it('【肥胆】选择无效后取消当前目标并恢复牌结算', () => {
    const state = {
      turnNumber: 2,
      players: [player('bag', 0), player('attacker', 1)],
      cardResolution: { kind: 'slash', sourceId: 'attacker', targetId: 'bag', targetCancelled: false },
    } as unknown as SanguoshaState
    const resumeCardTarget = vi.fn()
    const host = { state, resumeCardTarget } as unknown as SkillHost
    runtime('肥胆').resume!(host, 'bag', { step: 'choice', data: { targetId: 'attacker' } } as never,
      { requestId: 'r', playerId: 'attacker', payload: { optionId: 'cancel' } })
    expect((state.cardResolution as { targetCancelled: boolean }).targetCancelled).toBe(true)
    expect(resumeCardTarget).toHaveBeenCalledOnce()
  })

  it('【抢单】只响应其他两名角色之间的牌转移，且每轮只排入一次', () => {
    const state = {
      roundNumber: 3,
      players: [player('bag', 0), player('giver', 1), player('receiver', 2, ['hand'])],
    } as unknown as SanguoshaState
    const queued: unknown[] = []
    const host = { state, queueSkill: (prompt: unknown) => queued.push(prompt) } as unknown as SkillHost
    const trigger = runtime('抢单').triggers!.find((entry) => entry.event === 'CardZoneMoved')!
    const context = { event: { payload: { fromPlayerId: 'giver', toPlayerId: 'receiver' } } } as never
    trigger.handle(host, 'bag', context)
    trigger.handle(host, 'bag', context)
    expect(queued).toHaveLength(1)
    ;(state as unknown as { feidudai: { qiangdanRound: Record<string, number>; qiangdanPending: Record<string, boolean> } }).feidudai = {
      qiangdanRound: { bag: 3 }, qiangdanPending: {},
    }
    trigger.handle(host, 'bag', context)
    expect(queued).toHaveLength(1)
  })

  it('【风雨无阻】所有目标无距离限制，远距离用牌结算后排入代价', () => {
    const state = {
      turnNumber: 1, roundNumber: 1, currentPlayerId: 'bag',
      players: [player('bag', 0), player('near', 1), player('middle', 2), player('far', 3), player('last', 4)],
      zones: { drawPile: [], discardPile: [], processingArea: [] }, cards: {},
    } as unknown as SanguoshaState
    const queued: unknown[] = []
    const host = { state, queueSkill: (prompt: unknown) => queued.push(prompt) } as unknown as SkillHost
    expect(runtime('风雨无阻').ignoresDistanceTo!(state, 'bag', 'far')).toBe(true)
    expect(runtime('风雨无阻').ignoresTrickDistance).toBe(true)
    runtime('风雨无阻').triggers!.find((entry) => entry.event === 'CardUsed')!.handle(host, 'bag', {
      event: { sourceId: 'bag', payload: { cardId: 'used', targetIds: ['far'] } },
    } as never)
    runtime('风雨无阻').triggers!.find((entry) => entry.event === 'AfterCardUse')!.handle(host, 'bag', {
      event: { sourceId: 'bag', payload: { cardId: 'used' } },
    } as never)
    expect(queued).toHaveLength(1)
    expect(queued[0]).toMatchObject({ skillId: skill('风雨无阻').id, step: 'pay-cost' })
  })
})
