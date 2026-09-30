import { describe, expect, it } from 'vitest'
import { SanguoshaGame } from '@/sanguosha/engine/game'
import { assertCardConservation, moveCard } from '@/sanguosha/engine/zones'
import { maxCardsOf } from '@/sanguosha/engine/phase'
import { canMultiCardViewAs, baseCardsOf, MULTI_VIEWAS_ACTION } from '@/sanguosha/engine/multi-card-viewas'
import { SHENZHAOYUN } from '@/sanguosha/data/characters/god-shenzhaoyun'
import { getSkillRuntime } from '@/sanguosha/engine/skills/runtime'
import type { CardId, GameSetup, Identity, PlayerId, Suit } from '@/sanguosha/engine/types'

/**
 * 神赵云。按武将册当前采用规则，2 体力。
 *
 * 规则核验：绝境在进入/脱离濒死时摸牌；龙魂至多两张同花色牌。
 */

function gameWith(characterIds: string[], seed = 'shenzhaoyun', humanPlayerIds: string[] = []): SanguoshaGame {
  const setup: GameSetup = {
    mode: 'identity', generalChoices: 1,
    players: Array.from({ length: characterIds.length }, (_, index) => ({ id: `p${index}`, nickname: `玩家${index}`, isHuman: humanPlayerIds.includes(`p${index}`) })),
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
  it('进入和脱离濒死各摸一张，手牌上限加二', () => {
    const game = gameWith(FIVE)
    const owner = playerOf(game, 'p0')
    expect(SHENZHAOYUN.maxHp).toBe(2)
    owner.maxHp = 2
    clearHand(game, 'p0')
    const before = owner.zones.hand.length
    game.emit('EnterDying', { playerId: 'p0', hp: 0 })
    expect(owner.zones.hand).toHaveLength(before + 1)
    game.emit('QuitDying', { playerId: 'p0', hp: 1 })
    expect(owner.zones.hand).toHaveLength(before + 2)
  })

  it('手牌上限 +2', () => {
    const game = gameWith(FIVE)
    const owner = playerOf(game, 'p0')
    owner.hp = 2
    expect(maxCardsOf(game.state, 'p0'), '体力 2 + 绝境 2').toBe(4)
    owner.hp = 1
    expect(maxCardsOf(game.state, 'p0'), '体力 1 + 绝境 2').toBe(3)
  })
})

