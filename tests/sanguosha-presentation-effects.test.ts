import { describe, expect, it } from 'vitest'
import { directedTargets, effectOwnerIds, seatEffectFor } from '@/sanguosha/presentation/effects'
import type { PresentationEvent } from '@/sanguosha/engine/presentation'

function event(kind: PresentationEvent['kind'], extra: Partial<PresentationEvent>): PresentationEvent {
  return { id: `e-${kind}`, seq: 1, kind, text: kind, ...extra }
}

describe('座位表现归属', () => {
  it('伤害、失去体力和回复只作用在目标，不误伤来源', () => {
    for (const kind of ['damage', 'lose-hp'] as const) {
      const current = event(kind, { sourceId: 'p0', targetIds: ['p1'], amount: 1 })
      expect(seatEffectFor(current, 'p0')).toBeNull()
      expect(seatEffectFor(current, 'p1')).toBe('damage')
      expect(effectOwnerIds(current)).toEqual(['p1'])
    }
    const recover = event('recover', { sourceId: 'p0', targetIds: ['p1'], amount: 1 })
    expect(seatEffectFor(recover, 'p0')).toBeNull()
    expect(seatEffectFor(recover, 'p1')).toBe('recover')
    expect(effectOwnerIds(recover)).toEqual(['p1'])
  })

  it('闪突出响应者；技能来源和目标使用不同效果', () => {
    const dodge = event('card-response', { sourceId: 'p1', cardName: '闪' })
    expect(seatEffectFor(dodge, 'p1')).toBe('dodge')
    const skill = event('skill', { sourceId: 'p0', targetIds: ['p1'], skillName: '奇袭' })
    expect(seatEffectFor(skill, 'p0')).toBe('skill')
    expect(seatEffectFor(skill, 'p1')).toBe('skill-target')
  })

  it('一到两个目标画箭头，AOE 不画满屏箭头', () => {
    expect(directedTargets(event('card-use', { sourceId: 'p0', targetIds: ['p1', 'p2'] }))).toEqual(['p1', 'p2'])
    expect(directedTargets(event('card-use', { sourceId: 'p0', targetIds: ['p1', 'p2', 'p3'] }))).toEqual([])
  })
})
