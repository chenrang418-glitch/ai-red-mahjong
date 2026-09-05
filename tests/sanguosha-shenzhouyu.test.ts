import { describe, expect, it } from 'vitest'
import { SanguoshaGame } from '@/sanguosha/engine/game'
import { assertGameInvariants } from '@/sanguosha/engine/invariants'
import { assertCardConservation } from '@/sanguosha/engine/zones'
import type { GameSetup, Identity, PlayerId, Suit } from '@/sanguosha/engine/types'

/**
 * 神周瑜。本项目自研表述。
 *
 * 两条最容易做错的地方：
 *
 * 1. **琴音统计的是「本弃牌阶段弃置的手牌」**，不是「本回合使用/打出的牌」，
 *    触发时机是**弃牌阶段结束时**而不是结束阶段。复用引擎已有的弃牌溯源账本。
 * 2. **业炎的代价门槛是「对任意一人分到 ≥2 点」**，不是「3 点全给一人」；
 *    失去 3 点体力是 LoseHp 不是伤害；火焰伤害必须走统一伤害管线。
 */

function gameWith(characterIds: string[], seed = 'shenzhouyu'): SanguoshaGame {
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
  while (game.state.pendingRequests.length > 0) {
    const request = game.state.pendingRequests[0]
    game.respond({ requestId: request.id, playerId: request.playerId, payload: { optionId: 'no' } })
  }
  return game
}

function pending(game: SanguoshaGame) {
  return game.state.pendingRequests[0]
}

function playerOf(game: SanguoshaGame, playerId: PlayerId) {
  return game.state.players.find((player) => player.id === playerId)!
}

function detach(game: SanguoshaGame, cardId: string): void {
  game.state.zones.drawPile = game.state.zones.drawPile.filter((id) => id !== cardId)
  game.state.zones.discardPile = game.state.zones.discardPile.filter((id) => id !== cardId)
  for (const player of game.state.players) {
    player.zones.hand = player.zones.hand.filter((id) => id !== cardId)
  }
}

function clearHand(game: SanguoshaGame, playerId: PlayerId): void {
  const owner = playerOf(game, playerId)
  game.state.zones.discardPile.push(...owner.zones.hand)
  owner.zones.hand = []
}

function giveHand(game: SanguoshaGame, playerId: PlayerId, cardIds: string[]): void {
  for (const cardId of cardIds) {
    detach(game, cardId)
    playerOf(game, playerId).zones.hand.push(cardId)
  }
}

/** 各取一张不同花色的牌，用来凑业炎的代价。 */
function fourSuits(game: SanguoshaGame): string[] {
  const suits: Suit[] = ['spade', 'heart', 'club', 'diamond']
  return suits.map((suit) => {
    const card = Object.values(game.state.cards).find((candidate) => candidate.suit === suit)
    if (!card) throw new Error(`找不到 ${suit}`)
    return card.id
  })
}

function enterPlay(game: SanguoshaGame, playerId: PlayerId): void {
  game.state.currentPlayerId = playerId
  game.state.normalTurnPlayerId = playerId
  game.state.currentTurnKind = 'normal'
  game.state.phase = 'play'
  game.state.skippedPhases = []
  for (const player of game.state.players) player.turnUsedSkills = []
}

/** 走真实弃牌阶段：手牌超上限时引擎会发弃牌请求，弃完进入结束阶段。 */
function runDiscardPhase(game: SanguoshaGame, playerId: PlayerId, discardCount: number): void {
  const owner = playerOf(game, playerId)
  owner.hp = 1
  clearHand(game, playerId)
  giveHand(game, playerId, game.state.zones.drawPile.slice(0, discardCount + 1))
  game.state.currentPlayerId = playerId
  game.state.normalTurnPlayerId = playerId
  game.state.currentTurnKind = 'normal'
  game.state.phase = 'play'
  game.state.skippedPhases = []
  game.advancePhase()

  const request = pending(game)
  if (request?.purpose === 'discard-phase') {
    game.respond({
      requestId: request.id, playerId,
      payload: { cardIds: request.cardIds.slice(0, request.min) },
    })
  }
  /*
   * 答完弃牌请求只是把牌弃掉，阶段还停在 discard。
   * `PhaseEnd('discard')`（琴音挂的时机）要**再推进一次**才会发出来。
   */
  if (game.state.pendingRequests.length === 0) game.advancePhase()
}

const FIVE = ['shenzhouyu', 'zhangfei', 'zhangfei', 'zhangfei', 'zhangfei']

