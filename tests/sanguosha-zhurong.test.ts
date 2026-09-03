import { describe, expect, it } from 'vitest'
import { SanguoshaGame } from '@/sanguosha/engine/game'
import { assertGameInvariants } from '@/sanguosha/engine/invariants'
import { assertCardConservation } from '@/sanguosha/engine/zones'
import type { GameSetup, Identity, PlayerId, Suit } from '@/sanguosha/engine/types'

/**
 * 林包·祝融【巨象】【烈刃】。经典首版。
 *
 * 【巨象】的重点是**时序**：南蛮必须先完整结算完，实体牌才归祝融。
 * 提前抢走的话后面的目标就没牌可结算了，压测会直接抓到。
 *
 * 【烈刃】的重点是**不自己实现拼点**：拼点的暗选、揭示、比点、弃置
 * 全在 `engine/pindian.ts`，这里只验证「什么时候能发动、赢了拿什么」。
 */

function gameWith(characterIds: string[], seed = 'zhurong'): SanguoshaGame {
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
  game.state.currentPlayerId = 'p0'
  game.state.phase = 'play'
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
    player.zones.judgingArea = player.zones.judgingArea.filter((id) => id !== cardId)
  }
}

function findCard(game: SanguoshaGame, match: (card: { id: string; name: string; suit: Suit; rank: number; category: string }) => boolean): string {
  const card = Object.values(game.state.cards).find((candidate) => match(candidate))
  if (!card) throw new Error('这副牌里找不到符合条件的牌')
  return card.id
}

function giveCard(game: SanguoshaGame, playerId: PlayerId, cardId: string): string {
  detach(game, cardId)
  playerOf(game, playerId).zones.hand.push(cardId)
  return cardId
}

function clearHand(game: SanguoshaGame, playerId: PlayerId): void {
  const owner = playerOf(game, playerId)
  game.state.zones.discardPile.push(...owner.zones.hand)
  owner.zones.hand = []
}

/** 走完所有剩余请求：求牌一律放弃，技能选项一律取第一项。 */
function settle(game: SanguoshaGame): void {
  for (let guard = 0; guard < 120; guard += 1) {
    const request = pending(game)
    if (!request) return
    if (request.kind === 'respond-card') {
      game.respond({ requestId: request.id, playerId: request.playerId, payload: { actionId: 'respond-pass' } })
    } else if (request.kind === 'choose-option') {
      game.respond({ requestId: request.id, playerId: request.playerId, payload: { optionId: request.options[0].id } })
    } else if (request.kind === 'choose-targets') {
      game.respond({ requestId: request.id, playerId: request.playerId, payload: { targetIds: request.candidateIds.slice(0, Math.max(request.min, 1)) } })
    } else if (request.kind === 'choose-cards') {
      const pool = [...request.cardIds, ...request.hiddenCardSlots]
      game.respond({ requestId: request.id, playerId: request.playerId, payload: { cardIds: pool.slice(0, request.min) } })
    } else {
      game.respond({ requestId: request.id, playerId: request.playerId, payload: { actionId: 'rescue-pass' } })
    }
  }
  throw new Error('请求没有收敛')
}

/** 某人出南蛮，其余人不响应，走完整张牌。 */
function playNanman(game: SanguoshaGame, sourceId: PlayerId): string {
  const nanman = giveCard(game, sourceId, findCard(game, (card) => card.name === '南蛮入侵'))
  game.state.currentPlayerId = sourceId
  game.state.phase = 'play'
  game.act(sourceId, game.legalActions(sourceId).find((candidate) => candidate.id.startsWith(`play:${nanman}:`))!.id)
  settle(game)
  return nanman
}

const FIVE = ['zhurong', 'zhangfei', 'zhangfei', 'zhangfei', 'zhangfei']

