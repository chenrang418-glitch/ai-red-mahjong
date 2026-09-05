import { describe, expect, it } from 'vitest'
import { ALL_CHARACTERS } from '@/sanguosha/data/characters/standard'
import { buildPresentationEvent, skillDisplayName } from '@/sanguosha/engine/presentation'
import type { GameEvent } from '@/sanguosha/engine/events'
import type { SanguoshaState } from '@/sanguosha/engine/types'

/**
 * 中央提示不能出现拼音。
 *
 * 表现层原来的写法是 `payload.skillName ?? payload.skillId`：任何一个技能
 * 忘了传 `skillName`，界面上就会显示技能 id（刘禅【若愚】显示成 ruoyu）。
 * 逐个武将补 `skillName` 治不了根——下一个新技能照样会忘，所以改成按 id
 * 反查中文名，并在这里钉死。
 */

/** 只有 skillId、没有 skillName 的 SkillActivated——这就是会出问题的那种写法。 */
function bareSkillEvent(skillId: string): GameEvent {
  return {
    id: `skill-${skillId}`, seq: 1, name: 'SkillActivated',
    payload: { playerId: 'p0', skillId },
    sourceId: 'p0',
  } as unknown as GameEvent
}

const state = {
  players: [{ id: 'p0', nickname: '甲', alive: true, characterId: 'liushan' }],
} as unknown as SanguoshaState

describe('技能名显示', () => {
  it('每一个武将牌上印着的技能都能查到中文名', () => {
    const pinyin: string[] = []
    for (const character of ALL_CHARACTERS) {
      for (const skill of character.skills) {
        if (skillDisplayName(skill.id) === skill.id) pinyin.push(`${character.name}/${skill.id}`)
      }
    }
    expect(pinyin, '这些技能会在界面上显示成拼音').toEqual([])
  })

  it('技能忘了传 skillName 时，按 id 反查中文名而不是甩出拼音', () => {
    for (const character of ALL_CHARACTERS) {
      for (const skill of character.skills) {
        const built = buildPresentationEvent(state, bareSkillEvent(skill.id))
        expect(built?.skillName, `${character.name}/${skill.id}`).toBe(skill.name)
        expect(built?.text, `${character.name}/${skill.id}`).not.toContain(skill.id)
      }
    }
  })

  it('刘禅【若愚】不再显示成 ruoyu', () => {
    const built = buildPresentationEvent(state, bareSkillEvent('ruoyu'))
    expect(built?.skillName).toBe('若愚')
    expect(built?.text).toContain('若愚')
    expect(built?.text).not.toContain('ruoyu')
  })
})
