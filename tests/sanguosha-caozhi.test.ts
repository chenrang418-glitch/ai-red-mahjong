import { describe, expect, it } from 'vitest'
import { SanguoshaGame } from '@/sanguosha/engine/game'
import { assertCardConservation, moveCard, type ZoneRef } from '@/sanguosha/engine/zones'
import { assertGameInvariants } from '@/sanguosha/engine/invariants'
import { resolveDamage } from '@/sanguosha/engine/damage'
import { discardEntryOf } from '@/sanguosha/engine/discard-provenance'
import type { GameSetup, Identity, PlayerId, SanguoshaState } from '@/sanguosha/engine/types'

/**
 * 曹植（一将成名 2011）。
 *
 * 四条主张，逐条有断言：
 *
 * - 【落英】看的是「**怎么进的**弃牌堆」，不是弃牌堆里有什么；
 * - 自己的牌不算，别人的判定牌算，被改判换下来的那张也算；
 * - 结算前重新验一遍牌还在不在，绝不凭空复制；
 * - 【酒诗】的代价是翻面，和真酒共用同一套酒的账；翻回正面只在
 *   **真的受到过伤害**之后给一次机会。
 */

const CAST = ['caozhi', 'zhangfei', 'guanyu', 'zhaoyun', 'huangzhong']

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

