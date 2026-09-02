import { describe, expect, it } from 'vitest'
import { SanguoshaGame } from '@/sanguosha/engine/game'
import { assertGameInvariants } from '@/sanguosha/engine/invariants'
import { decideResponse } from '@/sanguosha/ai'
import { GameRng } from '@/sanguosha/engine/rng'
import type { ChooseCardsRequest } from '@/sanguosha/engine/requests'
import type { GameSetup, Identity, PlayerId, Suit } from '@/sanguosha/engine/types'

/**
 * 司马懿【鬼才】。
 *
 * 判定原本是一次同步翻牌，没有任何插入点；鬼才要求玩家**看到牌面之后**再决定，
 * 所以判定被拆成了「翻牌 → 逐人询问改判 → 结算」。
 *
 * 这里钉住的重点：
 * 1. 没有鬼才在场时判定仍然一步走完，**不多出任何请求**（回归保护）；
 * 2. 改判真的改变了结算结果，而不只是换了张牌面；
 * 3. 改判可以连续进行，且每次都要付出一张手牌（不会无限循环）；
 * 4. 判定牌是公开的，改判请求不泄露任何暗信息。
 */

function rawGame(characterIds: string[], seed = 'guicai'): SanguoshaGame {
  const setup: GameSetup = {
    mode: 'identity', generalChoices: 1,
    players: Array.from({ length: characterIds.length }, (_, index) => ({ id: `p${index}`, nickname: `玩家${index}`, isHuman: false })),
  }
  const game = new SanguoshaGame({ seed, setup })
  const identities: Identity[] = ['lord', 'rebel', 'loyalist', 'rebel', 'renegade']
  game.state.players.forEach((player, index) => {
    player.identity = identities[index % identities.length]
    player.characterId = characterIds[index]
  })
  game.start()
  return game
}

/** 开局可能带着技能发问（甄姬的洛神），先一律放弃，把牌局清到干净状态。 */
function gameWith(characterIds: string[], seed = 'guicai'): SanguoshaGame {
  const game = rawGame(characterIds, seed)
  while (game.state.pendingRequests.length > 0) {
    const request = game.state.pendingRequests[0]
    game.respond({ requestId: request.id, playerId: request.playerId, payload: { optionId: 'no' } })
  }
  return game
}

/** 清空某人的手牌。牌要真的送进弃牌堆，直接清数组会破坏牌张守恒。 */
function clearHand(game: SanguoshaGame, playerId: PlayerId): void {
  const owner = game.state.players.find((player) => player.id === playerId)!
  game.state.zones.discardPile.push(...owner.zones.hand)
  owner.zones.hand = []
}

function pending(game: SanguoshaGame) {
  return game.state.pendingRequests[0]
}

/** 把一张指定花色的牌放到牌堆顶，作为下一张判定牌。 */
function putSuitOnTop(game: SanguoshaGame, suit: Suit): string {
  const cardId = game.state.zones.drawPile.find((id) => game.state.cards[id].suit === suit)
  if (!cardId) throw new Error(`牌堆里没有${suit}`)
  game.state.zones.drawPile = [cardId, ...game.state.zones.drawPile.filter((id) => id !== cardId)]
  return cardId
}

/** 给某人一张指定花色的手牌，返回牌 id。 */
function giveSuit(game: SanguoshaGame, playerId: PlayerId, suit: Suit): string {
  const cardId = game.state.zones.drawPile.find((id) => game.state.cards[id].suit === suit)
  if (!cardId) throw new Error(`牌堆里没有${suit}`)
  game.state.zones.drawPile = game.state.zones.drawPile.filter((id) => id !== cardId)
  game.state.players.find((player) => player.id === playerId)!.zones.hand.push(cardId)
  return cardId
}

/** 把【乐不思蜀】放进某人的判定区，并把回合推到他的判定阶段。 */
function stageLebusishu(game: SanguoshaGame, ownerId: PlayerId): void {
  const leCardId = Object.values(game.state.cards).find((card) => card.name === '乐不思蜀')!.id
  game.state.zones.drawPile = game.state.zones.drawPile.filter((id) => id !== leCardId)
  game.state.zones.discardPile = game.state.zones.discardPile.filter((id) => id !== leCardId)
  for (const player of game.state.players) player.zones.hand = player.zones.hand.filter((id) => id !== leCardId)
  game.state.players.find((player) => player.id === ownerId)!.zones.judgingArea.push(leCardId)
  game.state.currentPlayerId = ownerId
  // 从准备阶段推进一步就进判定阶段，判定阶段的入口逻辑才会跑起来
  game.state.phase = 'prepare'
}

/** 进入判定阶段并走完无懈询问，停在改判询问（或判定已经结束）。 */
function runJudgePhase(game: SanguoshaGame): void {
  game.advancePhase()
  passNullifications(game)
}

