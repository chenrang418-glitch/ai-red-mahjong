import { describe, expect, it } from 'vitest'
import { SanguoshaGame } from '@/sanguosha/engine/game'
import { assertGameInvariants } from '@/sanguosha/engine/invariants'
import type { GameSetup, Identity, PlayerId } from '@/sanguosha/engine/types'

/**
 * 会向玩家发问的技能。
 *
 * 这些技能的等待状态必须完全落在 GameState 里——Durable Object 随时可能休眠，
 * 所以每个用例都顺带断言 skillResolution 是可序列化的，并且和 pendingRequests 对得上。
 */

function setup(): GameSetup {
  return {
    mode: 'identity', generalChoices: 1,
    players: Array.from({ length: 5 }, (_, index) => ({ id: `p${index}`, nickname: `玩家${index}`, isHuman: index === 0 })),
  }
}

/** 起一局并把武将钉死，避免依赖发牌随机性。 */
function gameWith(characterIds: (string | null)[], seed = 'skill-test'): SanguoshaGame {
  const game = new SanguoshaGame({ seed, setup: setup() })
  const identities: Identity[] = ['lord', 'rebel', 'loyalist', 'rebel', 'renegade']
  game.state.players.forEach((player, index) => {
    player.identity = identities[index]
    player.characterId = characterIds[index] ?? 'machao'
  })
  game.start()
  return game
}

function pending(game: SanguoshaGame) {
  return game.state.pendingRequests[0]
}

function answer(game: SanguoshaGame, playerId: PlayerId, payload: unknown): void {
  const request = pending(game)
  expect(request).toBeTruthy()
  game.respond({ requestId: request.id, playerId, payload })
}

/** 推进到指定玩家的指定阶段，中途遇到请求就交给回调处理。 */
function advanceTo(game: SanguoshaGame, playerId: PlayerId, phase: string, onRequest?: (game: SanguoshaGame) => void): void {
  for (let step = 0; step < 200; step += 1) {
    if (game.state.currentPlayerId === playerId && game.state.phase === phase) return
    if (game.state.pendingRequests.length > 0) {
      if (!onRequest) throw new Error(`意外的请求：${pending(game).kind} / ${pending(game).prompt}`)
      onRequest(game)
      continue
    }
    game.advancePhase()
  }
  throw new Error('没能推进到目标阶段')
}