describe('巨象：南蛮入侵对祝融无效', () => {
  it('祝融不受南蛮伤害，也不被要求出杀', () => {
    const game = gameWith(FIVE)
    for (const player of game.state.players) clearHand(game, player.id)
    const hpBefore = playerOf(game, 'p0').hp

    playNanman(game, 'p1')

    expect(playerOf(game, 'p0').hp).toBe(hpBefore)
  })

  it('和孟获祸首共用同一套无效机制，两人同时在场互不覆盖', () => {
    const game = gameWith(['zhurong', 'menghuo', 'zhangfei', 'zhangfei', 'zhangfei'])
    for (const player of game.state.players) clearHand(game, player.id)
    const damage: Array<{ sourceId: string | undefined; targetId: string | undefined }> = []
    game.events.on('Damaged', (context) => {
      if ((context.event.payload as { cardName?: unknown }).cardName !== '南蛮入侵') return
      damage.push({ sourceId: context.event.sourceId, targetId: context.event.targetId })
    })

    const nanman = playNanman(game, 'p2')

    expect(playerOf(game, 'p0').hp, '祝融免疫').toBe(4)
    expect(playerOf(game, 'p1').hp, '孟获免疫').toBe(4)
    expect(damage.map((entry) => entry.targetId).sort(), '只有另外两人挨打').toEqual(['p3', 'p4'])
    for (const entry of damage) expect(entry.sourceId, '伤害来源归孟获').toBe('p1')
    expect(playerOf(game, 'p0').zones.hand, '结算完南蛮归祝融').toContain(nanman)
    assertCardConservation(game.state)
    assertGameInvariants(game.state)
  })
})

describe('巨象：结算完毕后获得南蛮', () => {
  it('其他角色使用的南蛮结算结束后进入祝融手牌，而不是弃牌堆', () => {
    const game = gameWith(FIVE)
    for (const player of game.state.players) clearHand(game, player.id)

    const nanman = playNanman(game, 'p1')

    expect(playerOf(game, 'p0').zones.hand).toContain(nanman)
    expect(game.state.zones.discardPile).not.toContain(nanman)
    assertCardConservation(game.state)
    assertGameInvariants(game.state)
  })

  it('结算过程中南蛮仍在处理区，不会被提前拿走', () => {
    const game = gameWith(FIVE)
    for (const player of game.state.players) clearHand(game, player.id)
    const nanman = giveCard(game, 'p1', findCard(game, (card) => card.name === '南蛮入侵'))
    game.state.currentPlayerId = 'p1'
    game.act('p1', game.legalActions('p1').find((candidate) => candidate.id.startsWith(`play:${nanman}:`))!.id)

    // 第一个目标刚被问到求杀，这时候整张牌还没结算完
    expect(pending(game), '应该正卡在求杀上').toBeTruthy()
    expect(game.state.zones.processingArea, '南蛮此刻必须还在处理区').toContain(nanman)
    expect(playerOf(game, 'p0').zones.hand, '还没结算完就不能进祝融手牌').not.toContain(nanman)

    settle(game)
    expect(playerOf(game, 'p0').zones.hand, '结算完了才归祝融').toContain(nanman)
  })

  it('祝融自己使用的南蛮照常进弃牌堆', () => {
    const game = gameWith(FIVE)
    for (const player of game.state.players) clearHand(game, player.id)

    const nanman = playNanman(game, 'p0')

    expect(game.state.zones.discardPile).toContain(nanman)
    expect(playerOf(game, 'p0').zones.hand).not.toContain(nanman)
  })

  it('被无懈掉也照样获得——规则看的是「结算完毕」，不是「造成伤害」', () => {
    const game = gameWith(FIVE)
    for (const player of game.state.players) clearHand(game, player.id)
    const nanman = giveCard(game, 'p1', findCard(game, (card) => card.name === '南蛮入侵'))
    const wuxie = giveCard(game, 'p2', findCard(game, (card) => card.name === '无懈可击'))
    game.state.currentPlayerId = 'p1'
    game.act('p1', game.legalActions('p1').find((candidate) => candidate.id.startsWith(`play:${nanman}:`))!.id)

    // 无懈窗口出现时用掉，其余一律放弃
    for (let guard = 0; guard < 120; guard += 1) {
      const request = pending(game)
      if (!request) break
      const actionIds = (request as { actionIds?: string[] }).actionIds ?? []
      const nullify = actionIds.find((id) => id === `respond-nullification:${wuxie}`)
      game.respond({
        requestId: request.id, playerId: request.playerId,
        payload: nullify ? { actionId: nullify } : request.kind === 'choose-cards' ? { cardIds: [] } : { actionId: 'respond-pass' },
      })
    }

    expect(playerOf(game, 'p0').zones.hand, '有人被无懈保住也不影响巨象').toContain(nanman)
    assertCardConservation(game.state)
  })

  it('祝融死亡后不再获得南蛮', () => {
    const game = gameWith(FIVE)
    for (const player of game.state.players) clearHand(game, player.id)
    const zhurong = playerOf(game, 'p0')
    zhurong.alive = false
    zhurong.hp = 0

    const nanman = playNanman(game, 'p1')

    expect(game.state.zones.discardPile, '死人不拿牌，南蛮照常进弃牌堆').toContain(nanman)
    expect(zhurong.zones.hand).not.toContain(nanman)
  })
})

