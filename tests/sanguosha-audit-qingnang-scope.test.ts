import { describe, expect, it } from 'vitest'
import { SanguoshaGame } from '@/sanguosha/engine/game'
import { queueExtraPhaseAfterCurrent } from '@/sanguosha/engine/extra-phase'
import { assertGameInvariants } from '@/sanguosha/engine/invariants'

function fixture() {
  const game = new SanguoshaGame({ seed: 'audit-qingnang-phase-scope', setup: {
    mode: 'identity', generalChoices: 1,
    players: Array.from({ length: 5 }, (_, index) => ({ id: `p${index}`, nickname: `玩家${index}`, isHuman: true })),
  } })
  const identities = ['lord', 'rebel', 'loyalist', 'rebel', 'renegade'] as const
  game.state.players.forEach((player, index) => {
    player.identity = identities[index]
    player.characterId = index === 0 ? 'huatuo' : 'zhangfei'
  })
  game.state.currentPlayerId = 'p0'
  game.state.normalTurnPlayerId = 'p0'
  game.start()
  for (let step = 0; game.state.phase !== 'play' && step < 10; step++) game.advancePhase()
  expect(game.state.phase).toBe('play')
  game.state.players[1]!.hp = game.state.players[1]!.maxHp - 3
  return game
}

function use(game: SanguoshaGame) {
  game.act('p0', 'skill:qingnang')
  const cost = game.state.pendingRequests[0]!
  game.respond({ requestId: cost.id, playerId: cost.playerId,
    payload: { cardIds: [game.state.players[0]!.zones.hand[0]!] } })
  const target = game.state.pendingRequests[0]!
  game.respond({ requestId: target.id, playerId: target.playerId, payload: { targetIds: ['p1'] } })
}

describe('审计回归：青囊按出牌阶段实例计次', () => {
  it('同一阶段成功后不能再发动，保存和恢复也不重置次数', () => {
    let game = fixture()
    use(game)
    const hp = game.state.players[1]!.hp
    const hand = [...game.state.players[0]!.zones.hand]
    expect(game.legalActions('p0').some((action) => action.id === 'skill:qingnang')).toBe(false)
    game = SanguoshaGame.restore(game.serialize())
    expect(() => game.act('p0', 'skill:qingnang')).toThrow()
    expect(game.state.players[1]!.hp).toBe(hp)
    expect(game.state.players[0]!.zones.hand).toEqual(hand)
    assertGameInvariants(game.state)
  })

  it('同一回合插入额外出牌阶段后另有一次，额外阶段内仍限一次', () => {
    const game = fixture()
    const turn = game.state.turnNumber
    const hpBefore = game.state.players[1]!.hp
    const handBefore = game.state.players[0]!.zones.hand.length
    use(game)
    queueExtraPhaseAfterCurrent(game.state, 'p0', 'play', 'audit:extra-play', 'discard')
    game.advancePhase()
    expect(game.state.phase).toBe('play')
    expect(game.state.extraPhase).toBeDefined()
    expect(game.state.turnNumber).toBe(turn)
    expect(game.legalActions('p0').some((action) => action.id === 'skill:qingnang')).toBe(true)
    use(game)
    expect(game.state.players[1]!.hp).toBe(hpBefore + 2)
    expect(game.state.players[0]!.zones.hand).toHaveLength(handBefore - 2)
    expect(game.legalActions('p0').some((action) => action.id === 'skill:qingnang')).toBe(false)
    assertGameInvariants(game.state)
  })
})