/** 走完所有无懈询问，停在改判询问（或判定已经结束）。 */
function passNullifications(game: SanguoshaGame): void {
  for (let guard = 0; guard < 20; guard += 1) {
    const request = pending(game)
    if (!request || request.kind !== 'respond-card') return
    game.respond({ requestId: request.id, playerId: request.playerId, payload: { actionId: 'respond-pass' } })
  }
}

const NO_GUICAI = ['zhangfei', 'zhangfei', 'zhangfei', 'zhangfei', 'zhangfei']
const WITH_GUICAI = ['zhangfei', 'simayi', 'zhangfei', 'zhangfei', 'zhangfei']

describe('没有鬼才在场时，判定仍然一步走完', () => {
  it('乐不思蜀判定不产生额外请求，出牌阶段照常被跳过', () => {
    const game = gameWith(NO_GUICAI)
    stageLebusishu(game, 'p0')
    putSuitOnTop(game, 'spade')

    runJudgePhase(game)

    expect(game.state.retrial, '没人能改判，改判窗口不该留下').toBeNull()
    expect(pending(game), '判定不该多出任何请求').toBeUndefined()
    expect(game.state.skippedPhases).toContain('play')
    assertGameInvariants(game.state)
  })

  it('红桃判定则不跳过出牌阶段', () => {
    const game = gameWith(NO_GUICAI)
    stageLebusishu(game, 'p0')
    putSuitOnTop(game, 'heart')

    runJudgePhase(game)

    expect(game.state.skippedPhases ?? []).not.toContain('play')
    assertGameInvariants(game.state)
  })
})

describe('鬼才的改判窗口', () => {
  it('判定牌翻开之后向司马懿发问，候选是他的手牌', () => {
    const game = gameWith(WITH_GUICAI)
    stageLebusishu(game, 'p0')
    putSuitOnTop(game, 'spade')

    runJudgePhase(game)

    const request = pending(game) as ChooseCardsRequest
    expect(request?.kind).toBe('choose-cards')
    expect(request.purpose).toBe('retrial')
    expect(request.playerId, '问的是司马懿，不是被判定的人').toBe('p1')
    expect(request.min, '不改判是合法回答').toBe(0)
    expect(request.cardIds.sort()).toEqual([...game.state.players[1].zones.hand].sort())
    assertGameInvariants(game.state)
  })

  it('放弃改判就按原判定牌结算', () => {
    const game = gameWith(WITH_GUICAI)
    stageLebusishu(game, 'p0')
    putSuitOnTop(game, 'spade')

    runJudgePhase(game)
    const request = pending(game)!
    game.respond({ requestId: request.id, playerId: 'p1', payload: { cardIds: [] } })

    expect(game.state.retrial).toBeNull()
    expect(game.state.skippedPhases, '黑桃判定：出牌阶段被跳过').toContain('play')
    assertGameInvariants(game.state)
  })

  it('用红桃改判，出牌阶段不再被跳过', () => {
    const game = gameWith(WITH_GUICAI)
    stageLebusishu(game, 'p0')
    clearHand(game, 'p1')
    const heart = giveSuit(game, 'p1', 'heart')
    // 先发牌再置顶：giveSuit 也是从牌堆里挑，顺序反了会把刚置顶的那张拿走
    const original = putSuitOnTop(game, 'spade')

    runJudgePhase(game)
    const request = pending(game)!
    game.respond({ requestId: request.id, playerId: 'p1', payload: { cardIds: [heart] } })

    expect(game.state.skippedPhases ?? [], '改成红桃，乐不思蜀失效').not.toContain('play')
    expect(game.state.zones.discardPile, '原判定牌进弃牌堆').toContain(original)
    expect(game.state.zones.discardPile, '改判用的牌也进弃牌堆').toContain(heart)
    expect(game.state.players[1].zones.hand, '改判的牌确实离手').not.toContain(heart)
    assertGameInvariants(game.state)
  })

  it('改判之后会再问一次——同一个人可以连续改判', () => {
    const game = gameWith(WITH_GUICAI)
    stageLebusishu(game, 'p0')
    clearHand(game, 'p1')
    const first = giveSuit(game, 'p1', 'heart')
    giveSuit(game, 'p1', 'club')
    putSuitOnTop(game, 'spade')

    runJudgePhase(game)
    game.respond({ requestId: pending(game)!.id, playerId: 'p1', payload: { cardIds: [first] } })

    const again = pending(game) as ChooseCardsRequest
    expect(again?.purpose, '改完之后应当再问一次').toBe('retrial')
    expect(again.retrial?.cardName, '这一问针对的是新的判定牌').toBe(game.state.cards[first].name)
    expect(again.cardIds, '用掉的牌不能再当候选').not.toContain(first)
    assertGameInvariants(game.state)
  })

  it('手牌打空之后不再发问，判定收尾', () => {
    const game = gameWith(WITH_GUICAI)
    stageLebusishu(game, 'p0')
    clearHand(game, 'p1')
    const only = giveSuit(game, 'p1', 'heart')
    putSuitOnTop(game, 'spade')

    runJudgePhase(game)
    game.respond({ requestId: pending(game)!.id, playerId: 'p1', payload: { cardIds: [only] } })

    expect(pending(game), '没牌了就不该再问').toBeUndefined()
    expect(game.state.retrial).toBeNull()
    assertGameInvariants(game.state)
  })

  it('司马懿死了就不再发问', () => {
    const game = gameWith(WITH_GUICAI)
    stageLebusishu(game, 'p0')
    putSuitOnTop(game, 'spade')
    game.state.players[1].alive = false
    game.state.players[1].identityRevealed = true

    runJudgePhase(game)

    expect(game.state.retrial).toBeNull()
    expect(pending(game)).toBeUndefined()
    assertGameInvariants(game.state)
  })
})

