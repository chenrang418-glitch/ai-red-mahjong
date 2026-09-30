import { describe, expect, it } from 'vitest'
import { ALL_CHARACTERS } from '@/sanguosha/data/characters/standard'
import {
  B50_JIE_JUSHOU, B50_MOU_HUANGZHONG, B50_MOU_XIAHOU_SHI, B50_MOU_ZHAOYUN, B50_ZOUSHI,
  HISTORICAL_BATCH50_CHARACTERS,
} from '@/sanguosha/data/characters/historical-batch50'
import { isGeneralRevealProhibited } from '@/sanguosha/engine/general-slots'
import { SanguoshaGame } from '@/sanguosha/engine/game'
import { getSkillRuntime } from '@/sanguosha/engine/skills/runtime'
import { markUsedThisPhase } from '@/sanguosha/engine/phase-usage'
import { moveCard } from '@/sanguosha/engine/zones'

function gameFixture() {
  const game = new SanguoshaGame({ seed: 'historical-batch50-targeted', setup: {
    mode: 'identity', generalChoices: 1,
    players: Array.from({ length: 5 }, (_, index) => ({ id: `p${index}`, nickname: `玩家${index}`, isHuman: index === 0 })),
  } })
  return { game, owner: game.state.players[0], other: game.state.players[1] }
}

describe('第50批注册与新增规则', () => {
  it('本批导出列表中的角色全部进入正式选将注册表且没有重复 ID', () => {
    const ids = HISTORICAL_BATCH50_CHARACTERS.map((character) => character.id)
    expect(HISTORICAL_BATCH50_CHARACTERS).toHaveLength(10)
    expect(new Set(ids).size).toBe(ids.length)
    for (const character of HISTORICAL_BATCH50_CHARACTERS)
      expect(ALL_CHARACTERS.find((entry) => entry.id === character.id)).toBe(character)
  })

  it('谋赵云未强化的龙胆不能把杀转化为其他基本牌', () => {
    const { game, owner } = gameFixture()
    owner.characterId = B50_MOU_ZHAOYUN.id
    const runtime = getSkillRuntime(B50_MOU_ZHAOYUN.skills[0].id)!
    runtime.onGameStart?.(game, owner.id)
    const slashId = game.state.zones.drawPile.find((id) => game.state.cards[id]?.name === '杀')!
    const respond = runtime.triggers?.find((entry) => entry.event === 'CardResponded')!
    respond.handle(game, owner.id, { event: { sourceId: owner.id, payload: {
      playerId: owner.id, cardId: slashId, cardName: '桃', asking: false,
    } } } as never)
    expect((game.state as typeof game.state & { b50ZhaoyunCharges?: Record<string, number> }).b50ZhaoyunCharges?.[owner.id]).toBe(1)
  })

  it('界沮授渐营只开放出牌阶段限一次的基本牌转化', () => {
    const { game, owner } = gameFixture()
    owner.characterId = B50_JIE_JUSHOU.id
    const cardId = game.state.zones.drawPile[0]
    moveCard(game.state, cardId, { kind: 'drawPile' }, { kind: 'hand', playerId: owner.id })
    game.state.phase = 'play'
    game.state.currentPlayerId = owner.id
    const skill = getSkillRuntime(B50_JIE_JUSHOU.skills[0].id)!
    expect(skill.viewAs?.(game.state, owner.id)).toContainEqual(expect.objectContaining({ asCardName: '桃' }))
    markUsedThisPhase(game.state, owner.id, skill.id)
    expect(skill.viewAs?.(game.state, owner.id)).toEqual([])
  })

  it('祸水在邹氏明置且其回合時禁止其他角色明置，不限制邹氏自己', () => {
    const { game, owner, other } = gameFixture()
    owner.characterId = B50_ZOUSHI.id
    owner.primaryGeneralRevealed = true
    other.characterId = 'caocao'
    game.state.currentPlayerId = owner.id
    expect(isGeneralRevealProhibited(game.state, other.id, 'primary')).toBe(true)
    expect(isGeneralRevealProhibited(game.state, owner.id, 'primary')).toBe(false)
  })

  it('樵拾在同一全局回合的第一次合格伤害后即消耗次数', () => {
    const { game, owner, other } = gameFixture()
    owner.characterId = B50_MOU_XIAHOU_SHI.id
    const runtime = getSkillRuntime(B50_MOU_XIAHOU_SHI.skills.find((skill) => skill.name === '樵拾')!.id)!
    const trigger = runtime.triggers?.find((entry) => entry.event === 'AfterDamage')!
    const context = { event: { targetId: owner.id, sourceId: other.id, payload: { amount: 1 } } }
    trigger.handle(game, owner.id, context as never)
    trigger.handle(game, owner.id, context as never)
    expect(game.state.skillQueue.filter((entry) => entry.skillId === runtime.id)).toHaveLength(1)
  })

  it('谋黄忠烈弓挂有伤害修正和逐实体响应牌限制入口', () => {
    const runtime = getSkillRuntime(B50_MOU_HUANGZHONG.skills[0].id)!
    expect(runtime.outgoingDamage).toBeTypeOf('function')
    expect(runtime.prohibitsResponseCard).toBeTypeOf('function')
    expect(B50_MOU_HUANGZHONG.skills[0].description).toContain('清除“烈弓”记录的花色')
  })
})
