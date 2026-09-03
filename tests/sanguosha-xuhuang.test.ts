import { describe, expect, it } from 'vitest'
import { SanguoshaGame } from '@/sanguosha/engine/game'
import { assertGameInvariants } from '@/sanguosha/engine/invariants'
import { assertCardConservation } from '@/sanguosha/engine/zones'
import type { GameSetup, Identity, PlayerId, Suit } from '@/sanguosha/engine/types'

/**
 * 林包·徐晃【断粮】。
 *
 * 采用**首版**技能文本：「你可以将一张黑色的基本牌或装备牌当【兵粮寸断】使用；
 * 你可以对与你距离 2 以内的角色使用【兵粮寸断】。」
 * 不是界徐晃的「对手牌数不小于你的角色无距离限制」，也没有【截辎】。
 *
 * 这一组钉住的核心是**断粮自己什么都不做**：它只提供一个转化和一个距离修正，
 * 之后那张【兵粮寸断】必须和实体牌走完全相同的公共管线——判定区唯一性、
 * 无懈窗口、改判、跳过摸牌阶段、结算后进弃牌堆。任何一条要是被技能私有实现
 * 绕过去了，下面就会有一条红。
 */

function gameWith(characterIds: string[], seed = 'xuhuang'): SanguoshaGame {
  const setup: GameSetup = {
    mode: 'identity', generalChoices: 1,
    players: Array.from({ length: characterIds.length }, (_, index) => ({ id: `p${index}`, nickname: `玩家${index}`, isHuman: false })),
  }
  const game = new SanguoshaGame({ seed, setup })
  const identities: Identity[] = ['lord', 'rebel', 'loyalist', 'rebel', 'renegade', 'rebel', 'loyalist']
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

/** 把某张牌从任何地方摘出来。 */
function detach(game: SanguoshaGame, cardId: string): void {
  game.state.zones.drawPile = game.state.zones.drawPile.filter((id) => id !== cardId)
  game.state.zones.discardPile = game.state.zones.discardPile.filter((id) => id !== cardId)
  for (const player of game.state.players) {
    player.zones.hand = player.zones.hand.filter((id) => id !== cardId)
    player.zones.judgingArea = player.zones.judgingArea.filter((id) => id !== cardId)
  }
}

function findCard(
  game: SanguoshaGame,
  match: (card: { name: string; suit: Suit; category: string; slot: string | undefined }) => boolean,
): string {
  const card = Object.values(game.state.cards).find((candidate) => match({ ...candidate, slot: candidate.equipmentSlot }))
  if (!card) throw new Error('这副牌里找不到符合条件的牌')
  return card.id
}

/** 把一张牌塞进某人手牌，返回牌 id。 */
function giveCard(game: SanguoshaGame, playerId: PlayerId, cardId: string): string {
  detach(game, cardId)
  playerOf(game, playerId).zones.hand.push(cardId)
  return cardId
}

/** 清空手牌，避免别的牌产生干扰动作。 */
function clearHand(game: SanguoshaGame, playerId: PlayerId): void {
  const owner = playerOf(game, playerId)
  game.state.zones.discardPile.push(...owner.zones.hand)
  owner.zones.hand = []
}

/** 徐晃把某张牌当兵粮打给某人的那条动作。 */
function duanliangAction(game: SanguoshaGame, cardId: string, targetId: PlayerId) {
  return game.legalActions('p0').find((action) => action.id === `play:viewas:${cardId}:${targetId}`)
}

/** 现在能被断粮指到的所有目标。 */
function duanliangTargets(game: SanguoshaGame, cardId: string): PlayerId[] {
  return game.legalActions('p0')
    .filter((action) => action.id.startsWith(`play:viewas:${cardId}:`))
    .map((action) => action.id.slice(`play:viewas:${cardId}:`.length))
}

/** 把牌堆顶换成指定花色，作为下一张判定牌。 */
function putSuitOnTop(game: SanguoshaGame, suit: Suit): string {
  const cardId = game.state.zones.drawPile.find((id) => game.state.cards[id].suit === suit)
  if (!cardId) throw new Error(`牌堆里没有${suit}`)
  game.state.zones.drawPile = [cardId, ...game.state.zones.drawPile.filter((id) => id !== cardId)]
  return cardId
}

/** 把回合交给某人并推进到判定阶段，走完无懈询问。 */
function runJudgePhaseOf(game: SanguoshaGame, playerId: PlayerId): void {
  game.state.currentPlayerId = playerId
  game.state.phase = 'prepare'
  game.state.skippedPhases = []
  game.state.judgedDelayedCards = []
  game.advancePhase()
  for (let guard = 0; guard < 20; guard += 1) {
    const request = pending(game)
    if (!request || request.kind !== 'respond-card') break
    game.respond({ requestId: request.id, playerId: request.playerId, payload: { actionId: 'respond-pass' } })
  }
}

const FIVE = ['xuhuang', 'zhangfei', 'zhangfei', 'zhangfei', 'zhangfei']
const SEVEN = ['xuhuang', 'zhangfei', 'zhangfei', 'zhangfei', 'zhangfei', 'zhangfei', 'zhangfei']

describe('断粮的牌源', () => {
  it('黑色基本牌可以当兵粮寸断', () => {
    const game = gameWith(FIVE)
    clearHand(game, 'p0')
    const spadeSlash = giveCard(game, 'p0', findCard(game, (card) => card.name === '杀' && card.suit === 'spade'))
    expect(duanliangAction(game, spadeSlash, 'p1'), '黑色【杀】应该能当兵粮').toBeTruthy()
  })

  it('黑色装备牌可以当兵粮寸断', () => {
    const game = gameWith(FIVE)
    clearHand(game, 'p0')
    const blackEquip = giveCard(game, 'p0', findCard(game, (card) => card.category === 'equipment' && (card.suit === 'spade' || card.suit === 'club')))
    expect(duanliangAction(game, blackEquip, 'p1'), '黑色装备牌应该能当兵粮').toBeTruthy()
  })

  it('红色牌不能当兵粮寸断', () => {
    const game = gameWith(FIVE)
    clearHand(game, 'p0')
    const redCard = giveCard(game, 'p0', findCard(game, (card) => card.category === 'basic' && (card.suit === 'heart' || card.suit === 'diamond')))
    expect(duanliangTargets(game, redCard), '红牌不该产生断粮动作').toEqual([])
  })

  it('黑色锦囊牌不能当兵粮寸断——技能文本只给了基本牌和装备牌', () => {
    const game = gameWith(FIVE)
    clearHand(game, 'p0')
    const blackTrick = giveCard(game, 'p0', findCard(game, (card) => card.category === 'trick' && (card.suit === 'spade' || card.suit === 'club')))
    expect(duanliangTargets(game, blackTrick), '黑锦囊不该产生断粮动作').toEqual([])
  })

  it('装备区里的黑色装备也能当兵粮寸断，技能文本没有限定手牌', () => {
    const game = gameWith(FIVE)
    clearHand(game, 'p0')
    const weapon = findCard(game, (card) => card.category === 'equipment' && card.slot === 'weapon' && (card.suit === 'spade' || card.suit === 'club'))
    detach(game, weapon)
    playerOf(game, 'p0').zones.equipment.weapon = weapon
    expect(duanliangAction(game, weapon, 'p1'), '装备区的黑武器应该能当兵粮').toBeTruthy()
  })

  it('判定区里的牌不是合法牌源', () => {
    const game = gameWith(FIVE)
    clearHand(game, 'p0')
    const spadeSlash = findCard(game, (card) => card.name === '杀' && card.suit === 'spade')
    detach(game, spadeSlash)
    playerOf(game, 'p0').zones.judgingArea.push(spadeSlash)
    expect(duanliangTargets(game, spadeSlash), '判定区的牌不该能被转化').toEqual([])
  })
})

describe('断粮的距离修正', () => {
  it('普通角色的兵粮寸断只能打距离 1 以内', () => {
    const game = gameWith(['zhangfei', 'zhangfei', 'zhangfei', 'zhangfei', 'zhangfei'])
    clearHand(game, 'p0')
    const bingliang = giveCard(game, 'p0', findCard(game, (card) => card.name === '兵粮寸断'))
    const targets = game.legalActions('p0')
      .filter((action) => action.id.startsWith(`play:${bingliang}:`))
      .map((action) => action.id.slice(`play:${bingliang}:`.length))
    expect(targets.sort(), '五人局距离 1 的只有两名邻座').toEqual(['p1', 'p4'])
  })

  it('徐晃凭断粮可以打到距离 2', () => {
    const game = gameWith(FIVE)
    clearHand(game, 'p0')
    const spadeSlash = giveCard(game, 'p0', findCard(game, (card) => card.name === '杀' && card.suit === 'spade'))
    expect(duanliangTargets(game, spadeSlash).sort(), '五人局其他四人都在距离 2 以内').toEqual(['p1', 'p2', 'p3', 'p4'])
  })

  it('超出修正后的距离仍然非法——断粮只加 1，不是无距离限制', () => {
    const game = gameWith(SEVEN)
    clearHand(game, 'p0')
    const spadeSlash = giveCard(game, 'p0', findCard(game, (card) => card.name === '杀' && card.suit === 'spade'))
    // 七人局：p1/p6 距离 1，p2/p5 距离 2，p3/p4 距离 3
    expect(duanliangTargets(game, spadeSlash).sort()).toEqual(['p1', 'p2', 'p5', 'p6'])
  })

  it('距离修正只作用于兵粮寸断，不会顺带放宽别的锦囊', () => {
    const game = gameWith(SEVEN)
    clearHand(game, 'p0')
    const shunshou = giveCard(game, 'p0', findCard(game, (card) => card.name === '顺手牵羊'))
    const targets = game.legalActions('p0')
      .filter((action) => action.id.startsWith(`play:${shunshou}:`))
      .map((action) => action.id.slice(`play:${shunshou}:`.length))
    expect(targets.sort(), '顺手牵羊仍然只能打距离 1').toEqual(['p1', 'p6'])
  })
})

describe('断粮转化出的兵粮寸断走公共延时锦囊管线', () => {
  it('底牌进入目标判定区，并且按兵粮寸断结算', () => {
    const game = gameWith(FIVE)
    clearHand(game, 'p0')
    const spadeSlash = giveCard(game, 'p0', findCard(game, (card) => card.name === '杀' && card.suit === 'spade'))

    game.act('p0', duanliangAction(game, spadeSlash, 'p2')!.id)

    expect(playerOf(game, 'p2').zones.judgingArea, '底牌应该进目标判定区').toContain(spadeSlash)
    expect(playerOf(game, 'p0').zones.hand, '底牌应该离开徐晃手牌').not.toContain(spadeSlash)
    assertCardConservation(game.state)
    assertGameInvariants(game.state)
  })

  it('判定非梅花时真正跳过摸牌阶段，而不是摸 0 张', () => {
    const game = gameWith(FIVE)
    clearHand(game, 'p0')
    const spadeSlash = giveCard(game, 'p0', findCard(game, (card) => card.name === '杀' && card.suit === 'spade'))
    game.act('p0', duanliangAction(game, spadeSlash, 'p2')!.id)

    putSuitOnTop(game, 'spade')
    const before = playerOf(game, 'p2').zones.hand.length
    runJudgePhaseOf(game, 'p2')

    expect(game.state.skippedPhases, '摸牌阶段应当被标记为跳过').toContain('draw')
    expect(playerOf(game, 'p2').zones.hand.length, '被跳过就一张都不该摸').toBe(before)
    expect(game.state.zones.discardPile, '判定完底牌进弃牌堆').toContain(spadeSlash)
    assertCardConservation(game.state)
  })

  it('判定为梅花时不跳过摸牌阶段', () => {
    const game = gameWith(FIVE)
    clearHand(game, 'p0')
    const spadeSlash = giveCard(game, 'p0', findCard(game, (card) => card.name === '杀' && card.suit === 'spade'))
    game.act('p0', duanliangAction(game, spadeSlash, 'p2')!.id)

    putSuitOnTop(game, 'club')
    runJudgePhaseOf(game, 'p2')

    expect(game.state.skippedPhases, '梅花判定不跳过摸牌').not.toContain('draw')
    assertCardConservation(game.state)
  })

  it('判定区已有兵粮寸断时不能再放第二张，实体牌和转化牌统一检查', () => {
    const game = gameWith(FIVE)
    clearHand(game, 'p0')
    const spadeSlash = giveCard(game, 'p0', findCard(game, (card) => card.name === '杀' && card.suit === 'spade'))
    const realBingliang = findCard(game, (card) => card.name === '兵粮寸断')
    detach(game, realBingliang)
    playerOf(game, 'p2').zones.judgingArea.push(realBingliang)

    expect(duanliangTargets(game, spadeSlash), 'p2 已经有兵粮，不该出现在目标里').not.toContain('p2')
    expect(duanliangTargets(game, spadeSlash), '别人照常可以').toContain('p1')
  })

  it('徐晃不能把兵粮寸断放到自己判定区', () => {
    const game = gameWith(FIVE)
    clearHand(game, 'p0')
    const spadeSlash = giveCard(game, 'p0', findCard(game, (card) => card.name === '杀' && card.suit === 'spade'))
    expect(duanliangTargets(game, spadeSlash), '延时锦囊不能对自己用（闪电除外）').not.toContain('p0')
  })

  it('判定前开无懈窗口，被无懈掉就只弃牌不跳过摸牌阶段', () => {
    const game = gameWith(FIVE)
    clearHand(game, 'p0')
    const spadeSlash = giveCard(game, 'p0', findCard(game, (card) => card.name === '杀' && card.suit === 'spade'))
    game.act('p0', duanliangAction(game, spadeSlash, 'p2')!.id)

    const wuxie = giveCard(game, 'p2', findCard(game, (card) => card.name === '无懈可击'))
    putSuitOnTop(game, 'spade')

    game.state.currentPlayerId = 'p2'
    game.state.phase = 'prepare'
    game.state.skippedPhases = []
    game.state.judgedDelayedCards = []
    game.advancePhase()

    const ask = pending(game)
    expect(ask?.kind, '判定牌翻开前必须先问无懈').toBe('respond-card')
    game.respond({ requestId: ask.id, playerId: 'p2', payload: { actionId: `respond-nullification:${wuxie}` } })
    // 反无懈窗口：其余人一律放弃
    for (let guard = 0; guard < 20; guard += 1) {
      const next = pending(game)
      if (!next || next.kind !== 'respond-card') break
      game.respond({ requestId: next.id, playerId: next.playerId, payload: { actionId: 'respond-pass' } })
    }

    expect(game.state.skippedPhases, '被无懈掉就不该跳过摸牌').not.toContain('draw')
    expect(game.state.zones.discardPile, '被无懈的兵粮寸断照样弃掉').toContain(spadeSlash)
    assertCardConservation(game.state)
  })

  it('鬼才可以改判断粮放下的兵粮寸断', () => {
    const game = gameWith(['xuhuang', 'zhangfei', 'simayi', 'zhangfei', 'zhangfei'])
    clearHand(game, 'p0')
    const spadeSlash = giveCard(game, 'p0', findCard(game, (card) => card.name === '杀' && card.suit === 'spade'))
    game.act('p0', duanliangAction(game, spadeSlash, 'p2')!.id)

    // 司马懿手上留一张梅花，用来把「跳过摸牌」改掉
    clearHand(game, 'p2')
    const club = giveCard(game, 'p2', findCard(game, (card) => card.suit === 'club' && card.name !== '兵粮寸断'))
    putSuitOnTop(game, 'spade')
    runJudgePhaseOf(game, 'p2')

    const retrial = pending(game)
    expect(retrial?.kind, '鬼才应该拿到改判请求').toBe('choose-cards')
    game.respond({ requestId: retrial.id, playerId: 'p2', payload: { cardIds: [club] } })
    for (let guard = 0; guard < 20; guard += 1) {
      const next = pending(game)
      if (!next) break
      game.respond({
        requestId: next.id,
        playerId: next.playerId,
        payload: next.kind === 'choose-cards' ? { cardIds: [] } : { actionId: 'respond-pass' },
      })
    }

    expect(game.state.skippedPhases, '改成梅花之后不该跳过摸牌').not.toContain('draw')
    assertCardConservation(game.state)
  })
})

describe('断粮拆自己的装备时仍走统一的失去装备时机', () => {
  it('把装备区的白银狮子当兵粮打出去会触发它的回血', () => {
    const game = gameWith(FIVE)
    clearHand(game, 'p0')
    const lion = findCard(game, (card) => card.name === '白银狮子')
    detach(game, lion)
    const xuhuang = playerOf(game, 'p0')
    xuhuang.zones.equipment.armor = lion
    xuhuang.hp = 2

    game.act('p0', duanliangAction(game, lion, 'p1')!.id)

    expect(xuhuang.zones.equipment.armor, '白银狮子应该已经离开装备区').toBeNull()
    expect(xuhuang.hp, '失去白银狮子要回复一点体力').toBe(3)
    expect(playerOf(game, 'p1').zones.judgingArea, '它现在是 p1 判定区里的兵粮寸断').toContain(lion)
    assertCardConservation(game.state)
    assertGameInvariants(game.state)
  })
})
