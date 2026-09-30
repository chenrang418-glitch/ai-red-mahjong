import { describe, expect, it } from 'vitest'
import { ALL_CHARACTERS, getCharacter, skillIdsOf } from '@/sanguosha/data/characters/standard'
import { getSkillRuntime } from '@/sanguosha/engine/skills/runtime'

const batch35 = [
  ['zherong', ['futu-b35', 'jingtu-b35', 'jiebian-b35', 'fozong-b35']],
  ['mi-furen', ['guixiu-b35', 'qingyu-b35', 'xuancun-b35']],
  ['li-ru-jie', ['juece-jie-b35', 'mieji-jie-b35', 'fencheng-jie-b35']],
  ['ma-jun', ['jingxie-b35', 'qiaosi-b35']],
  ['panzhang-mazhong-jie', ['duodao-jie-b35', 'anjian-jie-b35']],
  ['pang-degong', ['pingcai-b35', 'yinshi-b35']],
  ['li-feng', ['tunchu-b35', 'shuliang-b35']],
  ['yan-baihu', ['zhidao-b35', 'jili-b35']],
  ['lai-min', ['laishou-b35', 'luanqun-b35']],
  ['ma-liang', ['zishu-b35', 'yingyuan-b35']],
] as const

describe('武将册第35批注册', () => {
  it('10名武将及每项技能运行时均已注册，且人物ID全局唯一', () => {
    for (const [id, skills] of batch35) {
      expect(getCharacter(id), id).toBeDefined()
      expect(skillIdsOf(id)).toEqual(skills.filter(skillId => !getCharacter(id)!.skills.find(skill => skill.id === skillId)?.granted))
      for (const skillId of skills) expect(getSkillRuntime(skillId), `${id}:${skillId}`).toBeDefined()
    }
    expect(ALL_CHARACTERS.filter(character => batch35.some(([id]) => id === character.id))).toHaveLength(10)
    expect(new Set(ALL_CHARACTERS.map(character => character.id)).size).toBe(ALL_CHARACTERS.length)
  })
})
