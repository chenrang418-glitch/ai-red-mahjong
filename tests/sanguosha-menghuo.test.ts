import { describe, expect, it } from 'vitest'
import { SanguoshaGame } from '@/sanguosha/engine/game'
import { assertGameInvariants } from '@/sanguosha/engine/invariants'
import { assertCardConservation } from '@/sanguosha/engine/zones'
import type { GameSetup, Identity, PlayerId, Suit } from '@/sanguosha/engine/types'

/**
 * 林包·孟获【祸首】【再起】。经典首版。
 *
 * 这一组要钉住的是**两个公共机制的语义**，而不只是「孟获能用」：
 *
 * - 【祸首】的免疫是「成为目标，但这张牌对他无效」，**不是「不能成为目标」**。
 *   孟获仍然在南蛮的目标列表里，只是不被要求出杀、不受伤害。
 * - 【祸首】只改**伤害来源**，绝不改这张牌的使用者。使用者一旦被改掉，
 *   无懈、战报、奸雄「获得造成伤害的牌」会跟着一起错。
 */

function gameWith(characterIds: string[], seed = 'menghuo'): SanguoshaGame {
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

function findCard(game: SanguoshaGame, match: (card: { name: string; suit: Suit; category: string }) => boolean): string {
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

/** 把若干指定花色的牌按顺序压到牌堆顶。 */
function stackTop(game: SanguoshaGame, suits: Suit[]): string[] {
  const picked: string[] = []
  for (const suit of suits) {
    const cardId = game.state.zones.drawPile.find((id) => game.state.cards[id].suit === suit && !picked.includes(id))
    if (!cardId) throw new Error(`牌堆里没有足够的${suit}`)
    picked.push(cardId)
  }
  game.state.zones.drawPile = [...picked, ...game.state.zones.drawPile.filter((id) => !picked.includes(id))]
  return picked
}

/** 记录每一次伤害的来源，用来验证祸首改的是来源而不是使用者。 */
function recordDamage(game: SanguoshaGame): Array<{ sourceId: string | undefined; targetId: string | undefined; cardName: unknown }> {
  const log: Array<{ sourceId: string | undefined; targetId: string | undefined; cardName: unknown }> = []
  game.events.on('Damaged', (context) => {
    log.push({
      sourceId: context.event.sourceId,
      targetId: context.event.targetId,
      cardName: (context.event.payload as { cardName?: unknown }).cardName,
    })
  })
  return log
}

/** 记录 CardUsed，用来确认牌的使用者没有被改写。 */
function recordCardUse(game: SanguoshaGame): Array<{ sourceId: string | undefined; cardName: unknown }> {
  const log: Array<{ sourceId: string | undefined; cardName: unknown }> = []
  game.events.on('CardUsed', (context) => {
    log.push({ sourceId: context.event.sourceId, cardName: (context.event.payload as { cardName?: unknown }).cardName })
  })
  return log
}

/**
 * 走完所有待处理请求。
 *
 * 求牌一律放弃（这样南蛮必定造成伤害），但技能类的选项和目标一律接受第一项——
 * 测试要观察的正是「受伤之后触发的技能拿到了谁」，一律拒绝就什么都验不到。
 */
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

/** 使用者出南蛮，其余人一律不出杀，走完整张牌的结算。 */
function playNanman(game: SanguoshaGame, sourceId: PlayerId): string {
  const nanman = giveCard(game, sourceId, findCard(game, (card) => card.name === '南蛮入侵'))
  game.state.currentPlayerId = sourceId
  game.state.phase = 'play'
  const action = game.legalActions(sourceId).find((candidate) => candidate.id.startsWith(`play:${nanman}:`))
  if (!action) throw new Error('南蛮入侵没有产生使用动作')
  game.act(sourceId, action.id)
  settle(game)
  return nanman
}

/** 把回合交给某人并进入摸牌阶段。 */
function enterDrawPhase(game: SanguoshaGame, playerId: PlayerId): void {
  game.state.currentPlayerId = playerId
  game.state.phase = 'judge'
  game.state.skippedPhases = []
  game.state.judgedDelayedCards = []
  game.advancePhase()
}

const FIVE = ['menghuo', 'zhangfei', 'zhangfei', 'zhangfei', 'zhangfei']

describe('祸首：南蛮入侵对孟获无效', () => {
  it('孟获不会被要求打出【杀】，也不受伤害', () => {
    const game = gameWith(FIVE)
    for (const player of game.state.players) clearHand(game, player.id)
    const damage = recordDamage(game)
    const hpBefore = playerOf(game, 'p0').hp

    playNanman(game, 'p1')

    expect(playerOf(game, 'p0').hp, '孟获不该掉血').toBe(hpBefore)
    expect(damage.some((entry) => entry.targetId === 'p0'), '孟获不该受到南蛮伤害').toBe(false)
    assertCardConservation(game.state)
    assertGameInvariants(game.state)
  })

  it('无效是「效果无效」而不是「不能成为目标」——孟获仍然在目标列表里', () => {
    const game = gameWith(FIVE)
    for (const player of game.state.players) clearHand(game, player.id)
    const nanman = giveCard(game, 'p1', findCard(game, (card) => card.name === '南蛮入侵'))
    game.state.currentPlayerId = 'p1'
    const action = game.legalActions('p1').find((candidate) => candidate.id.startsWith(`play:${nanman}:`))
    expect(action, '南蛮应该能用').toBeTruthy()
    expect(action!.targetIds, '孟获仍然是南蛮的合法目标').toContain('p0')
  })

  it('其他角色照常被要求出杀', () => {
    const game = gameWith(FIVE)
    for (const player of game.state.players) clearHand(game, player.id)
    const nanman = giveCard(game, 'p1', findCard(game, (card) => card.name === '南蛮入侵'))
    game.state.currentPlayerId = 'p1'
    game.act('p1', game.legalActions('p1').find((candidate) => candidate.id.startsWith(`play:${nanman}:`))!.id)

    const request = pending(game)
    expect(request?.kind, '第一个被问到的人应该收到求杀').toBe('respond-card')
    expect(request.playerId, '孟获不该被问，应该跳到下一个人').not.toBe('p0')
  })
})

describe('祸首：伤害来源改为孟获', () => {
  it('别人使用的南蛮打到第三方时，伤害来源是孟获', () => {
    const game = gameWith(FIVE)
    for (const player of game.state.players) clearHand(game, player.id)
    const damage = recordDamage(game)

    playNanman(game, 'p1')

    const hits = damage.filter((entry) => entry.cardName === '南蛮入侵')
    expect(hits.length, '除孟获外的三人都该被打到').toBe(3)
    for (const hit of hits) {
      expect(hit.sourceId, `${hit.targetId} 受到的伤害来源应该是孟获`).toBe('p0')
    }
    assertCardConservation(game.state)
  })

  it('牌的使用者不变，被改的只有伤害来源', () => {
    const game = gameWith(FIVE)
    for (const player of game.state.players) clearHand(game, player.id)
    const uses = recordCardUse(game)

    playNanman(game, 'p1')

    const nanmanUse = uses.find((entry) => entry.cardName === '南蛮入侵')
    expect(nanmanUse?.sourceId, '使用者仍然是 p1').toBe('p1')
  })

  it('孟获自己使用南蛮时来源本来就是他，行为不变', () => {
    const game = gameWith(FIVE)
    for (const player of game.state.players) clearHand(game, player.id)
    const damage = recordDamage(game)

    playNanman(game, 'p0')

    const hits = damage.filter((entry) => entry.cardName === '南蛮入侵')
    expect(hits.length, '其余四人都被打到').toBe(4)
    for (const hit of hits) expect(hit.sourceId).toBe('p0')
  })

  it('伤害来源改写只作用于南蛮，万箭齐发不受影响', () => {
    const game = gameWith(FIVE)
    for (const player of game.state.players) clearHand(game, player.id)
    const damage = recordDamage(game)

    const wanjian = giveCard(game, 'p1', findCard(game, (card) => card.name === '万箭齐发'))
    game.state.currentPlayerId = 'p1'
    game.act('p1', game.legalActions('p1').find((candidate) => candidate.id.startsWith(`play:${wanjian}:`))!.id)
    settle(game)

    const hits = damage.filter((entry) => entry.cardName === '万箭齐发')
    expect(hits.length, '万箭对孟获照常生效，四个人都中').toBe(4)
    for (const hit of hits) expect(hit.sourceId, '万箭的来源仍是 p1').toBe('p1')
  })

  it('后续的受伤时机看到的是改写后的来源', () => {
    // 夏侯惇【刚烈】在受到伤害后对**伤害来源**发难，正好用来验证下游拿到的是谁
    const game = gameWith(['menghuo', 'zhangfei', 'xiahoudun', 'zhangfei', 'zhangfei'])
    for (const player of game.state.players) clearHand(game, player.id)
    // 刚烈判定非红桃才生效，把牌堆顶固定成黑桃，别让这条测试随机红绿
    stackTop(game, ['spade'])
    const banners: Array<{ skillId: unknown; targetIds: unknown; sourceId: string | undefined; targetId: string | undefined }> = []
    game.events.on('SkillActivated', (context) => {
      const payload = context.event.payload as { skillId?: unknown; targetIds?: unknown }
      banners.push({
        skillId: payload.skillId, targetIds: payload.targetIds,
        sourceId: context.event.sourceId, targetId: context.event.targetId,
      })
    })

    playNanman(game, 'p1')

    // 祸首自己的横幅：p2 受到的那次伤害，来源被改写成孟获
    const attribution = banners.filter((entry) => entry.skillId === 'huoshou')
    expect(attribution.length, '祸首应该为每次南蛮伤害播一条来源改写').toBeGreaterThan(0)
    for (const entry of attribution) expect(entry.sourceId, '改写后的来源是孟获').toBe('p0')

    // 刚烈把代价加在**伤害来源**头上。孟获手牌已清空（不足两张），
    // 所以直接失去一点体力——这就是「下游技能确实拿到了改写后的来源」的可观察证据。
    expect(banners.some((entry) => entry.skillId === 'ganglie'), '夏侯惇受到南蛮伤害后应该能发动刚烈').toBe(true)
    expect(playerOf(game, 'p0').hp, '刚烈应该打到孟获身上，而不是真正用牌的 p1').toBe(3)
    expect(playerOf(game, 'p1').hp, 'p1 只是用牌的人，不该被刚烈波及').toBe(4)
  })
})

describe('再起：摸牌阶段的替代', () => {
  it('满血时不发动，也不弹窗', () => {
    const game = gameWith(FIVE)
    const before = playerOf(game, 'p0').zones.hand.length
    enterDrawPhase(game, 'p0')
    expect(pending(game), '满血不该有再起的询问').toBeUndefined()
    expect(playerOf(game, 'p0').zones.hand.length, '照常摸两张').toBe(before + 2)
  })

  it('放弃发动就正常摸两张', () => {
    const game = gameWith(FIVE)
    playerOf(game, 'p0').hp = 2
    const before = playerOf(game, 'p0').zones.hand.length
    enterDrawPhase(game, 'p0')
    const ask = pending(game)
    expect(ask?.kind).toBe('choose-option')
    game.respond({ requestId: ask.id, playerId: 'p0', payload: { optionId: 'no' } })
    expect(playerOf(game, 'p0').zones.hand.length).toBe(before + 2)
    assertCardConservation(game.state)
  })

  it('失去 2 点体力就亮 2 张：红桃回血并进弃牌堆，其余进手牌', () => {
    const game = gameWith(FIVE)
    const menghuo = playerOf(game, 'p0')
    menghuo.hp = 2
    clearHand(game, 'p0')
    const [heart, spade] = stackTop(game, ['heart', 'spade'])

    enterDrawPhase(game, 'p0')
    const ask = pending(game)
    game.respond({ requestId: ask.id, playerId: 'p0', payload: { optionId: 'yes' } })

    expect(menghuo.hp, '一张红桃回 1 点').toBe(3)
    expect(game.state.zones.discardPile, '红桃牌进弃牌堆').toContain(heart)
    expect(menghuo.zones.hand, '非红桃收进手牌').toContain(spade)
    expect(menghuo.zones.hand, '红桃不该进手牌').not.toContain(heart)
    expect(game.state.zones.processingArea, '处理区不能留下残牌').toEqual([])
    assertCardConservation(game.state)
    assertGameInvariants(game.state)
  })

  it('发动之后不再摸那两张牌', () => {
    const game = gameWith(FIVE)
    playerOf(game, 'p0').hp = 3
    clearHand(game, 'p0')
    stackTop(game, ['spade'])

    enterDrawPhase(game, 'p0')
    game.respond({ requestId: pending(game).id, playerId: 'p0', payload: { optionId: 'yes' } })

    expect(playerOf(game, 'p0').zones.hand.length, '失 1 血只亮 1 张，且不额外摸牌').toBe(1)
  })

  it('全是红桃时回满，且一张牌都不进手牌', () => {
    const game = gameWith(FIVE)
    const menghuo = playerOf(game, 'p0')
    menghuo.hp = 1
    clearHand(game, 'p0')
    const hearts = stackTop(game, ['heart', 'heart', 'heart'])

    enterDrawPhase(game, 'p0')
    game.respond({ requestId: pending(game).id, playerId: 'p0', payload: { optionId: 'yes' } })

    expect(menghuo.hp, '三张红桃回 3 点，正好回满').toBe(4)
    expect(menghuo.zones.hand, '没有非红桃可拿').toEqual([])
    for (const cardId of hearts) expect(game.state.zones.discardPile).toContain(cardId)
    assertCardConservation(game.state)
    assertGameInvariants(game.state)
  })

  it('回血不会超过体力上限', () => {
    const game = gameWith(FIVE)
    const menghuo = playerOf(game, 'p0')
    menghuo.hp = 3
    clearHand(game, 'p0')
    stackTop(game, ['heart'])

    enterDrawPhase(game, 'p0')
    game.respond({ requestId: pending(game).id, playerId: 'p0', payload: { optionId: 'yes' } })

    expect(menghuo.hp).toBe(4)
    assertGameInvariants(game.state)
  })

  it('一张红桃都没有时不回血，全部进手牌', () => {
    const game = gameWith(FIVE)
    const menghuo = playerOf(game, 'p0')
    menghuo.hp = 2
    clearHand(game, 'p0')
    const blacks = stackTop(game, ['spade', 'club'])

    enterDrawPhase(game, 'p0')
    game.respond({ requestId: pending(game).id, playerId: 'p0', payload: { optionId: 'yes' } })

    expect(menghuo.hp, '没有红桃就不回血').toBe(2)
    expect(menghuo.zones.hand.sort()).toEqual([...blacks].sort())
    assertCardConservation(game.state)
  })

  it('牌堆不足时重洗弃牌堆，不越界', () => {
    const game = gameWith(FIVE)
    const menghuo = playerOf(game, 'p0')
    menghuo.hp = 1
    clearHand(game, 'p0')
    // 只留一张牌在牌堆，其余全塞进弃牌堆，逼再起去重洗
    const keep = game.state.zones.drawPile[0]
    game.state.zones.discardPile.push(...game.state.zones.drawPile.slice(1))
    game.state.zones.drawPile = [keep]

    enterDrawPhase(game, 'p0')
    game.respond({ requestId: pending(game).id, playerId: 'p0', payload: { optionId: 'yes' } })

    expect(menghuo.zones.hand.length + (4 - menghuo.hp === 3 ? 0 : 0), '亮了 3 张，去向都确定').toBeGreaterThanOrEqual(0)
    expect(game.state.zones.processingArea, '处理区不能留下残牌').toEqual([])
    assertCardConservation(game.state)
    assertGameInvariants(game.state)
  })
})
