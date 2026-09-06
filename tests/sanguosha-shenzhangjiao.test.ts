import { describe, expect, it } from 'vitest'
import { SanguoshaGame } from '@/sanguosha/engine/game'
import { GameRng } from '@/sanguosha/engine/rng'
import { assertCardConservation, moveCard, type ZoneRef } from '@/sanguosha/engine/zones'
import { assertGameInvariants } from '@/sanguosha/engine/invariants'
import { deckReshuffledThisTurn, findCardsSummingTo, reshuffleDrawPile, ruleCardNumber } from '@/sanguosha/engine/deck'
import type { GameSetup, Identity, PlayerId, SanguoshaState } from '@/sanguosha/engine/types'

/**
 * 神·张角。
 *
 * 四条主张，逐条有断言：
 *
 * - 【异兆】的点数走统一口径：虚拟牌没有点数，多子牌转化也没有单一点数；
 * - 十位数按 `floor(黄 / 10)`，而且**一次标记变化只检查一次**，跨两档也只取一张牌；
 * - 【肆军】拿到的那组牌点数之和**恰好** 36，而且是牌堆里真实存在的实体牌；
 * - 【天劫】看的是「这个回合牌堆洗过牌」这条真事实，洗两次也只给一次机会。
 */

const CAST = ['shenzhangjiao', 'zhangfei', 'guanyu', 'zhaoyun', 'huangzhong']

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
      if (equipped === cardId) return { kind: 'equipment', playerId: owner.id, slot: slot as keyof typeof owner.zones.equipment }
    }
  }
  throw new Error('找不到卡牌：' + cardId)
}

/** 从牌堆或弃牌堆里拿一张闲置的、指定牌名（可再指定点数）的牌塞给某人。 */
function giveCard(game: SanguoshaGame, playerId: string, cardName: string, rank?: number): string {
  const card = Object.values(game.state.cards).find((candidate) => candidate.name === cardName
    && (rank === undefined || candidate.rank === rank)
    && (game.state.zones.drawPile.includes(candidate.id) || game.state.zones.discardPile.includes(candidate.id)))
  if (!card) throw new Error(`牌堆里没有闲置的【${cardName}】${rank ?? ''}`)
  moveCard(game.state, card.id, locate(game.state, card.id), { kind: 'hand', playerId })
  return card.id
}

function trimHand(game: SanguoshaGame, playerId: string, count: number): void {
  const player = playerOf(game, playerId)
  for (const cardId of player.zones.hand.slice(count)) {
    moveCard(game.state, cardId, { kind: 'hand', playerId }, { kind: 'discardPile' })
  }
}

/** 神张角用一张手牌出【杀】打某人。 */
function slash(game: SanguoshaGame, cardId: string, targetId: string): void {
  const action = game.legalActions('p0').find((candidate) => candidate.kind === 'use-card'
    && candidate.asCardName === '杀'
    && candidate.cardIds.includes(cardId)
    && candidate.targetIds.includes(targetId))
  if (!action) throw new Error('没有可用的【杀】动作')
  game.act('p0', action.id)
  settle(game)
}

