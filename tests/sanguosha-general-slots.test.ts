import { describe, expect, it } from 'vitest'
import { ownedSkillIds } from '@/sanguosha/engine/skills/runtime'
import { revealedGeneralCharacterIdsOf, setGeneralRevealed } from '@/sanguosha/engine/general-slots'
import { SanguoshaGame } from '@/sanguosha/engine/game'
import { buildPlayerView } from '@/sanguosha/engine/view'
import type { PlayerState, SanguoshaState } from '@/sanguosha/engine/types'

function playerFixture(overrides: Partial<PlayerState> = {}): PlayerState {
  return {
    id: 'p1', seat: 0, nickname: '测试', isHuman: true, alive: true, identity: 'rebel', identityRevealed: true,
    characterId: 'primary', hp: 4, maxHp: 4, chained: false, faceDown: false,
    zones: { hand: [], equipment: { weapon: null, weapon2: null, armor: null, offensiveHorse: null, defensiveHorse: null, treasure: null }, judgingArea: [] },
    marks: {}, characterPiles: {}, grantedSkills: [], temporaryGrantedSkills: [], usedLimitedSkills: [],
    turnUsedSkills: [], distanceFromOthers: 0, distanceToOthers: 0, attackRangeBonus: 0,
    ...overrides,
  }
}

function stateFixture(player: PlayerState): SanguoshaState {
  return { players: [player], cards: {} } as unknown as SanguoshaState
}

describe('双将武将槽位公共规则', () => {
  it('保持单将旧存档兼容，并且只有明置的将位提供技能', () => {
    const player = playerFixture({ deputyCharacterId: 'deputy', deputyGeneralRevealed: false })
    expect(revealedGeneralCharacterIdsOf(player)).toEqual(['primary'])
    player.deputyGeneralRevealed = true
    expect(revealedGeneralCharacterIdsOf(player)).toEqual(['primary', 'deputy'])
    player.primaryGeneralRevealed = false
    expect(revealedGeneralCharacterIdsOf(player)).toEqual(['deputy'])
  })

  it('按将位明暗状态汇总技能，全武将技能失效时同时关闭主副将技能', () => {
    const player = playerFixture({
      deputyCharacterId: 'deputy', deputyGeneralRevealed: true,
    })
    const skills = (characterId: string) => characterId === 'primary' ? ['skill-primary'] : ['skill-deputy']
    expect(ownedSkillIds(stateFixture(player), player.id, skills)).toEqual(['skill-primary', 'skill-deputy'])
    player.primaryGeneralRevealed = false
    expect(ownedSkillIds(stateFixture(player), player.id, skills)).toEqual(['skill-deputy'])
    player.characterSkillsDisabled = true
    expect(ownedSkillIds(stateFixture(player), player.id, skills)).toEqual([])
  })

  it('拒绝对不存在的武将牌明置或暗置', () => {
    const player = playerFixture()
    expect(setGeneralRevealed(player, 'deputy', true)).toBe(false)
    expect(setGeneralRevealed(player, 'primary', false)).toBe(true)
    expect(revealedGeneralCharacterIdsOf(player)).toEqual([])
  })

  it('对他人隐藏暗置武将身份，并在本人视图保留完整牌面', () => {
    const game = new SanguoshaGame({ seed: 'general-slot-view', setup: {
      mode: 'identity', generalChoices: 1,
      players: [{ id: 'p1', nickname: '甲', isHuman: true }, { id: 'p2', nickname: '乙', isHuman: false }, { id: 'p3', nickname: '丙', isHuman: false }, { id: 'p4', nickname: '丁', isHuman: false }, { id: 'p5', nickname: '戊', isHuman: false }],
    } })
    game.state.status = 'playing'
    game.state.players[0].characterId = 'caocao'
    game.state.players[1].characterId = 'liubei'
    game.state.players[1].primaryGeneralRevealed = false
    game.state.players[1].deputyCharacterId = 'sunquan'
    game.state.players[1].deputyGeneralRevealed = false
    const publicView = buildPlayerView(game.state, 'p1').players.find((entry) => entry.id === 'p2')!
    expect(publicView.generalSlots).toEqual([
      { slot: 'primary', characterId: null, revealed: false },
      { slot: 'deputy', characterId: null, revealed: false },
    ])
    expect(publicView.characterId).toBeNull()
    expect(publicView.kingdom).toBeNull()
    const ownerView = buildPlayerView(game.state, 'p2').players.find((entry) => entry.id === 'p2')!
    expect(ownerView.generalSlots?.map((slot) => slot.characterId)).toEqual(['liubei', 'sunquan'])
    game.state.players[1].deputyGeneralRevealed = true
    const deputyRevealedView = buildPlayerView(game.state, 'p1').players.find((entry) => entry.id === 'p2')!
    expect(deputyRevealedView.generalSlots).toEqual([
      { slot: 'primary', characterId: null, revealed: false },
      { slot: 'deputy', characterId: 'sunquan', revealed: true },
    ])
    expect(deputyRevealedView.characterId).toBeNull()
    expect(deputyRevealedView.kingdom).toBe('wu')
  })
})
