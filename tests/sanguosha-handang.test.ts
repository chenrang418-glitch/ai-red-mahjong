import { describe, expect, it } from 'vitest'
import { SanguoshaGame } from '@/sanguosha/engine/game'
import { assertCardConservation, moveCard, type ZoneRef } from '@/sanguosha/engine/zones'
import { assertGameInvariants } from '@/sanguosha/engine/invariants'
import { slashRules } from '@/sanguosha/engine/slash-rules'
import { declinedThisPhase, usedThisPhase } from '@/sanguosha/engine/phase-usage'
import { weaponCardsOf } from '@/sanguosha/engine/equipment-slots'
import type { GameSetup, Identity, PlayerId, SanguoshaState } from '@/sanguosha/engine/types'

/**
 * 韩当（一将成名 2012）。
 *
 * 逐条有断言的主张：
 *
 * - 【弓骑】的代价是手牌**或**装备区的一张牌，判定区不算；
 * - 取消不消耗「出牌阶段限一次」，弃了牌才算用掉；
 * - 弃普通牌只给「无距离限制」，弃**装备牌**再多一张【杀】；
 * - 「是不是装备牌」看牌的**类别**，从手里弃的装备牌同样算数；
 * - 修正到本回合结束为止，走公共的回合级【杀】规则；
 * - 【解烦】是限定技，一局一次；
 * - 没有武器的人只拿到「令韩当摸一张牌」这一个选项；
 * - 选弃武器的人真的弃掉武器，选让摸的人让韩当摸一张。
 */

const CAST = ['zhangfei', 'handang', 'zhaoyun', 'huangzhong', 'guojia']
const HANDANG_ID = 'p1'

interface AnyRequest { id: string; playerId: PlayerId; kind: string; prompt?: string }

