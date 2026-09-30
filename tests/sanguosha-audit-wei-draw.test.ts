import { describe, expect, it } from 'vitest'
import { SanguoshaGame } from '@/sanguosha/engine/game'
import { assertGameInvariants } from '@/sanguosha/engine/invariants'
import { moveCard } from '@/sanguosha/engine/zones'

function atDraw(characterId: string) {
  const game = new SanguoshaGame({ seed: `audit-wei-draw-${characterId}`, setup: {
    mode: 'identity', generalChoices: 1,
    players: Array.from({ length: 5 }, (_, index) => ({ id: `p${index}`, nickname: `玩家${index}`, isHuman: true })),
  } })
  const identities = ['lord', 'rebel', 'loyalist', 'rebel', 'renegade'] as const
  game.state.players.forEach((player, index) => {
    player.characterId = index === 0 ? characterId : 'zhangfei'
    player.identity = identities[index]
  })
  game.state.currentPlayerId = 'p0'
  game.state.normalTurnPlayerId = 'p0'
  game.start()
  for (let step = 0; game.state.phase !== 'draw' && step < 10; step++) game.advancePhase()
  expect(game.state.phase).toBe('draw')
  expect(game.state.skillResolution?.skillId).toBe(characterId === 'xuchu' ? 'luoyi' : 'tuxi')
  return game
}

function answer(game: SanguoshaGame, optionId: string) {
  const request = game.state.pendingRequests[0]!
  game.respond({ requestId: request.id, playerId: request.playerId, payload: { optionId } })
}

describe('审计回归：魏包摸牌必须经过公共规则入口', () => {
  it.each(['yes', 'no'])('裸衣 %s：移动前有摸牌窗口，逐牌移区，获得牌明确标记为摸牌', (optionId) => {
    const game = atDraw('xuchu')
    const count = optionId === 'yes' ? 1 : 2
    const before = [...game.state.players[0]!.zones.hand]
    const top = game.state.zones.drawPile.slice(0, count)
    const order: string[] = []
    game.events.on('DrawAttempt', (context) => {
      expect(context.event.payload).toMatchObject({ playerId: 'p0', count, isDraw: true })
      expect(game.state.players[0]!.zones.hand).toEqual(before)
      expect(game.state.zones.drawPile.slice(0, count)).toEqual(top)
      order.push('attempt')
    })
    game.events.on('CardZoneMoved', () => { order.push('move') })
    game.events.on('GainCard', (context) => {
      expect(context.event.payload).toMatchObject({ playerId: 'p0', cardIds: top, isDraw: true, reason: 'draw' })
      expect(context.event.targetId).toBe('p0')
      expect(context.event.cardIds).toEqual(top)
      order.push('gain')
    })
    answer(game, optionId)
    expect(order).toEqual(['attempt', ...Array(count).fill('move'), 'gain'])
    expect(game.state.players[0]!.zones.hand).toEqual([...before, ...top])
    expect(game.state.players[0]!.marks.luoyi).toBe(optionId === 'yes' ? 1 : undefined)
    assertGameInvariants(game.state)
  })

  it.each(['yes', 'no'])('裸衣 %s：空牌堆从弃牌堆重洗后仍摸足实际张数', (optionId) => {
    const game = atDraw('xuchu')
    for (const cardId of [...game.state.zones.drawPile])
      moveCard(game.state, cardId, { kind: 'drawPile' }, { kind: 'discardPile' })
    const before = game.state.players[0]!.zones.hand.length
    let reshuffles = 0
    game.events.on('DeckReshuffled', () => { reshuffles++ })
    answer(game, optionId)
    expect(reshuffles).toBe(1)
    expect(game.state.players[0]!.zones.hand).toHaveLength(before + (optionId === 'yes' ? 1 : 2))
    assertGameInvariants(game.state)
  })

  it('拒绝突袭时正常摸两张，而非无来源的获得牌', () => {
    const game = atDraw('zhangliao')
    const before = game.state.players[0]!.zones.hand.length
    let attempts = 0
    let gains = 0
    game.events.on('DrawAttempt', () => { attempts++ })
    game.events.on('GainCard', (context) => {
      expect(context.event.payload).toMatchObject({ playerId: 'p0', isDraw: true })
      gains++
    })
    answer(game, 'no')
    expect(attempts).toBe(1)
    expect(gains).toBe(1)
    expect(game.state.players[0]!.zones.hand).toHaveLength(before + 2)
    assertGameInvariants(game.state)
  })

  it('裸衣摸牌被谮润挂起后可序列化恢复，拒绝替代只补一张且不重复记裸衣回答', () => {
    let game = atDraw('xuchu')
    game.state.players[0]!.grantedSkills.push('zanrun-sunhong:b61')
    const before = game.state.players[0]!.zones.hand.length
    const decisionsBefore = game.state.decisions.length
    answer(game, 'yes')
    expect(game.state.skillResolution?.skillId).toBe('zanrun-sunhong:b61')
    expect(game.state.players[0]!.zones.hand).toHaveLength(before)
    expect(game.state.drawOperationReplay?.operation.kind).toBe('respond')
    game = SanguoshaGame.restore(game.serialize())
    answer(game, 'no')
    expect(game.state.players[0]!.zones.hand).toHaveLength(before + 1)
    expect(game.state.players[0]!.marks.luoyi).toBe(1)
    expect(game.state.decisions).toHaveLength(decisionsBefore + 2)
    expect(game.state.drawOperationReplay).toBeUndefined()
    expect(game.state.skillResolution).toBeNull()
    expect(game.state.pendingRequests).toHaveLength(0)
    assertGameInvariants(game.state)
  })
})
