import { describe, expect, it } from 'vitest'
import { ALL_CHARACTERS } from '@/sanguosha/data/characters/standard'
import { SanguoshaGame } from '@/sanguosha/engine/game'
import { getSkillRuntime } from '@/sanguosha/engine/skills/runtime'
import type { CardId } from '@/sanguosha/engine/types'
import { moveCard } from '@/sanguosha/engine/zones'

const batch = ALL_CHARACTERS.filter(({ id }) => id.endsWith('-b52'))
const skillId = (characterName: string, skillName: string) => batch.find((entry) => entry.name === characterName)!.skills.find((entry) => entry.name === skillName)!.id

function fixture() {
  const game = new SanguoshaGame({ seed: 'historical-batch52-targeted', setup: {
    mode: 'identity', generalChoices: 1,
    players: Array.from({ length: 5 }, (_, index) => ({ id: `b52p${index}`, nickname: `玩家${index}`, isHuman: index === 0 })),
  } })
  return { game, owner: game.state.players[0]!, target: game.state.players[1]! }
}

describe('第52批武将与技能运行时', () => {
  it('正式注册正好十将，且每项技能都有运行时', () => {
    expect(batch).toHaveLength(10)
    expect(new Set(batch.map(({ id }) => id)).size).toBe(10)
    for (const character of batch) for (const skill of character.skills)
      expect(getSkillRuntime(skill.id), `${character.name}【${skill.name}】`).toBeDefined()
  })

  it('曹休【千驹】只减少自身计算至其他人的距离', () => {
    const { game, owner } = fixture()
    owner.characterId = 'jie-caoxiu-b52'
    owner.hp = owner.maxHp - 2
    const runtime = getSkillRuntime(skillId('界·曹休', '千驹'))!
    expect(runtime.distanceModifier?.toOthers).toBeTypeOf('function')
    expect((runtime.distanceModifier!.toOthers as (state: typeof game.state, id: string) => number)(game.state, owner.id)).toBe(-2)
  })

  it('大乔红桃【流离】奖励是可序列化的唯一额外出牌标记', () => {
    const { game, owner } = fixture()
    owner.characterId = 'mou-daqiao-b52'
    const runtime = getSkillRuntime(skillId('谋·大乔', '流离'))!
    const state = game.state as typeof game.state & { b52LiuliExtraPlay?: Record<string, true> }
    state.b52LiuliExtraPlay = { [owner.id]: true }
    expect(runtime.extraPhaseAtTurnStart?.(game.state, owner.id)).toBe('play')
    delete state.b52LiuliExtraPlay[owner.id]
    expect(runtime.extraPhaseAtTurnStart?.(game.state, owner.id)).toBeNull()
  })

  it('孙策【英姿※】在 DrawPhase 修改真实摸牌数量并提供回合手牌上限', () => {
    const { game, owner } = fixture()
    owner.characterId = 'mou-sunce-b52'
    const id = skillId('谋·孙策', '英姿※')
    owner.grantedSkills = [id]
    owner.hp = 2
    const ids = game.state.zones.drawPile.splice(0, 2)
    owner.zones.hand.push(...ids)
    const runtime = getSkillRuntime(id)!
    const event = game.dispatch('DrawPhase', { playerId: owner.id, count: 2 })
    expect(event.event.payload).toMatchObject({ count: 4 })
    expect(runtime.maxCardsBonus?.(game.state, owner.id)).toBe(2)
  })

  it('孟获【再起】伤害蓄力每回合仅增加一次且封顶七点', () => {
    const { game, owner, target } = fixture()
    owner.characterId = 'mou-menghuo-b52'
    const id = skillId('谋·孟获', '再起')
    owner.marks.mouMenghuoZaiqi = 6
    game.dispatch('DamageSettled', { finalAmount: 1 }, { sourceId: owner.id, targetId: target.id })
    game.dispatch('DamageSettled', { finalAmount: 1 }, { sourceId: owner.id, targetId: target.id })
    expect(owner.marks.mouMenghuoZaiqi).toBe(7)
  })

  it('朱桓【奋励】阶段资格相等时发出可选择的真实跳阶段请求', () => {
    const { game, owner } = fixture()
    game.state.status = 'playing'
    owner.characterId = 'jie-zhuhuan-b52'
    owner.zones.hand.push(...game.state.zones.drawPile.splice(0, 1))
    game.state.players[1]!.zones.hand.push(...game.state.zones.drawPile.splice(0, 1))
    const runtime = getSkillRuntime(skillId('界·朱桓', '奋励'))!
    expect(runtime.offerPhaseSkip?.(game, owner.id, 'draw')).toBe(true)
    expect(game.state.skillResolution).toMatchObject({ skillId: skillId('界·朱桓', '奋励'), step: 'skip' })
  })

  it('郭女王【诬诽】将伤害类锦囊的来源改为当前“雀”角色', () => {
    const { game, owner, target } = fixture()
    owner.characterId = 'guonuwang-b52'
    const id = skillId('郭女王', '诬诽')
    ;(game.state as typeof game.state & { b52GuoMarker?: { ownerId: string; targetId: string; suit: string; expiresAtTurn: number } }).b52GuoMarker = {
      ownerId: owner.id, targetId: target.id, suit: 'heart', expiresAtTurn: 99,
    }
    const runtime = getSkillRuntime(id)!
    expect(runtime.modifyDamageSource?.(game.state, owner.id, { sourceId: owner.id, targetId: game.state.players[2]!.id, cardId: null, cardName: '决斗', chainTransfer: false })).toBe(target.id)
  })

  it('阎象【睿敛】从弃牌堆随机取同类两张时不重复移动同一实体牌', () => {
    const { game, owner, target } = fixture()
    owner.characterId = 'yanxiang-b52'
    const id = skillId('阎象', '睿敛')
    const candidates = game.state.zones.drawPile.filter((cardId) => game.state.cards[cardId]?.category === 'basic').slice(0, 2) as CardId[]
    expect(candidates).toHaveLength(2)
    for (const cardId of candidates) {
      game.state.zones.drawPile.splice(game.state.zones.drawPile.indexOf(cardId), 1)
      game.state.zones.discardPile.push(cardId)
    }
    const runtime = getSkillRuntime(id)!
    runtime.resume!(game, owner.id, { step: 'category', data: { targetId: target.id } } as never,
      { payload: { optionId: 'basic' } } as never)
    expect(owner.zones.hand.filter((cardId) => candidates.includes(cardId))).toHaveLength(1)
    expect(target.zones.hand.filter((cardId) => candidates.includes(cardId))).toHaveLength(1)
  })

  it('魏延【孤厉】主动技先要求选择普通杀合法目标，再进入挂起请求', () => {
    const { game, owner } = fixture()
    game.state.status = 'playing'
    game.state.phase = 'play'
    game.state.currentPlayerId = owner.id
    owner.characterId = 'xing-weiyan-b52'
    const cardId = game.state.zones.drawPile[0] as CardId
    moveCard(game.state, cardId, { kind: 'drawPile' }, { kind: 'hand', playerId: owner.id })
    const id = skillId('星·魏延', '孤厉')
    const runtime = getSkillRuntime(id)!
    const action = runtime.activeActions?.(game.state, owner.id).find(({ id: actionId }) => actionId === `skill:${id}`)
    expect(action).toBeDefined()
    runtime.invokeActive?.(game, owner.id, action!.id)
    expect(game.state.skillResolution).toMatchObject({ skillId: id, step: 'target' })
    expect(owner.zones.hand).toContain(cardId)
  })

  it('孙策【激昂】将所有手牌作成本并挂起真实决斗目标选择', () => {
    const { game, owner } = fixture()
    game.state.status = 'playing'
    game.state.phase = 'play'
    game.state.currentPlayerId = owner.id
    owner.characterId = 'mou-sunce-b52'
    const costs = game.state.zones.drawPile.splice(0, 2) as CardId[]
    owner.zones.hand.push(...costs)
    const id = skillId('谋·孙策', '激昂')
    const runtime = getSkillRuntime(id)!
    const action = runtime.activeActions?.(game.state, owner.id).find(({ id: actionId }) => actionId === `skill:${id}:all-hand-duel`)
    expect(action).toBeDefined()
    runtime.invokeActive?.(game, owner.id, action!.id)
    expect(costs.every((cardId) => game.state.zones.discardPile.includes(cardId))).toBe(true)
    expect(game.state.skillResolution).toMatchObject({ skillId: id, step: 'all-hand-targets' })
  })

  it('苦谏牌被任意角色真正使用时，原武将与实际使用者各摸两张', () => {
    const { game, owner, target } = fixture()
    game.state.status = 'playing'
    owner.characterId = 'yanxiang-b52'
    const marked = game.state.zones.drawPile[0] as CardId
    moveCard(game.state, marked, { kind: 'drawPile' }, { kind: 'hand', playerId: target.id })
    ;(game.state as typeof game.state & { b52Kujian?: Record<string, { ownerId: string; recipientId: string }> }).b52Kujian = {
      [marked]: { ownerId: owner.id, recipientId: target.id },
    }
    const ownerCount = owner.zones.hand.length
    const targetCount = target.zones.hand.length
    game.dispatch('CardUsed', { cardId: marked, cardName: game.state.cards[marked]!.name, targetIds: [] }, { sourceId: target.id })
    expect(owner.zones.hand.length).toBe(ownerCount + 2)
    expect(target.zones.hand.length).toBe(targetCount + 2)
    expect((game.state as typeof game.state & { b52Kujian?: Record<string, unknown> }).b52Kujian?.[marked]).toBeUndefined()
  })
})
