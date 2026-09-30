import { describe, expect, it, vi } from 'vitest'
import { getCharacter } from '../src/sanguosha/data/characters/standard'
import { getSkillRuntime, type SkillHost } from '../src/sanguosha/engine/skills/runtime'
import { GameRng } from '../src/sanguosha/engine/rng'
import type { SanguoshaState } from '../src/sanguosha/engine/types'

const SHIYU = 'wangyuanji-shiyu'
const LVJIAN = 'wangyuanji-lvjian'

function testHost(state: SanguoshaState) {
  const asks: Array<{ skillId: string; ownerId: string; step: string; data?: Record<string, unknown>; build: (id: string) => unknown }> = []
  const host = {
    state,
    rng: new GameRng('wangyuanji-current-test'),
    dispatch: vi.fn(),
    askSkill: (request: (typeof asks)[number]) => asks.push(request),
    queueSkill: vi.fn(),
  } as unknown as SkillHost
  return { host, asks }
}

function stateWithPlayers(): SanguoshaState {
  return {
    seed: 'wangyuanji-current-test',
    roundNumber: 1,
    turnNumber: 1,
    currentPlayerId: 'wang',
    cards: {},
    cardAliases: {},
    cardNatures: {},
    players: [
      { id: 'wang', alive: true, nickname: '王元姬', hp: 2, maxHp: 3, zones: { hand: ['w1', 'w2'], equipment: { weapon: null, armor: null, offensiveMount: null, defensiveMount: null, treasure: null }, judgingArea: [] } },
      { id: 'target', alive: true, nickname: '目标', hp: 3, maxHp: 3, zones: { hand: ['t1', 't2', 't3'], equipment: { weapon: null, armor: null, offensiveMount: null, defensiveMount: null, treasure: null }, judgingArea: [] } },
      { id: 'other', alive: true, nickname: '其他', hp: 3, maxHp: 3, zones: { hand: ['o1'], equipment: { weapon: null, armor: null, offensiveMount: null, defensiveMount: null, treasure: null }, judgingArea: [] } },
    ],
    zones: { drawPile: ['d1', 'd2', 'd3'], discardPile: [], processingArea: [] },
  } as unknown as SanguoshaState
}

describe('王元姬当前武将册版本', () => {
  it('正式角色池采用魏势力【识预】【率俭】，两项技能均有运行时', () => {
    const character = getCharacter('wangyuanji')!
    expect(character.kingdom).toBe('wei')
    expect(character.skills.map(({ name }) => name)).toEqual(['识预', '率俭'])
    expect(getSkillRuntime(SHIYU)).toBeDefined()
    expect(getSkillRuntime(LVJIAN)).toBeDefined()
  })

  it('【识预】在他人回合开始发出秘密类别选择，并按实际使用类别记账', () => {
    const state = stateWithPlayers()
    const { host, asks } = testHost(state)
    const runtime = getSkillRuntime(SHIYU)!
    const trigger = runtime.triggers!.find(({ event }) => event === 'TurnStart')!
    trigger.handle(host, 'wang', { event: { payload: { playerId: 'target' }, sourceId: 'target' } } as never)
    expect(asks[0]?.step).toBe('invoke')

    runtime.resume!(host, 'wang', { step: 'invoke', data: { targetId: 'target' } }, { payload: { optionId: 'yes' } } as never)
    const request = asks[1]!.build('guess-request') as { kind: string; options: Array<{ id: string }>; prompt: string }
    expect(request.kind).toBe('choose-options')
    expect(request.options.map(({ id }) => id)).toEqual(['basic', 'trick', 'equipment'])
    expect(request.prompt).toContain('秘密')

    const used = runtime.triggers!.find(({ event }) => event === 'CardUsed')!
    used.handle(host, 'wang', { event: { payload: { cardName: '杀' }, sourceId: 'target' } } as never)
    used.handle(host, 'wang', { event: { payload: { cardName: '无中生有' }, sourceId: 'target' } } as never)
    expect((state as unknown as { wangyuanjiTurnCards: Record<string, { categories: string[] }> }).wangyuanjiTurnCards.target.categories)
      .toEqual(['basic', 'trick'])
  })

  it('【率俭】按“弃至不再最多”计算数量，再令所选角色摸等量牌', () => {
    const state = stateWithPlayers()
    for (const id of ['w1', 'w2', 't1', 't2', 't3', 'o1', 'd1', 'd2', 'd3']) {
      state.cards[id] = { id, name: '杀', suit: 'spade', rank: 1, color: 'black', category: 'basic' } as never
    }
    const { host, asks } = testHost(state)
    const runtime = getSkillRuntime(LVJIAN)!
    runtime.resume!(host, 'wang', { step: 'rate-choice', data: {} }, { payload: { optionId: 'hand' } } as never)
    const targets = asks.at(-1)!.build('target-request') as { candidateIds: string[] }
    expect(targets.candidateIds).toEqual(['target'])

    runtime.resume!(host, 'wang', { step: 'rate-discard-target', data: { area: 'hand' } }, { payload: { targetIds: ['target'] } } as never)
    const discard = asks.at(-1)!.build('discard-request') as { playerId: string; min: number; max: number }
    expect(discard).toMatchObject({ playerId: 'target', min: 2, max: 2 })

    runtime.resume!(host, 'wang', { step: 'rate-discard', data: { area: 'hand', targetId: 'target', amount: 2 } }, { payload: { cardIds: ['t1', 't2'] } } as never)
    expect(state.zones.discardPile).toEqual(['t1', 't2'])
    runtime.resume!(host, 'wang', { step: 'rate-draw-target', data: { area: 'hand', amount: 2 } }, { payload: { targetIds: ['wang'] } } as never)
    expect(state.players.find(({ id }) => id === 'wang')!.zones.hand).toHaveLength(4)
  })
})
