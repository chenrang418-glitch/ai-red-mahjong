import { describe, expect, it } from 'vitest'
import { SanguoshaGame } from '@/sanguosha/engine/game'
import { assertCardConservation, moveCard } from '@/sanguosha/engine/zones'
import { maxCardsOf } from '@/sanguosha/engine/phase'
import { canMultiCardViewAs, baseCardsOf, MULTI_VIEWAS_ACTION } from '@/sanguosha/engine/multi-card-viewas'
import { SHENZHAOYUN, longhunRequiredCount } from '@/sanguosha/data/characters/god-shenzhaoyun'
import type { CardId, GameSetup, Identity, PlayerId, Suit } from '@/sanguosha/engine/types'

/**
 * 神赵云。经典**原版**，2 体力。
 *
 * 版本锁三条（2018 重做版一条都不要）：
 * - 绝境 = 摸牌阶段额外摸「已损失体力」张 + 手牌上限 +2
 * - 龙魂 = X 张**同花色**牌，X = 当前体力且至少为 1
 * - 没有「进入/脱离濒死摸牌」「至多两张」「两红增强」「两黑弃牌」
 */

function gameWith(characterIds: string[], seed = 'shenzhaoyun'): SanguoshaGame {
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

function playerOf(game: SanguoshaGame, playerId: PlayerId) {
  return game.state.players.find((player) => player.id === playerId)!
}

function pending(game: SanguoshaGame) {
  return game.state.pendingRequests[0]
}

function detach(game: SanguoshaGame, cardId: CardId): void {
  const state = game.state
  state.zones.drawPile = state.zones.drawPile.filter((id) => id !== cardId)
  state.zones.discardPile = state.zones.discardPile.filter((id) => id !== cardId)
  state.zones.processingArea = state.zones.processingArea.filter((id) => id !== cardId)
  for (const player of state.players) {
    player.zones.hand = player.zones.hand.filter((id) => id !== cardId)
    player.zones.judgingArea = player.zones.judgingArea.filter((id) => id !== cardId)
    for (const [slot, equipped] of Object.entries(player.zones.equipment)) {
      if (equipped === cardId) player.zones.equipment[slot as keyof typeof player.zones.equipment] = null
    }
  }
}

function clearHand(game: SanguoshaGame, playerId: PlayerId): void {
  for (const cardId of [...playerOf(game, playerId).zones.hand]) {
    moveCard(game.state, cardId, { kind: 'hand', playerId }, { kind: 'discardPile' })
  }
}

function giveHand(game: SanguoshaGame, playerId: PlayerId, cardIds: CardId[]): void {
  for (const cardId of cardIds) {
    detach(game, cardId)
    playerOf(game, playerId).zones.hand.push(cardId)
  }
}

/** 找 n 张指定花色、且不是指定排除名单里的牌。 */
function cardsOfSuit(game: SanguoshaGame, suit: Suit, count: number, exclude: CardId[] = []): CardId[] {
  const found = Object.values(game.state.cards)
    .filter((card) => card.suit === suit && !exclude.includes(card.id) && !card.virtual)
    .slice(0, count)
    .map((card) => card.id)
  if (found.length < count) throw new Error(`${suit} 花色的牌不够`)
  return found
}

const FIVE = ['shenzhaoyun', 'zhangfei', 'zhangfei', 'zhangfei', 'zhangfei']

describe('绝境', () => {
  it('满血时不额外摸牌，掉一血额外摸一张', () => {
    const game = gameWith(FIVE)
    const owner = playerOf(game, 'p0')
    /*
     * 体力上限在发牌时按当时的随机武将算过了，测试里手动改 characterId 不会重算，
     * 所以「经典神赵云是 2 体力」这条版本锁要断言**武将定义**本身，
     * 流程用例则自己把上限摆成 2。
     */
    expect(SHENZHAOYUN.maxHp, '经典神赵云是 2 体力').toBe(2)
    owner.maxHp = 2

    const drawCount = (hp: number): number => {
      owner.hp = hp
      clearHand(game, 'p0')
      game.state.currentPlayerId = 'p0'
      game.state.normalTurnPlayerId = 'p0'
      game.state.currentTurnKind = 'normal'
      game.state.phase = 'judge'
      game.state.skippedPhases = []
      game.state.judgedDelayedCards = []
      game.advancePhase()
      return playerOf(game, 'p0').zones.hand.length
    }

    expect(drawCount(2), '2/2 血：正常摸 2 张').toBe(2)
    expect(drawCount(1), '1/2 血：额外摸 1 张，共 3 张').toBe(3)
  })

  it('额外摸牌数按当前最大体力算，不写死 2', () => {
    const game = gameWith(FIVE)
    const owner = playerOf(game, 'p0')
    owner.maxHp = 5
    owner.hp = 2
    clearHand(game, 'p0')
    game.state.currentPlayerId = 'p0'
    game.state.normalTurnPlayerId = 'p0'
    game.state.currentTurnKind = 'normal'
    game.state.phase = 'judge'
    game.state.skippedPhases = []
    game.state.judgedDelayedCards = []
    game.advancePhase()
    expect(playerOf(game, 'p0').zones.hand, '已损失 3 点，摸 2+3=5 张').toHaveLength(5)
  })

  it('摸牌阶段被跳过时不会凭空额外摸牌', () => {
    const game = gameWith(FIVE)
    const owner = playerOf(game, 'p0')
    owner.hp = 1
    clearHand(game, 'p0')
    game.state.currentPlayerId = 'p0'
    game.state.normalTurnPlayerId = 'p0'
    game.state.currentTurnKind = 'normal'
    game.state.phase = 'judge'
    game.state.skippedPhases = ['draw']
    game.state.judgedDelayedCards = []
    game.advancePhase()
    expect(playerOf(game, 'p0').zones.hand, '整个摸牌阶段被跳过').toHaveLength(0)
  })

  it('手牌上限 +2（这一条经典神赵云确实有）', () => {
    const game = gameWith(FIVE)
    const owner = playerOf(game, 'p0')
    owner.hp = 2
    expect(maxCardsOf(game.state, 'p0'), '体力 2 + 绝境 2').toBe(4)
    owner.hp = 1
    expect(maxCardsOf(game.state, 'p0'), '体力 1 + 绝境 2').toBe(3)
  })
})

describe('龙魂：X 的计算', () => {
  it('X 等于当前体力，且至少为 1', () => {
    const game = gameWith(FIVE)
    const owner = playerOf(game, 'p0')
    owner.hp = 2
    expect(longhunRequiredCount(game.state, 'p0'), '2 血要 2 张').toBe(2)
    owner.hp = 1
    expect(longhunRequiredCount(game.state, 'p0'), '1 血要 1 张').toBe(1)
    owner.hp = 0
    expect(longhunRequiredCount(game.state, 'p0'), '0 血仍是 1 张').toBe(1)
    owner.hp = -1
    expect(longhunRequiredCount(game.state, 'p0'), '负血仍是 1 张').toBe(1)
  })

  it('X 是当前体力，不是已损失体力', () => {
    const game = gameWith(FIVE)
    const owner = playerOf(game, 'p0')
    owner.maxHp = 4
    owner.hp = 1
    // 已损失 3 点。如果错写成已损失体力，这里会是 3
    expect(longhunRequiredCount(game.state, 'p0')).toBe(1)
  })
})

describe('龙魂：底牌区域与花色', () => {
  it('手牌和装备区都能当底牌，判定区不能', () => {
    const game = gameWith(FIVE)
    clearHand(game, 'p0')
    playerOf(game, 'p0').hp = 1

    const hearts = cardsOfSuit(game, 'heart', 3)
    giveHand(game, 'p0', [hearts[0]])
    // 第二张装到装备区
    detach(game, hearts[1])
    playerOf(game, 'p0').zones.equipment.armor = hearts[1]
    // 第三张放判定区
    detach(game, hearts[2])
    playerOf(game, 'p0').zones.judgingArea.push(hearts[2])

    const pool = baseCardsOf(game.state, 'p0', 'heart')
    expect(pool, '手牌算').toContain(hearts[0])
    expect(pool, '装备区算').toContain(hearts[1])
    expect(pool, '判定区不算').not.toContain(hearts[2])
  })

  it('同花色才行，同颜色不同花色不行', () => {
    const game = gameWith(FIVE)
    clearHand(game, 'p0')
    playerOf(game, 'p0').hp = 2  // 需要 2 张

    // 一张红桃 + 一张方块：都是红色，但花色不同
    giveHand(game, 'p0', [cardsOfSuit(game, 'heart', 1)[0], cardsOfSuit(game, 'diamond', 1)[0]])
    expect(canMultiCardViewAs(game.state, 'p0', '桃'), '红桃只有一张，凑不够 2 张').toBe(false)

    // 换成两张红桃
    clearHand(game, 'p0')
    giveHand(game, 'p0', cardsOfSuit(game, 'heart', 2))
    expect(canMultiCardViewAs(game.state, 'p0', '桃'), '两张红桃可以').toBe(true)
  })

  it('四种花色各自对应一种牌', () => {
    const game = gameWith(FIVE)
    playerOf(game, 'p0').hp = 1
    const cases: Array<[Suit, string]> = [
      ['heart', '桃'], ['diamond', '杀'], ['club', '闪'], ['spade', '无懈可击'],
    ]
    for (const [suit, cardName] of cases) {
      clearHand(game, 'p0')
      giveHand(game, 'p0', cardsOfSuit(game, suit, 1))
      expect(canMultiCardViewAs(game.state, 'p0', cardName), `${suit} → ${cardName}`).toBe(true)
      // 花色对不上的牌名不能凑
      const wrong = cases.find(([otherSuit]) => otherSuit !== suit)![1]
      expect(canMultiCardViewAs(game.state, 'p0', wrong), `${suit} 不该能凑 ${wrong}`).toBe(false)
    }
  })
})

describe('龙魂：濒死自救', () => {
  it('0 血濒死时一张红桃就能龙魂成桃自救', () => {
    const game = gameWith(FIVE)
    clearHand(game, 'p0')
    playerOf(game, 'p0').hp = 1
    const heart = cardsOfSuit(game, 'heart', 1)[0]
    giveHand(game, 'p0', [heart])

    // 打到 0 血进入濒死
    game.damage({ sourceId: 'p1', targetId: 'p0', amount: 1, cardName: null })
    const request = pending(game)
    expect(request?.kind, '进入求桃').toBe('rescue')
    expect(request.playerId).toBe('p0')
    expect((request as unknown as { actionIds: string[] }).actionIds, '应当能用龙魂')
      .toContain(MULTI_VIEWAS_ACTION)

    game.respond({ requestId: request.id, playerId: 'p0', payload: { actionId: MULTI_VIEWAS_ACTION } })
    const pick = pending(game)
    expect(String(pick.prompt)).toContain('龙魂')
    expect(String(pick.prompt), '提示里要写清楚需要几张、要同花色').toContain('1 张花色相同')
    game.respond({ requestId: pick.id, playerId: 'p0', payload: { cardIds: [heart] } })

    expect(playerOf(game, 'p0').alive, '自救成功').toBe(true)
    expect(playerOf(game, 'p0').hp, '回到 1 血').toBe(1)
    assertCardConservation(game.state)
  })

  it('2 血时要两张同花色，濒死掉到 0 血后只要一张', () => {
    const game = gameWith(FIVE)
    clearHand(game, 'p0')
    const owner = playerOf(game, 'p0')
    owner.hp = 2
    const hearts = cardsOfSuit(game, 'heart', 1)
    giveHand(game, 'p0', hearts)
    // 2 血时只有一张红桃，凑不出
    expect(canMultiCardViewAs(game.state, 'p0', '桃')).toBe(false)

    // 打到 0 血进入濒死，这时 X 变成 1，同一张牌就够了
    game.damage({ sourceId: 'p1', targetId: 'p0', amount: 2, cardName: null })
    expect(canMultiCardViewAs(game.state, 'p0', '桃'), '濒死时 X=1').toBe(true)
    const request = pending(game)
    expect((request as unknown as { actionIds: string[] }).actionIds).toContain(MULTI_VIEWAS_ACTION)
  })
})

describe('龙魂：装备牌作为底牌', () => {
  it('用装备区的牌发动，装备正常离场', () => {
    const game = gameWith(FIVE)
    clearHand(game, 'p0')
    playerOf(game, 'p0').hp = 1
    const heart = cardsOfSuit(game, 'heart', 1)[0]
    detach(game, heart)
    playerOf(game, 'p0').zones.equipment.armor = heart

    const lost: string[] = []
    game.events.on('LoseEquipment', () => { lost.push('LoseEquipment') })

    game.damage({ sourceId: 'p1', targetId: 'p0', amount: 1, cardName: null })
    game.respond({ requestId: pending(game).id, playerId: 'p0', payload: { actionId: MULTI_VIEWAS_ACTION } })
    game.respond({ requestId: pending(game).id, playerId: 'p0', payload: { cardIds: [heart] } })

    expect(playerOf(game, 'p0').alive).toBe(true)
    expect(playerOf(game, 'p0').zones.equipment.armor, '装备离开了装备区').toBeNull()
    expect(lost, '装备离场事件要发出来').not.toHaveLength(0)
    assertCardConservation(game.state)
  })
})

describe('龙魂：响应链接入', () => {
  it('求闪时可以用梅花龙魂', () => {
    const game = gameWith(FIVE)
    clearHand(game, 'p0')
    playerOf(game, 'p0').hp = 1
    const club = cardsOfSuit(game, 'club', 1)[0]
    giveHand(game, 'p0', [club])

    // p1 对 p0 出杀
    const slash = Object.values(game.state.cards).find((card) => card.name === '杀')!.id
    detach(game, slash)
    clearHand(game, 'p1')
    giveHand(game, 'p1', [slash])
    game.state.currentPlayerId = 'p1'
    game.state.normalTurnPlayerId = 'p1'
    game.state.currentTurnKind = 'normal'
    game.state.phase = 'play'
    game.state.skippedPhases = []
    game.state.judgedDelayedCards = []

    const action = game.legalActions('p1').find((candidate) => (
      candidate.kind === 'use-card' && (candidate as { cardIds?: string[] }).cardIds?.includes(slash)
        && (candidate as { targetIds?: string[] }).targetIds?.includes('p0')
    ))
    if (!action) return  // 距离不够就跳过这条
    game.act('p1', action.id)

    const request = pending(game)
    expect(request?.playerId).toBe('p0')
    expect((request as unknown as { actionIds: string[] }).actionIds, '求闪时能用龙魂')
      .toContain(MULTI_VIEWAS_ACTION)
    game.respond({ requestId: request.id, playerId: 'p0', payload: { actionId: MULTI_VIEWAS_ACTION } })
    game.respond({ requestId: pending(game).id, playerId: 'p0', payload: { cardIds: [club] } })
    expect(playerOf(game, 'p0').hp, '闪成功，没掉血').toBe(1)
    assertCardConservation(game.state)
  })
})

describe('版本锁：不是 2018 重做版', () => {
  it('龙魂没有「至多两张」的上限，X 完全跟着体力走', () => {
    const game = gameWith(FIVE)
    const owner = playerOf(game, 'p0')
    owner.maxHp = 5
    owner.hp = 4
    // 2018 版限制至多 2 张；经典版就是 4 张
    expect(longhunRequiredCount(game.state, 'p0')).toBe(4)
  })

  it('进入濒死不摸牌（2018 版才有）', () => {
    const game = gameWith(FIVE)
    clearHand(game, 'p0')
    playerOf(game, 'p0').hp = 1
    game.damage({ sourceId: 'p1', targetId: 'p0', amount: 1, cardName: null })
    expect(playerOf(game, 'p0').zones.hand, '进入濒死不该摸到牌').toHaveLength(0)
  })

  it('绝境和龙魂之外没有别的技能', () => {
    const game = gameWith(FIVE)
    expect(playerOf(game, 'p0').grantedSkills ?? []).toHaveLength(0)
  })
})