describe('琴音：弃牌阶段结束时结算', () => {
  it('本弃牌阶段弃了两张手牌：弹出发动询问', () => {
    const game = gameWith(FIVE)
    runDiscardPhase(game, 'p0', 2)
    const ask = pending(game)
    expect(ask?.kind).toBe('choose-option')
    expect(String(ask.prompt)).toContain('琴音')
    expect(ask.options.map((option: { id: string }) => option.id)).toEqual(['qinyin-recover', 'qinyin-lose', 'no'])
  })

  it('只弃了一张：不触发', () => {
    const game = gameWith(FIVE)
    runDiscardPhase(game, 'p0', 1)
    expect(pending(game), '不足两张不该触发琴音').toBeUndefined()
  })

  it('统计的是弃置，不是使用/打出：出牌阶段用掉的牌不计入', () => {
    const game = gameWith(FIVE)
    const owner = playerOf(game, 'p0')
    owner.hp = 5
    clearHand(game, 'p0')
    // 手牌不超上限，弃牌阶段一张都不用弃
    giveHand(game, 'p0', game.state.zones.drawPile.slice(0, 2))
    game.state.currentPlayerId = 'p0'
    game.state.normalTurnPlayerId = 'p0'
    game.state.currentTurnKind = 'normal'
    game.state.phase = 'play'
    game.state.skippedPhases = []
    game.advancePhase()
    expect(pending(game), '没弃牌就不该触发琴音').toBeUndefined()
  })

  it('选「全体回复」：所有受伤角色各回 1 点', () => {
    const game = gameWith(FIVE)
    for (const id of ['p1', 'p2', 'p3', 'p4']) playerOf(game, id).hp = 2
    runDiscardPhase(game, 'p0', 2)
    game.respond({ requestId: pending(game).id, playerId: 'p0', payload: { optionId: 'qinyin-recover' } })
    for (const id of ['p1', 'p2', 'p3', 'p4']) {
      expect(playerOf(game, id).hp, `${id} 应当回 1 点`).toBe(3)
    }
    assertGameInvariants(game.state)
  })

  it('选「全体失去」：所有角色各掉 1 点，走 loseHp 不是伤害', () => {
    const game = gameWith(FIVE)
    for (const id of ['p1', 'p2', 'p3', 'p4']) playerOf(game, id).hp = 3
    runDiscardPhase(game, 'p0', 2)
    /*
     * `runDiscardPhase` 把神周瑜压到 1 血来逼出弃牌请求，
     * 但这里要测的是「所有角色各失去 1 点」的正常结算——
     * 1 血的他会被自己的琴音扣进濒死，后续队列就停了。
     * 先把他的血补回来再选。
     */
    const owner = playerOf(game, 'p0')
    owner.maxHp = 4
    owner.hp = 4
    const ownerHpBefore = owner.hp
    game.respond({ requestId: pending(game).id, playerId: 'p0', payload: { optionId: 'qinyin-lose' } })
    // 把可能弹出的求桃跑掉
    let guard = 0
    while (pending(game) && guard < 10) {
      const request = pending(game)
      const payload = request.kind === 'rescue' || request.kind === 'respond-card'
        ? { actionId: request.actionIds[request.actionIds.length - 1] }
        : { optionId: 'no', cardIds: [], targetIds: [] }
      game.respond({ requestId: request.id, playerId: request.playerId, payload })
      guard += 1
    }
    for (const id of ['p1', 'p2', 'p3', 'p4']) {
      expect(playerOf(game, id).hp, `${id} 应当掉 1 点`).toBe(2)
    }
    expect(playerOf(game, 'p0').hp, '神周瑜自己也算「所有角色」').toBe(ownerHpBefore - 1)
    assertGameInvariants(game.state)
  })

  it('放弃则什么都不发生', () => {
    const game = gameWith(FIVE)
    for (const id of ['p1', 'p2']) playerOf(game, id).hp = 2
    runDiscardPhase(game, 'p0', 2)
    game.respond({ requestId: pending(game).id, playerId: 'p0', payload: { optionId: 'no' } })
    expect(playerOf(game, 'p1').hp).toBe(2)
  })
})