describe('技能请求通道', () => {
  it('等待状态可序列化，并且和 pendingRequests 对得上', () => {
    const game = gameWith(['zhenji'])
    // 主公 p0 是甄姬，开局就是他的准备阶段，洛神应当已经发问
    const resolution = game.state.skillResolution
    expect(resolution).toMatchObject({ kind: 'skill', skillId: 'luoshen', ownerId: 'p0', step: 'ask' })
    expect(pending(game).id).toBe(resolution!.requestId)
    // 整个状态必须能过一遍 JSON，DO 才存得住
    expect(() => JSON.parse(JSON.stringify(game.state))).not.toThrow()
    assertGameInvariants(game.state)

    // 挂着请求时不允许推进阶段
    expect(() => game.advancePhase()).toThrow(/Request/)
  })

  it('洛神：判定为黑色时获得判定牌并可再次发动', () => {
    const game = gameWith(['zhenji'])
    // 把牌堆顶换成一张确定的黑牌
    const blackId = Object.values(game.state.cards).find((card) => card.color === 'black' && game.state.zones.drawPile.includes(card.id))!.id
    game.state.zones.drawPile = [blackId, ...game.state.zones.drawPile.filter((id) => id !== blackId)]

    const handBefore = game.state.players[0].zones.hand.length
    answer(game, 'p0', { optionId: 'yes' })

    expect(game.state.players[0].zones.hand).toContain(blackId)
    expect(game.state.players[0].zones.hand.length).toBe(handBefore + 1)
    // 黑色 → 再问一次
    expect(game.state.skillResolution?.skillId).toBe('luoshen')
    assertGameInvariants(game.state)

    // 放弃之后状态干净
    answer(game, 'p0', { optionId: 'no' })
    expect(game.state.skillResolution).toBeNull()
    expect(game.state.pendingRequests).toHaveLength(0)
    assertGameInvariants(game.state)
  })

  it('洛神：判定为红色时不获得牌，也不再发问', () => {
    const game = gameWith(['zhenji'])
    const redId = Object.values(game.state.cards).find((card) => card.color === 'red' && game.state.zones.drawPile.includes(card.id))!.id
    game.state.zones.drawPile = [redId, ...game.state.zones.drawPile.filter((id) => id !== redId)]

    answer(game, 'p0', { optionId: 'yes' })
    expect(game.state.players[0].zones.hand).not.toContain(redId)
    expect(game.state.zones.discardPile).toContain(redId)
    expect(game.state.skillResolution).toBeNull()
    assertGameInvariants(game.state)
  })

  it('裸衣：发动则少摸一张，且【杀】伤害 +1；回合结束标记清除', () => {
    const game = gameWith(['xuchu'])
    advanceTo(game, 'p0', 'draw')
    const handBefore = game.state.players[0].zones.hand.length

    expect(pending(game).kind).toBe('choose-option')
    answer(game, 'p0', { optionId: 'yes' })

    expect(game.state.players[0].zones.hand.length).toBe(handBefore + 1)
    expect(game.state.players[0].marks.luoyi).toBe(1)

    const victim = game.state.players[1]
    const hpBefore = victim.hp
    game.damage({ sourceId: 'p0', targetId: victim.id, amount: 1, nature: 'normal', cardName: '杀' })
    expect(victim.hp).toBe(hpBefore - 2)

    // 别的牌不吃这个加成
    const other = game.state.players[2]
    const otherHpBefore = other.hp
    game.damage({ sourceId: 'p0', targetId: other.id, amount: 1, nature: 'normal', cardName: '火攻' })
    expect(other.hp).toBe(otherHpBefore - 1)

    advanceTo(game, 'p1', 'prepare', (current) => {
      const request = pending(current)
      if (request.kind === 'choose-cards') {
        current.respond({ requestId: request.id, playerId: request.playerId, payload: { cardIds: request.cardIds.slice(0, request.min) } })
      } else throw new Error(`意外的请求：${request.kind}`)
    })
    expect(game.state.players[0].marks.luoyi).toBeUndefined()
  })

  it('裸衣：放弃则照常摸两张', () => {
    const game = gameWith(['xuchu'])
    advanceTo(game, 'p0', 'draw')
    const handBefore = game.state.players[0].zones.hand.length
    answer(game, 'p0', { optionId: 'no' })
    expect(game.state.players[0].zones.hand.length).toBe(handBefore + 2)
    expect(game.state.players[0].marks.luoyi).toBeUndefined()
  })

  it('突袭：拿走两名角色各一张手牌，牌总数守恒', () => {
    const game = gameWith(['zhangliao'])
    advanceTo(game, 'p0', 'draw')
    const handBefore = game.state.players[0].zones.hand.length
    const victimsBefore = [game.state.players[1].zones.hand.length, game.state.players[2].zones.hand.length]

    answer(game, 'p0', { optionId: 'yes' })
    const targetRequest = pending(game)
    expect(targetRequest.kind).toBe('choose-targets')
    // 自己不在候选里
    expect((targetRequest as { candidateIds: string[] }).candidateIds).not.toContain('p0')
    answer(game, 'p0', { targetIds: ['p1', 'p2'] })

    expect(game.state.players[0].zones.hand.length).toBe(handBefore + 2)
    expect(game.state.players[1].zones.hand.length).toBe(victimsBefore[0] - 1)
    expect(game.state.players[2].zones.hand.length).toBe(victimsBefore[1] - 1)
    assertGameInvariants(game.state)
  })

  it('突袭：放弃则照常摸两张', () => {
    const game = gameWith(['zhangliao'])
    advanceTo(game, 'p0', 'draw')
    const handBefore = game.state.players[0].zones.hand.length
    answer(game, 'p0', { optionId: 'no' })
    expect(game.state.players[0].zones.hand.length).toBe(handBefore + 2)
  })

  it('青囊：出牌阶段限一次，弃一张牌令受伤角色回复一点', () => {
    const game = gameWith(['huatuo'])
    advanceTo(game, 'p0', 'play')
    // 先制造一个伤员，否则技能按设计不会出现
    const patient = game.state.players[3]
    patient.hp -= 1

    const actions = game.legalActions('p0')
    const qingnang = actions.find((action) => action.id === 'skill:qingnang')
    expect(qingnang).toBeTruthy()

    game.act('p0', 'skill:qingnang')
    const discardRequest = pending(game)
    expect(discardRequest.kind).toBe('choose-cards')
    const discarded = (discardRequest as { cardIds: string[] }).cardIds[0]
    answer(game, 'p0', { cardIds: [discarded] })

    const targetRequest = pending(game)
    expect(targetRequest.kind).toBe('choose-targets')
    // 只有受伤的人能被选
    expect((targetRequest as { candidateIds: string[] }).candidateIds).toEqual([patient.id])
    answer(game, 'p0', { targetIds: [patient.id] })

    expect(patient.hp).toBe(patient.maxHp)
    expect(game.state.zones.discardPile).toContain(discarded)
    expect(game.state.players[0].zones.hand).not.toContain(discarded)
    assertGameInvariants(game.state)

    // 限一次：不再出现
    expect(game.legalActions('p0').some((action) => action.id === 'skill:qingnang')).toBe(false)
  })

  it('青囊：场上无人受伤时不给出这个动作', () => {
    const game = gameWith(['huatuo'])
    advanceTo(game, 'p0', 'play')
    expect(game.state.players.every((player) => player.hp === player.maxHp)).toBe(true)
    expect(game.legalActions('p0').some((action) => action.id === 'skill:qingnang')).toBe(false)
  })

  it('技能等待期间，别的技能不会插队发问', () => {
    // 甄姬和许褚同局：洛神在准备阶段问，裸衣在摸牌阶段问，不会撞在一起
    const game = gameWith(['zhenji', 'xuchu'])
    expect(game.state.skillResolution?.skillId).toBe('luoshen')
    expect(game.state.pendingRequests).toHaveLength(1)
    answer(game, 'p0', { optionId: 'no' })
    expect(game.state.skillResolution).toBeNull()
  })
})