describe('烈刃：使用【杀】造成伤害后的拼点', () => {
  /**
   * 摆一次必中的【杀】：祝融手里放一张拼点用的牌 + 一张【杀】，
   * 受害者手里只留一张指定点数的非【闪】牌（能拼点，但闪不掉）。
   *
   * 顺序很重要：牌必须在**出杀之前**就位。烈刃是排队技能，杀一结算完队列立刻发问，
   * 「双方都有手牌」在发问前就已经判过一次，那之后再补牌已经晚了。
   */
  function stage(game: SanguoshaGame, options: { ownRank?: number; victimRank?: number } = {}): void {
    clearHand(game, 'p0')
    clearHand(game, 'p1')
    // 两边要的点数可能相同，必须避开同一张牌——否则给 p1 发牌时会把 p0 那张抽走，
    // 祝融手上就只剩【杀】，打完直接没牌拼点
    const used = new Set<string>()
    const take = (match: (card: { id: string; name: string; rank: number }) => boolean): string => {
      const cardId = findCard(game, (card) => match(card) && !used.has(card.id))
      used.add(cardId)
      return cardId
    }
    if (options.ownRank) giveCard(game, 'p0', take((card) => card.rank === options.ownRank && card.name !== '杀'))
    if (options.victimRank) giveCard(game, 'p1', take((card) => card.rank === options.victimRank && card.name !== '闪'))
    const slash = giveCard(game, 'p0', take((card) => card.name === '杀'))
    game.state.currentPlayerId = 'p0'
    game.state.phase = 'play'
    const action = game.legalActions('p0').find((candidate) => candidate.id === `play:${slash}:p1`)
    if (!action) throw new Error('杀没有产生对 p1 的动作')
    game.act('p0', action.id)
    const dodge = pending(game)
    if (dodge?.kind === 'respond-card') {
      game.respond({ requestId: dodge.id, playerId: 'p1', payload: { actionId: 'respond-pass' } })
    }
  }

  /** 双方各交出自己手上那张拼点牌。 */
  function submitPindian(game: SanguoshaGame): void {
    for (const playerId of ['p0', 'p1'] as const) {
      const request = game.state.pendingRequests.find(
        (candidate) => candidate.playerId === playerId && candidate.kind === 'choose-cards' && candidate.purpose === 'pindian',
      )
      if (!request) throw new Error(`${playerId} 没有收到拼点请求`)
      game.respond({ requestId: request.id, playerId, payload: { cardIds: [playerOf(game, playerId).zones.hand[0]] } })
    }
  }

  it('杀造成伤害后弹出烈刃询问', () => {
    const game = gameWith(FIVE)
    stage(game, { ownRank: 13, victimRank: 2 })

    const ask = pending(game)
    expect(ask?.kind).toBe('choose-option')
    expect(ask.prompt).toContain('烈刃')
  })

  it('拼点获胜时选牌请求里，对方手牌只以占位槽出现', () => {
    const game = gameWith(FIVE)
    stage(game, { ownRank: 13, victimRank: 2 })
    giveCard(game, 'p1', findCard(game, (card) => card.rank === 3 && card.name !== '闪'))

    game.respond({ requestId: pending(game).id, playerId: 'p0', payload: { optionId: 'yes' } })
    submitPindian(game)

    const gain = pending(game)
    expect(gain?.kind, '赢了应该弹出获得牌的请求').toBe('choose-cards')
    expect(gain.playerId, '选牌的是祝融').toBe('p0')
    expect(gain.cardIds, '对方没有装备，公开候选为空').toEqual([])
    expect(gain.hiddenCardSlots.length, '不许先看牌面再挑').toBe(playerOf(game, 'p1').zones.hand.length)
  })

  it('拿到的是真牌，且牌张守恒', () => {
    const game = gameWith(FIVE)
    stage(game, { ownRank: 13, victimRank: 2 })
    giveCard(game, 'p1', findCard(game, (card) => card.rank === 3 && card.name !== '闪'))

    game.respond({ requestId: pending(game).id, playerId: 'p0', payload: { optionId: 'yes' } })
    submitPindian(game)

    const gain = pending(game)
    const remaining = [...playerOf(game, 'p1').zones.hand]
    expect(remaining.length, '拼点弃掉一张后还剩一张').toBe(1)
    game.respond({ requestId: gain.id, playerId: 'p0', payload: { cardIds: [gain.hiddenCardSlots[0]] } })

    expect(playerOf(game, 'p0').zones.hand, '那张牌真的到了祝融手上').toContain(remaining[0])
    expect(playerOf(game, 'p1').zones.hand, '对方手上不能还留着同一张').not.toContain(remaining[0])
    assertCardConservation(game.state)
    assertGameInvariants(game.state)
  })

  it('可以拿对方的装备牌，装备离场走统一时机', () => {
    const game = gameWith(FIVE)
    stage(game, { ownRank: 13, victimRank: 2 })
    const lion = findCard(game, (card) => card.name === '白银狮子')
    detach(game, lion)
    const victim = playerOf(game, 'p1')
    victim.zones.equipment.armor = lion
    victim.hp = 2

    game.respond({ requestId: pending(game).id, playerId: 'p0', payload: { optionId: 'yes' } })
    submitPindian(game)

    const gain = pending(game)
    expect(gain.cardIds, '装备区是公开的，可以直接选').toContain(lion)
    game.respond({ requestId: gain.id, playerId: 'p0', payload: { cardIds: [lion] } })

    expect(playerOf(game, 'p0').zones.hand, '白银狮子进了祝融手牌').toContain(lion)
    expect(victim.zones.equipment.armor).toBeNull()
    expect(victim.hp, '失去白银狮子照常回一点体力').toBe(3)
    assertCardConservation(game.state)
  })

  it('拼点输了不拿牌', () => {
    const game = gameWith(FIVE)
    stage(game, { ownRank: 2, victimRank: 13 })
    const handBefore = playerOf(game, 'p1').zones.hand.length

    game.respond({ requestId: pending(game).id, playerId: 'p0', payload: { optionId: 'yes' } })
    submitPindian(game)

    expect(pending(game), '输了就不该再有获得牌的请求').toBeUndefined()
    expect(playerOf(game, 'p1').zones.hand.length, '只少了拼点那一张').toBe(handBefore - 1)
    assertCardConservation(game.state)
  })

  it('平局也不拿牌——「若你赢」不包含平局', () => {
    const game = gameWith(FIVE)
    stage(game, { ownRank: 7, victimRank: 7 })
    const handBefore = playerOf(game, 'p1').zones.hand.length

    game.respond({ requestId: pending(game).id, playerId: 'p0', payload: { optionId: 'yes' } })
    submitPindian(game)

    expect(pending(game), '平局不该弹出获得牌的请求').toBeUndefined()
    expect(playerOf(game, 'p1').zones.hand.length).toBe(handBefore - 1)
  })

  it('可以放弃发动', () => {
    const game = gameWith(FIVE)
    stage(game, { ownRank: 13, victimRank: 2 })
    game.respond({ requestId: pending(game).id, playerId: 'p0', payload: { optionId: 'no' } })
    expect(pending(game), '放弃之后不该留下任何请求').toBeUndefined()
    expect(game.state.pindian).toBeNull()
  })

  it('对方没有手牌就不发动，不弹空拼点', () => {
    const game = gameWith(FIVE)
    stage(game, { ownRank: 13 })
    expect(playerOf(game, 'p1').zones.hand, '受害者一张牌都没有').toEqual([])
    expect(pending(game), '不该弹出烈刃询问').toBeUndefined()
  })

  it('祝融自己打完杀就没牌了也不发动', () => {
    const game = gameWith(FIVE)
    stage(game, { victimRank: 2 })
    expect(playerOf(game, 'p0').zones.hand, '杀打出去之后祝融手上空了').toEqual([])
    expect(pending(game), '拼点双方都必须有手牌').toBeUndefined()
  })

  it('杀被闪掉就不触发烈刃', () => {
    const game = gameWith(FIVE)
    clearHand(game, 'p0')
    clearHand(game, 'p1')
    giveCard(game, 'p0', findCard(game, (card) => card.rank === 13 && card.name !== '杀'))
    const slash = giveCard(game, 'p0', findCard(game, (card) => card.name === '杀'))
    const dodgeCard = giveCard(game, 'p1', findCard(game, (card) => card.name === '闪'))
    game.state.currentPlayerId = 'p0'
    game.act('p0', game.legalActions('p0').find((candidate) => candidate.id === `play:${slash}:p1`)!.id)

    const request = pending(game)
    const play = (request as { actionIds: string[] }).actionIds.find((id) => id.includes(dodgeCard))
    expect(play, '应该能打出这张闪').toBeTruthy()
    game.respond({ requestId: request.id, playerId: 'p1', payload: { actionId: play! } })

    expect(playerOf(game, 'p1').hp, '闪掉了就没伤害').toBe(4)
    expect(pending(game), '没造成伤害就不该有烈刃询问').toBeUndefined()
  })

  it('目标被这一杀打死时不发动，也不向死人发拼点', () => {
    const game = gameWith(FIVE)
    playerOf(game, 'p1').hp = 1
    stage(game, { ownRank: 13, victimRank: 2 })
    settle(game)

    expect(playerOf(game, 'p1').alive, '目标应该已经阵亡').toBe(false)
    expect(game.state.pindian, '不该对死人发起拼点').toBeNull()
    assertCardConservation(game.state)
    assertGameInvariants(game.state)
  })

  it('用完拼点必须把状态和暗牌区清空，别的拼点技能才用得上', () => {
    const game = gameWith(['zhurong', 'zhangfei', 'xunyu', 'zhangfei', 'zhangfei'])
    stage(game, { ownRank: 13, victimRank: 2 })

    game.respond({ requestId: pending(game).id, playerId: 'p0', payload: { optionId: 'yes' } })
    submitPindian(game)
    settle(game)

    expect(game.state.pindian, '拼点结束后状态必须清空').toBeNull()
    expect(Object.keys(game.state.privateZones ?? {}), '暗选用的私有区必须关掉').toEqual([])
    assertCardConservation(game.state)
    assertGameInvariants(game.state)
  })
})