describe('业炎：限定技与代价', () => {
  function yeyanAction(game: SanguoshaGame) {
    return game.legalActions('p0').find((action) => action.kind === 'invoke-skill' && action.skillId === 'yeyan')
  }

  it('付不起代价时只能选三个人（三人各 1 点是唯一合法分配）', () => {
    const game = gameWith(FIVE)
    clearHand(game, 'p0')
    // 手上只有两种花色，凑不出四张不同花色
    const spades = Object.values(game.state.cards).filter((card) => card.suit === 'spade').slice(0, 2).map((card) => card.id)
    giveHand(game, 'p0', spades)
    enterPlay(game, 'p0')

    game.act('p0', yeyanAction(game)!.id)
    const request = pending(game)
    expect(String(request.prompt)).toContain('付不起大业炎的代价')
    game.respond({ requestId: request.id, playerId: 'p0', payload: { targetIds: ['p1', 'p2', 'p3'] } })

    const split = pending(game)
    expect(split.kind).toBe('choose-option')
    expect(split.options, '只剩「三人各 1 点」这一种').toHaveLength(1)
  })

  it('三人各 1 点：不付代价，三人各掉 1 点火焰伤害', () => {
    const game = gameWith(FIVE)
    clearHand(game, 'p0')
    giveHand(game, 'p0', Object.values(game.state.cards).filter((card) => card.suit === 'spade').slice(0, 2).map((card) => card.id))
    const before = ['p1', 'p2', 'p3'].map((id) => playerOf(game, id).hp)
    const ownerHp = playerOf(game, 'p0').hp
    enterPlay(game, 'p0')

    game.act('p0', yeyanAction(game)!.id)
    game.respond({ requestId: pending(game).id, playerId: 'p0', payload: { targetIds: ['p1', 'p2', 'p3'] } })
    const split = pending(game)
    game.respond({ requestId: split.id, playerId: 'p0', payload: { optionId: split.options[0].id } })
    // 把队列跑完（逐名结算）
    let guard = 0
    while (pending(game) && guard < 12) {
      const request = pending(game)
      const payload = request.kind === 'rescue' || request.kind === 'respond-card'
        ? { actionId: request.actionIds[request.actionIds.length - 1] }
        : { optionId: 'no', cardIds: [], targetIds: [] }
      game.respond({ requestId: request.id, playerId: request.playerId, payload })
      guard += 1
    }

    ;['p1', 'p2', 'p3'].forEach((id, index) => {
      expect(playerOf(game, id).hp, `${id} 应当掉 1 点`).toBe(before[index] - 1)
    })
    expect(playerOf(game, 'p0').hp, '小业炎不付体力代价').toBe(ownerHp)
    assertCardConservation(game.state)
    assertGameInvariants(game.state)
  })

  it('对一人分到 2 点及以上：先弃四张不同花色手牌并失去 3 点体力', () => {
    const game = gameWith(FIVE)
    clearHand(game, 'p0')
    const cost = fourSuits(game)
    giveHand(game, 'p0', cost)
    const owner = playerOf(game, 'p0')
    owner.maxHp = 8
    owner.hp = 8
    enterPlay(game, 'p0')

    game.act('p0', yeyanAction(game)!.id)
    game.respond({ requestId: pending(game).id, playerId: 'p0', payload: { targetIds: ['p1'] } })
    const split = pending(game)
    // 只有一个目标：3 点全给他，必然要付代价
    const option = split.options.find((candidate: { label: string }) => candidate.label.includes('需付代价'))!
    game.respond({ requestId: split.id, playerId: 'p0', payload: { optionId: option.id } })

    const costRequest = pending(game)
    expect(costRequest.kind, '要先弃四张不同花色手牌').toBe('choose-cards')
    expect(costRequest.min).toBe(4)
    game.respond({ requestId: costRequest.id, playerId: 'p0', payload: { cardIds: cost } })

    let guard = 0
    while (pending(game) && guard < 12) {
      const request = pending(game)
      const payload = request.kind === 'rescue' || request.kind === 'respond-card'
        ? { actionId: request.actionIds[request.actionIds.length - 1] }
        : { optionId: 'no', cardIds: [], targetIds: [] }
      game.respond({ requestId: request.id, playerId: request.playerId, payload })
      guard += 1
    }

    expect(owner.hp, '失去 3 点体力（LoseHp，不是伤害）').toBe(5)
    expect(owner.zones.hand, '四张代价牌离开手牌').toHaveLength(0)
    assertCardConservation(game.state)
  })

  it('限定技一局一次', () => {
    const game = gameWith(FIVE)
    clearHand(game, 'p0')
    giveHand(game, 'p0', Object.values(game.state.cards).filter((card) => card.suit === 'spade').slice(0, 2).map((card) => card.id))
    enterPlay(game, 'p0')
    game.act('p0', yeyanAction(game)!.id)
    game.respond({ requestId: pending(game).id, playerId: 'p0', payload: { targetIds: ['p1', 'p2', 'p3'] } })
    const split = pending(game)
    game.respond({ requestId: split.id, playerId: 'p0', payload: { optionId: split.options[0].id } })
    let guard = 0
    while (pending(game) && guard < 12) {
      const request = pending(game)
      const payload = request.kind === 'rescue' || request.kind === 'respond-card'
        ? { actionId: request.actionIds[request.actionIds.length - 1] }
        : { optionId: 'no', cardIds: [], targetIds: [] }
      game.respond({ requestId: request.id, playerId: request.playerId, payload })
      guard += 1
    }

    expect(playerOf(game, 'p0').usedLimitedSkills).toContain('yeyan')
    enterPlay(game, 'p0')
    expect(yeyanAction(game), '限定技用过就不再出现').toBeUndefined()
  })

  it('取消选目标不消耗限定技', () => {
    const game = gameWith(FIVE)
    clearHand(game, 'p0')
    giveHand(game, 'p0', fourSuits(game))
    enterPlay(game, 'p0')
    game.act('p0', yeyanAction(game)!.id)
    game.respond({ requestId: pending(game).id, playerId: 'p0', payload: { targetIds: [] } })
    expect(playerOf(game, 'p0').usedLimitedSkills, '取消不该把限定技用掉').not.toContain('yeyan')
    expect(yeyanAction(game)).toBeTruthy()
  })

  it('火焰伤害走统一管线：藤甲不挡火，反而加伤', () => {
    const game = gameWith(FIVE)
    clearHand(game, 'p0')
    giveHand(game, 'p0', Object.values(game.state.cards).filter((card) => card.suit === 'spade').slice(0, 2).map((card) => card.id))
    const vine = Object.values(game.state.cards).find((card) => card.name === '藤甲')!
    detach(game, vine.id)
    playerOf(game, 'p1').zones.equipment.armor = vine.id
    playerOf(game, 'p1').hp = 4
    enterPlay(game, 'p0')

    game.act('p0', yeyanAction(game)!.id)
    game.respond({ requestId: pending(game).id, playerId: 'p0', payload: { targetIds: ['p1', 'p2', 'p3'] } })
    const split = pending(game)
    game.respond({ requestId: split.id, playerId: 'p0', payload: { optionId: split.options[0].id } })
    let guard = 0
    while (pending(game) && guard < 12) {
      const request = pending(game)
      const payload = request.kind === 'rescue' || request.kind === 'respond-card'
        ? { actionId: request.actionIds[request.actionIds.length - 1] }
        : { optionId: 'no', cardIds: [], targetIds: [] }
      game.respond({ requestId: request.id, playerId: request.playerId, payload })
      guard += 1
    }
    // 藤甲对火焰伤害 +1，所以 1 点变 2 点——证明确实走了统一伤害管线
    expect(playerOf(game, 'p1').hp, '藤甲让火伤 +1').toBe(2)
  })
})

