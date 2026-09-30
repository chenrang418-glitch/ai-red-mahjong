import { describe, expect, it } from 'vitest'
import { ALL_CHARACTERS, skillIdsOf } from '@/sanguosha/data/characters/standard'
import { HISTORICAL_BATCH41_CHARACTERS } from '@/sanguosha/data/characters/historical-batch41'
import { canTarget } from '@/sanguosha/engine/distance'
import { getSkillRuntime } from '@/sanguosha/engine/skills/runtime'
import { SanguoshaGame } from '@/sanguosha/engine/game'
import { startPlaying } from '@/sanguosha/engine/turn'
import type { SkillHost } from '@/sanguosha/engine/skills/runtime'

function fixture() {
  const game = new SanguoshaGame({ seed: 'historical-b43-targeted', setup: {
    mode: 'identity', generalChoices: 1,
    players: Array.from({ length: 5 }, (_, index) => ({ id: `p${index}`, nickname: `玩家${index}`, isHuman: index === 0 })),
  } })
  const state = game.state as any
  state.status = 'playing'; state.phase = 'play'; state.currentPlayerId = 'p0'; state.normalTurnPlayerId = 'p0'; state.turnNumber = 2
  state.players.forEach((entry: any, index: number) => {
    entry.characterId = index === 0 ? 'niujin-b43' : 'caocao'
    entry.hp = 3; entry.maxHp = 4
  })
  const requests: any[] = [], events: any[] = []
  const host = {
    state, rng: game.rng,
    dispatch(name: string, payload: any, metadata: any) { events.push({ name, payload, metadata }); return game.dispatch(name as any, payload, metadata) },
    askSkill(options: any) { requests.push({ ...options, request: options.build(`b43-${requests.length}`) }) },
    queueSkill(prompt: any) { state.skillQueue.push(prompt) },
    beginVirtualSlash: game.beginVirtualSlash.bind(game), beginVirtualTrick: game.beginVirtualTrick.bind(game),
    resumeCardTarget: game.resumeCardTarget.bind(game), enterDying: game.enterDying.bind(game),
    resumePhaseEntry() {},
  } as any as SkillHost
  return { game, state, host, requests, events }
}

describe('武将册第43批注册与定向规则', () => {
  it('登记十名新版本/角色，且每项自带技能都挂载运行时', () => {
    expect(HISTORICAL_BATCH41_CHARACTERS).toHaveLength(10)
    for (const character of HISTORICAL_BATCH41_CHARACTERS) {
      expect(ALL_CHARACTERS).toContain(character)
      expect(skillIdsOf(character.id)).toEqual(character.skills.filter(skill => !skill.granted).map(skill => skill.id))
      for (const skill of character.skills.filter(skill => !skill.granted)) {
        expect(getSkillRuntime(skill.id), `${character.name}/${skill.name}`).toBeDefined()
      }
    }
    expect(new Set(ALL_CHARACTERS.map(character => character.id)).size).toBe(ALL_CHARACTERS.length)
  })

  it('牛金【挫锐】按备选区数量计算起始手牌，并只排定其自己的首次判定阶段跳过', () => {
    const { state, host } = fixture()
    state.status = 'setup'
    const runtime = getSkillRuntime('cuorui-b43')!
    state.players[0].reserveCharacterIds = ['caocao', 'liubei']
    expect(runtime.initialHandCount?.(state, 'p0', 4)).toBe(4)
    expect(runtime.initialHandCount?.(state, 'p1', 4)).toBe(2)
    runtime.onGameStart?.(host, 'p0')
    startPlaying(state, () => {})
    expect(state.skippedPhases).toContain('judge')
    expect(state.scheduledSkippedPhasesByPlayer?.p0).toBeUndefined()
    expect(state.players[0].reserveCharacterIds).toEqual(['caocao', 'liubei'])
  })

  it('界黃忠【烈弓】按實體殺點數指定距離，並在指定目標時鎖定不可閃條件', () => {
    const { state } = fixture()
    state.players.forEach((entry: any, index: number) => { entry.characterId = index === 0 ? 'jie-huangzhong-b43' : 'caocao'; entry.seat = index })
    const slash = state.zones.drawPile[0]
    state.cards[slash].rank = 2
    state.players[0].zones.hand.push(slash)
    state.players[2].zones.hand.splice(0, state.players[2].zones.hand.length)
    expect(canTarget(state, 'p0', 'p2', undefined, slash)).toBe(true)
    const runtime = getSkillRuntime('jie-liegong-b43')!
    runtime.triggers?.find(entry => entry.event === 'TargetSpecified')?.handle({ state } as any, 'p0', {
      event: { sourceId: 'p0', payload: { cardName: '杀', cardId: slash, targetIds: ['p2'] } },
    } as any)
    expect(runtime.slashUndodgeable?.(state, 'p0', 'p2', slash)).toBe(true)
  })

  it('界魏延【奇谋】使用次数与距离加成按失去体力数结算，并在回合结束清除距离标记', () => {
    const { state, host, requests } = fixture()
    state.players[0].characterId = 'jie-weiyan-b43'
    const runtime = getSkillRuntime('qimou-b43')!
    expect(runtime.activeActions?.(state, 'p0')).toHaveLength(1)
    runtime.invokeActive?.(host, 'p0', 'qimou-b43')
    expect(requests.at(-1)?.request.options).toHaveLength(3)
    runtime.resume?.(host, 'p0', requests.at(-1), { payload: { optionId: '2' } } as any)
    expect(state.players[0].hp).toBe(1)
    expect(state.players[0].usedLimitedSkills).toContain('qimou-b43')
    expect(state.players[0].marks['qimou-distance-b43']).toBe(2)
    runtime.triggers?.find(entry => entry.event === 'TurnEnd')?.handle(host, 'p0', { event: { targetId: 'p0', payload: { playerId: 'p0' } } } as any)
    expect(state.players[0].marks['qimou-distance-b43']).toBeUndefined()
  })
})
