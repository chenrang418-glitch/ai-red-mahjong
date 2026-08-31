import { describe, expect, it } from 'vitest'
import { checkIdentityVictory, identitiesFor, identityDistribution } from '@/sanguosha/engine/modes/identity'
import { emptyEquipment, type Identity, type PlayerState } from '@/sanguosha/engine/types'

function players(identities: Identity[]): PlayerState[] {
  return identities.map((identity, seat) => ({
    id: `p${seat}`, seat, nickname: `玩家${seat}`, isHuman: seat === 0, alive: true,
    identity, identityRevealed: identity === 'lord', characterId: null, hp: 4, maxHp: 4,
    chained: false, faceDown: false, zones: { hand: [], equipment: emptyEquipment(), judgingArea: [] },
    marks: {}, usedLimitedSkills: [], distanceFromOthers: 0, distanceToOthers: 0, attackRangeBonus: 0,
  }))
}

describe('经典身份局配置与胜负', () => {
  it('5～8 人固定身份表精确', () => {
    expect(identityDistribution[5]).toEqual(['lord', 'loyalist', 'rebel', 'rebel', 'renegade'])
    expect(identityDistribution[6]).toEqual(['lord', 'loyalist', 'rebel', 'rebel', 'rebel', 'renegade'])
    expect(identityDistribution[7]).toEqual(['lord', 'loyalist', 'loyalist', 'rebel', 'rebel', 'rebel', 'renegade'])
    expect(identityDistribution[8]).toEqual(['lord', 'loyalist', 'loyalist', 'rebel', 'rebel', 'rebel', 'rebel', 'renegade'])
    expect(() => identitiesFor(4)).toThrow('5～8')
  })

  it('主公死亡且未形成内奸单独存活时反贼获胜', () => {
    const state = players([...identityDistribution[5]])
    state[0].alive = false
    expect(checkIdentityVictory(state)).toMatchObject({ winningCamp: 'rebel' })
  })

  it('内奸最后与主公决战并击杀主公时内奸获胜', () => {
    const state = players([...identityDistribution[5]])
    for (const player of state) player.alive = player.identity === 'lord' || player.identity === 'renegade'
    state.find((player) => player.identity === 'lord')!.alive = false
    expect(checkIdentityVictory(state)).toMatchObject({ winningCamp: 'renegade', winnerIds: ['p4'] })
  })

  it('最后一名反贼和内奸死亡后主忠获胜', () => {
    const state = players([...identityDistribution[5]])
    for (const player of state) if (player.identity === 'rebel' || player.identity === 'renegade') player.alive = false
    expect(checkIdentityVictory(state)).toMatchObject({ winningCamp: 'lord' })
  })
})
