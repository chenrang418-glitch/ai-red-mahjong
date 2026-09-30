import { describe, expect, it } from 'vitest'
import { ALL_CHARACTERS, getCharacter, skillIdsOf } from '@/sanguosha/data/characters/standard'
import { HISTORICAL_BATCH35_CHARACTERS } from '@/sanguosha/data/characters/historical-batch35'
import { getSkillRuntime } from '@/sanguosha/engine/skills/runtime'
import { lockCardColor, cardPlayable } from '@/sanguosha/engine/card-play-lock'
import { getDistance } from '@/sanguosha/engine/distance'
import { SanguoshaGame } from '@/sanguosha/engine/game'
import type { SkillHost } from '@/sanguosha/engine/skills/runtime'
import type { PlayerId } from '@/sanguosha/engine/types'
import '@/sanguosha/engine/game'

function fixture() {
  const game = new SanguoshaGame({
    seed: 'batch37-targeted',
    setup: { mode: 'identity', generalChoices: 1, players: Array.from({ length: 5 }, (_, i) => ({ id: `p${i}`, nickname: `玩家${i}`, isHuman: i === 0 })) },
  })
  const state = game.state as any
  state.status = 'playing'; state.phase = 'play'; state.currentPlayerId = 'p0'; state.normalTurnPlayerId = 'p0'; state.turnNumber = 1; state.roundNumber = 1
  state.players.forEach((p: any, i: number) => { p.characterId = i === 0 ? 'sp-caiwenji-b37' : 'zhangfei'; p.hp = 3; p.maxHp = 4 })
  return { game, state }
}