describe('龙魂：张数与花色', () => {
  it('任意体力下都允许 1 至 2 张同花色牌', () => {
    const game = gameWith(FIVE)
    const owner = playerOf(game, 'p0')
    owner.hp = 2
    const spec = getSkillRuntime('longhun')!.multiCardViewAs!(game.state, 'p0')!
    expect(spec.requiredCount, '最少一张').toBe(1)
    expect(spec.maxCount, '至多两张').toBe(2)
    giveHand(game, 'p0', cardsOfSuit(game, 'heart', 2))
    expect(canMultiCardViewAs(game.state, 'p0', '桃')).toBe(true)
    expect(canMultiCardViewAs(game.state, 'p0', '桃'), '有两张同花色时可选择一张或两张').toBe(true)
    owner.hp = 1
    expect(getSkillRuntime('longhun')!.multiCardViewAs!(game.state, 'p0')!.maxCount).toBe(2)
    owner.hp = 0
    expect(getSkillRuntime('longhun')!.multiCardViewAs!(game.state, 'p0')!.maxCount).toBe(2)
    owner.hp = -1
    expect(getSkillRuntime('longhun')!.multiCardViewAs!(game.state, 'p0')!.maxCount).toBe(2)
  })

  it('当前体力不改变至多两张的规则', () => {
    const game = gameWith(FIVE)
    const owner = playerOf(game, 'p0')
    owner.maxHp = 4
    owner.hp = 1
    const spec = getSkillRuntime('longhun')!.multiCardViewAs!(game.state, 'p0')!
    expect(spec.requiredCount).toBe(1)
    expect(spec.maxCount).toBe(2)
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

  it('转化候选不跨花色混合', () => {
    const game = gameWith(FIVE)
    clearHand(game, 'p0')
    playerOf(game, 'p0').hp = 2  // 体力值不影响龙魂张数

    // 一张红桃 + 一张方块分别属于不同转换花色
    giveHand(game, 'p0', [cardsOfSuit(game, 'heart', 1)[0], cardsOfSuit(game, 'diamond', 1)[0]])
    expect(baseCardsOf(game.state, 'p0', 'heart')).toHaveLength(1)
    expect(baseCardsOf(game.state, 'p0', 'diamond')).toHaveLength(1)

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
    expect(String(pick.prompt), '提示里要写清楚可选张数与花色要求').toContain('1至2 张花色相同')
    game.respond({ requestId: pick.id, playerId: 'p0', payload: { cardIds: [heart] } })

    expect(playerOf(game, 'p0').alive, '自救成功').toBe(true)
    expect(playerOf(game, 'p0').hp, '回到 1 血').toBe(1)
    assertCardConservation(game.state)
  })

  it('两张同花色可供玩家选择；可用数量与当前体力无关', () => {
    const game = gameWith(FIVE)
    clearHand(game, 'p0')
    const owner = playerOf(game, 'p0')
    owner.hp = 2
    const hearts = cardsOfSuit(game, 'heart', 1)
    giveHand(game, 'p0', hearts)
    // 另有一张红桃后，龙魂可选一张或两张。
    const secondHeart = cardsOfSuit(game, 'heart', 2, hearts)[0]
    giveHand(game, 'p0', [secondHeart])
    expect(canMultiCardViewAs(game.state, 'p0', '桃')).toBe(true)
    // 打到 0 血后允许张数仍然是 1 至 2。
    game.damage({ sourceId: 'p1', targetId: 'p0', amount: 2, cardName: null })
    expect(canMultiCardViewAs(game.state, 'p0', '桃'), '濒死时仍允许龙魂').toBe(true)
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

describe('龙魂：出牌阶段主动使用与双红奖励', () => {
  function enterPlay(game: SanguoshaGame, playerId: PlayerId): void {
    game.state.currentPlayerId = playerId
    game.state.normalTurnPlayerId = playerId
    game.state.currentTurnKind = 'normal'
    game.state.phase = 'play'
    game.state.skippedPhases = []
    game.state.judgedDelayedCards = []
  }

  it('两张红桃可主动当桃使用，回复值加一', () => {
    const game = gameWith(FIVE)
    clearHand(game, 'p0')
    playerOf(game, 'p0').maxHp = 4
    playerOf(game, 'p0').hp = 1
    const hearts = cardsOfSuit(game, 'heart', 2)
    giveHand(game, 'p0', hearts)
    enterPlay(game, 'p0')

    const action = game.legalActions('p0').find((candidate) => candidate.kind === 'use-card'
      && candidate.sourceSkillId === 'longhun' && candidate.asCardName === '桃' && candidate.cardIds.length === 2)
    const allLonghunActions = game.legalActions('p0').filter((candidate) => candidate.kind === 'use-card' && candidate.sourceSkillId === 'longhun')
    expect(allLonghunActions.some((candidate) => candidate.kind === 'use-card' && candidate.cardIds.length === 1), '应允许只选一张')
    expect(allLonghunActions.every((candidate) => candidate.kind !== 'use-card' || candidate.cardIds.length <= 2
      && new Set(candidate.cardIds.map((id) => game.state.cards[id]?.suit)).size === 1), '主动动作只能使用至多两张同花色材料')
    expect(action, '应提供自主选择两张红桃当桃的主动用牌动作').toBeTruthy()
    game.act('p0', action!.id)
    expect(playerOf(game, 'p0').hp, '基础回复1加两张红牌奖励1').toBe(3)
    expect(hearts.every((id) => game.state.zones.discardPile.includes(id)), '两张材料都应弃置').toBe(true)
    assertCardConservation(game.state)
  })

  it('两张方块主动当火杀使用，伤害值加一', () => {
    const game = gameWith(FIVE)
    clearHand(game, 'p0')
    const diamonds = cardsOfSuit(game, 'diamond', 2)
    giveHand(game, 'p0', diamonds)
    enterPlay(game, 'p0')

    const action = game.legalActions('p0').find((candidate) => candidate.kind === 'use-card'
      && candidate.sourceSkillId === 'longhun' && candidate.asCardName === '杀'
      && candidate.cardIds.length === 2 && candidate.targetIds.includes('p1'))
    expect(action, '应提供合法的主动火杀目标选项').toBeTruthy()
    game.act('p0', action!.id)
    const request = pending(game)
    if (request?.kind === 'respond-card')
      game.respond({ requestId: request.id, playerId: request.playerId, payload: { actionId: 'respond-pass' } })
    expect(playerOf(game, 'p1').hp, '两张红牌使火杀造成2点伤害').toBe(2)
    expect(diamonds.every((id) => game.state.zones.discardPile.includes(id)), '两张材料都应弃置').toBe(true)
    assertCardConservation(game.state)
  })

  it('单张红桃当桃使用不获得双红加成', () => {
    const game = gameWith(FIVE)
    clearHand(game, 'p0')
    playerOf(game, 'p0').maxHp = 4
    playerOf(game, 'p0').hp = 1
    const heart = cardsOfSuit(game, 'heart', 1)[0]
    giveHand(game, 'p0', [heart])
    enterPlay(game, 'p0')

    const action = game.legalActions('p0').find((candidate) => candidate.kind === 'use-card'
      && candidate.sourceSkillId === 'longhun' && candidate.asCardName === '桃' && candidate.cardIds.length === 1)
    expect(action).toBeTruthy()
    game.act('p0', action!.id)
    expect(playerOf(game, 'p0').hp).toBe(2)
    assertCardConservation(game.state)
  })
})

describe('龙魂：两张黑牌响应后的当前回合角色弃牌', () => {
  it('黑桃双牌响应时建立私密弃牌选择并弃置当前回合角色的一张牌', () => {
    const game = gameWith(FIVE, 'longhun-black-response', ['p0'])
    clearHand(game, 'p0')
    clearHand(game, 'p1')
    const spades = cardsOfSuit(game, 'spade', 2)
    giveHand(game, 'p0', spades)
    const spare = cardsOfSuit(game, 'club', 1)[0]
    giveHand(game, 'p1', [spare])
    game.state.currentPlayerId = 'p1'
    game.state.normalTurnPlayerId = 'p1'
    game.state.currentTurnKind = 'normal'
    game.state.phase = 'play'
    game.state.skippedPhases = []
    game.state.judgedDelayedCards = []

    const dismantlement = Object.values(game.state.cards).find((card) => card.name === '过河拆桥' && !card.virtual)!.id
    const targetCard = Object.values(game.state.cards).find((card) => card.name === '闪' && !card.virtual && card.id !== spare)!.id
    clearHand(game, 'p1')
    clearHand(game, 'p2')
    giveHand(game, 'p1', [dismantlement, spare])
    giveHand(game, 'p2', [targetCard])
    const use = game.legalActions('p1').find((candidate) => candidate.kind === 'use-card'
      && candidate.cardIds[0] === dismantlement && candidate.targetIds.includes('p2'))
    expect(use).toBeTruthy()
    game.act('p1', use!.id)

    let nullification = pending(game)
    while (nullification?.playerId !== 'p0' || nullification.kind !== 'respond-card') {
      expect(nullification, `响应链应到达真人神赵云；resolution=${JSON.stringify(game.state.cardResolution)} status=${game.state.status}`).toBeTruthy()
      if (nullification!.kind === 'respond-card') {
        game.respond({ requestId: nullification!.id, playerId: nullification!.playerId, payload: { actionId: 'respond-pass' } })
      } else if (nullification!.kind === 'choose-cards') {
        const choices = [...nullification!.cardIds, ...nullification!.hiddenCardSlots]
        expect(choices.length).toBeGreaterThan(0)
        game.respond({ requestId: nullification!.id, playerId: nullification!.playerId, payload: { cardIds: [choices[0]] } })
      } else {
        throw new Error(`黑桃无懈测试遇到非预期请求：${nullification!.kind}`)
      }
      nullification = pending(game)
    }
    expect((nullification as unknown as { actionIds: string[] }).actionIds).toContain(MULTI_VIEWAS_ACTION)
    game.respond({ requestId: nullification.id, playerId: 'p0', payload: { actionId: MULTI_VIEWAS_ACTION } })
    const chooseMaterial = pending(game)!
    game.respond({ requestId: chooseMaterial.id, playerId: 'p0', payload: { cardIds: spades } })

    let discard = pending(game)
    while (!(discard?.kind === 'choose-cards' && discard.skillId === 'longhun')) {
      expect(discard, '黑桃龙魂响应的后续无懈链应继续等待').toBeTruthy()
      expect(discard!.kind).toBe('respond-card')
      game.respond({ requestId: discard!.id, playerId: discard!.playerId, payload: { actionId: 'respond-pass' } })
      discard = pending(game)
    }
    expect(discard?.kind).toBe('choose-cards')
    expect(discard?.skillId).toBe('longhun')
    expect(discard?.playerId).toBe('p0')
    expect(String(discard?.prompt)).toContain('当前回合角色')
    const hiddenSlot = (discard as unknown as { hiddenCardSlots: string[] }).hiddenCardSlots[0]
    expect(hiddenSlot, '对方手牌应以私密占位槽让赵云选择').toBeTruthy()
    game.respond({ requestId: discard!.id, playerId: 'p0', payload: { cardIds: [hiddenSlot] } })
    expect(game.state.zones.discardPile).toContain(spare)
    assertCardConservation(game.state)
  })
})

describe('神赵云技能登记', () => {
  it('绝境和龙魂之外没有别的技能', () => {
    const game = gameWith(FIVE)
    expect(playerOf(game, 'p0').grantedSkills ?? []).toHaveLength(0)
  })
})
