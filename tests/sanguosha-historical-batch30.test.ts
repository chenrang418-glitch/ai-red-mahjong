import { describe, expect, it } from 'vitest'
import { ALL_CHARACTERS, getCharacter, skillIdsOf } from '@/sanguosha/data/characters/standard'
import { getSkillRuntime } from '@/sanguosha/engine/skills/runtime'

const batch30 = [
  ['kongrong', ['mingshi-b30', 'lirang-b30']],
  ['zhongyu', ['zanming-b30']],
  ['puyangxing', ['hezhong-b30']],
] as const

describe('第30批历史武将注册', () => {
  it('保留的三名武将和全部技能运行时均已注册', () => {
    expect(batch30).toHaveLength(3)
    for (const [id, skills] of batch30) {
      expect(getCharacter(id), id).toBeDefined()
      expect(skillIdsOf(id)).toEqual(skills)
      for (const skillId of skills) expect(getSkillRuntime(skillId), `${id}:${skillId}`).toBeDefined()
    }
    expect(ALL_CHARACTERS.filter(x => batch30.some(([id]) => id === x.id))).toHaveLength(3)
  })

})
