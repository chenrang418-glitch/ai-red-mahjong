import { describe, expect, it } from 'vitest'
import { SanguoshaGame } from '@/sanguosha/engine/game'
import { assertGameInvariants } from '@/sanguosha/engine/invariants'
import { assertCardConservation } from '@/sanguosha/engine/zones'
import { maxCardsOf } from '@/sanguosha/engine/phase'
import { getCharacter } from '@/sanguosha/data/characters/standard'
import type { GameSetup, Identity, PlayerId, Suit } from '@/sanguosha/engine/types'

/**
 * 林包·董卓【酒池】【肉林】【崩坏】【暴虐】。经典首版，8 体力。
 *
 * 四条最容易做错的地方：
 *
 * 1. **酒池转化出来的酒仍受「每回合一次」限制**，不能拿一手黑桃无限喝。
 * 2. **肉林两个方向都生效**，而且和无双撞在一起取 max，不是相加变四张闪。
 * 3. **崩坏「不是最低」并列时不触发**，写成「有人 ≤ 我」是错的。
 * 4. **暴虐的发动者是造成伤害的那名群势力角色**，不是董卓。
 */

function gameWith(characterIds: string[], seed = 'dongzhuo'): SanguoshaGame {
  const setup: GameSetup = {
    mode: 'identity', generalChoices: 1,
    players: Array.from({ length: characterIds.length }, (_, index) => ({ id: `p${index}`, nickname: `玩家${index}`, isHuman: false })),
  }
  const game = new SanguoshaGame({ seed, setup })
  const identities: Identity[] = ['lord', 'rebel', 'loyalist', 'rebel', 'renegade']
  game.state.players.forEach((player, index) => {
    player.identity = identities[index % identities.length]
    player.characterId = characterIds[index]
    /*
     * 直接塞 characterId 会绕过选将流程，而体力上限是在**选将的回应里**设的，
     * 不补这一句所有人都会停在默认的 4 血——董卓 8 血就测不出来了。
     * 主公 +1 是身份局规则，这里照抄引擎那一条。
     */
    const character = getCharacter(characterIds[index])!
    player.maxHp = character.maxHp + (player.identity === 'lord' ? 1 : 0)
    player.hp = player.maxHp
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

function findCard(game: SanguoshaGame, match: (card: { id: string; name: string; suit: Suit }) => boolean, used: Set<string> = new Set()): string {
  const card = Object.values(game.state.cards).find((candidate) => !used.has(candidate.id) && match(candidate))
  if (!card) throw new Error('这副牌里找不到符合条件的牌')
  used.add(card.id)
  return card.id
}

function give(game: SanguoshaGame, playerId: PlayerId, cardId: string): string {
  detach(game, cardId)
  playerOf(game, playerId).zones.hand.push(cardId)
  return cardId
}

function clearHand(game: SanguoshaGame, playerId: PlayerId): void {
  const owner = playerOf(game, playerId)
  game.state.zones.discardPile.push(...owner.zones.hand)
  owner.zones.hand = []
}

/** 把排队的技能发问放出来：从准备阶段推进到判定阶段，不会顺带冒出别的请求。 */
function settleQueue(game: SanguoshaGame): void {
  if (game.state.status !== 'playing' || game.state.pendingRequests.length > 0) return
  game.state.phase = 'prepare'
  game.state.skippedPhases = []
  game.state.judgedDelayedCards = []
  game.advancePhase()
}

const FIVE = ['dongzhuo', 'zhangfei', 'zhangfei', 'zhangfei', 'zhangfei']

describe('酒池：黑桃手牌当酒', () => {
  it('黑桃手牌产生一条「当【酒】使用」的动作', () => {
    const game = gameWith(FIVE)
    clearHand(game, 'p0')
    const spade = give(game, 'p0', findCard(game, (card) => card.suit === 'spade' && card.name !== '酒'))
    const action = game.legalActions('p0')
      .find((candidate) => candidate.kind === 'use-card' && candidate.asCardName === '酒' && candidate.cardIds.includes(spade))
    expect(action, '黑桃手牌应该能当酒').toBeTruthy()
  })

  it('非黑桃不行', () => {
    const game = gameWith(FIVE)
    clearHand(game, 'p0')
    const heart = give(game, 'p0', findCard(game, (card) => card.suit === 'heart' && card.name !== '酒'))
    expect(game.legalActions('p0').some((candidate) => candidate.kind === 'use-card' && candidate.asCardName === '酒' && candidate.cardIds.includes(heart))).toBe(false)
  })

  it('装备区的黑桃不行——文本写的是「黑桃手牌」', () => {
    const game = gameWith(FIVE)
    clearHand(game, 'p0')
    const spadeEquip = findCard(game, (card) => card.suit === 'spade' && Boolean(game.state.cards[card.id].equipmentSlot))
    detach(game, spadeEquip)
    playerOf(game, 'p0').zones.equipment.weapon = spadeEquip
    expect(game.legalActions('p0').some((candidate) => candidate.kind === 'use-card' && candidate.asCardName === '酒' && candidate.cardIds.includes(spadeEquip))).toBe(false)
  })

  it('转化出来的酒仍然受「每回合一次」限制', () => {
    const game = gameWith(FIVE)
    clearHand(game, 'p0')
    const used = new Set<string>()
    const first = give(game, 'p0', findCard(game, (card) => card.suit === 'spade' && card.name !== '酒', used))
    const second = give(game, 'p0', findCard(game, (card) => card.suit === 'spade' && card.name !== '酒', used))

    const wineAction = game.legalActions('p0')
      .find((candidate) => candidate.kind === 'use-card' && candidate.asCardName === '酒' && candidate.cardIds.includes(first))!
    game.act('p0', wineAction.id)
    expect(game.state.turnUsage.wineUses, '喝过一次').toBe(1)
    expect(
      game.legalActions('p0').some((candidate) => candidate.kind === 'use-card' && candidate.asCardName === '酒' && candidate.cardIds.includes(second)),
      '一手黑桃也只能喝一次',
    ).toBe(false)
    assertCardConservation(game.state)
  })
})

describe('肉林：与女性角色互相出杀需要两张闪', () => {
  /** p0 对 target 出一张杀，返回这次结算需要几张闪。 */
  function slashAndReadDodges(game: SanguoshaGame, sourceId: PlayerId, targetId: PlayerId): number {
    const slash = give(game, sourceId, findCard(game, (card) => card.name === '杀'))
    game.state.currentPlayerId = sourceId
    game.state.phase = 'play'
    const action = game.legalActions(sourceId).find((candidate) => candidate.id === `play:${slash}:${targetId}`)
    if (!action) throw new Error('没有产生对目标的杀')
    game.act(sourceId, action.id)
    return (game.state.cardResolution as { dodgeRemaining: number }).dodgeRemaining
  }

  it('董卓砍女性角色需要两张闪', () => {
    const game = gameWith(['dongzhuo', 'diaochan', 'zhangfei', 'zhangfei', 'zhangfei'])
    for (const player of game.state.players) clearHand(game, player.id)
    expect(slashAndReadDodges(game, 'p0', 'p1')).toBe(2)
  })

  it('董卓砍男性角色只需要一张闪', () => {
    const game = gameWith(FIVE)
    for (const player of game.state.players) clearHand(game, player.id)
    expect(slashAndReadDodges(game, 'p0', 'p1')).toBe(1)
  })

  it('女性角色砍董卓时，董卓也要两张闪', () => {
    const game = gameWith(['dongzhuo', 'diaochan', 'zhangfei', 'zhangfei', 'zhangfei'])
    for (const player of game.state.players) clearHand(game, player.id)
    expect(slashAndReadDodges(game, 'p1', 'p0')).toBe(2)
  })

  it('男性角色砍董卓只需要一张闪', () => {
    const game = gameWith(FIVE)
    for (const player of game.state.players) clearHand(game, player.id)
    expect(slashAndReadDodges(game, 'p1', 'p0')).toBe(1)
  })

  it('和无双撞在一起取 max，不会变成四张闪', () => {
    // 吕布是男性且有【无双】：他砍董卓时无双要求两张，肉林条件不成立，结果仍是 2
    const game = gameWith(['dongzhuo', 'lvbu', 'zhangfei', 'zhangfei', 'zhangfei'])
    for (const player of game.state.players) clearHand(game, player.id)
    expect(slashAndReadDodges(game, 'p1', 'p0'), '两个来源取 max 而不是相加').toBe(2)
  })

  it('两张闪要分两次响应，第一张不能直接抵消整次杀', () => {
    const game = gameWith(['dongzhuo', 'diaochan', 'zhangfei', 'zhangfei', 'zhangfei'])
    for (const player of game.state.players) clearHand(game, player.id)
    const used = new Set<string>()
    const dodgeA = give(game, 'p1', findCard(game, (card) => card.name === '闪', used))
    const dodgeB = give(game, 'p1', findCard(game, (card) => card.name === '闪', used))
    const slash = give(game, 'p0', findCard(game, (card) => card.name === '杀', used))
    const before = playerOf(game, 'p1').hp

    game.act('p0', `play:${slash}:p1`)
    const first = pending(game)
    expect(first?.kind).toBe('respond-card')
    const firstPlay = (first as { actionIds: string[] }).actionIds.find((id) => id.includes(dodgeA))!
    game.respond({ requestId: first.id, playerId: 'p1', payload: { actionId: firstPlay } })

    const second = pending(game)
    expect(second?.kind, '第一张闪之后还要再问一次').toBe('respond-card')
    const secondPlay = (second as { actionIds: string[] }).actionIds.find((id) => id.includes(dodgeB))!
    game.respond({ requestId: second.id, playerId: 'p1', payload: { actionId: secondPlay } })

    expect(playerOf(game, 'p1').hp, '两张闪打满，这一刀被抵消').toBe(before)
    assertCardConservation(game.state)
  })

  it('只打出一张闪仍然会中杀', () => {
    const game = gameWith(['dongzhuo', 'diaochan', 'zhangfei', 'zhangfei', 'zhangfei'])
    for (const player of game.state.players) clearHand(game, player.id)
    const used = new Set<string>()
    const dodge = give(game, 'p1', findCard(game, (card) => card.name === '闪', used))
    const slash = give(game, 'p0', findCard(game, (card) => card.name === '杀', used))
    const before = playerOf(game, 'p1').hp

    game.act('p0', `play:${slash}:p1`)
    const first = pending(game)
    const play = (first as { actionIds: string[] }).actionIds.find((id) => id.includes(dodge))!
    game.respond({ requestId: first.id, playerId: 'p1', payload: { actionId: play } })
    const second = pending(game)
    game.respond({ requestId: second.id, playerId: 'p1', payload: { actionId: 'respond-pass' } })

    expect(playerOf(game, 'p1').hp, '少一张闪照样中').toBe(before - 1)
    assertCardConservation(game.state)
  })
})

describe('崩坏：结束阶段的强制损耗', () => {
  /** 把回合推进到董卓的结束阶段。 */
  function enterFinish(game: SanguoshaGame): void {
    game.state.currentPlayerId = 'p0'
    game.state.phase = 'discard'
    game.state.skippedPhases = []
    game.state.judgedDelayedCards = []
    game.advancePhase()
  }

  it('董卓是全场体力最低时不触发', () => {
    const game = gameWith(FIVE)
    playerOf(game, 'p0').hp = 2
    for (const id of ['p1', 'p2', 'p3', 'p4']) playerOf(game, id).hp = 4
    enterFinish(game)
    expect(pending(game), '最低就不该触发').toBeUndefined()
  })

  it('并列最低也不触发——「不是最低」不包含并列', () => {
    const game = gameWith(FIVE)
    playerOf(game, 'p0').hp = 3
    playerOf(game, 'p1').hp = 3
    for (const id of ['p2', 'p3', 'p4']) playerOf(game, id).hp = 4
    enterFinish(game)
    expect(pending(game), '并列最低仍然算「是最低」').toBeUndefined()
  })

  it('不是最低时必须二选一，不能放弃', () => {
    const game = gameWith(FIVE)
    playerOf(game, 'p0').hp = 8
    enterFinish(game)
    const ask = pending(game)
    expect(ask?.kind).toBe('choose-option')
    expect(ask.optional, '锁定技不能放弃').toBe(false)
    expect(ask.options.map((option: { id: string }) => option.id)).toEqual(['benghuai-lose-hp', 'benghuai-lose-max'])
  })

  it('选失去体力：体力 -1，上限不变，且不触发受伤类技能', () => {
    const game = gameWith(['dongzhuo', 'zhangfei', 'xiahoudun', 'zhangfei', 'zhangfei'])
    const dongzhuo = playerOf(game, 'p0')
    dongzhuo.hp = 8
    let ganglie = 0
    game.events.on('SkillActivated', (context) => {
      if ((context.event.payload as { skillId?: unknown }).skillId === 'ganglie') ganglie += 1
    })
    enterFinish(game)
    game.respond({ requestId: pending(game).id, playerId: 'p0', payload: { optionId: 'benghuai-lose-hp' } })

    expect(dongzhuo.hp).toBe(7)
    expect(dongzhuo.maxHp, '上限不变').toBe(9)
    expect(ganglie, '失去体力不是受到伤害').toBe(0)
    assertGameInvariants(game.state)
  })

  it('选减体力上限：上限 -1，体力超出时被裁下来', () => {
    const game = gameWith(FIVE)
    const dongzhuo = playerOf(game, 'p0')
    // 主公 +1，所以上限是 9；把体力顶满
    dongzhuo.hp = dongzhuo.maxHp
    const maxBefore = dongzhuo.maxHp
    enterFinish(game)
    game.respond({ requestId: pending(game).id, playerId: 'p0', payload: { optionId: 'benghuai-lose-max' } })

    expect(dongzhuo.maxHp).toBe(maxBefore - 1)
    expect(dongzhuo.hp, '体力不能高于上限，超出的被裁掉').toBe(maxBefore - 1)
    assertGameInvariants(game.state)
  })

  it('减上限时体力低于新上限则不受影响', () => {
    const game = gameWith(FIVE)
    const dongzhuo = playerOf(game, 'p0')
    dongzhuo.hp = 5
    const maxBefore = dongzhuo.maxHp
    enterFinish(game)
    game.respond({ requestId: pending(game).id, playerId: 'p0', payload: { optionId: 'benghuai-lose-max' } })

    expect(dongzhuo.maxHp).toBe(maxBefore - 1)
    expect(dongzhuo.hp, '5 仍然低于新上限，不动').toBe(5)
    assertGameInvariants(game.state)
  })

  it('手牌上限跟着当前体力走，减上限裁到体力时一起变', () => {
    const game = gameWith(FIVE)
    const dongzhuo = playerOf(game, 'p0')
    dongzhuo.hp = dongzhuo.maxHp
    const before = maxCardsOf(game.state, 'p0')
    enterFinish(game)
    game.respond({ requestId: pending(game).id, playerId: 'p0', payload: { optionId: 'benghuai-lose-max' } })
    expect(maxCardsOf(game.state, 'p0'), '手牌上限读的是同一个入口').toBe(before - 1)
  })

  it('掉血走的是失去体力，会正常压到濒死边界', () => {
    const game = gameWith(FIVE)
    const dongzhuo = playerOf(game, 'p0')
    // 董卓 2 血、别人 1 血：他不是最低，会触发崩坏
    dongzhuo.hp = 2
    playerOf(game, 'p1').hp = 1
    for (const id of ['p2', 'p3', 'p4']) playerOf(game, id).hp = 4
    enterFinish(game)
    game.respond({ requestId: pending(game).id, playerId: 'p0', payload: { optionId: 'benghuai-lose-hp' } })
    expect(dongzhuo.hp).toBe(1)
    expect(dongzhuo.alive).toBe(true)
    assertGameInvariants(game.state)
  })
})

describe('暴虐：其他群势力角色造成伤害后', () => {
  const LORD_DONGZHUO = ['dongzhuo', 'zhangjiao', 'zhangfei', 'zhangfei', 'zhangfei']

  /** 把牌堆顶换成指定花色，作为下一张判定牌。 */
  function stackJudge(game: SanguoshaGame, suit: Suit): void {
    const top = game.state.zones.drawPile.find((id) => game.state.cards[id].suit === suit)!
    game.state.zones.drawPile = [top, ...game.state.zones.drawPile.filter((id) => id !== top)]
  }

  it('问的是造成伤害的那名群势力角色，不是董卓', () => {
    const game = gameWith(LORD_DONGZHUO)
    playerOf(game, 'p0').hp = 5
    game.damage({ sourceId: 'p1', targetId: 'p2', amount: 1, cardName: '杀' })
    settleQueue(game)

    const ask = pending(game)
    expect(ask?.kind).toBe('choose-option')
    expect(ask.prompt).toContain('暴虐')
    expect(ask.playerId, '决定权在造成伤害的群角色手上').toBe('p1')
  })

  it('判定为黑桃时董卓回复一点体力', () => {
    const game = gameWith(LORD_DONGZHUO)
    const dongzhuo = playerOf(game, 'p0')
    dongzhuo.hp = 5
    game.damage({ sourceId: 'p1', targetId: 'p2', amount: 1, cardName: '杀' })
    settleQueue(game)
    stackJudge(game, 'spade')
    game.respond({ requestId: pending(game).id, playerId: 'p1', payload: { optionId: 'yes' } })
    // 判定可能引出改判询问，一律放弃
    for (let guard = 0; guard < 20; guard += 1) {
      const request = pending(game)
      if (!request) break
      game.respond({ requestId: request.id, playerId: request.playerId, payload: request.kind === 'choose-cards' ? { cardIds: [] } : { actionId: 'respond-pass' } })
    }
    expect(dongzhuo.hp, '黑桃回一点').toBe(6)
    assertCardConservation(game.state)
  })

  it('判定不是黑桃就不回血', () => {
    const game = gameWith(LORD_DONGZHUO)
    const dongzhuo = playerOf(game, 'p0')
    dongzhuo.hp = 5
    game.damage({ sourceId: 'p1', targetId: 'p2', amount: 1, cardName: '杀' })
    settleQueue(game)
    stackJudge(game, 'heart')
    game.respond({ requestId: pending(game).id, playerId: 'p1', payload: { optionId: 'yes' } })
    for (let guard = 0; guard < 20; guard += 1) {
      const request = pending(game)
      if (!request) break
      game.respond({ requestId: request.id, playerId: request.playerId, payload: request.kind === 'choose-cards' ? { cardIds: [] } : { actionId: 'respond-pass' } })
    }
    expect(dongzhuo.hp).toBe(5)
  })

  it('非群势力角色造成伤害不触发', () => {
    const game = gameWith(['dongzhuo', 'zhangfei', 'zhangfei', 'zhangfei', 'zhangfei'])
    playerOf(game, 'p0').hp = 5
    game.damage({ sourceId: 'p1', targetId: 'p2', amount: 1, cardName: '杀' })
    settleQueue(game)
    expect(pending(game), '张飞是蜀，不该触发').toBeUndefined()
  })

  it('董卓自己造成伤害不触发——文本是「其他群势力角色」', () => {
    const game = gameWith(LORD_DONGZHUO)
    playerOf(game, 'p0').hp = 5
    game.damage({ sourceId: 'p0', targetId: 'p2', amount: 1, cardName: '杀' })
    settleQueue(game)
    expect(pending(game)).toBeUndefined()
  })

  it('董卓不是主公时不生效', () => {
    const game = gameWith(LORD_DONGZHUO)
    playerOf(game, 'p0').identity = 'rebel'
    playerOf(game, 'p1').identity = 'lord'
    playerOf(game, 'p0').hp = 5
    game.damage({ sourceId: 'p1', targetId: 'p2', amount: 1, cardName: '杀' })
    settleQueue(game)
    expect(pending(game), '主公技只在坐主公位时生效').toBeUndefined()
  })

  it('一次伤害事件只判一次，挨两点也只问一次', () => {
    const game = gameWith(LORD_DONGZHUO)
    playerOf(game, 'p0').hp = 5
    playerOf(game, 'p2').hp = 4
    game.damage({ sourceId: 'p1', targetId: 'p2', amount: 2, cardName: '杀' })
    settleQueue(game)
    const ask = pending(game)
    expect(ask?.prompt).toContain('暴虐')
    game.respond({ requestId: ask.id, playerId: 'p1', payload: { optionId: 'no' } })
    expect(pending(game), '一次伤害只问一次').toBeUndefined()
  })
})
