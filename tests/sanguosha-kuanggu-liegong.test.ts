import { describe, expect, it } from 'vitest'
import { SanguoshaGame } from '@/sanguosha/engine/game'
import { assertCardConservation, moveCard, type ZoneRef } from '@/sanguosha/engine/zones'
import { assertGameInvariants } from '@/sanguosha/engine/invariants'
import { getDistance } from '@/sanguosha/engine/distance'
import { getSkillRuntime } from '@/sanguosha/engine/skills/runtime'
import type { GameSetup, Identity, PlayerId, SanguoshaState } from '@/sanguosha/engine/types'

/**
 * 魏延【狂骨】和黄忠【烈弓】。
 *
 * 这两个锁定技在此之前**一次都没有被测试碰过**（全仓库 grep 为 0）。
 * 两个都是规则敏感的：一个改回血、一个改「能不能闪」，
 * 静默坏掉了不会有任何提示。
 *
 * 每条「不触发」的断言旁边都配一条「触发」的反证——
 * 否则那条断言可能只是因为局面根本没走到。
 */

interface AnyRequest { id: string; playerId: PlayerId; kind: string; prompt?: string }

function defaultResponse(request: AnyRequest) {
  const pick = request as unknown as {
    cardIds?: string[]; hiddenCardSlots?: string[]; candidateIds?: string[]
    options?: { id: string }[]; min?: number
  }
  const payload: Record<string, unknown> = request.kind === 'choose-cards'
    ? { cardIds: [...(pick.cardIds ?? []), ...(pick.hiddenCardSlots ?? [])].slice(0, pick.min ?? 0) }
    : request.kind === 'choose-targets'
      ? { targetIds: (pick.candidateIds ?? []).slice(0, pick.min ?? 0) }
      : request.kind === 'choose-option'
        ? { optionId: pick.options![pick.options!.length - 1].id }
        : request.kind === 'arrange-cards'
          ? { top: [...(pick.cardIds ?? [])], bottom: [] }
          : request.kind === 'distribute-cards'
            ? { assignments: [] }
            : request.kind === 'rescue' ? { actionId: 'rescue-pass' } : { actionId: 'respond-pass' }
  return { requestId: request.id, playerId: request.playerId, payload }
}

function settle(
  game: SanguoshaGame,
  choose: (request: AnyRequest) => Record<string, unknown> | null = () => null,
): void {
  for (let guard = 0; guard < 400; guard += 1) {
    const request = game.state.pendingRequests[0] as AnyRequest | undefined
    if (!request) return
    const custom = choose(request)
    game.respond(custom
      ? { requestId: request.id, playerId: request.playerId, payload: custom }
      : defaultResponse(request))
  }
  throw new Error('结算没有收敛')
}

function gameAt(seed: string, characterIds: string[], playerCount = 5): SanguoshaGame {
  const setup: GameSetup = {
    mode: 'identity', generalChoices: 1,
    players: Array.from({ length: playerCount }, (_, index) => ({ id: `p${index}`, nickname: `玩家${index}`, isHuman: index === 0 })),
  }
  const game = new SanguoshaGame({ seed, setup })
  const identities: Identity[] = ['lord', 'rebel', 'loyalist', 'rebel', 'renegade', 'rebel', 'loyalist']
  game.state.players.forEach((player, index) => {
    player.identity = identities[index]
    player.identityRevealed = player.identity === 'lord'
    player.characterId = characterIds[index]
  })
  game.state.currentPlayerId = 'p0'
  game.start()
  settle(game)
  return game
}

function playerOf(game: SanguoshaGame, id: string) {
  return game.state.players.find((candidate) => candidate.id === id)!
}

