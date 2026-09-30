import { describe, expect, it } from 'vitest'
import { SanguoshaGame } from '@/sanguosha/engine/game'
import { getSkillRuntime } from '@/sanguosha/engine/skills/runtime'
import { ALL_CHARACTERS } from '@/sanguosha/data/characters/standard'
import { HISTORICAL_BATCH75_CHARACTERS } from '@/sanguosha/data/characters/historical-batch75'

function gameFor(seed: string): SanguoshaGame {
  const game = new SanguoshaGame({ seed, setup: { mode: 'identity', generalChoices: 1,
    players: Array.from({ length: 5 }, (_, index) => ({ id: `${seed}-${index}`, nickname: `玩家${index}`, isHuman: true })) } })
  game.state.status = 'playing'
  game.state.pendingRequests = []
  game.state.players.forEach((player) => { player.characterId = null })
  return game
}

describe('武将册第75批技能接入', () => {
  it('按武将册次序登记十名，每项技能均有实际运行时', () => {
    expect(HISTORICAL_BATCH75_CHARACTERS.map(({ name }) => name)).toEqual([
      '卞喜', '关宁', '韩龙', '张楚', '公孙度', '袁谭袁尚袁熙', '董贵人', '张瑾云', '段巧笑', '田尚衣',
    ])
    expect(HISTORICAL_BATCH75_CHARACTERS.every(({ id }) => ALL_CHARACTERS.some((character) => character.id === id))).toBe(true)
    expect(new Set(HISTORICAL_BATCH75_CHARACTERS.map(({ id }) => id)).size).toBe(10)
    for (const character of HISTORICAL_BATCH75_CHARACTERS)
      for (const skill of character.skills) expect(getSkillRuntime(skill.id), `${character.name}【${skill.name}】`).toBeDefined()
  })

  it('韩龙【独往】把牌堆顶五张非【杀】置入“刺”，并双向增加距离', () => {
    const game = gameFor('b75-duwang')
    const owner = game.state.players[0]!
    owner.characterId = 'hanlong-b75'
    const runtime = getSkillRuntime('duwang-hanlong-b75')!
    runtime.onGameStart!(game as never, owner.id)
    const spikes = owner.characterPiles?.['刺'] ?? []
    expect(spikes).toHaveLength(5)
    expect(spikes.every((id) => game.state.cards[id]?.name !== '杀')).toBe(true)
    expect(runtime.distanceModifier?.toOthers?.(game.state, owner.id)).toBe(1)
    expect(runtime.distanceModifier?.fromOthers?.(game.state, owner.id)).toBe(1)
  })

  it('张瑾云【继椒】只在牌堆洗牌或角色死亡后于回合结束重置限定技', () => {
    const game = gameFor('b75-jijiao-reset')
    const owner = game.state.players[0]!
    owner.characterId = 'zhangjinyun-b75'
    owner.usedLimitedSkills.push('jijiao-zhangjinyun-b75')
    const runtime = getSkillRuntime('jijiao-zhangjinyun-b75')!
    const turnEnd = runtime.triggers!.find((trigger) => trigger.event === 'TurnEnd')!
    turnEnd.handle(game as never, owner.id, { event: { id: 'b75-end-no-reset', seq: game.state.seq++, name: 'TurnEnd', payload: {} }, cancelled: false, cancel() { this.cancelled = true } } as never)
    expect(owner.usedLimitedSkills).toContain('jijiao-zhangjinyun-b75')
    ;(game.state as typeof game.state & { b75?: Record<string, any> }).b75 = { jijiaoReset: { [owner.id]: true } }
    turnEnd.handle(game as never, owner.id, { event: { id: 'b75-end-reset', seq: game.state.seq++, name: 'TurnEnd', payload: {} }, cancelled: false, cancel() { this.cancelled = true } } as never)
    expect(owner.usedLimitedSkills).not.toContain('jijiao-zhangjinyun-b75')
  })
})