describe('公共机制：牌堆', () => {
  it('重洗只有一个入口，而且会留下「这个回合洗过牌」的痕迹', () => {
    const game = gameAt('zj-deck-reshuffle')
    expect(deckReshuffledThisTurn(game.state), '一开始没洗过').toBe(false)

    // 把牌堆全部搬进弃牌堆，再洗回去
    const pile = [...game.state.zones.drawPile]
    for (const cardId of pile) moveCard(game.state, cardId, { kind: 'drawPile' }, { kind: 'discardPile' })
    const moved = reshuffleDrawPile(game.state, new GameRng('zj-deck-reshuffle'))
    expect(moved, '洗回去的张数').toBe(pile.length)
    expect(deckReshuffledThisTurn(game.state), '留下了痕迹').toBe(true)
    expect(game.state.zones.discardPile, '弃牌堆清空').toHaveLength(0)
    assertCardConservation(game.state)

    // 空弃牌堆不算一次洗牌
    const before = game.state.deckReshuffle!.count
    expect(reshuffleDrawPile(game.state, new GameRng('x'))).toBe(0)
    expect(game.state.deckReshuffle!.count, '空洗不记账').toBe(before)
  })

  it('点数口径：实体牌有点数，虚拟牌没有', () => {
    const game = gameAt('zj-card-number')
    const real = giveCard(game, 'p0', '杀')
    expect(ruleCardNumber(game.state, real), '实体牌读它自己的点数').toBe(game.state.cards[real].rank)
    /*
     * 技能凭空生成的牌**没有点数**。返回 0 是错的：0 会被当成一个真点数，
     * 让「按点数算」的效果凭空多算一次。
     */
    game.beginVirtualSlash({ sourceId: 'p1', targetId: 'p2', sourceSkillId: 'test' })
    const virtualId = Object.keys(game.state.cards).find((id) => id.startsWith('virtual:'))!
    expect(ruleCardNumber(game.state, virtualId), '虚拟牌没有点数').toBeNull()
    settle(game)
  })

  it('凑点数和：恰好命中，凑不出返回 null', () => {
    const game = gameAt('zj-subset-sum')
    const rng = new GameRng('zj-subset-sum')
    const picked = findCardsSummingTo(game.state, rng, 36)
    expect(picked, '一副整牌堆里凑得出 36').not.toBeNull()
    const sum = picked!.reduce((total, cardId) => total + game.state.cards[cardId].rank, 0)
    expect(sum, '是恰好 36，不是凑够 36').toBe(36)
    expect(new Set(picked).size, '不会重复用同一张牌').toBe(picked!.length)
    for (const cardId of picked!) {
      expect(game.state.zones.drawPile, '每一张都真的在牌堆里').toContain(cardId)
    }

    // 同一个种子跑两遍结果一样
    const again = findCardsSummingTo(game.state, new GameRng('zj-subset-sum'), 36)
    expect(again, '同种子可复现').toEqual(picked)

    // 牌堆空了自然凑不出
    for (const cardId of [...game.state.zones.drawPile]) {
      moveCard(game.state, cardId, { kind: 'drawPile' }, { kind: 'discardPile' })
    }
    expect(findCardsSummingTo(game.state, rng, 36), '凑不出就是 null，不给一个最接近的').toBeNull()
  })

  it('凑点数和在大牌堆上也是线性时间，不会指数爆炸', () => {
    const game = gameAt('zj-subset-perf')
    const started = Date.now()
    for (let round = 0; round < 200; round += 1) {
      findCardsSummingTo(game.state, new GameRng(`perf-${round}`), 36)
    }
    // 真要是 2^N 枚举，一百多张牌跑一次就回不来了
    expect(Date.now() - started, '两百次搜索应当很快').toBeLessThan(5_000)
  })
})

