import { describe, expect, it } from 'vitest'
import { ALL_CHARACTERS, STANDARD_CHARACTERS, allCharacterIds, getCharacter, skillIdsOf } from '@/sanguosha/data/characters/standard'
import { WIND_CHARACTERS } from '@/sanguosha/data/characters/wind'
import { FIRE_CHARACTERS } from '@/sanguosha/data/characters/fire'
import { FOREST_CHARACTERS } from '@/sanguosha/data/characters/forest'
import { ENTERTAINMENT_CHARACTERS } from '@/sanguosha/data/characters/entertainment'
import { getSkillRuntime } from '@/sanguosha/engine/skills/runtime'
// 技能运行时靠 import 副作用注册，而装备类技能（含铁骑、流离）注册在引擎侧。
// 不把引擎拉进来，这里会把已实现的技能误判成空壳。
import '@/sanguosha/engine/game'

/**
 * 武将包的边界。
 *
 * 最容易犯的错是让 `STANDARD_CHARACTERS` 实际装上扩展包武将——
 * 名字和内容对不上，之后所有「池子多大」的判断都会跟着错。
 * 这里把「谁属于哪个包」和「可用池子 = 全部已登记包之和」都钉死。
 */

describe('包的归属不能串', () => {
  it('STANDARD_CHARACTERS 只装标准包', () => {
    for (const character of STANDARD_CHARACTERS) {
      expect(character.pack, `${character.name} 不该在标准包数组里`).toBe('standard')
    }
  })

  it('风包、火包、林包和娱乐包各自的 pack 字段也要对', () => {
    for (const character of WIND_CHARACTERS) expect(character.pack, `${character.name}`).toBe('wind')
    for (const character of FIRE_CHARACTERS) expect(character.pack, `${character.name}`).toBe('fire')
    for (const character of FOREST_CHARACTERS) expect(character.pack, `${character.name}`).toBe('forest')
    for (const character of ENTERTAINMENT_CHARACTERS) expect(character.pack, `${character.name}`).toBe('entertainment')
  })

  it('可用池子正好是全部包之和，没有重复 id', () => {
    expect(ALL_CHARACTERS.length).toBe(
      STANDARD_CHARACTERS.length + WIND_CHARACTERS.length + FIRE_CHARACTERS.length + FOREST_CHARACTERS.length + ENTERTAINMENT_CHARACTERS.length,
    )
    const ids = ALL_CHARACTERS.map((character) => character.id)
    expect(new Set(ids).size, '武将 id 不能重复').toBe(ids.length)
  })

  it('allCharacterIds 给的是整个可用池，不只是标准包', () => {
    expect(allCharacterIds().length).toBe(ALL_CHARACTERS.length)
  })
})

describe('登记的武将必须真的能玩', () => {
  it('每个技能都有对应的运行时或被引擎直接消费', () => {
    // 引擎直接读技能 id 的锁定技（不走 registerSkillRuntime）
    const ENGINE_CONSUMED = new Set(['qicai'])
    const missing: string[] = []
    for (const character of ALL_CHARACTERS) {
      for (const skill of character.skills) {
        if (ENGINE_CONSUMED.has(skill.id)) continue
        if (!getSkillRuntime(skill.id)) missing.push(`${character.name}【${skill.name}】(${skill.id})`)
      }
    }
    expect(missing, '这些技能只有描述没有实现，属于空壳').toEqual([])
  })

  it('getCharacter 和 skillIdsOf 覆盖所有包', () => {
    for (const character of ALL_CHARACTERS) {
      expect(getCharacter(character.id), `${character.name} 查不到`).toBeTruthy()
      expect(skillIdsOf(character.id).length, `${character.name} 技能列表为空`).toBeGreaterThan(0)
    }
  })
})