describe('武将册第37批登记与规则钩子', () => {
  it('登记册内十名角色，且每项技能都有运行时', () => {
    expect(HISTORICAL_BATCH35_CHARACTERS).toHaveLength(10)
    for (const character of HISTORICAL_BATCH35_CHARACTERS) {
      expect(getCharacter(character.id)).toBe(character)
      expect(skillIdsOf(character.id)).toEqual(character.skills.filter(skill => !skill.granted).map(skill => skill.id))
      for (const skill of character.skills) expect(getSkillRuntime(skill.id), `${character.name}:${skill.id}`).toBeDefined()
    }
    expect(new Set(ALL_CHARACTERS.map(character => character.id)).size).toBe(ALL_CHARACTERS.length)
  })

  it('马超追击只将低体力目标的距离压为1，誓仇目标数等于已损失体力', () => {
    const { state } = fixture()
    state.players[0].characterId = 'sp-machao-b37'; state.players[0].hp = 2
    state.players[1].hp = 2; state.players[2].hp = 3
    const zhuiji = getSkillRuntime('zhuiji-sp-b37')!
    expect(zhuiji.directedDistanceTo!(state, 'p0', 'p1')).toBe(-99)
    expect(zhuiji.directedDistanceTo!(state, 'p0', 'p2')).toBe(0)
    expect(getDistance(state, 'p0', 'p1')).toBe(1)
    expect(getSkillRuntime('shichou-sp-b37')!.extraSlashTargets!(state, 'p0', 'normal')).toBe(2)
  })

  it('贾诩缜略只屏蔽指定普通锦囊的无懈，仍禁止延时锦囊选中自己', () => {
    const runtime = getSkillRuntime('zhenlue-sp-b37')!
    expect(runtime.cannotBeNullified!(null as any, 'p0', '决斗')).toBe(true)
    expect(runtime.cannotBeNullified!(null as any, 'p0', '南蛮入侵')).toBe(false)
    expect(runtime.prohibitsTarget!(null as any, 'p0', 'p1', '乐不思蜀')).toBe(true)
    expect(runtime.prohibitsTarget!(null as any, 'p0', 'p1', '杀')).toBe(false)
  })

  it('潜袭颜色限制作用于手牌使用/响应共用规则，不影响装备牌', () => {
    const { state } = fixture()
    const target = state.players[1]
    const red = state.zones.drawPile.shift()
    const black = state.zones.drawPile.shift()
    const equipment = state.zones.drawPile.shift()
    state.cards[red].suit = 'heart'; state.cards[black].suit = 'spade'; state.cards[equipment].suit = 'heart'; state.cards[equipment].category = 'equipment'
    target.zones.hand.push(red, black); target.zones.equipment.weapon = equipment
    lockCardColor(state, { targetId: 'p1', color: 'red', sourceId: 'p0', skillId: 'qianxi-jie-madai-b37' })
    expect(cardPlayable(state, 'p1', red)).toBe(false)
    expect(cardPlayable(state, 'p1', black)).toBe(true)
    expect(cardPlayable(state, 'p1', equipment)).toBe(true)
    expect(cardPlayable(state, 'p1', red, { forResponse: true })).toBe(false)
  })

  it('冲阵按确认发动后再以暗手牌槽秘密选择并获得牌', () => {
    const { game, state } = fixture()
    const cardId = state.zones.drawPile.shift()
    state.players[1].zones.hand.push(cardId)
    const requests: any[] = []
    const events: any[] = []
    const host = {
      state, rng: game.rng, dispatch(name: string, payload: any, metadata: any) { events.push({ name, payload, metadata }) },
      askSkill(options: any) { requests.push({ options, request: options.build(`b37-chongzhen-${requests.length}`) }) },
    } as any as SkillHost
    const runtime = getSkillRuntime('chongzhen-sp-b37')!
    runtime.startQueued!(host, 'p0', { skillId: 'chongzhen-sp-b37', ownerId: 'p0', step: 'rob', data: { targetId: 'p1' } } as any)
    runtime.resume!(host, 'p0', { step: 'choose', data: { targetId: 'p1' } } as any, { payload: { optionId: 'yes' } } as any)
    const request = requests.at(-1).request
    expect(request.kind).toBe('choose-cards')
    expect(request.cardIds).toEqual([])
    expect(request.hiddenCardSlots).toHaveLength(1)
    runtime.resume!(host, 'p0', { step: 'steal', data: { targetId: 'p1' } } as any, { payload: { cardIds: [request.hiddenCardSlots[0]] } } as any)
    expect(state.players[1].zones.hand).toEqual([])
    expect(state.players[0].zones.hand).toContain(cardId)
    expect(events.map(event => event.name)).toEqual(['LoseCard', 'GainCard'])
  })

  it('默识拒绝复用第一张牌后仍可进入第二张牌选择', () => {
    const { game, state } = fixture()
    state.players[0].zones.hand.push(state.zones.drawPile.shift())
    const requests: any[] = []
    const host = { state, rng: game.rng, dispatch: () => ({ event: {} }), askSkill(options: any) { requests.push(options) } } as any as SkillHost
    getSkillRuntime('moshi-sp-b37')!.resume!(host, 'p0', { step: 'invoke-first', data: { names: ['杀', '桃'] } } as any, { payload: { optionId: 'no' } } as any)
    expect(requests).toHaveLength(1)
    expect(requests[0].step).toBe('invoke-second')
  })

  it('励战只在其拥有者自己的回合结束排入结算', () => {
    const queued: any[] = []
    const { game, state } = fixture()
    const host = { state, rng: game.rng, queueSkill: (prompt: any) => queued.push(prompt) } as any as SkillHost
    const trigger = getSkillRuntime('lizhan-sp-b37')!.triggers![0]
    trigger.handle(host, 'p0', { event: { payload: { playerId: 'p1' } } } as any)
    expect(queued).toHaveLength(0)
    trigger.handle(host, 'p0', { event: { payload: { playerId: 'p0' } } } as any)
    expect(queued).toHaveLength(1)
    expect(queued[0].skillId).toBe('lizhan-sp-b37')
  })

  it('伪溃发现闪时，对象间双向距离在本回合视为1并使用不计次数杀', () => {
    const { game, state } = fixture()
    state.players.forEach((player: any, index: number) => { player.seat = index })
    state.players[1].seat = 2
    state.players[0].distanceToOthers = 3
    state.players[1].distanceFromOthers = 2
    const flash = Object.values(state.cards).find((card: any) => card.name === '闪') as any
    const target = state.players[1]
    target.zones.hand.push(flash.id)
    const virtualSlashes: any[] = []
    const requests: any[] = []
    const host = {
      state, rng: game.rng, dispatch: () => ({ event: {} }),
      askSkill(options: any) { requests.push({ options, request: options.build(`b37-weikui-${requests.length}`) }) },
      beginVirtualSlash(options: any) { virtualSlashes.push(options); return true },
    } as any as SkillHost
    expect(getDistance(state, 'p0', 'p1')).toBeGreaterThan(1)
    getSkillRuntime('weikui-sp-b37')!.resume!(host, 'p0', { step: 'target', data: {} } as any, { payload: { targetIds: ['p1'] } } as any)
    expect(requests.at(-1).request.viewOnlyCardIds).toEqual([flash.id])
    expect(requests.at(-1).request.cardIds).toEqual([])
    getSkillRuntime('weikui-sp-b37')!.resume!(host, 'p0', { step: 'reveal-hand', data: { targetId: 'p1' } } as any, { payload: { cardIds: [] } } as any)
    expect(getDistance(state, 'p0', 'p1')).toBe(1)
    expect(getDistance(state, 'p1', 'p0')).toBe(1)
    expect(virtualSlashes).toEqual([{ sourceId: 'p0', targetId: 'p1', sourceSkillId: 'weikui-sp-b37', countUsage: false }])
  })

  it('陈情四种花色各异时以濒死虚拟桃完成救援并续接濒死栈', () => {
    const { game, state } = fixture()
    const dying = state.players[1]
    dying.hp = 0
    state.dying = { playerId: 'p1', sourceId: 'p4', damageNature: 'normal', responderOrder: ['p1', 'p2', 'p3', 'p4', 'p0'], responderIndex: 0, assistIndex: 1, requestId: null }
    const requests: any[] = []
    const host = {
      state, rng: game.rng, dispatch: game.dispatch.bind(game), queueSkill: () => {}, resumeAfterDying: () => {},
      askSkill(options: any) { requests.push({ ...options, request: options.build(`b37-${requests.length}`) }) },
      useVirtualPeachDuringDying: (sourceId: PlayerId, targetId: PlayerId, reason: string) => game.useVirtualPeachDuringDying(sourceId, targetId, reason),
    } as any as SkillHost
    const skill = getSkillRuntime('chenqing-sp-b37')!
    expect(skill.dyingAssist!(host, 'p0', 'p1', 'p4')).toBe('pending')
    skill.resume!(host, 'p0', { step: 'target', data: { dyingPlayerId: 'p1' } } as any, { payload: { targetIds: ['p2'] } } as any)
    expect(requests.at(-1).request).toMatchObject({ kind: 'choose-cards', playerId: 'p2', min: 4, max: 4 })
    const ids = requests.at(-1).request.cardIds as string[]
    ;['spade', 'heart', 'club', 'diamond'].forEach((suit, i) => { state.cards[ids[i]].suit = suit })
    skill.resume!(host, 'p0', { step: 'discard', data: { dyingPlayerId: 'p1', targetId: 'p2' } } as any, { payload: { cardIds: ids.slice(0, 4) } } as any)
    expect(dying.hp).toBe(1)
    expect(state.dying).toBeNull()
  })
})
