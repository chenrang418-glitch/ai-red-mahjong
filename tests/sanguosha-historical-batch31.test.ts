import { describe, expect, it } from 'vitest'
import { ALL_CHARACTERS, getCharacter, skillIdsOf } from '@/sanguosha/data/characters/standard'
import { getSkillRuntime } from '@/sanguosha/engine/skills/runtime'

const batch31 = [
  ['gongsunxiu', ['gangu-b31', 'kuizhen-b31']],
  ['dingfeng', ['duanbing-b31', 'fenxun-b31']],
  ['fuwan', ['moukui-b31']],
  ['litong', ['funing-b31']],
  ['wuyan', ['jishi-b31']],
  ['jiangji', ['jinglue-b31']],
  ['peixiu', ['zhitu-b31']],
] as const

describe('第31批历史武将注册', () => {
  it('保留的七名武将和全部技能运行时均已注册', () => {
    expect(batch31).toHaveLength(7)
    for (const [id, skills] of batch31) {
      expect(getCharacter(id), id).toBeDefined()
      expect(skillIdsOf(id)).toEqual(skills)
      for (const skillId of skills) expect(getSkillRuntime(skillId), `${id}:${skillId}`).toBeDefined()
    }
    expect(ALL_CHARACTERS.filter(x => batch31.some(([id]) => id === x.id))).toHaveLength(7)
  })

  it('丁奉【短兵】只在存在距离为1的角色时增加目标位', () => {
    const runtime = getSkillRuntime('duanbing-b31')!
    const state = {
      players: [
        { id: 'p0', alive: true, seat: 0, distanceToOthers: 0, distanceFromOthers: 0, zones: { equipment: {} } },
        { id: 'p1', alive: true, seat: 1, distanceToOthers: 0, distanceFromOthers: 0, zones: { equipment: {} } },
      ],
    } as any
    expect(runtime.extraSlashTargets?.(state, 'p0')).toBe(1)
  })

})