function defaultResponse(request: AnyRequest) {
  const payload: Record<string, unknown> = (() => {
    switch (request.kind) {
      case 'choose-option': {
        const options = (request as unknown as { options: { id: string }[] }).options
        return { optionId: options[options.length - 1].id }
      }
      case 'choose-options': {
        const pick = request as unknown as { options: { id: string }[]; min: number }
        return { optionIds: pick.options.slice(0, pick.min ?? 0).map((option) => option.id) }
      }
      case 'choose-cards': {
        const pick = request as unknown as { cardIds: string[]; hiddenCardSlots: string[]; min: number }
        return { cardIds: [...pick.cardIds, ...pick.hiddenCardSlots].slice(0, pick.min ?? 0) }
      }
      case 'choose-targets': {
        const pick = request as unknown as { candidateIds: string[]; min: number }
        return { targetIds: pick.candidateIds.slice(0, pick.min ?? 0) }
      }
      case 'arrange-cards': {
        const pick = request as unknown as { cardIds: string[] }
        return { top: [...pick.cardIds], bottom: [] }
      }
      case 'distribute-cards': return { assignments: [] }
      case 'rescue': return { actionId: 'rescue-pass' }
      default: return { actionId: 'respond-pass' }
    }
  })()
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

/** 开局并停在韩当的出牌阶段。 */
function gameAtHandangPlay(seed: string, characterIds: string[] = CAST): SanguoshaGame {
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
  settle(game)
  for (let guard = 0; guard < 20; guard += 1) {
    game.advancePhase()
    settle(game)
    if (game.state.currentPlayerId === HANDANG_ID && game.state.phase === 'play') return game
  }
  throw new Error('没有走到韩当的出牌阶段')
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

function findFree(game: SanguoshaGame, match: (card: Record<string, unknown>) => boolean): string {
  const card = Object.values(game.state.cards).find((candidate) => !candidate.virtual
    && match(candidate as unknown as Record<string, unknown>)
    && (game.state.zones.drawPile.includes(candidate.id) || game.state.zones.discardPile.includes(candidate.id)))
  if (!card) throw new Error('牌堆里找不到符合条件的牌')
  return card.id
}

function setHand(game: SanguoshaGame, playerId: string, cardIds: string[]): void {
  const owner = playerOf(game, playerId)
  for (const cardId of [...owner.zones.hand]) {
    moveCard(game.state, cardId, { kind: 'hand', playerId }, { kind: 'discardPile' })
  }
  for (const cardId of cardIds) {
    moveCard(game.state, cardId, locate(game.state, cardId), { kind: 'hand', playerId })
  }
}

function gongqiAction(game: SanguoshaGame) {
  return game.legalActions(HANDANG_ID).find((action) => action.kind === 'invoke-skill' && action.id === 'gongqi-invoke')
}

function jiefanAction(game: SanguoshaGame) {
  return game.legalActions(HANDANG_ID).find((action) => action.kind === 'invoke-skill' && action.id === 'jiefan-invoke')
}

/** 发动弓骑并弃掉 cardId。返回弃牌请求里给出的候选。 */
function useGongqi(game: SanguoshaGame, cardId: string | null): string[] {
  let candidates: string[] = []
  game.act(HANDANG_ID, gongqiAction(game)!.id)
  settle(game, (request) => {
    if (request.playerId === HANDANG_ID && request.kind === 'choose-cards' && request.prompt?.includes('弓骑')) {
      candidates = [...(request as unknown as { cardIds: string[] }).cardIds]
      return { cardIds: cardId ? [cardId] : [] }
    }
    return null
  })
  return candidates
}

describe('韩当【弓骑】', () => {
  it('代价候选是手牌 + 装备区，判定区不算', () => {
    const game = gameAtHandangPlay('handang-cost-zone')
    const hand = findFree(game, (card) => card.category !== 'equipment')
    setHand(game, HANDANG_ID, [hand])
    const weapon = findFree(game, (card) => card.equipmentSlot === 'weapon')
    moveCard(game.state, weapon, locate(game.state, weapon), { kind: 'equipment', playerId: HANDANG_ID, slot: 'weapon' })
    const delayed = findFree(game, (card) => card.name === '乐不思蜀')
    moveCard(game.state, delayed, locate(game.state, delayed), { kind: 'judgingArea', playerId: HANDANG_ID })

    const candidates = useGongqi(game, hand)
    expect(candidates, '手牌在候选里').toContain(hand)
    expect(candidates, '装备区的牌也在候选里').toContain(weapon)
    expect(candidates, '判定区的牌不在候选里').not.toContain(delayed)
  })

  it('弃普通牌：本回合【杀】无距离限制，但不多一张', () => {
    const game = gameAtHandangPlay('handang-plain-cost')
    const hand = findFree(game, (card) => card.category !== 'equipment')
    setHand(game, HANDANG_ID, [hand])
    expect(slashRules(game.state, HANDANG_ID).ignoreDistance, '发动前没有豁免').toBe(false)

    useGongqi(game, hand)
    const rules = slashRules(game.state, HANDANG_ID)
    expect(rules.ignoreDistance, '本回合【杀】无距离限制').toBe(true)
    expect(rules.extraUses, '弃的不是装备牌，不多一张').toBe(0)
    expect(game.state.zones.discardPile, '代价牌进弃牌堆').toContain(hand)
    assertCardConservation(game.state)
    assertGameInvariants(game.state)
  })

  it('弃装备区的装备牌：额外多一张【杀】', () => {
    const game = gameAtHandangPlay('handang-equip-cost')
    setHand(game, HANDANG_ID, [])
    const weapon = findFree(game, (card) => card.equipmentSlot === 'weapon')
    moveCard(game.state, weapon, locate(game.state, weapon), { kind: 'equipment', playerId: HANDANG_ID, slot: 'weapon' })

    useGongqi(game, weapon)
    const rules = slashRules(game.state, HANDANG_ID)
    expect(rules.ignoreDistance).toBe(true)
    expect(rules.extraUses, '弃装备牌多一张【杀】').toBe(1)
    expect(weaponCardsOf(game.state, HANDANG_ID), '武器真的离场了').toHaveLength(0)
    assertCardConservation(game.state)
  })

  it('从**手里**弃一张装备牌同样多一张【杀】：看的是牌的类别', () => {
    const game = gameAtHandangPlay('handang-equip-in-hand')
    const equipInHand = findFree(game, (card) => card.category === 'equipment')
    setHand(game, HANDANG_ID, [equipInHand])

    useGongqi(game, equipInHand)
    expect(slashRules(game.state, HANDANG_ID).extraUses, '手里的装备牌也算装备牌').toBe(1)
  })

  it('取消不付任何代价，但本阶段不再重复弹出（活锁护栏）', () => {
    const game = gameAtHandangPlay('handang-once')
    const first = findFree(game, (card) => card.category !== 'equipment')
    const second = findFree(game, (card) => card.category !== 'equipment' && card.id !== first)
    setHand(game, HANDANG_ID, [first, second])

    // 取消：交空数组
    useGongqi(game, null)
    expect(playerOf(game, HANDANG_ID).zones.hand, '没有付出任何代价').toHaveLength(2)
    expect(slashRules(game.state, HANDANG_ID).ignoreDistance, '也没有拿到修正').toBe(false)
    expect(usedThisPhase(game.state, HANDANG_ID, 'gongqi'), '「出牌阶段限一次」没有被消耗').toBe(false)
    /*
     * 但这条动作在**这个出牌阶段实例**里不再报出来。
     *
     * 取消之后场面一点没变，再报出来就会被反复点开——压测里这会直接
     * 把牌局跑成无限循环。护栏记在 `phase-usage` 的放弃账上，
     * 下一个出牌阶段实例重新开始。
     */
    expect(declinedThisPhase(game.state, HANDANG_ID, 'gongqi'), '留下了放弃记号').toBe(true)
    expect(gongqiAction(game), '同一个阶段里不再重复弹出').toBeUndefined()
  })

  it('真的弃过牌之后本阶段不能再发动', () => {
    const game = gameAtHandangPlay('handang-once-used')
    const first = findFree(game, (card) => card.category !== 'equipment')
    const second = findFree(game, (card) => card.category !== 'equipment' && card.id !== first)
    setHand(game, HANDANG_ID, [first, second])
    useGongqi(game, first)
    expect(usedThisPhase(game.state, HANDANG_ID, 'gongqi'), '这一次真的用掉了').toBe(true)
    expect(gongqiAction(game)).toBeUndefined()
  })

  it('修正到本回合结束为止', () => {
    const game = gameAtHandangPlay('handang-turn-scope')
    const equipInHand = findFree(game, (card) => card.category === 'equipment')
    setHand(game, HANDANG_ID, [equipInHand])
    useGongqi(game, equipInHand)
    expect(slashRules(game.state, HANDANG_ID).ignoreDistance).toBe(true)

    for (let guard = 0; guard < 12; guard += 1) {
      game.advancePhase()
      settle(game)
      if (game.state.currentPlayerId !== HANDANG_ID) break
    }
    expect(game.state.currentPlayerId, '已经进入下一个人的回合').not.toBe(HANDANG_ID)
    const rules = slashRules(game.state, HANDANG_ID)
    expect(rules.ignoreDistance, '距离豁免随回合结束到期').toBe(false)
    expect(rules.extraUses, '额外次数也到期').toBe(0)
    assertGameInvariants(game.state)
  })
})

describe('韩当【解烦】', () => {
  /** 给若干人装上武器，返回 playerId → weaponCardId。 */
  function armEveryone(game: SanguoshaGame, playerIds: string[]): Map<string, string> {
    const armed = new Map<string, string>()
    for (const playerId of playerIds) {
      const weapon = findFree(game, (card) => card.equipmentSlot === 'weapon')
      moveCard(game.state, weapon, locate(game.state, weapon), { kind: 'equipment', playerId, slot: 'weapon' })
      armed.set(playerId, weapon)
    }
    return armed
  }

  it('没有武器的人只拿到「令其摸一张牌」这一个选项', () => {
    const game = gameAtHandangPlay('jiefan-options')
    const armed = armEveryone(game, ['p0'])
    const offered = new Map<string, string[]>()
    game.act(HANDANG_ID, jiefanAction(game)!.id)
    settle(game, (request) => {
      if (request.kind === 'choose-option' && request.prompt?.includes('解烦')) {
        offered.set(request.playerId, (request as unknown as { options: { id: string }[] }).options.map((option) => option.id))
      }
      return null
    })
    expect(armed.size).toBe(1)
    expect(offered.get('p0'), '有武器的人两项都有').toEqual(['discard-weapon', 'let-draw'])
    for (const playerId of ['p2', 'p3', 'p4']) {
      expect(offered.get(playerId), `${playerId} 没有武器，只给让摸这一项`).toEqual(['let-draw'])
    }
  })

  it('选弃武器的真的弃掉，选让摸的让韩当摸一张', () => {
    const game = gameAtHandangPlay('jiefan-resolve')
    const armed = armEveryone(game, ['p0', 'p2', 'p3', 'p4'])
    const handBefore = playerOf(game, HANDANG_ID).zones.hand.length

    game.act(HANDANG_ID, jiefanAction(game)!.id)
    settle(game, (request) => {
      if (request.kind === 'choose-option' && request.prompt?.includes('解烦')) {
        // p0、p2 弃武器；p3、p4 让韩当摸牌
        const discard = request.playerId === 'p0' || request.playerId === 'p2'
        return { optionId: discard ? 'discard-weapon' : 'let-draw' }
      }
      return null
    })

    for (const playerId of ['p0', 'p2']) {
      expect(weaponCardsOf(game.state, playerId), `${playerId} 的武器被弃掉`).toHaveLength(0)
      expect(game.state.zones.discardPile, '武器进弃牌堆').toContain(armed.get(playerId))
    }
    for (const playerId of ['p3', 'p4']) {
      expect(weaponCardsOf(game.state, playerId), `${playerId} 保留武器`).toHaveLength(1)
    }
    expect(playerOf(game, HANDANG_ID).zones.hand.length, '两个人选了让摸，韩当摸两张').toBe(handBefore + 2)
    assertCardConservation(game.state)
    assertGameInvariants(game.state)
  })

  it('限定技一局一次', () => {
    const game = gameAtHandangPlay('jiefan-limited')
    expect(jiefanAction(game), '一开始能发动').toBeDefined()
    game.act(HANDANG_ID, jiefanAction(game)!.id)
    settle(game)
    expect(playerOf(game, HANDANG_ID).usedLimitedSkills, '限定技记账').toContain('jiefan')
    expect(jiefanAction(game), '用过之后不能再发动').toBeUndefined()
  })

  it('超时默认是「令其摸一张牌」，不替玩家弃掉武器', () => {
    const game = gameAtHandangPlay('jiefan-timeout-default')
    const armed = armEveryone(game, ['p0'])
    const handBefore = playerOf(game, HANDANG_ID).zones.hand.length
    game.act(HANDANG_ID, jiefanAction(game)!.id)
    // defaultResponse 对 choose-option 取最后一项；有武器的人最后一项正是「令其摸一张牌」
    settle(game)
    expect(weaponCardsOf(game.state, 'p0'), '没有替玩家弃掉武器').toHaveLength(1)
    expect(game.state.zones.discardPile, '武器还在他身上').not.toContain(armed.get('p0'))
    expect(playerOf(game, HANDANG_ID).zones.hand.length, '四个人都让摸').toBe(handBefore + 4)
  })
})
