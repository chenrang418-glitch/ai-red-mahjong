import { describe, expect, it } from 'vitest'
import { SanguoshaGame } from '@/sanguosha/engine/game'
import { assertCardConservation } from '@/sanguosha/engine/zones'
import type { GameSetup, Identity, PlayerId, Suit } from '@/sanguosha/engine/types'

/**
 * 神吕蒙。经典「神话再临·神」版本。
 *
 * 两条重点：
 *
 * 1. **涉猎是摸牌阶段替代**，不是「摸两张之外再亮五张」；摸牌阶段被跳过时
 *    根本不该有机会发动。「每种花色各一张」由候选集合保证，同花色多张时玩家自己选。
 * 2. **攻心看到的是全部手牌，而且只有神吕蒙看得到**——第三方连这条请求都看不到。
 *    置于牌堆顶必须是真实移动，下一张摸到的就是它。
 */

function gameWith(characterIds: string[], seed = 'shenlvmeng'): SanguoshaGame {
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
  game.state.zones.processingArea = game.state.zones.processingArea.filter((id) => id !== cardId)
  for (const player of game.state.players) {
    player.zones.hand = player.zones.hand.filter((id) => id !== cardId)
    player.zones.judgingArea = player.zones.judgingArea.filter((id) => id !== cardId)
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

/** 找 N 张指定花色的牌（互不重复）。 */
function cardsOfSuit(game: SanguoshaGame, suit: Suit, count: number, exclude: string[] = []): string[] {
  const found = Object.values(game.state.cards)
    .filter((card) => card.suit === suit && !exclude.includes(card.id))
    .slice(0, count)
    .map((card) => card.id)
  if (found.length < count) throw new Error(`${suit} 不够 ${count} 张`)
  return found
}

/** 把指定的牌按顺序摆到牌堆顶，亮牌时必定翻到它们。 */
function stackTop(game: SanguoshaGame, cardIds: string[]): void {
  for (const cardId of cardIds) detach(game, cardId)
  game.state.zones.drawPile.unshift(...cardIds)
}

/** 进入摸牌阶段（走真实阶段状态机，涉猎挂在 DrawPhase 上）。 */
function enterDraw(game: SanguoshaGame, playerId: PlayerId): void {
  game.state.currentPlayerId = playerId
  game.state.normalTurnPlayerId = playerId
  game.state.currentTurnKind = 'normal'
  game.state.phase = 'judge'
  game.state.skippedPhases = []
  game.state.judgedDelayedCards = []
  game.advancePhase()
}

function enterPlay(game: SanguoshaGame, playerId: PlayerId): void {
  game.state.currentPlayerId = playerId
  game.state.normalTurnPlayerId = playerId
  game.state.currentTurnKind = 'normal'
  game.state.phase = 'play'
  game.state.skippedPhases = []
  for (const player of game.state.players) player.turnUsedSkills = []
}

const FIVE = ['shenlvmeng', 'zhangfei', 'zhangfei', 'zhangfei', 'zhangfei']

describe('涉猎：摸牌阶段替代', () => {
  it('摸牌阶段弹出发动询问；放弃则正常摸两张', () => {
    const game = gameWith(FIVE)
    clearHand(game, 'p0')
    enterDraw(game, 'p0')
    const ask = pending(game)
    expect(ask?.kind).toBe('choose-option')
    expect(String(ask.prompt)).toContain('涉猎')

    game.respond({ requestId: ask.id, playerId: 'p0', payload: { optionId: 'no' } })
    expect(playerOf(game, 'p0').zones.hand.length, '放弃就正常摸两张').toBe(2)
    assertCardConservation(game.state)
  })

  it('摸牌阶段被跳过时根本不会触发', () => {
    const game = gameWith(FIVE)
    clearHand(game, 'p0')
    game.state.currentPlayerId = 'p0'
    game.state.normalTurnPlayerId = 'p0'
    game.state.currentTurnKind = 'normal'
    game.state.phase = 'judge'
    game.state.skippedPhases = ['draw']
    game.advancePhase()
    expect(pending(game), '摸牌阶段被跳过就不该有涉猎窗口').toBeUndefined()
    expect(playerOf(game, 'p0').zones.hand.length, '也不该摸到牌').toBe(0)
  })

  it('四种花色齐全：拿满四张，其余进弃牌堆', () => {
    const game = gameWith(FIVE)
    clearHand(game, 'p0')
    // 牌堆顶摆成 ♠♥♣♦♠：四种花色，黑桃两张
    const spades = cardsOfSuit(game, 'spade', 2)
    const heart = cardsOfSuit(game, 'heart', 1, spades)
    const club = cardsOfSuit(game, 'club', 1, [...spades, ...heart])
    const diamond = cardsOfSuit(game, 'diamond', 1, [...spades, ...heart, ...club])
    const top = [spades[0], heart[0], club[0], diamond[0], spades[1]]
    stackTop(game, top)

    enterDraw(game, 'p0')
    game.respond({ requestId: pending(game).id, playerId: 'p0', payload: { optionId: 'yes' } })

    // 逐张挑：每次候选里只剩还没拿过的花色
    let guard = 0
    while (pending(game)?.kind === 'choose-cards' && guard < 8) {
      const request = pending(game)
      game.respond({ requestId: request.id, playerId: 'p0', payload: { cardIds: [request.cardIds[0]] } })
      guard += 1
    }

    const hand = playerOf(game, 'p0').zones.hand
    expect(hand.length, '四种花色各一张').toBe(4)
    const suits = hand.map((cardId) => game.state.cards[cardId].suit)
    expect(new Set(suits).size, '拿到的四张必须花色互不相同').toBe(4)
    // 第五张（多出来的那张黑桃）进弃牌堆
    expect(game.state.zones.discardPile).toContain(spades[1])
    expect(game.state.zones.processingArea, '处理区不能留下牌').toHaveLength(0)
    assertCardConservation(game.state)
  })

  it('只有两种花色：只能拿两张', () => {
    const game = gameWith(FIVE)
    clearHand(game, 'p0')
    const spades = cardsOfSuit(game, 'spade', 3)
    const hearts = cardsOfSuit(game, 'heart', 2, spades)
    stackTop(game, [...spades, ...hearts])

    enterDraw(game, 'p0')
    game.respond({ requestId: pending(game).id, playerId: 'p0', payload: { optionId: 'yes' } })
    let guard = 0
    while (pending(game)?.kind === 'choose-cards' && guard < 8) {
      const request = pending(game)
      game.respond({ requestId: request.id, playerId: 'p0', payload: { cardIds: [request.cardIds[0]] } })
      guard += 1
    }
    expect(playerOf(game, 'p0').zones.hand.length, '只有两种花色就只能拿两张').toBe(2)
    assertCardConservation(game.state)
  })

  it('同花色多张时由玩家自己选：候选里同时列出这几张', () => {
    const game = gameWith(FIVE)
    clearHand(game, 'p0')
    const spades = cardsOfSuit(game, 'spade', 3)
    const hearts = cardsOfSuit(game, 'heart', 2, spades)
    stackTop(game, [...spades, ...hearts])

    enterDraw(game, 'p0')
    game.respond({ requestId: pending(game).id, playerId: 'p0', payload: { optionId: 'yes' } })
    const first = pending(game)
    expect(first.kind).toBe('choose-cards')
    // 五张全在候选里（还没拿过任何花色）
    expect(first.cardIds.length).toBe(5)

    // 先拿一张黑桃，下一轮候选里就不该再有黑桃
    game.respond({ requestId: first.id, playerId: 'p0', payload: { cardIds: [spades[0]] } })
    const second = pending(game)
    expect(second.kind).toBe('choose-cards')
    for (const cardId of second.cardIds) {
      expect(game.state.cards[cardId].suit, '拿过的花色不能再出现在候选里').not.toBe('spade')
    }
  })

  it('拿完之后阶段照常往下走', () => {
    const game = gameWith(FIVE)
    clearHand(game, 'p0')
    enterDraw(game, 'p0')
    game.respond({ requestId: pending(game).id, playerId: 'p0', payload: { optionId: 'yes' } })
    let guard = 0
    while (pending(game)?.kind === 'choose-cards' && guard < 8) {
      const request = pending(game)
      game.respond({ requestId: request.id, playerId: 'p0', payload: { cardIds: [request.cardIds[0]] } })
      guard += 1
    }
    expect(game.state.phase, '涉猎结束后进入出牌阶段').toBe('play')
  })
})

describe('攻心：看牌与处置', () => {
  function invokeGongxin(game: SanguoshaGame, targetId: PlayerId) {
    enterPlay(game, 'p0')
    const action = game.legalActions('p0').find((candidate) => (
      candidate.kind === 'invoke-skill' && candidate.skillId === 'gongxin'
    ))
    if (!action) throw new Error('攻心动作没有生成')
    game.act('p0', action.id)
    const request = pending(game)
    game.respond({ requestId: request.id, playerId: 'p0', payload: { targetIds: [targetId] } })
  }

  it('出牌阶段限一次；没有手牌的角色不进候选', () => {
    const game = gameWith(FIVE)
    for (const id of ['p1', 'p2', 'p3', 'p4']) clearHand(game, id)
    giveHand(game, 'p1', cardsOfSuit(game, 'heart', 1))
    enterPlay(game, 'p0')

    const action = game.legalActions('p0').find((candidate) => (
      candidate.kind === 'invoke-skill' && candidate.skillId === 'gongxin'
    ))!
    game.act('p0', action.id)
    const request = pending(game)
    expect(request.candidateIds, '只有 p1 有手牌').toEqual(['p1'])
    game.respond({ requestId: request.id, playerId: 'p0', payload: { targetIds: ['p1'] } })
    // 跑完剩下的步骤
    let guard = 0
    while (pending(game) && guard < 6) {
      const next = pending(game)
      const payload = next.kind === 'choose-cards' ? { cardIds: [] } : { optionId: 'gongxin-discard' }
      game.respond({ requestId: next.id, playerId: next.playerId, payload })
      guard += 1
    }
    enterPlay(game, 'p0')
    playerOf(game, 'p0').turnUsedSkills = ['gongxin']
    expect(
      game.legalActions('p0').some((candidate) => candidate.kind === 'invoke-skill' && candidate.skillId === 'gongxin'),
      '一个出牌阶段只能攻心一次',
    ).toBe(false)
  })

  it('看到的是目标全部手牌里的红桃，且请求只发给神吕蒙', () => {
    const game = gameWith(FIVE)
    clearHand(game, 'p1')
    const hearts = cardsOfSuit(game, 'heart', 2)
    const spade = cardsOfSuit(game, 'spade', 1, hearts)
    giveHand(game, 'p1', [...hearts, ...spade])

    invokeGongxin(game, 'p1')
    const view = pending(game)
    expect(view.kind).toBe('choose-cards')
    expect(view.playerId, '请求发给神吕蒙自己').toBe('p0')
    expect(view.cardIds.sort(), '候选是目标手上的红桃').toEqual([...hearts].sort())

    // **隐私**：第三方的 PlayerView 里既看不到这条请求，也看不到目标手牌
    const outsider = game.viewFor('p2')
    expect(outsider.pendingRequest, '别人看不到神吕蒙的攻心请求').toBeNull()
    expect(outsider.players.find((player) => player.id === 'p1')!.hand, '别人看不到 p1 的手牌').toBeNull()
    const owner = game.viewFor('p0')
    expect(owner.pendingRequest, '神吕蒙自己看得到').not.toBeNull()
  })

  it('目标没有红桃：仍然看得到手牌，之后没有可处理的牌', () => {
    const game = gameWith(FIVE)
    clearHand(game, 'p1')
    giveHand(game, 'p1', cardsOfSuit(game, 'spade', 2))

    invokeGongxin(game, 'p1')
    const view = pending(game)
    expect(view.kind, '没有红桃也要给他看完').toBe('choose-cards')
    expect(view.cardIds, '但没有可处理的红桃').toEqual([])
    expect(view.max).toBe(0)
    game.respond({ requestId: view.id, playerId: 'p0', payload: { cardIds: [] } })
    expect(pending(game), '看完就结束，不强行弃牌 / 置顶').toBeUndefined()
  })

  it('弃置：牌真的进弃牌堆', () => {
    const game = gameWith(FIVE)
    clearHand(game, 'p1')
    const heart = cardsOfSuit(game, 'heart', 1)[0]
    giveHand(game, 'p1', [heart])

    invokeGongxin(game, 'p1')
    game.respond({ requestId: pending(game).id, playerId: 'p0', payload: { cardIds: [heart] } })
    game.respond({ requestId: pending(game).id, playerId: 'p0', payload: { optionId: 'gongxin-discard' } })

    expect(playerOf(game, 'p1').zones.hand, '牌离开目标手牌').not.toContain(heart)
    expect(game.state.zones.discardPile).toContain(heart)
    assertCardConservation(game.state)
  })

  it('置于牌堆顶：真实移动，下一张摸到的就是它', () => {
    const game = gameWith(FIVE)
    clearHand(game, 'p1')
    const heart = cardsOfSuit(game, 'heart', 1)[0]
    giveHand(game, 'p1', [heart])

    invokeGongxin(game, 'p1')
    game.respond({ requestId: pending(game).id, playerId: 'p0', payload: { cardIds: [heart] } })
    game.respond({ requestId: pending(game).id, playerId: 'p0', payload: { optionId: 'gongxin-topdeck' } })

    expect(playerOf(game, 'p1').zones.hand).not.toContain(heart)
    expect(game.state.zones.drawPile[0], '置顶之后下一张就是它').toBe(heart)
    expect(game.state.zones.discardPile, '不是复制，也不路过弃牌堆').not.toContain(heart)
    assertCardConservation(game.state)
  })

  it('取消选目标不消耗次数', () => {
    const game = gameWith(FIVE)
    enterPlay(game, 'p0')
    const action = game.legalActions('p0').find((candidate) => (
      candidate.kind === 'invoke-skill' && candidate.skillId === 'gongxin'
    ))!
    game.act('p0', action.id)
    game.respond({ requestId: pending(game).id, playerId: 'p0', payload: { targetIds: [] } })
    expect(
      game.legalActions('p0').some((candidate) => candidate.kind === 'invoke-skill' && candidate.skillId === 'gongxin'),
      '取消不该把这一次用掉',
    ).toBe(true)
  })

  it('攻心过程可以序列化恢复，恢复后隐私仍然成立', () => {
    const game = gameWith(FIVE)
    clearHand(game, 'p1')
    const heart = cardsOfSuit(game, 'heart', 1)[0]
    giveHand(game, 'p1', [heart])
    invokeGongxin(game, 'p1')

    const restored = SanguoshaGame.restore(JSON.parse(JSON.stringify(game.serialize())))
    expect(restored.viewFor('p2').pendingRequest, '恢复之后第三方仍然看不到').toBeNull()
    const view = restored.state.pendingRequests[0]
    expect(view.playerId).toBe('p0')
    restored.respond({ requestId: view.id, playerId: 'p0', payload: { cardIds: [heart] } })
    restored.respond({ requestId: restored.state.pendingRequests[0].id, playerId: 'p0', payload: { optionId: 'gongxin-discard' } })
    expect(restored.state.zones.discardPile).toContain(heart)
    assertCardConservation(restored.state)
  })
})
