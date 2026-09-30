import { describe, expect, it } from 'vitest'
import { ALL_CHARACTERS, getCharacter, skillIdsOf } from '@/sanguosha/data/characters/standard'
import { emptyEquipment } from '@/sanguosha/engine/types'
import { GameRng } from '@/sanguosha/engine/rng'
import { equipmentSkillIdsOf, getSkillRuntime } from '@/sanguosha/engine/skills/runtime'

const batch27 = [
  ['caojinyu', ['yuqi', 'shanshen', 'xianjing']],
  ['fengfangnv', ['zhuangshu', 'chuiti']],
  ['heyan', ['yachai', 'qingtan']],
  ['wanglie', ['chongwang', 'huagui']],
  ['yangyi', ['juanxia', 'dingcuo']],
  ['yangwan', ['youyan', 'zhuihuan']],
  ['linghuyu', ['xuzhi']],
  ['huzun', ['zhantao', 'anjing']],
  ['feiyao', ['zhenfeng']],
  ['qiaorui', ['aishou', 'saowei']],
] as const

describe('第27批历史武将注册', () => {
  it('十名武将及技能运行时完整注册', () => {
    for (const [id, skills] of batch27) {
      expect(getCharacter(id)).toBeDefined()
      expect(skillIdsOf(id)).toEqual(skills)
      for (const skillId of skills) expect(getSkillRuntime(skillId)).toBeDefined()
    }
    expect(ALL_CHARACTERS.filter(x => batch27.some(([id]) => id === x.id))).toHaveLength(10)
  })

  it('冯方女的特殊宝梳能从装备区获得对应运行时技能', () => {
    const state = {
      players: [{ id: 'p0', zones: { hand: [], equipment: { ...emptyEquipment(), treasure: 'treasure-1' }, judgingArea: [] } }],
      cards: { 'treasure-1': { id: 'treasure-1', specialEquipment: 'xishu' } },
    } as any
    expect(equipmentSkillIdsOf(state, 'p0')).toContain('xishu')
  })

  it('琼梳防止伤害会先发出按伤害数支付的交互请求', () => {
    const state = {
      players: [{ id: 'p0', zones: { hand: ['h1', 'h2'], equipment: emptyEquipment(), judgingArea: [] } }],
      cards: { h1: { id: 'h1' }, h2: { id: 'h2' } },
    } as any
    const queued: any[] = []
    let request: any
    const host: any = {
      state,
      rng: new GameRng('batch27-qiongshu'),
      queueSkill: (entry: any) => queued.push(entry),
      askSkill: (entry: any) => { request = entry.build('request-1') },
    }
    const runtime = getSkillRuntime('qiongshu')!
    expect(runtime.offersTargetDamagePreventionAsk?.(host, 'p0', { targetId: 'p0', amount: 2 })).toBe(true)
    expect(queued).toEqual([{ skillId: 'qiongshu', ownerId: 'p0', step: 'prevent', data: { amount: 2 } }])
    runtime.startQueued?.(host, 'p0', queued[0])
    expect(request).toMatchObject({ kind: 'choose-cards', playerId: 'p0', cardIds: ['h1', 'h2'], min: 0, max: 2 })
  })

  it('犀梳通过阶段引擎窗口记录跳过判定或弃牌阶段', () => {
    const state = {
      phase: 'judge', skippedPhases: [],
      players: [{ id: 'p0', alive: true, zones: { hand: [], equipment: { ...emptyEquipment(), treasure: 'treasure-1' }, judgingArea: [] } }],
      cards: { 'treasure-1': { id: 'treasure-1', name: '犀梳' } },
    } as any
    let request: any
    const host: any = {
      state,
      askSkill: (entry: any) => { request = entry.build('request-1') },
      resumePhaseEntry: () => { host.resumed = true },
    }
    const runtime = getSkillRuntime('xishu')!
    expect(runtime.offerPhaseSkip?.(host, 'p0', 'judge')).toBe(true)
    expect(request).toMatchObject({ kind: 'choose-option', options: [{ id: 'yes' }, { id: 'no' }] })
    runtime.resume?.(host, 'p0', { step: 'phase-skip', data: { phase: 'judge' } } as any, { payload: { optionId: 'yes' } } as any)
    expect(state.skippedPhases).toEqual(['judge'])
    expect(host.resumed).toBe(true)
  })

  it('诱言接受真实弃牌阶段的 discard-phase 事件，并且每阶段只触发一次', () => {
    const state = {
      phase: 'discard', turnNumber: 3,
      zones: { drawPile: ['spade-1', 'heart-1', 'club-1', 'diamond-1'], discardPile: ['lost-1'], processingArea: [] },
      cardAliases: {}, cardNatures: {},
      players: [{ id: 'p0', zones: { hand: [], equipment: emptyEquipment(), judgingArea: [] } }],
      cards: {
        'lost-1': { id: 'lost-1', suit: 'spade' }, 'spade-1': { id: 'spade-1', suit: 'spade' },
        'heart-1': { id: 'heart-1', suit: 'heart' }, 'club-1': { id: 'club-1', suit: 'club' }, 'diamond-1': { id: 'diamond-1', suit: 'diamond' },
      },
    } as any
    const host: any = { state, rng: new GameRng('batch27-youyan'), dispatch: () => undefined }
    const trigger = getSkillRuntime('youyan')!.triggers?.find(entry => entry.event === 'LoseCard')!
    const context: any = { event: { sourceId: 'p0', payload: { reason: 'discard-phase', cardIds: ['lost-1'] } } }
    trigger.handle(host, 'p0', context)
    expect(state.players[0].zones.hand).toEqual(['heart-1', 'club-1', 'diamond-1'])
    expect(state.zones.drawPile).toEqual(['spade-1'])
    trigger.handle(host, 'p0', context)
    expect(state.players[0].zones.hand).toHaveLength(3)
  })
})
