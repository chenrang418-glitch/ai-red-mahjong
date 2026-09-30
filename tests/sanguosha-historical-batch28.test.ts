import { describe, expect, it } from 'vitest'
import { ALL_CHARACTERS, getCharacter, skillIdsOf } from '@/sanguosha/data/characters/standard'
import { getSkillRuntime } from '@/sanguosha/engine/skills/runtime'

const batch28 = [
  ['zhangkai', ['xiangshu-b28']],
  ['liuchong_luojun', ['minze', 'jini']],
  ['qiuliju', ['koule', 'suiren']],
  ['dongzhao', ['yijia', 'dingji']],
  ['leibo', ['silue', 'shuaijie']],
  ['liuli', ['fuli-b28', 'dehua-b28']],
  ['kanze', ['xiashu', 'kuanshi']],
  ['zhangmiao', ['mouni', 'zongfan', 'zhangu']],
  ['xiangchong', ['guying', 'muzhen']],
  ['wangyue', ['shifeng', 'jiandao']],
] as const

describe('第28批历史武将注册', () => {
  it('十名武将、组合武将和全部技能运行时均已注册', () => {
    expect(batch28).toHaveLength(10)
    for (const [id, skills] of batch28) {
      expect(getCharacter(id)).toBeDefined()
      expect(skillIdsOf(id)).toEqual(skills)
      for (const skillId of skills) expect(getSkillRuntime(skillId), `${id}:${skillId}`).toBeDefined()
    }
    expect(getCharacter('liuchong_luojun')?.name).toBe('刘宠骆俊')
    expect(ALL_CHARACTERS.filter(x => batch28.some(([id]) => id === x.id))).toHaveLength(10)
  })
})
