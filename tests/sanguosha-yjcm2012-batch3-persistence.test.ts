import { describe, expect, it } from 'vitest'
import { SanguoshaGame } from '@/sanguosha/engine/game'
import { assertCardConservation, moveCard } from '@/sanguosha/engine/zones'
import { assertGameInvariants } from '@/sanguosha/engine/invariants'
import { grantTurnSlashBonus, slashRules } from '@/sanguosha/engine/slash-rules'
import { declinedThisPhase, markDeclinedThisPhase } from '@/sanguosha/engine/phase-usage'
import { livingKingdomCount } from '@/sanguosha/engine/living-kingdoms'
import { maxCardsOf } from '@/sanguosha/engine/phase'
import { buildPlayerView } from '@/sanguosha/engine/view'
import type { GameSetup, Identity, PlayerId } from '@/sanguosha/engine/types'

/**
 * 一将成名 2012 第三批带进来的状态**必须能过一遍存盘重建**。
 *
 * Durable Object 随时会休眠。这一批要带过去的是：弓骑的回合级修正、
 * 解烦的多人同时决定、安恤挂起中的暗牌挑选、追忆排给死人的发问、
 * 自守已经跳掉的阶段位、宗室的动态上限、耀武发给伤害来源的请求。
 *
 * 重连之后不能：重复摸牌、重复获得牌、重复回复、重复跳过阶段、
 * 丢掉动态上限、丢掉发给别人的请求、泄漏暗牌。
 */

interface AnyRequest { id: string; playerId: PlayerId; kind: string; prompt?: string }

function gameAt(seed: string, characterIds: string[], playerCount = 5): SanguoshaGame {
  const setup: GameSetup = {
    mode: 'identity', generalChoices: 1,
    players: Array.from({ length: playerCount }, (_, index) => ({ id: `p${index}`, nickname: `玩家${index}`, isHuman: index === 0 })),
  }
  const game = new SanguoshaGame({ seed, setup })
  const identities: Identity[] = ['lord', 'rebel', 'loyalist', 'rebel', 'renegade', 'rebel', 'loyalist', 'rebel']
  game.state.players.forEach((player, index) => {
    player.identity = identities[index]
    player.identityRevealed = player.identity === 'lord'
    player.characterId = characterIds[index]
  })
  game.state.currentPlayerId = 'p0'
  game.start()
  drain(game)
  return game
}