describe('业炎：代价这一步不能变成死循环', () => {
  function yeyanActionOf(game: SanguoshaGame) {
    return game.legalActions('p0').find((action) => action.kind === 'invoke-skill' && action.skillId === 'yeyan')
  }

  /**
   * 回归（seed=soak-5-178）：代价这一步交上来的四张牌花色有重复时，
   * 旧实现直接静默 return——限定技没被消耗，出牌阶段可以原样再发一次，
   * 于是「发动→选目标→选分配→交牌→发动…」无限转圈。
   * 代价是强制的，走到这一步就必须落地。
   */
  it('交上来的四张牌花色重复时兜底成合法的一组，技能照常消耗掉', () => {
    const game = gameWith(FIVE)
    clearHand(game, 'p0')
    // 四种花色各一张（保证付得起），外加两张重复花色供「交错」用
    const legal = fourSuits(game)
    const spades = Object.values(game.state.cards).filter((card) => card.suit === 'spade').slice(0, 3).map((card) => card.id)
    giveHand(game, 'p0', [...new Set([...legal, ...spades])])
    playerOf(game, 'p0').hp = 4
    playerOf(game, 'p0').maxHp = 4
    playerOf(game, 'p1').hp = 5
    playerOf(game, 'p1').maxHp = 5
    enterPlay(game, 'p0')

    game.act('p0', yeyanActionOf(game)!.id)
    game.respond({ requestId: pending(game).id, playerId: 'p0', payload: { targetIds: ['p1'] } })
    const split = pending(game)
    game.respond({ requestId: split.id, playerId: 'p0', payload: { optionId: split.options[0].id } })

    const cost = pending(game)
    expect(String(cost.prompt)).toContain('弃置四张')
    // 故意交一组花色重复的（三张黑桃 + 一张别的）
    const bad = [...spades, legal.find((cardId) => !spades.includes(cardId))!].slice(0, 4)
    game.respond({ requestId: cost.id, playerId: 'p0', payload: { cardIds: bad } })

    let guard = 0
    while (pending(game) && guard < 12) {
      const request = pending(game)
      game.respond({
        requestId: request.id, playerId: request.playerId,
        payload: request.kind === 'rescue' || request.kind === 'respond-card'
          ? { actionId: request.actionIds[request.actionIds.length - 1] }
          : { optionId: 'no', cardIds: [], targetIds: [] },
      })
      guard += 1
    }

    expect(playerOf(game, 'p0').hp, '代价的 3 点体力照失').toBe(1)
    expect(playerOf(game, 'p1').hp, '3 点火焰伤害照打').toBe(2)
    expect(
      yeyanActionOf(game),
      '限定技必须已经消耗掉——留着就是死循环的入口',
    ).toBeUndefined()
    assertCardConservation(game.state)
    assertGameInvariants(game.state)
  })
})