describe('神·张角：异兆', () => {
  it('使用一张牌获得等于其点数的「黄」', () => {
    const game = gameAt('zj-yizhao-use')
    trimHand(game, 'p0', 0)
    const cardId = giveCard(game, 'p0', '杀', 7)
    expect(playerOf(game, 'p0').marks.huang ?? 0).toBe(0)
    slash(game, cardId, 'p1')
    expect(playerOf(game, 'p0').marks.huang, '7 点的【杀】给 7 枚「黄」').toBe(7)
  })

  it('打出一张牌同样获得「黄」', () => {
    const game = gameAt('zj-yizhao-respond')
    trimHand(game, 'p0', 0)
    const dodge = giveCard(game, 'p0', '闪', 12)
    // 让别人打神张角一张【杀】，神张角打出这张 12 点的【闪】
    game.beginVirtualSlash({ sourceId: 'p1', targetId: 'p0', sourceSkillId: 'test' })
    settle(game, (request) => {
      if (request.kind !== 'respond-card') return null
      const actionIds = (request as unknown as { actionIds: string[] }).actionIds
      const play = actionIds.find((actionId) => actionId !== 'respond-pass')
      return play ? { actionId: play } : null
    })
    expect(playerOf(game, 'p0').zones.hand, '闪确实打出去了').not.toContain(dodge)
    expect(playerOf(game, 'p0').marks.huang, '12 点的【闪】给 12 枚「黄」').toBe(12)
  })

  it('十位数变化时从牌堆获得一张对应点数的牌；不变化则不获得', () => {
    const game = gameAt('zj-yizhao-tens')
    trimHand(game, 'p0', 0)
    const owner = playerOf(game, 'p0')
    owner.marks.huang = 9

    const cardId = giveCard(game, 'p0', '杀', 7)
    const handBefore = owner.zones.hand.length
    slash(game, cardId, 'p1')
    expect(owner.marks.huang, '9 + 7').toBe(16)
    /*
     * 十位数从 0 变成 1，所以获得牌堆里一张点数为 1 的牌。
     * 打出去的那张【杀】已经离开手牌，所以手牌数是「减一再加一」。
     */
    expect(owner.zones.hand.length, '取回一张牌').toBe(handBefore - 1 + 1)
    const gained = owner.zones.hand[owner.zones.hand.length - 1]
    expect(game.state.cards[gained].rank, '点数正是变化后的十位数').toBe(1)
    assertCardConservation(game.state)
  })

  it('十位数没变就什么都不拿', () => {
    const game = gameAt('zj-yizhao-no-tens')
    trimHand(game, 'p0', 0)
    const owner = playerOf(game, 'p0')
    owner.marks.huang = 11
    const cardId = giveCard(game, 'p0', '杀', 2)
    slash(game, cardId, 'p1')
    expect(owner.marks.huang).toBe(13)
    expect(owner.zones.hand, '十位数仍是 1，没有额外获得牌').toHaveLength(0)
  })

  it('一次跨过两档十位，也只按变化后的十位取一张', () => {
    const game = gameAt('zj-yizhao-jump')
    trimHand(game, 'p0', 0)
    const owner = playerOf(game, 'p0')
    owner.marks.huang = 8
    const cardId = giveCard(game, 'p0', '杀', 13)
    slash(game, cardId, 'p1')
    expect(owner.marks.huang, '8 + 13').toBe(21)
    // 十位数 0 → 2，只取一张点数 2 的牌，不会因为「路过 1」再取一张
    expect(owner.zones.hand, '只获得一张').toHaveLength(1)
    expect(game.state.cards[owner.zones.hand[0]].rank).toBe(2)
  })

  it('牌堆里没有对应点数就安全跳过，不去弃牌堆也不洗牌', () => {
    const game = gameAt('zj-yizhao-missing')
    trimHand(game, 'p0', 0)
    const owner = playerOf(game, 'p0')
    owner.marks.huang = 9
    // 把牌堆里所有点数 1 的牌搬走，只留别的
    for (const cardId of [...game.state.zones.drawPile]) {
      if (game.state.cards[cardId].rank === 1) {
        moveCard(game.state, cardId, { kind: 'drawPile' }, { kind: 'discardPile' })
      }
    }
    const discardBefore = game.state.zones.discardPile.length
    const reshuffles = game.state.deckReshuffle?.count ?? 0
    const cardId = giveCard(game, 'p0', '杀', 7)
    slash(game, cardId, 'p1')

    expect(owner.marks.huang).toBe(16)
    expect(owner.zones.hand, '找不到就什么都不拿').toHaveLength(0)
    expect(game.state.deckReshuffle?.count ?? 0, '不会为了找牌去洗牌').toBe(reshuffles)
    expect(game.state.zones.discardPile.length, '也不去弃牌堆里翻').toBeGreaterThanOrEqual(discardBefore - 1)
    assertCardConservation(game.state)
  })
})

