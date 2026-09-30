import { describe, expect, it } from 'vitest'
import { SanguoshaGame } from '@/sanguosha/engine/game'
import { assertGameInvariants } from '@/sanguosha/engine/invariants'
import { moveCard } from '@/sanguosha/engine/zones'

const ZANRUN = 'zanrun-sunhong:b61'

function gameAtLuoyiDraw() {
  const game = new SanguoshaGame({ seed: 'audit-wei-draw-replacement', setup: {
    mode: 'identity', generalChoices: 1,
    players: Array.from({ length: 5 }, (_, index) => ({ id: `p${index}`, nickname: `玩家${index}`, isHuman: true })),
  } })
  const identities = ['lord', 'rebel', 'loyalist', 'rebel', 'renegade'] as const
  game.state.players.forEach((player, index) => {
    player.characterId = index === 0 ? 'xuchu' : 'zhangfei'
    player.identity = identities[index]
  })
  game.state.players[0]!.grantedSkills.push(ZANRUN)
  game.state.currentPlayerId = 'p0'
  game.state.normalTurnPlayerId = 'p0'
  game.start()
  for (let step = 0; game.state.phase !== 'draw' && step < 10; step++) game.advancePhase()
  expect(game.state.phase).toBe('draw')
  expect(game.state.skillResolution?.skillId).toBe('luoyi')

  const target = game.state.players[1]!
  if (target.zones.hand.length === 0) {
    const cardId = game.state.zones.drawPile[0]
    if (!cardId) throw new Error('测试初始化时没有可给目标角色的手牌')
    moveCard(game.state, cardId, { kind: 'drawPile' }, { kind: 'hand', playerId: target.id })
  }
  return game
}

function respond(game: SanguoshaGame, payload: unknown) {
  const request = game.state.pendingRequests.at(-1)
  if (!request) throw new Error('预期存在等待回答的请求')
  game.respond({ requestId: request.id, playerId: request.playerId, payload })
}

describe('审计回归：裸衣摸牌被谮润成功替代', () => {
  it('不继续消耗牌堆；替代牌经失去与获得事件转移，保存恢复后完成且守恒', () => {
    let game = gameAtLuoyiDraw()
    const ownerId = 'p0'
    const targetId = 'p1'
    const owner = game.state.players[0]!
    const target = game.state.players[1]!
    const drawPileBefore = [...game.state.zones.drawPile]
    const ownerHandBefore = owner.zones.hand.length
    const targetHandBefore = target.zones.hand.length

    respond(game, { optionId: 'yes' })
    expect(game.state.skillResolution?.skillId).toBe(ZANRUN)
    expect(game.state.drawOperationReplay?.operation.kind).toBe('respond')
    expect(game.state.players[0]!.zones.hand).toHaveLength(ownerHandBefore)
    expect(game.state.zones.drawPile).toEqual(drawPileBefore)

    respond(game, { optionId: 'yes' })
    const targetRequest = game.state.pendingRequests.at(-1)
    expect(targetRequest?.kind).toBe('choose-targets')
    respond(game, { targetIds: [targetId] })

    const takeRequest = game.state.pendingRequests.at(-1)
    expect(takeRequest?.kind).toBe('choose-cards')
    if (takeRequest?.kind !== 'choose-cards') throw new Error('谮润没有请求选择替代牌')
    const picked = takeRequest.hiddenCardSlots[0] ?? takeRequest.cardIds[0]
    if (!picked) throw new Error('目标角色没有可供谮润取得的手牌')
    respond(game, { cardIds: [picked] })
    expect(game.state.pendingRequests.at(-1)?.playerId).toBe(targetId)

    // 序列化保存挂起的 draw replay，再由恢复后的真实游戏实例完成最后一步。
    game = SanguoshaGame.restore(game.serialize())
    const events: Array<{ name: string; sourceId?: string; targetId?: string; cardIds?: string[]; payload: Record<string, unknown> }> = []
    for (const name of ['DrawAttempt', 'LoseCard', 'GainCard'] as const) {
      game.events.on(name, (context) => events.push({
        name, sourceId: context.event.sourceId, targetId: context.event.targetId,
        cardIds: context.event.cardIds, payload: context.event.payload,
      }))
    }
    respond(game, { optionId: 'forbid' })

    const lose = events.filter((event) => event.name === 'LoseCard')
    const gain = events.filter((event) => event.name === 'GainCard')
    const attempts = events.filter((event) => event.name === 'DrawAttempt')
    expect(attempts).toHaveLength(1)
    expect(attempts[0]?.payload).toMatchObject({ playerId: ownerId, count: 1, isDraw: true, attemptIndex: 0 })
    expect(lose).toHaveLength(1)
    expect(gain).toHaveLength(1)
    expect(lose[0]).toMatchObject({
      sourceId: targetId, targetId: ownerId, payload: { playerId: targetId, reason: ZANRUN },
    })
    expect(gain[0]).toMatchObject({
      sourceId: ownerId, targetId: ownerId, payload: { playerId: ownerId, reason: ZANRUN },
    })
    expect(gain[0]?.payload).not.toHaveProperty('isDraw')
    expect(gain[0]?.cardIds).toEqual(lose[0]?.cardIds)
    expect(gain[0]?.payload.cardIds).toEqual(lose[0]?.payload.cardIds)

    expect(game.state.players[0]!.zones.hand).toHaveLength(ownerHandBefore + 1)
    expect(game.state.players[1]!.zones.hand).toHaveLength(targetHandBefore - 1)
    expect(game.state.zones.drawPile).toEqual(drawPileBefore)
    expect(game.state.players[0]!.marks.luoyi).toBe(1)
    expect(game.state.drawOperationReplay).toBeUndefined()
    expect(game.state.skillResolution).toBeNull()
    expect(game.state.pendingRequests).toHaveLength(0)
    assertGameInvariants(game.state)
  })
})
