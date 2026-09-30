import { describe, expect, it } from 'vitest'
import { ALL_CHARACTERS, getCharacter } from '../src/sanguosha/data/characters/standard'
import { getSkillRuntime } from '../src/sanguosha/engine/skills/runtime'
import type { SanguoshaState } from '../src/sanguosha/engine/types'

describe('闪将补录批次注册对账', () => {
  it('六名补录武将保留，国战于禁已移除，当前注册共1024名', () => {
    const names = ['闪·赵云', '闪·刘宏', '闪·张辽', '闪·孙坚', '闪·朱儁', '族·荀灌']
    for (const name of names) expect(ALL_CHARACTERS.some((character) => character.name === name)).toBe(true)
    expect(ALL_CHARACTERS.some((character) => character.name === '国战·于禁')).toBe(false)
    expect(new Set(ALL_CHARACTERS.map((character) => character.id)).size).toBe(ALL_CHARACTERS.length)
    expect(getCharacter('guozhan-yujin-b58')).toBeUndefined()
    expect(getSkillRuntime('jieyue-guozhan-yujin:b58')).toBeUndefined()
    expect(ALL_CHARACTERS.length).toBe(1024)
  })

  it('闪赵云【镇胆】只从非基本手牌生成基本牌转化动作', () => {
    const character = getCharacter('flash-zhaoyun-b91')!
    const skill = character.skills.find((entry) => entry.name === '镇胆')!
    const runtime = getSkillRuntime(skill.id)!
    const state = {
      roundNumber: 1,
      players: [{ id: 'owner', alive: true, zones: { hand: ['trick', 'basic'], equipment: {}, judgingArea: [] } }],
      cards: {
        trick: { id: 'trick', name: '无中生有', category: 'trick', suit: 'heart', rank: 7 },
        basic: { id: 'basic', name: '杀', category: 'basic', suit: 'spade', rank: 8 },
      },
    } as unknown as SanguoshaState
    const options = runtime.viewAs!(state, 'owner')
    expect(options.length).toBeGreaterThan(0)
    expect(options.every((option) => option.cardId === 'trick')).toBe(true)
    expect(options.map((option) => option.asCardName)).toContain('闪')
  })

  it('本批每项技能都有已注册的运行时处理器', () => {
    for (const name of ['闪·赵云', '闪·刘宏', '闪·张辽', '闪·孙坚', '闪·朱儁', '族·荀灌']) {
      const character = ALL_CHARACTERS.find((entry) => entry.name === name)!
      for (const skill of character.skills) expect(getSkillRuntime(skill.id), `${name}·${skill.name}`).toBeDefined()
    }
  })

  it('关键复杂玩法挂入对应引擎时机', () => {
    const runtime = (name: string, skillName: string) => {
      const character = ALL_CHARACTERS.find((entry) => entry.name === name)!
      return getSkillRuntime(character.skills.find((skill) => skill.name === skillName)!.id)!
    }
    expect(runtime('闪·赵云', '龙临').interceptTarget).toBeTypeOf('function')
    expect(runtime('闪·赵云', '龙临').globalProhibitsSourceTarget).toBeTypeOf('function')
    expect(runtime('闪·孙坚', '绝烈').outgoingDamage).toBeTypeOf('function')
    expect(runtime('闪·张辽', '突围').triggers?.some((trigger) => trigger.event === 'TurnEnd')).toBe(true)
    expect(runtime('闪·朱儁', '分敌').prohibitsCardResponse).toBeTypeOf('function')
    expect(runtime('闪·朱儁', '分敌').prohibitsResponseCard).toBeTypeOf('function')
  })

  it('孙坚【绝烈】只强化原始伤害，不重复强化传导伤害', () => {
    const character = getCharacter('flash-sunjian-b91')!
    const skillId = character.skills.find((entry) => entry.name === '绝烈')!.id
    const runtime = getSkillRuntime(skillId)!
    const state = {
      b91: { sunjianJuelie: { slash: { ownerId: 'owner', bonus: true, askedTargets: [], damagedTargets: [] } } },
    } as unknown as SanguoshaState
    expect(runtime.outgoingDamage!(state, 'owner', {
      sourceId: 'owner', targetId: 'target', amount: 1, nature: 'normal', cardId: 'slash', cardName: '杀', chainTransfer: false,
    })).toEqual({ amount: 2 })
    expect(runtime.outgoingDamage!(state, 'owner', {
      sourceId: 'owner', targetId: 'chained', amount: 1, nature: 'normal', cardId: 'slash', cardName: '杀', chainTransfer: true,
    })).toBeNull()
  })

  it('朱儁【分敌】的实体牌与无实体响应限制只作用于当前目标和当前杀', () => {
    const character = getCharacter('flash-zhujun-b91')!
    const skillId = character.skills.find((skill) => skill.name === '分敌')!.id
    const runtime = getSkillRuntime(skillId)!
    const state = {
      turnNumber: 4,
      cardResolution: { kind: 'slash', cardId: 'slash', sourceId: 'source', targetId: 'target' },
      players: [{ id: 'owner', alive: true, characterId: character.id, zones: { hand: [], equipment: {}, judgingArea: [] } }],
      cards: {},
      b91: { zhuJunFence: { slash: { ownerId: 'owner', targetId: 'target', shown: ['shown'], damaged: false } } },
    } as unknown as SanguoshaState
    expect(runtime.prohibitsResponseCard!(state, 'owner', 'target', 'shown', '闪')).toBe(false)
    expect(runtime.prohibitsResponseCard!(state, 'owner', 'target', 'hidden', '闪')).toBe(true)
    expect(runtime.prohibitsCardlessResponse!(state, 'owner', 'target', '闪')).toBe(true)
    expect(runtime.prohibitsResponseCard!(state, 'owner', 'other-target', 'hidden', '闪')).toBe(false)
  })
})
