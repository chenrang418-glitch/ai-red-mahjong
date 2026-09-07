import { describe, expect, it } from 'vitest'
import { SanguoshaGame } from '@/sanguosha/engine/game'
import { assertCardConservation, moveCard } from '@/sanguosha/engine/zones'
import { discardAllCards } from '@/sanguosha/engine/discard-all'
import { gainOriginCounts } from '@/sanguosha/engine/card-gain-provenance'
import { resolveDamage } from '@/sanguosha/engine/damage'
import type { GameSetup, Identity, PlayerId } from '@/sanguosha/engine/types'

/**
 * 第二批带进来的**挂起状态**必须能过一遍存盘重建。
 *
 * Durable Object 随时会休眠。这四个人的技能都会在半路上停下来等玩家回答：
 * 心战看完牌堆顶等他挑红桃、旋风弃完第一张等他弃第二张、
 * 甘露选完第一名等他选第二名、补益在濒死轮询里等吴国太表态。
 * 这些「问到哪一步」全部写在可序列化的挂起状态里，重连之后必须原样回来，
 * 而且**不能重复结算**：不能再获得一次牌、再弃一次、再交换一次、再回一次血。
 *
 * 单独写这一条是因为通用的持久化用例是从全部武将里随机取阵容跑整局，
 * 这四个人被抽中的概率很低——「那条绿了」并不能说明这些状态被覆盖过。
 */

interface AnyRequest { id: string; playerId: PlayerId; kind: string; prompt?: string }

function gameAt(seed: string, characterIds: string[]): SanguoshaGame {
  const setup: GameSetup = {
    mode: 'identity', generalChoices: 1,
    players: Array.from({ length: 5 }, (_, index) => ({ id: `p${index}`, nickname: `玩家${index}`, isHuman: index === 0 })),
  }
  const game = new SanguoshaGame({ seed, setup })
  const identities: Identity[] = ['lord', 'rebel', 'loyalist', 'rebel', 'renegade']
  game.state.players.forEach((player, index) => {
    player.identity = identities[index]
    player.identityRevealed = player.identity === 'lord'
    player.characterId = characterIds[index]
  })
  game.state.currentPlayerId = 'p0'
  game.start()
  drain(game)
  while (game.state.phase !== 'play') {
    game.advancePhase()
    drain(game)
  }
  return game
}

/** 把当前所有请求用「最小承诺」的合法回答清掉。 */
function drain(game: SanguoshaGame, keep: (request: AnyRequest) => boolean = () => false): void {
  for (let guard = 0; guard < 400; guard += 1) {
    const request = game.state.pendingRequests[0] as AnyRequest | undefined
    if (!request || keep(request)) return
    game.respond({ requestId: request.id, playerId: request.playerId, payload: minimalPayload(request) })
  }
  throw new Error('结算没有收敛')
}

function minimalPayload(request: AnyRequest): Record<string, unknown> {
  switch (request.kind) {
    case 'choose-general': return { characterId: (request as unknown as { candidates: string[] }).candidates[0] }
    case 'choose-options': return { optionIds: [] }
    case 'choose-cards': {
      const pick = request as unknown as { cardIds: string[]; hiddenCardSlots: string[]; min: number }
      return { cardIds: [...pick.cardIds, ...pick.hiddenCardSlots].slice(0, pick.min ?? 0) }
    }
    case 'choose-targets': {
      const pick = request as unknown as { candidateIds: string[]; min: number }
      return { targetIds: pick.candidateIds.slice(0, pick.min ?? 0) }
    }
    case 'choose-option': {
      const options = (request as unknown as { options: { id: string }[] }).options
      return { optionId: options[options.length - 1].id }
    }
    case 'arrange-cards': {
      const pick = request as unknown as { cardIds: string[] }
      return { top: [...pick.cardIds], bottom: [] }
    }
    case 'rescue': return { actionId: 'rescue-pass' }
    default: return { actionId: 'respond-pass' }
  }
}

/** 存一次盘再读回来，模拟 Durable Object 休眠。 */
function roundTrip(game: SanguoshaGame): SanguoshaGame {
  return SanguoshaGame.restore(JSON.parse(JSON.stringify(game.serialize())))
}

function playerOf(game: SanguoshaGame, id: string) {
  return game.state.players.find((candidate) => candidate.id === id)!
}

function setHand(game: SanguoshaGame, playerId: string, count: number): void {
  const player = playerOf(game, playerId)
  for (const cardId of player.zones.hand.slice(count)) {
    moveCard(game.state, cardId, { kind: 'hand', playerId }, { kind: 'discardPile' })
  }
  while (player.zones.hand.length < count) {
    moveCard(game.state, game.state.zones.drawPile[0], { kind: 'drawPile' }, { kind: 'hand', playerId })
  }
}