function gameAt(seed: string, characterIds: string[] = CAST): SanguoshaGame {
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
  while (game.state.phase !== 'play') game.advancePhase()
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

/** 从牌堆或弃牌堆里拿一张闲置的、指定花色（可再指定牌名）的牌给某人。 */
function giveSuit(game: SanguoshaGame, playerId: string, suit: string, cardName?: string): string {
  const card = Object.values(game.state.cards).find((candidate) => candidate.suit === suit
    && !candidate.virtual
    && (cardName === undefined || candidate.name === cardName)
    && (game.state.zones.drawPile.includes(candidate.id) || game.state.zones.discardPile.includes(candidate.id)))
  if (!card) throw new Error(`牌堆里没有闲置的 ${suit} ${cardName ?? ''}`)
  moveCard(game.state, card.id, locate(game.state, card.id), { kind: 'hand', playerId })
  return card.id
}

function trimHand(game: SanguoshaGame, playerId: string, count: number): void {
  const player = playerOf(game, playerId)
  for (const cardId of player.zones.hand.slice(count)) {
    moveCard(game.state, cardId, { kind: 'hand', playerId }, { kind: 'discardPile' })
  }
}

/** 某人弃掉一张手牌（走引擎的弃牌语义：移动 + LoseCard）。 */
function discardFromHand(game: SanguoshaGame, playerId: string, cardId: string): void {
  moveCard(game.state, cardId, { kind: 'hand', playerId }, { kind: 'discardPile' })
  game.dispatch('LoseCard', { playerId, cardIds: [cardId], reason: 'test-discard' }, { sourceId: playerId, cardIds: [cardId] })
  game.settle()
}

/** 落英问到了就全拿。返回这次实际拿到的牌。 */
function takeLuoying(game: SanguoshaGame): string[] {
  const taken: string[] = []
  settle(game, (request) => {
    if (request.kind === 'choose-cards' && request.prompt?.includes('落英')) {
      const cardIds = (request as unknown as { cardIds: string[] }).cardIds
      taken.push(...cardIds)
      return { cardIds }
    }
    return null
  })
  return taken
}

describe('公共机制：弃牌来源', () => {
  it('分得清「被弃置」「判定用完」和「用过的牌」', () => {
    const game = gameAt('cz-provenance')
    const club = giveSuit(game, 'p1', 'club')
    discardFromHand(game, 'p1', club)
    expect(discardEntryOf(game.state, club)?.reason, '手牌弃置').toBe('discard')
    expect(discardEntryOf(game.state, club)?.ownerId, '记得它原来是谁的').toBe('p1')

    /*
     * 用过的牌结算完同样躺在弃牌堆里，但它不是「被弃置」的。
     * 只看弃牌堆的话这两种根本分不开。
     */
    const slash = giveSuit(game, 'p1', 'club', '杀')
    moveCard(game.state, slash, { kind: 'hand', playerId: 'p1' }, { kind: 'processingArea' })
    moveCard(game.state, slash, { kind: 'processingArea' }, { kind: 'discardPile' })
    expect(discardEntryOf(game.state, slash)?.reason, '用过的牌不算弃置').toBe('other')
  })

  it('牌离开弃牌堆之后记录也清掉，不会顶着旧原因回来', () => {
    const game = gameAt('cz-provenance-clear')
    const club = giveSuit(game, 'p1', 'club')
    discardFromHand(game, 'p1', club)
    expect(discardEntryOf(game.state, club)).not.toBeNull()
    moveCard(game.state, club, { kind: 'discardPile' }, { kind: 'hand', playerId: 'p2' })
    expect(discardEntryOf(game.state, club), '离开弃牌堆就清掉').toBeNull()
  })
})

describe('曹植：落英', () => {
  it('其他角色弃置的梅花牌可以获得，真实从弃牌堆移到手里', () => {
    const game = gameAt('cz-luoying-discard')
    trimHand(game, 'p0', 0)
    const club = giveSuit(game, 'p1', 'club')
    discardFromHand(game, 'p1', club)
    const taken = takeLuoying(game)

    expect(taken, '问到了这张梅花').toContain(club)
    expect(playerOf(game, 'p0').zones.hand, '真的进了手里').toContain(club)
    expect(game.state.zones.discardPile, '不在弃牌堆里了').not.toContain(club)
    assertCardConservation(game.state)
  })

  it('自己弃置的梅花不触发', () => {
    const game = gameAt('cz-luoying-self')
    const club = giveSuit(game, 'p0', 'club')
    discardFromHand(game, 'p0', club)
    let asked = false
    settle(game, (request) => {
      if (request.prompt?.includes('落英')) asked = true
      return null
    })
    expect(asked, '自己的牌不算「其他角色的牌」').toBe(false)
  })

  it('别的花色不触发', () => {
    const game = gameAt('cz-luoying-suit')
    const heart = giveSuit(game, 'p1', 'heart')
    discardFromHand(game, 'p1', heart)
    let asked = false
    settle(game, (request) => {
      if (request.prompt?.includes('落英')) asked = true
      return null
    })
    expect(asked, '只认梅花').toBe(false)
  })

  it('一次弃多张时，每一张合法的都能拿', () => {
    const game = gameAt('cz-luoying-multi')
    trimHand(game, 'p0', 0)
    trimHand(game, 'p1', 0)
    const first = giveSuit(game, 'p1', 'club')
    const second = giveSuit(game, 'p1', 'club')
    const heart = giveSuit(game, 'p1', 'heart')
    const cards = [first, second, heart]
    for (const cardId of cards) moveCard(game.state, cardId, { kind: 'hand', playerId: 'p1' }, { kind: 'discardPile' })
    game.dispatch('LoseCard', { playerId: 'p1', cardIds: cards, reason: 'test-discard' }, { sourceId: 'p1', cardIds: cards })
    game.settle()

    const taken = takeLuoying(game)
    expect(taken.sort(), '两张梅花都在候选里，红桃不在').toEqual([first, second].sort())
    expect(playerOf(game, 'p0').zones.hand.sort()).toEqual([first, second].sort())
  })

  it('牌已经被别的效果拿走了就不能再获得，绝不复制', () => {
    const game = gameAt('cz-luoying-stolen')
    trimHand(game, 'p0', 0)
    const club = giveSuit(game, 'p1', 'club')
    discardFromHand(game, 'p1', club)

    settle(game, (request) => {
      if (request.kind === 'choose-cards' && request.prompt?.includes('落英')) {
        // 就在他回答之前，别的效果把这张牌抢走了
        moveCard(game.state, club, { kind: 'discardPile' }, { kind: 'hand', playerId: 'p2' })
        return { cardIds: [club] }
      }
      return null
    })
    expect(playerOf(game, 'p2').zones.hand, '还在抢走它的人手里').toContain(club)
    expect(playerOf(game, 'p0').zones.hand, '曹植没有拿到').not.toContain(club)
    assertCardConservation(game.state)
  })

  it('别人的判定牌进弃牌堆同样触发；被改判换下来的那张也算', () => {
    const game = gameAt('cz-luoying-judge')
    trimHand(game, 'p0', 0)
    /*
     * 直接构造一次判定：把一张梅花放到牌堆顶，让 p1 判定。
     * 判定牌是从牌堆顶翻的，没有归属——按「其他角色的牌」处理。
     */
    const club = Object.values(game.state.cards).find((card) => card.suit === 'club'
      && !card.virtual
      && game.state.zones.drawPile.includes(card.id))!
    const pile = game.state.zones.drawPile
    pile.splice(pile.indexOf(club.id), 1)
    pile.unshift(club.id)

    game.dispatch('JudgeStart', { playerId: 'p1', reason: 'test' }, { targetId: 'p1' })
    moveCard(game.state, club.id, { kind: 'drawPile' }, { kind: 'processingArea' })
    game.dispatch('JudgeEnd', { playerId: 'p1', reason: 'test', judgeCardId: club.id }, { targetId: 'p1', cardIds: [club.id] })
    moveCard(game.state, club.id, { kind: 'processingArea' }, { kind: 'discardPile' }, { discardReason: 'judgment' })
    game.settle()

    const taken = takeLuoying(game)
    expect(taken, '判定牌也能落英').toContain(club.id)
    expect(playerOf(game, 'p0').zones.hand).toContain(club.id)
  })
})

describe('曹植：酒诗', () => {
  it('正面朝上时可以翻面视为使用一张【酒】，和真酒共用本回合限一次', () => {
    const game = gameAt('cz-jiushi-use')
    const owner = playerOf(game, 'p0')
    expect(owner.faceDown, '一开始正面朝上').toBe(false)

    const action = game.legalActions('p0').find((candidate) => candidate.kind === 'invoke-skill' && candidate.skillId === 'jiushi')
    expect(action, '出牌阶段点得到').toBeTruthy()
    game.act('p0', action!.id)
    settle(game)

    expect(playerOf(game, 'p0').faceDown, '代价是翻面，不是弃牌').toBe(true)
    expect(game.state.turnUsage.wineUses, '记进同一套酒的账').toBe(1)
    expect(game.state.turnUsage.wineDamageBonus, '下一张【杀】加伤').toBe(1)
    // 没有凭空多出一张实体酒
    expect(Object.values(game.state.cards).filter((card) => card.name === '酒' && card.virtual), '虚拟酒用完即销毁').toHaveLength(0)
    assertCardConservation(game.state)

    // 背面朝上就付不起代价了
    expect(
      game.legalActions('p0').some((candidate) => candidate.kind === 'invoke-skill' && candidate.skillId === 'jiushi'),
      '已经背面朝上，不能再发动',
    ).toBe(false)
  })

  it('濒死时可以靠酒诗自救', () => {
    const game = gameAt('cz-jiushi-dying')
    const owner = playerOf(game, 'p0')
    owner.hp = 1
    trimHand(game, 'p0', 0)

    resolveDamage(game as never, { sourceId: 'p1', targetId: 'p0', amount: 1 })
    game.settle()
    const request = game.state.pendingRequests[0] as unknown as { kind: string; playerId: string; actionIds: string[] }
    expect(request.kind, '进了濒死求救').toBe('rescue')
    expect(request.playerId).toBe('p0')
    expect(request.actionIds, '酒诗作为一条真实动作出现').toContain('rescue-jiushi')

    settle(game, (candidate) => (candidate.kind === 'rescue' ? { actionId: 'rescue-jiushi' } : null))
    expect(playerOf(game, 'p0').alive, '救回来了').toBe(true)
    expect(playerOf(game, 'p0').hp).toBe(1)
    expect(playerOf(game, 'p0').faceDown, '代价照付').toBe(true)
    assertCardConservation(game.state)
  })

  it('受到伤害结算结束后可以翻回正面，一次多点伤害只给一次机会', () => {
    const game = gameAt('cz-jiushi-restore')
    const owner = playerOf(game, 'p0')
    owner.hp = owner.maxHp
    owner.faceDown = true

    let asks = 0
    resolveDamage(game as never, { sourceId: 'p1', targetId: 'p0', amount: 3 })
    game.settle()
    settle(game, (request) => {
      if (request.kind === 'choose-option' && request.prompt?.includes('酒诗')) {
        asks += 1
        return { optionId: 'flip' }
      }
      return null
    })
    expect(asks, '3 点伤害只问一次').toBe(1)
    expect(playerOf(game, 'p0').faceDown, '翻回正面了').toBe(false)
    assertGameInvariants(game.state)
  })

  it('伤害被完全防止就没有这一次翻回机会', () => {
    const game = gameAt('cz-jiushi-prevented')
    const owner = playerOf(game, 'p0')
    owner.hp = owner.maxHp
    owner.faceDown = true
    // 大雾：防止非雷电伤害
    game.state.targetStates = [{
      name: 'dawu', ownerId: 'p0', expiry: 'source-next-turn-start', appliedTurn: game.state.turnNumber, sourceId: 'p1',
    }]

    let asked = false
    resolveDamage(game as never, { sourceId: 'p1', targetId: 'p0', amount: 1 })
    game.settle()
    settle(game, (request) => {
      if (request.prompt?.includes('酒诗')) asked = true
      return null
    })
    expect(playerOf(game, 'p0').hp, '伤害被挡住了').toBe(owner.maxHp)
    expect(asked, '没有真的受到伤害，就没有翻回机会').toBe(false)
    expect(playerOf(game, 'p0').faceDown, '仍然背面朝上').toBe(true)
  })
})