function locate(state: SanguoshaState, cardId: string): ZoneRef {
  if (state.zones.drawPile.includes(cardId)) return { kind: 'drawPile' }
  if (state.zones.discardPile.includes(cardId)) return { kind: 'discardPile' }
  if (state.zones.processingArea.includes(cardId)) return { kind: 'processingArea' }
  for (const owner of state.players) {
    if (owner.zones.hand.includes(cardId)) return { kind: 'hand', playerId: owner.id }
    if (owner.zones.judgingArea.includes(cardId)) return { kind: 'judgingArea', playerId: owner.id }
    for (const [slot, equipped] of Object.entries(owner.zones.equipment)) {
      if (equipped === cardId) return { kind: 'equipment', playerId: owner.id, slot: slot as never }
    }
  }
  throw new Error('找不到卡牌：' + cardId)
}

function findCard(game: SanguoshaGame, match: (card: Record<string, unknown>) => boolean): string {
  const card = Object.values(game.state.cards).find((candidate) => !candidate.virtual
    && match(candidate as unknown as Record<string, unknown>)
    && (game.state.zones.drawPile.includes(candidate.id) || game.state.zones.discardPile.includes(candidate.id)))
  if (!card) throw new Error('牌堆里找不到符合条件的牌')
  return card.id
}

function setHandCount(game: SanguoshaGame, playerId: string, count: number): void {
  const owner = playerOf(game, playerId)
  for (const cardId of [...owner.zones.hand]) {
    moveCard(game.state, cardId, { kind: 'hand', playerId }, { kind: 'discardPile' })
  }
  for (let index = 0; index < count; index += 1) {
    moveCard(game.state, game.state.zones.drawPile[0], { kind: 'drawPile' }, { kind: 'hand', playerId })
  }
}

// ─────────────────────────────── 狂骨 ───────────────────────────────

describe('魏延【狂骨】', () => {
  const CAST = ['weiyan', 'zhangfei', 'zhaoyun', 'huangzhong', 'guojia']

  /** 让魏延对 targetId 造成 amount 点伤害，返回他回了几点。 */
  function dealDamage(game: SanguoshaGame, targetId: string, amount: number, nature: 'normal' | 'fire' = 'normal'): number {
    const before = playerOf(game, 'p0').hp
    game.damage({ sourceId: 'p0', targetId, amount, nature, cardId: null, cardName: null })
    settle(game)
    return playerOf(game, 'p0').hp - before
  }

  it('对距离 1 以内的角色造成伤害后，回复等同点数的体力', () => {
    const game = gameAt('kuanggu-basic', CAST)
    const owner = playerOf(game, 'p0')
    owner.hp = 1
    expect(getDistance(game.state, 'p0', 'p1'), '前提：p1 距离是 1').toBe(1)
    expect(dealDamage(game, 'p1', 1), '1 点伤害回 1 点').toBe(1)
    expect(owner.hp).toBe(2)
  })

  it('伤害点数 = 回复点数，不是固定 1 点', () => {
    const game = gameAt('kuanggu-amount', CAST)
    const owner = playerOf(game, 'p0')
    owner.hp = 1
    expect(dealDamage(game, 'p1', 2), '2 点伤害回 2 点').toBe(2)
  })

  it('距离 2 不触发（反证：同一局里距离 1 触发）', () => {
    const game = gameAt('kuanggu-distance', CAST, 7)
    const owner = playerOf(game, 'p0')
    owner.hp = 1
    const far = game.state.players.find((player) => player.id !== 'p0'
      && getDistance(game.state, 'p0', player.id) >= 2)!
    expect(getDistance(game.state, 'p0', far.id), '前提：确实够远').toBeGreaterThan(1)

    expect(dealDamage(game, far.id, 1), '距离 2 以上不回血').toBe(0)
    expect(dealDamage(game, 'p1', 1), '反证：同一局里距离 1 照样回血').toBe(1)
  })

  it('满血时不回血，但也不出错', () => {
    const game = gameAt('kuanggu-full', CAST)
    const owner = playerOf(game, 'p0')
    owner.hp = owner.maxHp
    expect(dealDamage(game, 'p1', 1), '满血回不了').toBe(0)
    assertGameInvariants(game.state)
  })

  it('对自己造成伤害不触发', () => {
    const game = gameAt('kuanggu-self', CAST)
    const owner = playerOf(game, 'p0')
    owner.hp = 3
    const before = owner.hp
    game.damage({ sourceId: 'p0', targetId: 'p0', amount: 1, nature: 'normal', cardId: null, cardName: null })
    settle(game)
    expect(owner.hp, '只掉了那 1 点，没有回来').toBe(before - 1)
  })

  it('失去体力不是伤害：不触发', () => {
    const game = gameAt('kuanggu-losehp', CAST)
    const owner = playerOf(game, 'p0')
    owner.hp = 1
    const victim = playerOf(game, 'p1')
    const victimBefore = victim.hp
    victim.hp -= 1
    game.dispatch('LoseHp', { playerId: 'p1', amount: 1, reason: 'audit' }, { targetId: 'p1' })
    settle(game)
    expect(victim.hp, '目标确实少了 1 点').toBe(victimBefore - 1)
    expect(owner.hp, '魏延没有因此回血').toBe(1)
  })

  it('魏延自己在这一下之后阵亡就不回血', () => {
    const game = gameAt('kuanggu-dead', CAST)
    const owner = playerOf(game, 'p0')
    owner.hp = 1
    owner.alive = false
    owner.identityRevealed = true
    game.damage({ sourceId: 'p0', targetId: 'p1', amount: 1, nature: 'normal', cardId: null, cardName: null })
    settle(game)
    expect(owner.hp, '死人不回血').toBe(1)
  })
})