function equipAny(game: SanguoshaGame, playerId: string, slot: 'weapon' | 'armor' | 'defensiveHorse'): string {
  const card = Object.values(game.state.cards).find((candidate) => candidate.category === 'equipment'
    && candidate.equipmentSlot === slot
    && !candidate.virtual
    && game.state.zones.drawPile.includes(candidate.id))
  if (!card) throw new Error(`牌堆里没有闲置的${slot}装备`)
  moveCard(game.state, card.id, { kind: 'drawPile' }, { kind: 'equipment', playerId, slot })
  return card.id
}

describe('一将成名 2011 第二批：重连之后挂起状态一模一样', () => {
  it('心战停在「挑红桃」那一步：重连之后看到的还是同样三张，而且只能拿一次', () => {
    const game = gameAt('b2-persist-xinzhan', ['masu', 'zhangfei', 'guanyu', 'zhaoyun', 'huangzhong'])
    setHand(game, 'p0', playerOf(game, 'p0').maxHp + 1)
    const topBefore = game.state.zones.drawPile.slice(0, 3)
    const action = game.legalActions('p0').find((candidate) => candidate.id.includes('xinzhan'))!
    game.act('p0', action.id)

    const request = game.state.pendingRequests[0] as unknown as { id: string; cardIds: string[]; viewOnlyCardIds: string[] }
    const restored = roundTrip(game)
    const restoredRequest = restored.state.pendingRequests[0] as unknown as { id: string; cardIds: string[]; viewOnlyCardIds: string[] }
    expect(restoredRequest.id, '还是同一个请求').toBe(request.id)
    expect(restoredRequest.cardIds, '能选的红桃一样').toEqual(request.cardIds)
    expect(restoredRequest.viewOnlyCardIds, '只看不能选的那几张也一样').toEqual(request.viewOnlyCardIds)
    expect(restored.state.zones.drawPile.slice(0, 3), '三张牌仍然在牌堆里，没有被提前拿出来').toEqual(topBefore)

    const handBefore = playerOf(restored, 'p0').zones.hand.length
    drain(restored)
    const gained = playerOf(restored, 'p0').zones.hand.length - handBefore
    expect(gained, '最多只拿到当时看到的那几张红桃').toBeLessThanOrEqual(request.cardIds.length)
    assertCardConservation(restored.state)
  })

  it('旋风停在「弃第二张」那一步：重连之后接着弃，不会重来一遍', () => {
    const game = gameAt('b2-persist-xuanfeng', ['lingtong', 'zhangfei', 'guanyu', 'zhaoyun', 'huangzhong'])
    game.state.discardPhaseLedger = {
      phaseInstanceId: 'phase-test',
      ownerPlayerId: 'p0',
      records: game.state.zones.discardPile.slice(0, 2).map((cardId, index) => ({
        cardId, sourcePlayerId: 'p0', originalZone: 'hand' as const, moveReason: 'discard' as const, enteredDiscardAt: index,
      })),
    }
    setHand(game, 'p1', 4)
    const targetHandBefore = playerOf(game, 'p1').zones.hand.length

    game.dispatch('PhaseEnd', { playerId: 'p0', phase: 'discard' }, { sourceId: 'p0', phase: 'discard' })
    game.settle()
    // 选模式 → 选目标 → 弃第一张，然后停在「弃第二张」那一步
    let discards = 0
    drain(game, (request) => {
      if (request.kind === 'choose-cards' && request.prompt?.includes('旋风')) {
        if (discards >= 1) return true
        discards += 1
      }
      return false
    })
    // 手工把前两步答成「一名角色、弃两张」
    for (let guard = 0; guard < 6; guard += 1) {
      const request = game.state.pendingRequests[0] as AnyRequest | undefined
      if (!request) break
      if (request.kind === 'choose-option' && request.prompt?.includes('旋风')) {
        game.respond({ requestId: request.id, playerId: request.playerId, payload: { optionId: 'one' } })
        continue
      }
      if (request.kind === 'choose-targets' && request.prompt?.includes('旋风')) {
        const pick = request as unknown as { candidateIds: string[] }
        game.respond({ requestId: request.id, playerId: request.playerId, payload: { targetIds: [pick.candidateIds[0]] } })
        continue
      }
      if (request.kind === 'choose-cards' && request.prompt?.includes('旋风')) {
        const pick = request as unknown as { cardIds: string[]; hiddenCardSlots: string[] }
        game.respond({ requestId: request.id, playerId: request.playerId, payload: { cardIds: [...pick.cardIds, ...pick.hiddenCardSlots].slice(0, 1) } })
        break
      }
      break
    }

    const pending = game.state.pendingRequests[0] as AnyRequest | undefined
    const restored = roundTrip(game)
    if (pending) {
      expect(restored.state.pendingRequests[0]?.id, '停在哪一步就从哪一步接着走').toBe(pending.id)
    }
    drain(restored)
    const after = playerOf(restored, 'p1').zones.hand.length
    expect(targetHandBefore - after, '总共最多弃两张，不会因为重连多弃').toBeLessThanOrEqual(2)
    assertCardConservation(restored.state)
  })

  it('甘露选完第一名之后重连：次数已经记下，不会白发动第二次', () => {
    const game = gameAt('b2-persist-ganlu', ['wuguotai', 'zhangfei', 'guanyu', 'zhaoyun', 'huangzhong'])
    playerOf(game, 'p0').hp = playerOf(game, 'p0').maxHp - 2
    equipAny(game, 'p1', 'weapon')
    const action = game.legalActions('p0').find((candidate) => candidate.id.includes('ganlu'))!
    game.act('p0', action.id)
    // 第一步：选第一名
    const first = game.state.pendingRequests[0] as unknown as { id: string; candidateIds: string[] }
    game.respond({ requestId: first.id, playerId: 'p0', payload: { targetIds: [first.candidateIds[0]] } })

    const second = game.state.pendingRequests[0] as AnyRequest
    const restored = roundTrip(game)
    expect(restored.state.pendingRequests[0]?.id, '接着问第二名').toBe(second.id)
    drain(restored)
    const again = restored.legalActions('p0').find((candidate) => candidate.id.includes('ganlu'))
    expect(again, '本回合已经用过了，重连之后也不该冒出第二次').toBeUndefined()
    assertCardConservation(restored.state)
  })

  it('补益的「这次濒死已经发动过」记号过得去存盘', () => {
    const game = gameAt('b2-persist-buyi', ['wuguotai', 'zhangfei', 'guanyu', 'zhaoyun', 'huangzhong'])
    const target = playerOf(game, 'p1')
    for (const cardId of [...target.zones.hand]) {
      moveCard(game.state, cardId, { kind: 'hand', playerId: 'p1' }, { kind: 'discardPile' })
    }
    // 给他两张牌，保证展示之后还有手牌
    setHand(game, 'p1', 2)
    target.hp = 1
    resolveDamage(game as never, { sourceId: 'p2', targetId: 'p1', amount: 1, nature: 'normal' })
    game.settle()
    for (let guard = 0; guard < 8; guard += 1) {
      const request = game.state.pendingRequests[0] as AnyRequest | undefined
      if (!request) break
      if (request.kind === 'rescue' && request.playerId === 'p0') {
        const pick = request as unknown as { actionIds: string[] }
        const buyi = pick.actionIds.find((id) => id.includes('buyi'))
        if (buyi) {
          game.respond({ requestId: request.id, playerId: 'p0', payload: { actionId: buyi } })
          break
        }
      }
      game.respond({ requestId: request.id, playerId: request.playerId, payload: minimalPayload(request) })
    }
    const markKey = 'buyi-used:p0'
    const marked = playerOf(game, 'p1').marks[markKey]
    expect(marked, '发动之后记下了这是第几次濒死').toBeTruthy()

    const restored = roundTrip(game)
    expect(playerOf(restored, 'p1').marks[markKey], '记号原样回来').toBe(marked)
    drain(restored)
    assertCardConservation(restored.state)
  })

  it('手牌来源记录过得去存盘：重连之后仍然分得清哪张是抢来的', () => {
    const game = gameAt('b2-persist-gain', ['fazheng', 'zhangfei', 'guanyu', 'zhaoyun', 'huangzhong'])
    setHand(game, 'p1', 2)
    const taken = playerOf(game, 'p1').zones.hand.slice(0, 2)
    for (const cardId of taken) {
      moveCard(game.state, cardId, { kind: 'hand', playerId: 'p1' }, { kind: 'hand', playerId: 'p0' })
    }
    expect(gainOriginCounts(game.state, 'p0', taken).get('p1')).toBe(2)

    const restored = roundTrip(game)
    expect(gainOriginCounts(restored.state, 'p0', taken).get('p1'), '来源记录原样回来').toBe(2)
  })

  it('弃置所有牌的记录过得去存盘：落英仍然认得出「因弃置进的弃牌堆」', () => {
    const game = gameAt('b2-persist-discardall', ['masu', 'zhangfei', 'caozhi', 'zhaoyun', 'huangzhong'])
    setHand(game, 'p1', 2)
    equipAny(game, 'p1', 'armor')
    const discarded = discardAllCards(game as never, 'p1', 'test')
    game.settle()
    drain(game)
    expect(discarded.length, '手牌加装备都弃了').toBeGreaterThanOrEqual(2)

    const restored = roundTrip(game)
    for (const cardId of discarded) {
      const entry = restored.state.discardProvenance?.[cardId]
      // 已经被落英拿走的牌不在弃牌堆里，那种情况下没有记录也是对的
      if (!restored.state.zones.discardPile.includes(cardId)) continue
      expect(entry?.reason, `${cardId} 的进堆原因要带过来`).toBe('discard')
    }
    assertCardConservation(restored.state)
  })
})