function drain(game: SanguoshaGame): void {
  for (let guard = 0; guard < 400; guard += 1) {
    const request = game.state.pendingRequests[0] as AnyRequest | undefined
    if (!request) return
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
    case 'distribute-cards': return { assignments: [] }
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

describe('一将成名 2012 第三批：重连之后状态一模一样', () => {
  it('弓骑的回合级修正和放弃记号都过得去存盘', () => {
    const game = gameAt('b3-persist-gongqi', ['handang', 'zhangfei', 'guanyu', 'zhaoyun', 'huangzhong'])
    grantTurnSlashBonus(game.state, 'p0', { ignoreDistance: true, extraUses: 1 })
    markDeclinedThisPhase(game.state, 'p0', 'gongqi')

    const restored = roundTrip(game)
    const rules = slashRules(restored.state, 'p0')
    expect(rules.ignoreDistance, '距离豁免还在').toBe(true)
    expect(rules.extraUses, '额外次数还在').toBe(1)
    expect(declinedThisPhase(restored.state, 'p0', 'gongqi'), '放弃记号也带过来了').toBe(true)
  })

  it('解烦的多人同时决定过得去存盘：已交的答案不外泄、没交的照样能交', () => {
    const game = gameAt('b3-persist-jiefan', ['handang', 'zhangfei', 'guanyu', 'zhaoyun', 'huangzhong'])
    // 给两个人装上武器，让选项是完整的二选一
    for (const playerId of ['p1', 'p2']) {
      const weapon = Object.values(game.state.cards).find((card) => card.equipmentSlot === 'weapon'
        && !card.virtual && game.state.zones.drawPile.includes(card.id))!
      moveCard(game.state, weapon.id, { kind: 'drawPile' }, { kind: 'equipment', playerId, slot: 'weapon' })
    }
    game.state.currentPlayerId = 'p0'
    game.state.phase = 'play'
    const action = game.legalActions('p0').find((candidate) => candidate.kind === 'invoke-skill' && candidate.id === 'jiefan-invoke')!
    game.act('p0', action.id)
    expect(game.state.groupDecision, '多人决定已经挂起').not.toBeNull()
    // 先让 p1 交一个答案
    const first = game.state.pendingRequests.find((request) => request.playerId === 'p1')!
    game.respond({ requestId: first.id, playerId: 'p1', payload: { optionId: 'discard-weapon' } })

    const restored = roundTrip(game)
    expect(restored.state.groupDecision?.tag, '决定原样回来').toBe('jiefan-choice')
    expect(restored.state.groupDecision?.responses.p1, '已交的答案带过来了').toBe('discard-weapon')
    /*
     * 已交的答案不进任何人的视图。
     *
     * 断言盯的是**答案表**，不是「视图里出现过 discard-weapon 这个串」——
     * 后者会误报：还没答的人自己的请求里本来就带着这个选项 id。
     */
    for (const viewer of ['p0', 'p2', 'p3', 'p4']) {
      const view = buildPlayerView(restored.state, viewer) as unknown as Record<string, unknown>
      expect(JSON.stringify(view), `${viewer} 不该看到别人的答案表`).not.toContain('"responses"')
      const own = (view.pendingRequest as { playerId?: string } | null | undefined)?.playerId
      if (own) expect(own, '视图里只会有发给自己的那一条请求').toBe(viewer)
    }
    // 其余人照常答完，牌局要能收敛
    drain(restored)
    expect(restored.state.groupDecision, '收齐之后决定结清').toBeNull()
    assertCardConservation(restored.state)
    assertGameInvariants(restored.state)
  })

  it('安恤挂起在暗牌挑选上：重连之后从同一步接着走，且不泄漏手牌', () => {
    const game = gameAt('b3-persist-anxu', ['zhangfei', 'bulianshi', 'guanyu', 'zhaoyun', 'huangzhong'])
    // 手动摆出「p0 少、p2 多」的局面
    for (const cardId of [...playerOf(game, 'p0').zones.hand]) {
      moveCard(game.state, cardId, { kind: 'hand', playerId: 'p0' }, { kind: 'discardPile' })
    }
    game.state.currentPlayerId = 'p1'
    game.state.phase = 'play'
    const higherHand = [...playerOf(game, 'p2').zones.hand]
    expect(higherHand.length, '较多者确实有手牌').toBeGreaterThan(0)

    const action = game.legalActions('p1').find((candidate) => candidate.kind === 'invoke-skill' && candidate.id === 'anxu-invoke')!
    game.act('p1', action.id)
    const targets = game.state.pendingRequests[0]
    game.respond({ requestId: targets.id, playerId: 'p1', payload: { targetIds: ['p0', 'p2'] } })
    const pick = game.state.pendingRequests[0] as AnyRequest
    expect(pick.playerId, '挑牌的是获得者').toBe('p0')

    const restored = roundTrip(game)
    expect(restored.state.pendingRequests[0]?.id, '还是同一个请求').toBe(pick.id)
    // 步练师的视图里仍然看不到较多者的手牌
    const buView = JSON.stringify(buildPlayerView(restored.state, 'p1').players.find((player) => player.id === 'p2'))
    for (const cardId of higherHand) {
      expect(buView, `重连之后步练师仍然不该看到 ${cardId}`).not.toContain(cardId)
    }
    drain(restored)
    expect(playerOf(restored, 'p0').zones.hand, '接着走完，牌真的到手了').toHaveLength(1)
    assertCardConservation(restored.state)
  })

  it('追忆排给已阵亡拥有者的发问过得去存盘', () => {
    const game = gameAt('b3-persist-zhuiyi', ['zhangfei', 'bulianshi', 'guanyu', 'zhaoyun', 'huangzhong'])
    const bu = playerOf(game, 'p1')
    bu.hp = 1
    for (const cardId of [...bu.zones.hand]) {
      moveCard(game.state, cardId, { kind: 'hand', playerId: 'p1' }, { kind: 'discardPile' })
    }
    const slash = Object.values(game.state.cards).find((card) => card.name === '杀' && !card.virtual
      && game.state.zones.drawPile.includes(card.id))!
    moveCard(game.state, slash.id, { kind: 'drawPile' }, { kind: 'hand', playerId: 'p0' })
    playerOf(game, 'p0').attackRangeBonus = 6
    game.state.currentPlayerId = 'p0'
    game.state.phase = 'play'
    const action = game.legalActions('p0').find((candidate) => candidate.kind === 'use-card'
      && candidate.asCardName === '杀' && candidate.targetIds.includes('p1'))!
    game.act('p0', action.id)

    // 结算到追忆那一问就停下
    for (let guard = 0; guard < 40; guard += 1) {
      const request = game.state.pendingRequests[0] as AnyRequest | undefined
      if (!request) break
      if (request.playerId === 'p1' && request.prompt?.includes('追忆')) break
      game.respond({ requestId: request.id, playerId: request.playerId, payload: minimalPayload(request) })
    }
    const zhuiyi = game.state.pendingRequests[0] as AnyRequest
    expect(zhuiyi?.prompt, '停在追忆那一问上').toContain('追忆')
    expect(playerOf(game, 'p1').alive, '发问时她已经阵亡').toBe(false)

    const restored = roundTrip(game)
    expect(restored.state.pendingRequests[0]?.id, '发给死人的请求原样回来').toBe(zhuiyi.id)
    // 不变量必须接受它：这是声明过的例外，不是漏网请求
    assertGameInvariants(restored.state)
    const victim = playerOf(restored, 'p2')
    victim.hp = victim.maxHp - 1
    const handBefore = victim.zones.hand.length
    restored.respond({ requestId: zhuiyi.id, playerId: 'p1', payload: { targetIds: ['p2'] } })
    drain(restored)
    expect(victim.hp, '重连之后接着回复 1 点').toBe(victim.maxHp)
    expect(victim.zones.hand.length, '然后摸两张').toBe(handBefore + 2)
    assertCardConservation(restored.state)
  })

  it('自守跳掉的阶段位和宗室的动态上限都过得去存盘', () => {
    const game = gameAt('b3-persist-liubiao', ['zhangfei', 'liubiao', 'caocao', 'sunquan', 'shenzhaoyun'])
    const owner = playerOf(game, 'p1')
    owner.hp = 2
    game.state.currentPlayerId = 'p1'
    game.state.skippedPhases.push('play')
    const expected = livingKingdomCount(game.state)
    const maxCards = maxCardsOf(game.state, 'p1')

    const restored = roundTrip(game)
    expect(restored.state.skippedPhases, '跳过标记还在，不会重复跳也不会漏跳').toContain('play')
    expect(livingKingdomCount(restored.state), '势力数一致').toBe(expected)
    expect(maxCardsOf(restored.state, 'p1'), '手牌上限跟着回来').toBe(maxCards)

    // 重连之后势力数变化，上限仍然实时跟着变
    playerOf(restored, 'p4').alive = false
    playerOf(restored, 'p4').identityRevealed = true
    expect(maxCardsOf(restored.state, 'p1'), '仍然是现算的，不是存下来的定值').toBe(maxCards - 1)
  })

  it('耀武发给伤害来源的请求过得去存盘', () => {
    const game = gameAt('b3-persist-yaowu', ['zhangfei', 'huaxiong', 'guanyu', 'zhaoyun', 'huangzhong'])
    /*
     * 走**真实出牌**而不是直接调 `game.damage`：后者只跑伤害管线，
     * 不会把技能队列排空，请求根本不会挂出来。
     */
    const slash = Object.values(game.state.cards).find((card) => card.name === '杀' && !card.virtual
      && card.color === 'red' && (card.damageNature ?? 'normal') === 'normal'
      && game.state.zones.drawPile.includes(card.id))!
    moveCard(game.state, slash.id, { kind: 'drawPile' }, { kind: 'hand', playerId: 'p2' })
    playerOf(game, 'p2').attackRangeBonus = 6
    game.state.currentPlayerId = 'p2'
    game.state.phase = 'play'
    const action = game.legalActions('p2').find((candidate) => candidate.kind === 'use-card'
      && candidate.cardIds.includes(slash.id) && candidate.targetIds.includes('p1'))!
    game.act('p2', action.id)
    // 华雄不闪，让伤害真的落地
    for (let guard = 0; guard < 10; guard += 1) {
      const pending = game.state.pendingRequests[0] as AnyRequest | undefined
      if (!pending || pending.prompt?.includes('耀武')) break
      game.respond({ requestId: pending.id, playerId: pending.playerId, payload: minimalPayload(pending) })
    }
    const request = game.state.pendingRequests[0] as AnyRequest
    expect(request?.playerId, '请求发给伤害来源').toBe('p2')
    expect(request.prompt).toContain('耀武')

    const restored = roundTrip(game)
    expect(restored.state.pendingRequests[0]?.id, '还是同一个请求').toBe(request.id)
    expect(restored.state.pendingRequests[0]?.playerId, '仍然属于来源').toBe('p2')
    const source = playerOf(restored, 'p2')
    source.hp = source.maxHp - 1
    restored.respond({ requestId: request.id, playerId: 'p2', payload: { optionId: 'yaowu-recover' } })
    drain(restored)
    expect(source.hp, '重连之后接着回复，不会重复也不会丢').toBe(source.maxHp)
    assertCardConservation(restored.state)
    assertGameInvariants(restored.state)
  })
})
