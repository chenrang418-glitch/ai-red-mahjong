import { describe, expect, it } from 'vitest'
import { ALL_CHARACTERS, getCharacter, skillIdsOf } from '@/sanguosha/data/characters/standard'
import { getSkillRuntime } from '@/sanguosha/engine/skills/runtime'

const batch29 = [
  ['chenzhen', ['chushi-b29']],
  ['jiangqin', ['shangyi-b29', 'niaoxiang-b29']],
  ['xinpi', ['chijie-b29', 'yinju-b29']],
  ['chentai', ['jiuxian-b29', 'chenyong-b29']],
  ['zangba', ['hengjiang-b29']],
  ['mateng', ['xiongyi-b29']],
  ['tianfeng', ['sijian-b29', 'suishi-b29']],
  ['shenpei', ['gangzhi-b29', 'beizhan-b29']],
] as const

describe('第29批历史武将注册', () => {
  it('保留的八名武将和全部技能运行时均已注册', () => {
    expect(batch29).toHaveLength(8)
    for (const [id, skills] of batch29) {
      expect(getCharacter(id)).toBeDefined()
      expect(skillIdsOf(id)).toEqual(skills)
      for (const skillId of skills) expect(getSkillRuntime(skillId), `${id}:${skillId}`).toBeDefined()
    }
    expect(ALL_CHARACTERS.filter(x => batch29.some(([id]) => id === x.id))).toHaveLength(8)
  })

  it('蒋钦【鸟翔】只在三人围攻关系中把闪需求提高到两张', () => {
    const runtime = getSkillRuntime('niaoxiang-b29')!
    const state = { players: [{ id: 'p0', alive: true }, { id: 'p1', alive: true }, { id: 'p2', alive: true }] } as any
    expect(runtime.dodgeResponsesFor?.(state, 'p0', 'p0', 'p1')).toBe(2)
    expect(runtime.dodgeResponsesFor?.(state, 'p0', 'p0', 'p2')).toBe(2)
    const four = { players: [...state.players, { id: 'p3', alive: true }] } as any
    expect(runtime.dodgeResponsesFor?.(four, 'p0', 'p0', 'p2')).toBe(1)
  })

  it('审配【刚直】把受伤改为统一失去体力，并保留濒死入口', () => {
    const runtime = getSkillRuntime('gangzhi-b29')!
    const state = { players: [{ id: 'p0', alive: true, hp: 3, maxHp: 3, zones: { hand: [], equipment: {}, judgingArea: [] } }] } as any
    const host: any = { state, dispatch: () => ({ cancelled: false }), enterDying: (id: string) => { state.dying = id } }
    expect(runtime.interceptIncomingDamage?.(host, 'p0', { sourceId: 'p1', amount: 1, nature: 'normal', cardId: null, cardName: '杀', chainTransfer: false })).toBe(true)
    expect(state.players[0].hp).toBe(2)
    expect(runtime.replacesDamageWithHpLoss?.(state, 'p0', { sourceId: 'p0', targetId: 'p1', amount: 1, nature: 'normal', cardName: '杀' })).toBe(true)
  })

})