// ─────────────────────────────── 烈弓 ───────────────────────────────

describe('黄忠【烈弓】', () => {
  const CAST = ['huangzhong', 'zhangfei', 'zhaoyun', 'guanyu', 'guojia']

  /**
   * 边界表直接问技能运行时。
   *
   * `slashUndodgeable` 没有导出的聚合入口（`basic.ts` 里内联消费），
   * 所以这里问的是判据本身；**接线**由下面那两条真的打一刀的用例兜底，
   * 两者合起来才算完整。
   */
  function undodgeable(game: SanguoshaGame, targetId: string): boolean {
    return getSkillRuntime('liegong')!.slashUndodgeable!(game.state, 'p0', targetId)
  }

  it('目标手牌数 ≤ 黄忠体力值：不可被【闪】响应', () => {
    const game = gameAt('liegong-low', CAST)
    const owner = playerOf(game, 'p0')
    owner.hp = 4
    owner.maxHp = 4
    setHandCount(game, 'p1', 4)
    expect(undodgeable(game, 'p1'), '4 ≤ 4 成立').toBe(true)
    setHandCount(game, 'p1', 3)
    expect(undodgeable(game, 'p1'), '3 ≤ 4 也成立').toBe(true)
  })

  it('目标手牌数 ≥ 黄忠体力上限：同样不可被【闪】响应', () => {
    const game = gameAt('liegong-high', CAST)
    const owner = playerOf(game, 'p0')
    owner.hp = 2
    owner.maxHp = 4
    setHandCount(game, 'p1', 4)
    expect(undodgeable(game, 'p1'), '4 ≥ 4 成立').toBe(true)
    setHandCount(game, 'p1', 6)
    expect(undodgeable(game, 'p1'), '6 ≥ 4 也成立').toBe(true)
  })

  it('反证：两个条件都不满足时，可以被【闪】响应', () => {
    const game = gameAt('liegong-neither', CAST)
    const owner = playerOf(game, 'p0')
    owner.hp = 2
    owner.maxHp = 4
    // 手牌 3：既不 ≤ 2，也不 ≥ 4
    setHandCount(game, 'p1', 3)
    expect(undodgeable(game, 'p1'), '3 落在 (2, 4) 的开区间里').toBe(false)
  })

  it('判据跟着体力实时变，不是开局定死的', () => {
    const game = gameAt('liegong-dynamic', CAST)
    const owner = playerOf(game, 'p0')
    owner.hp = 2
    owner.maxHp = 4
    setHandCount(game, 'p1', 3)
    expect(undodgeable(game, 'p1')).toBe(false)
    // 黄忠掉一滴血：3 ≥ maxHp 仍不成立，但 3 ≤ hp 也不成立 → 还是能闪
    owner.hp = 3
    expect(undodgeable(game, 'p1'), '体力升到 3，3 ≤ 3 成立了').toBe(true)
  })

  it('真的打一刀：目标手上有【闪】也闪不掉', () => {
    const game = gameAt('liegong-real', CAST)
    const owner = playerOf(game, 'p0')
    owner.hp = 4
    owner.maxHp = 4
    owner.attackRangeBonus = 6
    // 目标只有一张【闪】：1 ≤ 4，烈弓成立
    const dodge = findCard(game, (card) => card.name === '闪')
    setHandCount(game, 'p1', 0)
    moveCard(game.state, dodge, locate(game.state, dodge), { kind: 'hand', playerId: 'p1' })

    const slash = findCard(game, (card) => card.name === '杀')
    moveCard(game.state, slash, locate(game.state, slash), { kind: 'hand', playerId: 'p0' })
    game.state.currentPlayerId = 'p0'
    game.state.phase = 'play'
    const hpBefore = playerOf(game, 'p1').hp

    const action = game.legalActions('p0').find((candidate) => candidate.kind === 'use-card'
      && candidate.cardIds.includes(slash) && candidate.targetIds.includes('p1'))!
    game.act('p0', action.id)
    let askedForDodge = false
    settle(game, (request) => {
      if (request.playerId === 'p1' && request.kind === 'respond-card') askedForDodge = true
      return null
    })

    expect(askedForDodge, '根本没问他要【闪】').toBe(false)
    expect(playerOf(game, 'p1').hp, '伤害照常落地').toBe(hpBefore - 1)
    expect(playerOf(game, 'p1').zones.hand, '那张【闪】还在他手上').toContain(dodge)
    assertCardConservation(game.state)
    assertGameInvariants(game.state)
  })

  it('反证：条件不成立时照常问【闪】，而且闪得掉', () => {
    const game = gameAt('liegong-real-control', CAST)
    const owner = playerOf(game, 'p0')
    owner.hp = 2
    owner.maxHp = 4
    owner.attackRangeBonus = 6
    // 目标手牌 3 张（含一张【闪】）：既不 ≤ 2 也不 ≥ 4
    setHandCount(game, 'p1', 2)
    const dodge = findCard(game, (card) => card.name === '闪')
    moveCard(game.state, dodge, locate(game.state, dodge), { kind: 'hand', playerId: 'p1' })
    expect(playerOf(game, 'p1').zones.hand.length, '前提：手牌正好 3 张').toBe(3)

    const slash = findCard(game, (card) => card.name === '杀')
    moveCard(game.state, slash, locate(game.state, slash), { kind: 'hand', playerId: 'p0' })
    game.state.currentPlayerId = 'p0'
    game.state.phase = 'play'
    const hpBefore = playerOf(game, 'p1').hp

    const action = game.legalActions('p0').find((candidate) => candidate.kind === 'use-card'
      && candidate.cardIds.includes(slash) && candidate.targetIds.includes('p1'))!
    game.act('p0', action.id)
    let askedForDodge = false
    settle(game, (request) => {
      if (request.playerId === 'p1' && request.kind === 'respond-card') {
        askedForDodge = true
        return { actionId: `respond-dodge:${dodge}` }
      }
      return null
    })

    expect(askedForDodge, '问了他要【闪】').toBe(true)
    expect(playerOf(game, 'p1').hp, '闪掉了，没掉血').toBe(hpBefore)
    assertCardConservation(game.state)
  })
})