describe('鬼才对技能判定同样生效', () => {
  it('可以改掉洛神的判定，把黑色改成红色以终止连判', () => {
    // 先手是谁由随机种子决定，这个种子下开局轮到 p0；甄姬坐 p0，
    // 开局就是他的准备阶段，洛神此时已经发问——所以这里不能先清请求
    const game = rawGame(['zhenji', 'simayi', 'zhangfei', 'zhangfei', 'zhangfei'], 'skill-test')
    expect(game.state.currentPlayerId, '这一条依赖开局先手是甄姬').toBe('p0')
    clearHand(game, 'p1')
    const diamond = giveSuit(game, 'p1', 'diamond')
    const black = putSuitOnTop(game, 'club')

    const luoshenAsk = pending(game)
    expect(luoshenAsk?.prompt, '开局应当停在洛神的发问上').toContain('洛神')
    game.respond({ requestId: luoshenAsk!.id, playerId: 'p0', payload: { optionId: 'yes' } })

    const retrial = pending(game) as ChooseCardsRequest
    expect(retrial?.purpose, '洛神的判定也要过改判窗口').toBe('retrial')
    expect(retrial.playerId).toBe('p1')
    game.respond({ requestId: retrial.id, playerId: 'p1', payload: { cardIds: [diamond] } })

    // 改成红色：判定牌不归甄姬，洛神也不会再问第二轮
    expect(game.state.players[0].zones.hand, '红色判定不给甄姬').not.toContain(diamond)
    expect(game.state.players[0].zones.hand, '被换掉的黑牌同样不归甄姬').not.toContain(black)
    expect(pending(game)?.prompt ?? '', '连判应当就此结束').not.toContain('洛神')
    assertGameInvariants(game.state)
  })
})

describe('改判请求不泄露暗信息', () => {
  it('候选只有自己的手牌，别人的手牌一张都不出现', () => {
    const game = gameWith(WITH_GUICAI)
    stageLebusishu(game, 'p0')
    putSuitOnTop(game, 'spade')
    const secrets = game.state.players[0].zones.hand

    runJudgePhase(game)

    const request = pending(game)!
    const serialized = JSON.stringify(request)
    for (const secret of secrets) {
      expect(serialized, '别人的手牌不该出现在改判请求里').not.toContain(secret)
    }
  })
})

describe('AI 的改判取舍', () => {
  function retrialChoice(game: SanguoshaGame, request: ChooseCardsRequest): string[] {
    const response = decideResponse(
      { view: game.viewFor('p1'), difficulty: 'normal', rng: new GameRng('ai'), suspicion: {} },
      request,
    )
    return (response.payload as { cardIds: string[] }).cardIds
  }

  /** 造一个「司马懿手里同时有红桃和黑桃」的改判询问。 */
  function retrialFixture(judgeSuit: Suit) {
    const game = gameWith(WITH_GUICAI)
    stageLebusishu(game, 'p0')
    clearHand(game, 'p1')
    const heart = giveSuit(game, 'p1', 'heart')
    const spade = giveSuit(game, 'p1', 'spade')
    putSuitOnTop(game, judgeSuit)
    runJudgePhase(game)
    return { game, heart, spade, request: pending(game) as ChooseCardsRequest }
  }

  it('结果已经如自己所愿时不浪费手牌', () => {
    // p0 是主公、p1 是反贼：司马懿希望主公的乐不思蜀生效，即判定为非红桃
    const { game, request } = retrialFixture('spade')
    expect(retrialChoice(game, request), '黑桃已经让主公被跳过，不必改').toEqual([])
  })

  it('结果不合心意且手里有能翻转的牌时才出手', () => {
    const { game, spade, request } = retrialFixture('heart')
    expect(retrialChoice(game, request), '红桃会让乐不思蜀失效，改成黑桃').toEqual([spade])
  })

  it('看不懂的判定理由一律放弃，不乱改', () => {
    const { game, request } = retrialFixture('heart')
    const unknown: ChooseCardsRequest = { ...request, retrial: { ...request.retrial!, reason: '双雄' } }
    expect(retrialChoice(game, unknown)).toEqual([])
  })
})
