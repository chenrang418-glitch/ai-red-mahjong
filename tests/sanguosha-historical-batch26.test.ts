import { describe, expect, it } from 'vitest'
import { ALL_CHARACTERS, getCharacter, skillIdsOf } from '@/sanguosha/data/characters/standard'
import { getSkillRuntime } from '@/sanguosha/engine/skills/runtime'

const batch26 = [
  ['wangkuang', ['renxia']],
  ['wangshuang', ['zhuilie']],
  ['zhangyan', ['suji', 'langdao']],
  ['sunlang', ['tingxian', 'benshe']],
  ['pangshanmin', ['caisi', 'zhuoli']],
  ['zhouxuan', ['wumei', 'zhanmeng']],
  ['fengyu', ['tiqi', 'baoshu']],
  ['huzhao', ['midu', 'xianwang']],
  ['fugan', ['qiaojian', 'xicha']],
  ['sufei', ['shujian']],
] as const

describe('第26批历史武将注册', () => {
  it('十名武将均以独立 sp 定义注册，且技能运行时已接入', () => {
    for (const [characterId, expectedSkills] of batch26) {
      const character = getCharacter(characterId)
      expect(character).toBeDefined()
      expect(character?.pack).toBe('sp')
      expect(skillIdsOf(characterId)).toEqual(expectedSkills)
      for (const skillId of expectedSkills) expect(getSkillRuntime(skillId)).toBeDefined()
    }
    expect(ALL_CHARACTERS.filter((character) => batch26.some(([id]) => id === character.id))).toHaveLength(10)
  })
})