describe('神·张角：肆军', () => {
  /** 把牌堆裁到指定张数，多的搬进弃牌堆。 */
  function trimDeck(game: SanguoshaGame, count: number): void {
    for (const cardId of game.state.zones.drawPile.slice(count)) {
      moveCard(game.state, cardId, { kind: 'drawPile' }, { kind: 'discardPile' })
    }
  }

  /**
   * 推进到神张角的下一个准备阶段，并在**回合真正开始的那一刻**布置局面。
   *
   * 布置不能提前一整轮做：中间四个人各摸各弃，牌堆张数早就变了，
   * 「黄是否大于牌堆张数」这条判断到时候读的是另一副局面。
   */
  function atNextPrepare(
    game: SanguoshaGame,
    arrange: () => void,
    choose: (request: AnyRequest) => Record<string, unknown> | null,
  ): void {
    let arranged = false
    game.events.on('TurnStart', (handled) => {
      if (arranged || (handled.event.payload as { playerId?: string }).playerId !== 'p0') return
      arranged = true
      arrange()
    })
    for (let guard = 0; guard < 60; guard += 1) {
      game.advancePhase()
      settle(game, choose)
      if (arranged && game.state.currentPlayerId === 'p0' && game.state.phase === 'prepare') return
    }
    throw new Error('没能回到神张角的准备阶段')
  }

  it('黄必须严格大于牌堆张数，相等不发动', () => {
    const game = gameAt('zj-sijun-equal')
    const prompts: string[] = []
    atNextPrepare(game, () => {
      trimDeck(game, 40)
      playerOf(game, 'p0').marks.huang = 40
    }, (request) => { prompts.push(request.prompt ?? ''); return null })
    expect(prompts.some((prompt) => prompt.includes('肆军')), '相等不给发动机会').toBe(false)
  })

  it('黄大于牌堆张数时可以发动：移除全部黄，拿到的牌点数之和恰好 36', () => {
    const game = gameAt('zj-sijun-invoke')
    /*
     * 拿到手的是哪几张，从战报事件里读，不去和手牌数量做差：
     * 中间隔着摸牌阶段和弃牌阶段，手牌早就不是原来那几张了。
     */
    const gained: string[] = []
    game.events.on('GainCard', (handled) => {
      const payload = handled.event.payload as { reason?: string; cardIds?: string[] }
      if (payload.reason === 'sijun') gained.push(...(payload.cardIds ?? []))
    })
    let asked = false
    atNextPrepare(game, () => {
      trimDeck(game, 40)
      playerOf(game, 'p0').marks.huang = 41
    }, (request) => {
      if (request.kind === 'choose-option' && request.prompt?.includes('肆军')) {
        asked = true
        return { optionId: 'invoke' }
      }
      return null
    })

    expect(asked, '给了发动机会').toBe(true)
    expect(playerOf(game, 'p0').marks.huang ?? 0, '黄全部移除').toBe(0)
    expect(gained.length, '确实拿到了牌').toBeGreaterThan(0)
    const sum = gained.reduce((total, cardId) => total + game.state.cards[cardId].rank, 0)
    expect(sum, '点数之和恰好 36').toBe(36)
    assertCardConservation(game.state)
    assertGameInvariants(game.state)
  })

  it('牌堆凑不出 36 时根本不给发动机会，黄也不会白扣', () => {
    const game = gameAt('zj-sijun-impossible')
    const prompts: string[] = []
    atNextPrepare(game, () => {
      /*
       * 只留点数 13 的牌：13 的倍数里没有 36，所以凑不出。
       * 这时候不该给发动机会——代价是「移除所有黄」，付了却拿不到东西是最坏的结果。
       */
      for (const cardId of [...game.state.zones.drawPile]) {
        if (game.state.cards[cardId].rank !== 13) {
          moveCard(game.state, cardId, { kind: 'drawPile' }, { kind: 'discardPile' })
        }
      }
      playerOf(game, 'p0').marks.huang = 999
    }, (request) => { prompts.push(request.prompt ?? ''); return null })
    expect(prompts.some((prompt) => prompt.includes('肆军')), '凑不出就不问').toBe(false)
    expect(playerOf(game, 'p0').marks.huang, '黄一枚都没少').toBe(999)
  })
})

