import { describe, expect, it } from 'vitest'
import { SanguoshaGame } from '@/sanguosha/engine/game'
import { assertCardConservation, moveCard, type ZoneRef } from '@/sanguosha/engine/zones'
import { assertGameInvariants } from '@/sanguosha/engine/invariants'
import { cardPlayable, lockedColorsOf } from '@/sanguosha/engine/card-play-lock'
import { getDistance } from '@/sanguosha/engine/distance'
import type { GameSetup, Identity, PlayerId, SanguoshaState } from '@/sanguosha/engine/types'

/**
 * 马岱（一将成名 2012）。
 *
 * 逐条有断言的主张：
 *
 * - 【马术】让他与其他角色的距离 -1（复用既有运行时，不另写一份）；
 * - 【潜袭】顺序固定：先摸、再弃、最后选目标；
 * - 目标是「距离**恰好**为 1」，不是「不大于 1」；
 * - 弃牌之后重新算距离——弃掉自己的进攻马会当场换一批候选；
 * - 禁的是**手牌**的使用或打出：装备区不受影响，弃置也不受影响；
 * - 转化技的子牌同样被禁；
 * - 无色的牌不产生禁令；
 * - 禁令到这个回合结束为止。
 */

/**
 * **马岱坐 p1，不坐 p0。**
 *
 * 潜袭挂在准备阶段开始上，而第一个回合的准备阶段是在 `game.start()` 里跑的——
 * 起始手牌也在那一刻发。马岱坐 p0 的话，想在他的准备阶段之前布好牌就只能
 * 在 `start()` 之前塞牌，而引擎会拒绝（「起始手牌已经发放」）。
 * 让他坐 p1：p0 先过一个完整回合，中间有的是时间布置，
 * 然后轮到他时准备阶段照真实路径跑。
 */
const CAST = ['zhangfei', 'madai', 'zhaoyun', 'huangzhong', 'guojia']
const MADAI_ID = 'p1'

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

