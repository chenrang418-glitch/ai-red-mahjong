import { describe, expect, it } from 'vitest'
import { SanguoshaGame } from '@/sanguosha/engine/game'
import { checkNationalWarVictory, nationalWarCampOf, revealNationalWarGeneral } from '@/sanguosha/engine/modes/national-war'

function setup() {
  const game = new SanguoshaGame({ seed: 'national-war-mode-rules', setup: {
    mode: 'identity', generalChoices: 1,
    players: Array.from({ length: 5 }, (_, index) => ({ id: `p${index}`, nickname: `玩家${index}`, isHuman: index === 0 })),
  } })
  game.state.status = 'playing'
  const [wei1, wei2, wei3, shu, wu] = game.state.players
  wei1.characterId = 'caocao'
  wei2.characterId = 'xunyu'
  wei3.characterId = 'xiahouyuan'
  shu.characterId = 'liubei'
  wu.characterId = 'sunquan'
  return { state: game.state, players: [wei1, wei2, wei3, shu, wu] }
}

describe('国战势力与胜负规则', () => {
  it('第一次令势力人数超过半数者成为野心家，此后同势力明置者各自成为野心家', () => {
    const { state, players } = setup()
    expect(revealNationalWarGeneral(state, players[0].id, 'primary')).toBe(true)
    expect(revealNationalWarGeneral(state, players[1].id, 'primary')).toBe(true)
    expect(revealNationalWarGeneral(state, players[2].id, 'primary')).toBe(true)
    expect(nationalWarCampOf(players[0])).toEqual({ kind: 'faction', faction: 'wei' })
    expect(nationalWarCampOf(players[1])).toEqual({ kind: 'faction', faction: 'wei' })
    expect(nationalWarCampOf(players[2])).toEqual({ kind: 'ambitious', playerId: players[2].id })

    const laterWei = state.players[4]
    laterWei.characterId = 'xiahoudun'
    expect(revealNationalWarGeneral(state, laterWei.id, 'primary')).toBe(true)
    expect(nationalWarCampOf(laterWei)).toEqual({ kind: 'ambitious', playerId: laterWei.id })
  })

  it('所有角色势力未确定前不判胜；确定后普通势力整体获胜', () => {
    const { state, players } = setup()
    revealNationalWarGeneral(state, players[0].id, 'primary')
    revealNationalWarGeneral(state, players[1].id, 'primary')
    expect(checkNationalWarVictory(state)).toBeNull()
    revealNationalWarGeneral(state, players[2].id, 'primary')
    revealNationalWarGeneral(state, players[3].id, 'primary')
    revealNationalWarGeneral(state, players[4].id, 'primary')
    players[2].alive = false
    players[3].alive = false
    players[4].alive = false
    expect(checkNationalWarVictory(state)).toEqual({
      camp: { kind: 'faction', faction: 'wei' }, winnerIds: [players[0].id, players[1].id],
    })
  })

  it('野心家与同为野心家的不同角色并非同一获胜阵营', () => {
    const { state, players } = setup()
    players.forEach((player, index) => {
      player.nationalWarFaction = index < 3 ? 'wei' : index === 3 ? 'shu' : 'wu'
      player.nationalWarAmbitious = index === 2 || index === 3
    })
    players[0].alive = false
    players[1].alive = false
    players[4].alive = false
    expect(checkNationalWarVictory(state)).toBeNull()
    players[3].alive = false
    expect(checkNationalWarVictory(state)).toEqual({
      camp: { kind: 'ambitious', playerId: players[2].id }, winnerIds: [players[2].id],
    })
  })
})