describe('神·张角：天劫', () => {
  it('本回合洗过牌才在回合结束时给机会', () => {
    const game = gameAt('zj-tianjie-no-reshuffle')
    const prompts: string[] = []
    game.advancePhase()
    settle(game, (request) => { prompts.push(request.prompt ?? ''); return null })
    game.advancePhase()
    settle(game, (request) => { prompts.push(request.prompt ?? ''); return null })
    game.advancePhase()
    settle(game, (request) => { prompts.push(request.prompt ?? ''); return null })
    expect(prompts.some((prompt) => prompt.includes('天劫')), '没洗牌就没有天劫').toBe(false)
  })

  it('洗过牌就给一次机会；同一回合洗两次也只给一次', () => {
    const game = gameAt('zj-tianjie-once')
    // 手动洗两次
    for (let round = 0; round < 2; round += 1) {
      const pile = [...game.state.zones.drawPile]
      for (const cardId of pile.slice(0, 5)) {
        moveCard(game.state, cardId, { kind: 'drawPile' }, { kind: 'discardPile' })
      }
      reshuffleDrawPile(game.state, game.rng)
    }
    expect(game.state.deckReshuffle!.count, '确实洗了两次').toBe(2)

    let tianjiePrompts = 0
    for (let guard = 0; guard < 8 && game.state.currentPlayerId === 'p0'; guard += 1) {
      game.advancePhase()
      settle(game, (request) => {
        if (request.kind === 'choose-targets' && request.prompt?.includes('天劫')) {
          tianjiePrompts += 1
          return { targetIds: [] }
        }
        return null
      })
    }
    expect(tianjiePrompts, '洗两次也只问一次').toBe(1)
  })

  it('伤害值是目标手牌里【闪】的张数，至少 1；转化出来的闪不算', () => {
    const game = gameAt('zj-tianjie-amount')
    // p1 手里没有闪，p2 有三张闪
    trimHand(game, 'p1', 0)
    trimHand(game, 'p2', 0)
    for (let index = 0; index < 3; index += 1) giveCard(game, 'p2', '闪')
    /*
     * p2 是关羽：他的红色牌都能当【杀】用，但那是潜力不是实体。
     * 这里再塞一张红色非闪的牌，它不该被算进「手牌中【闪】的数量」。
     */
    giveCard(game, 'p2', '桃')
    for (const id of ['p1', 'p2']) playerOf(game, id).hp = playerOf(game, id).maxHp
    const p1Hp = playerOf(game, 'p1').hp
    const p2Hp = playerOf(game, 'p2').hp

    const pile = [...game.state.zones.drawPile]
    for (const cardId of pile.slice(0, 5)) {
      moveCard(game.state, cardId, { kind: 'drawPile' }, { kind: 'discardPile' })
    }
    reshuffleDrawPile(game.state, game.rng)

    for (let guard = 0; guard < 8 && game.state.currentPlayerId === 'p0'; guard += 1) {
      game.advancePhase()
      settle(game, (request) => {
        if (request.kind === 'choose-targets' && request.prompt?.includes('天劫')) return { targetIds: ['p1', 'p2'] }
        return null
      })
    }
    expect(p1Hp - playerOf(game, 'p1').hp, '手里没有闪，按 1 点算').toBe(1)
    expect(p2Hp - playerOf(game, 'p2').hp, '三张闪就是 3 点').toBe(3)
    assertGameInvariants(game.state)
  })

  it('最多三名目标', () => {
    const game = gameAt('zj-tianjie-max')
    const pile = [...game.state.zones.drawPile]
    for (const cardId of pile.slice(0, 5)) {
      moveCard(game.state, cardId, { kind: 'drawPile' }, { kind: 'discardPile' })
    }
    reshuffleDrawPile(game.state, game.rng)
    let max = -1
    for (let guard = 0; guard < 8 && game.state.currentPlayerId === 'p0'; guard += 1) {
      game.advancePhase()
      settle(game, (request) => {
        if (request.kind === 'choose-targets' && request.prompt?.includes('天劫')) {
          max = (request as unknown as { max: number }).max
          return { targetIds: [] }
        }
        return null
      })
    }
    expect(max, '四名其他角色里最多选三名').toBe(3)
  })
})