/** 开局并跑完 p0 的准备阶段；此时还没轮到马岱，可以随意布置。 */
function gameBeforePrepare(seed: string, characterIds: string[] = CAST, playerCount = 5): SanguoshaGame {
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

function findFreeCard(game: SanguoshaGame, match: (card: { name: string; color: string; category: string; virtual?: boolean }) => boolean): string {
  const card = Object.values(game.state.cards).find((candidate) => !candidate.virtual
    && match(candidate as never)
    && (game.state.zones.drawPile.includes(candidate.id) || game.state.zones.discardPile.includes(candidate.id)))
  if (!card) throw new Error('牌堆里找不到符合条件的牌')
  return card.id
}

function give(game: SanguoshaGame, playerId: string, cardId: string): string {
  moveCard(game.state, cardId, locate(game.state, cardId), { kind: 'hand', playerId })
  return cardId
}

/**
 * 一路推进到马岱的准备阶段并跑完潜袭。
 *
 * 中途所有别人的问一律走默认答案；只有潜袭那三问按 `options` 回答。
 */
function runQianxi(
  game: SanguoshaGame,
  options: { discard?: string | null; target?: string | null; decline?: boolean } = {},
): { discardCandidates: string[]; targetCandidates: string[]; asked: boolean } {
  const result = { discardCandidates: [] as string[], targetCandidates: [] as string[], asked: false }
  const answer = (request: AnyRequest): Record<string, unknown> | null => {
    if (request.playerId !== MADAI_ID) return null
    if (request.kind === 'choose-option' && request.prompt?.includes('潜袭')) {
      result.asked = true
      return { optionId: options.decline ? 'cancel' : 'qianxi-invoke' }
    }
    if (request.kind === 'choose-cards' && request.prompt?.includes('潜袭')) {
      result.discardCandidates = [...(request as unknown as { cardIds: string[] }).cardIds]
      return options.discard ? { cardIds: [options.discard] } : null
    }
    if (request.kind === 'choose-targets' && request.prompt?.includes('潜袭')) {
      result.targetCandidates = [...(request as unknown as { candidateIds: string[] }).candidateIds]
      return options.target ? { targetIds: [options.target] } : null
    }
    return null
  }
  for (let guard = 0; guard < 20; guard += 1) {
    if (game.state.currentPlayerId === MADAI_ID && result.asked) return result
    game.advancePhase()
    settle(game, answer)
  }
  throw new Error('没有走到马岱的准备阶段')
}

describe('马岱【马术】', () => {
  it('与其他角色的距离 -1', () => {
    const game = gameBeforePrepare('madai-mashu')
    const withMashu = getDistance(game.state, MADAI_ID, 'p3')
    // 换成一个没有马术的武将再算一次，差值就是马术给的
    playerOf(game, MADAI_ID).characterId = 'zhangfei'
    const withoutMashu = getDistance(game.state, MADAI_ID, 'p3')
    expect(withMashu, '马术让距离少一').toBe(withoutMashu - 1)
  })
})

describe('马岱【潜袭】：流程', () => {
  it('准备阶段问一次；不发动就什么都不做', () => {
    const game = gameBeforePrepare('madai-decline')
    const result = runQianxi(game, { decline: true })
    expect(result.asked, '准备阶段确实问了').toBe(true)
    expect(result.discardCandidates, '没发动就不问弃牌').toHaveLength(0)
    expect(game.state.cardColorLocks ?? [], '没有产生禁令').toHaveLength(0)
  })

  it('先摸一张再弃一张，弃牌候选包含装备区', () => {
    const game = gameBeforePrepare('madai-draw-discard')
    const equip = findFreeCard(game, (card) => (card as { equipmentSlot?: string }).equipmentSlot === 'weapon')
    moveCard(game.state, equip, locate(game.state, equip), { kind: 'equipment', playerId: MADAI_ID, slot: 'weapon' })
    const handBefore = playerOf(game, MADAI_ID).zones.hand.length
    const result = runQianxi(game)
    /*
     * 弃牌候选是**摸完之后**的区域：手牌 +1（潜袭摸的那张）再加上装备区那张。
     * 这条同时验了「先摸再弃」的顺序——先弃再摸的话候选里不会有那张新牌。
     */
    expect(result.discardCandidates.length, '候选 = 摸后的手牌 + 装备区').toBe(handBefore + 1 + 1)
    expect(result.discardCandidates, '装备区的牌也能弃').toContain(equip)
    assertCardConservation(game.state)
    assertGameInvariants(game.state)
  })

  it('目标是「距离恰好为 1」的其他角色', () => {
    const game = gameBeforePrepare('madai-distance-one')
    const result = runQianxi(game)
    const expected = game.state.players
      .filter((player) => player.alive && player.id !== MADAI_ID && getDistance(game.state, MADAI_ID, player.id) === 1)
      .map((player) => player.id)
    expect(result.targetCandidates.slice().sort(), '候选就是距离恰好为 1 的人').toEqual(expected.sort())
    expect(result.targetCandidates.length, '五人局里马岱有距离为 1 的邻座').toBeGreaterThan(0)
  })
})

describe('马岱【潜袭】：禁令', () => {
  it('禁与弃牌同色的手牌，异色手牌照常', () => {
    const game = gameBeforePrepare('madai-lock-color')
    const redCard = findFreeCard(game, (card) => card.color === 'red' && card.name === '桃')
    give(game, MADAI_ID, redCard)
    const result = runQianxi(game, { discard: redCard, target: 'p2' })
    expect(result.targetCandidates, 'p2 在候选里').toContain('p2')
    expect(lockedColorsOf(game.state, 'p2'), '禁的是红色').toEqual(['red'])

    const redHand = give(game, 'p2', findFreeCard(game, (card) => card.color === 'red'))
    const blackHand = give(game, 'p2', findFreeCard(game, (card) => card.color === 'black'))
    expect(cardPlayable(game.state, 'p2', redHand), '红色手牌被禁').toBe(false)
    expect(cardPlayable(game.state, 'p2', blackHand), '黑色手牌不受影响').toBe(true)
  })

  it('只禁手牌：同色的装备区牌不受影响', () => {
    const game = gameBeforePrepare('madai-hand-only')
    const redCard = findFreeCard(game, (card) => card.color === 'red' && card.name === '桃')
    give(game, MADAI_ID, redCard)
    runQianxi(game, { discard: redCard, target: 'p2' })

    const redEquip = findFreeCard(game, (card) => card.color === 'red' && card.category === 'equipment')
    moveCard(game.state, redEquip, locate(game.state, redEquip), { kind: 'equipment', playerId: 'p2', slot: 'weapon' })
    expect(cardPlayable(game.state, 'p2', redEquip), '装备区的牌不受颜色禁令影响').toBe(true)
  })

  it('禁的是使用和打出，不禁弃置', () => {
    const game = gameBeforePrepare('madai-discard-ok')
    const redCard = findFreeCard(game, (card) => card.color === 'red' && card.name === '桃')
    give(game, MADAI_ID, redCard)
    runQianxi(game, { discard: redCard, target: 'p2' })

    const redHand = give(game, 'p2', findFreeCard(game, (card) => card.color === 'red'))
    // 弃置走的是 moveCard，不经过用牌禁令，所以照常能弃
    moveCard(game.state, redHand, { kind: 'hand', playerId: 'p2' }, { kind: 'discardPile' })
    expect(game.state.zones.discardPile, '被禁颜色的牌照样弃得掉').toContain(redHand)
    assertCardConservation(game.state)
  })

  it('转化技的子牌同样被禁：关羽用不出红牌当【杀】', () => {
    const game = gameBeforePrepare('madai-viewas-blocked', ['zhangfei', 'madai', 'guanyu', 'huangzhong', 'guojia'])
    const redCard = findFreeCard(game, (card) => card.color === 'red' && card.name === '桃')
    give(game, MADAI_ID, redCard)
    runQianxi(game, { discard: redCard, target: 'p2' })

    const guanyuRed = give(game, 'p2', findFreeCard(game, (card) => card.color === 'red' && card.name !== '杀'))
    playerOf(game, 'p2').attackRangeBonus = 6
    game.state.currentPlayerId = 'p2'
    game.state.phase = 'play'
    const viewAs = game.legalActions('p2').filter((action) => action.kind === 'use-card'
      && action.asCardName === '杀' && action.cardIds.includes(guanyuRed))
    expect(viewAs, '被禁颜色的手牌拿去转化也不行').toHaveLength(0)

    /*
     * 反证：把禁令摘掉，**同一张牌**立刻转化得出来。
     *
     * 不能拿一张黑牌当反例——武圣本来就只吃红牌，那样验的是武圣不是禁令。
     */
    delete game.state.cardColorLocks
    const unlocked = game.legalActions('p2').filter((action) => action.kind === 'use-card'
      && action.asCardName === '杀' && action.cardIds.includes(guanyuRed))
    expect(unlocked.length, '拦住它的确实是潜袭的颜色禁令').toBeGreaterThan(0)
  })

  it('弃出无色的牌就不产生禁令', () => {
    const game = gameBeforePrepare('madai-colorless')
    /*
     * 拿一张真实牌，把它的颜色改写成「无色」——奇策、父魂合成出来的牌
     * 就是这种状态。潜袭读的是**有效颜色**，所以这里等价于弃出一张无色牌。
     */
    const card = give(game, MADAI_ID, findFreeCard(game, (candidate) => candidate.color === 'red'))
    game.state.cardColorOverrides = { ...(game.state.cardColorOverrides ?? {}), [card]: null }
    const result = runQianxi(game, { discard: card })
    expect(result.targetCandidates, '无色不产生限制，连目标都不问').toHaveLength(0)
    expect(game.state.cardColorLocks ?? [], '没有禁令落地').toHaveLength(0)
  })

  it('禁令到马岱这个回合结束为止', () => {
    const game = gameBeforePrepare('madai-expire')
    const redCard = findFreeCard(game, (card) => card.color === 'red' && card.name === '桃')
    give(game, MADAI_ID, redCard)
    runQianxi(game, { discard: redCard, target: 'p2' })
    expect(lockedColorsOf(game.state, 'p2')).toEqual(['red'])

    for (let guard = 0; guard < 12; guard += 1) {
      game.advancePhase()
      settle(game)
      if (game.state.currentPlayerId !== MADAI_ID) break
    }
    expect(game.state.currentPlayerId, '已经进入下一个人的回合').not.toBe(MADAI_ID)
    expect(lockedColorsOf(game.state, 'p2'), '禁令随回合结束到期').toHaveLength(0)
    assertGameInvariants(game.state)
  })
})
