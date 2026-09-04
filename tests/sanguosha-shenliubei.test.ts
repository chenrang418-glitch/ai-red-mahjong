import { describe, expect, it } from 'vitest'
import { SanguoshaGame } from '@/sanguosha/engine/game'
import { assertCardConservation, moveCard } from '@/sanguosha/engine/zones'
import { maxCardsOf } from '@/sanguosha/engine/phase'
import { conversionStateOf, setConversionState } from '@/sanguosha/engine/conversion'
import { canUseCardAs, forcedIdentityFor } from '@/sanguosha/engine/forced-identity'
import { setChained } from '@/sanguosha/engine/character-state'
import type { CardId, GameSetup, Identity, PlayerId } from '@/sanguosha/engine/types'

/**
 * 神刘备。**三国杀移动版当前官方技能页现行版本**。
 *
 * 三条最要紧的：
 *
 * 1. 龙怒的「均视为」是**强制**的：阳状态下红色手牌不能再吃桃 / 装备 / 用锦囊 / 当闪打出。
 * 2. **无距离只给阳、无次数只给阴**，而且只对转出来的那些杀；实体【杀】不吃。
 * 3. 结营是**连环锁**：解除他连环的效果无效；已连环的角色（全场）手牌上限 +2。
 */

function gameWith(characterIds: string[], seed = 'shenliubei'): SanguoshaGame {
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
  drain(game)
  return game
}

function drain(game: SanguoshaGame, limit = 40): void {
  let guard = 0
  while (game.state.pendingRequests.length > 0 && guard < limit) {
    const request = game.state.pendingRequests[0]
    const payload = request.kind === 'choose-cards'
      ? { cardIds: [] }
      : request.kind === 'choose-targets'
        ? { targetIds: (request as unknown as { candidateIds: string[]; min: number }).candidateIds.slice(0, (request as unknown as { min: number }).min) }
        : { optionId: 'no' }
    game.respond({ requestId: request.id, playerId: request.playerId, payload })
    guard += 1
  }
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

function findCard(game: SanguoshaGame, match: (card: { name: string; suit: string; color: string; category: string; id: string }) => boolean): CardId {
  const card = Object.values(game.state.cards).find((candidate) => match(candidate as never))
  if (!card) throw new Error('找不到符合条件的牌')
  return card.id
}

/** 跑到 p0 的出牌阶段开始（会触发龙怒）。 */
function enterPlayPhase(game: SanguoshaGame, playerId: PlayerId): void {
  game.state.currentPlayerId = playerId
  game.state.normalTurnPlayerId = playerId
  game.state.currentTurnKind = 'normal'
  game.state.phase = 'draw'
  game.state.skippedPhases = []
  game.state.judgedDelayedCards = []
  game.state.pendingRequests = []
  game.advancePhase()
}

const FIVE = ['shenliubei', 'zhangfei', 'zhangfei', 'zhangfei', 'zhangfei']

describe('龙怒：转换技', () => {
  it('初始为阳，成功结算后切换到阴', () => {
    const game = gameWith(FIVE)
    expect(conversionStateOf(game.state, 'p0', 'longnu'), '初始为阳').toBe('yang')
    playerOf(game, 'p0').hp = 6
    playerOf(game, 'p0').maxHp = 6
    enterPlayPhase(game, 'p0')
    expect(conversionStateOf(game.state, 'p0', 'longnu'), '结算后切到阴').toBe('yin')
  })

  it('阳：失去 1 点体力并摸一张牌', () => {
    const game = gameWith(FIVE)
    const owner = playerOf(game, 'p0')
    owner.hp = 6
    owner.maxHp = 6
    clearHand(game, 'p0')
    enterPlayPhase(game, 'p0')
    expect(owner.hp, '失去 1 点体力').toBe(5)
    expect(owner.maxHp, '阳不减体力上限').toBe(6)
    expect(owner.zones.hand.length, '摸一张').toBe(1)
  })

  it('阴：减 1 点体力上限并摸一张牌', () => {
    const game = gameWith(FIVE)
    const owner = playerOf(game, 'p0')
    owner.hp = 6
    owner.maxHp = 6
    clearHand(game, 'p0')
    setConversionState(game.state, 'p0', 'longnu', 'yin')
    enterPlayPhase(game, 'p0')
    expect(owner.maxHp, '减 1 点体力上限').toBe(5)
    expect(owner.zones.hand.length, '摸一张').toBe(1)
    expect(conversionStateOf(game.state, 'p0', 'longnu'), '切回阳').toBe('yang')
  })

  it('出牌阶段被真正跳过时不触发也不转换', () => {
    const game = gameWith(FIVE)
    const owner = playerOf(game, 'p0')
    owner.hp = 6
    owner.maxHp = 6
    game.state.currentPlayerId = 'p0'
    game.state.normalTurnPlayerId = 'p0'
    game.state.currentTurnKind = 'normal'
    game.state.phase = 'draw'
    game.state.skippedPhases = ['play']
    game.state.judgedDelayedCards = []
    game.state.pendingRequests = []
    game.advancePhase()

    expect(owner.hp, '没有失去体力').toBe(6)
    expect(conversionStateOf(game.state, 'p0', 'longnu'), '阴阳状态不变').toBe('yang')
  })

  it('阴阳状态可序列化，重连不丢', () => {
    const game = gameWith(FIVE)
    setConversionState(game.state, 'p0', 'longnu', 'yin')
    const restored = SanguoshaGame.restore(JSON.parse(JSON.stringify(game.serialize())))
    expect(conversionStateOf(restored.state, 'p0', 'longnu')).toBe('yin')
  })
})

describe('龙怒·阳：红色手牌强制变火杀', () => {
  function setUpYang(game: SanguoshaGame): void {
    const owner = playerOf(game, 'p0')
    owner.hp = 6
    owner.maxHp = 6
    clearHand(game, 'p0')
    enterPlayPhase(game, 'p0')
  }

  it('红色手牌被强制改写成火杀', () => {
    const game = gameWith(FIVE)
    setUpYang(game)
    const peach = findCard(game, (card) => card.name === '桃')
    giveHand(game, 'p0', [peach])
    const forced = forcedIdentityFor(game.state, 'p0', peach)
    expect(forced, '红色手牌被改写').toBeTruthy()
    expect(forced!.asCardName).toBe('杀')
    expect(forced!.nature, '火属性').toBe('fire')
  })

  it('红桃【桃】不能再按原用途吃', () => {
    const game = gameWith(FIVE)
    setUpYang(game)
    const peach = findCard(game, (card) => card.name === '桃')
    giveHand(game, 'p0', [peach])
    playerOf(game, 'p0').hp = 3

    expect(canUseCardAs(game.state, 'p0', peach, '桃'), '不能当桃用').toBe(false)
    const actions = game.legalActions('p0').filter((action) => (
      action.kind === 'use-card' && (action as { cardIds?: string[] }).cardIds?.includes(peach)
    ))
    expect(actions.every((action) => (action as { asCardName?: string }).asCardName === '杀'),
      '这张牌只出得了杀的动作').toBe(true)
  })

  it('红色装备牌不能再装备', () => {
    const game = gameWith(FIVE)
    setUpYang(game)
    const redEquip = findCard(game, (card) => card.category === 'equipment' && card.color === 'red')
    giveHand(game, 'p0', [redEquip])
    const actions = game.legalActions('p0').filter((action) => (
      action.kind === 'use-card' && (action as { cardIds?: string[] }).cardIds?.includes(redEquip)
    ))
    expect(actions.every((action) => (action as { asCardName?: string }).asCardName === '杀'),
      '红色装备只能当杀').toBe(true)
  })

  it('红色锦囊不能再当锦囊用', () => {
    const game = gameWith(FIVE)
    setUpYang(game)
    const redTrick = findCard(game, (card) => card.category === 'trick' && card.color === 'red')
    giveHand(game, 'p0', [redTrick])
    const actions = game.legalActions('p0').filter((action) => (
      action.kind === 'use-card' && (action as { cardIds?: string[] }).cardIds?.includes(redTrick)
    ))
    expect(actions.every((action) => (action as { asCardName?: string }).asCardName === '杀'),
      '红色锦囊只能当杀').toBe(true)
  })

  it('黑色手牌完全不受影响', () => {
    const game = gameWith(FIVE)
    setUpYang(game)
    // 标准牌堆里【闪】全是红色，所以拿一张黑色锦囊来验
    const blackTrick = findCard(game, (card) => card.category === 'trick' && card.color === 'black')
    giveHand(game, 'p0', [blackTrick])
    expect(forcedIdentityFor(game.state, 'p0', blackTrick), '黑牌不被改写').toBeNull()
    const name = game.state.cards[blackTrick].name
    expect(canUseCardAs(game.state, 'p0', blackTrick, name), '黑色锦囊照常按原用途使用').toBe(true)
  })

  it('只作用于手牌，装备区的红牌不受影响', () => {
    const game = gameWith(FIVE)
    setUpYang(game)
    const redEquip = findCard(game, (card) => card.category === 'equipment' && card.color === 'red')
    detach(game, redEquip)
    playerOf(game, 'p0').zones.equipment.armor = redEquip
    expect(forcedIdentityFor(game.state, 'p0', redEquip), '装备区的牌不被改写').toBeNull()
  })

  it('阳仍受出杀次数限制（只给无距离，不给无次数）', () => {
    const game = gameWith(FIVE)
    setUpYang(game)
    const reds = Object.values(game.state.cards).filter((card) => card.color === 'red' && !card.virtual)
      .slice(0, 3).map((card) => card.id)
    giveHand(game, 'p0', reds)
    game.state.turnUsage.slashUses = 1  // 已经用过一张杀
    const actions = game.legalActions('p0').filter((action) => (
      action.kind === 'use-card' && (action as { asCardName?: string }).asCardName === '杀'
    ))
    expect(actions, '次数用完就出不了了').toHaveLength(0)
  })
})

describe('龙怒·阴：锦囊强制变雷杀', () => {
  function setUpYin(game: SanguoshaGame): void {
    const owner = playerOf(game, 'p0')
    owner.hp = 6
    owner.maxHp = 6
    clearHand(game, 'p0')
    setConversionState(game.state, 'p0', 'longnu', 'yin')
    enterPlayPhase(game, 'p0')
  }

  it('锦囊牌被强制改写成雷杀', () => {
    const game = gameWith(FIVE)
    setUpYin(game)
    const trick = findCard(game, (card) => card.category === 'trick')
    giveHand(game, 'p0', [trick])
    const forced = forcedIdentityFor(game.state, 'p0', trick)
    expect(forced).toBeTruthy()
    expect(forced!.nature, '雷属性').toBe('thunder')
    expect(forced!.unlimitedUses, '无次数限制').toBe(true)
  })

  it('基本牌和装备牌不受影响', () => {
    const game = gameWith(FIVE)
    setUpYin(game)
    const peach = findCard(game, (card) => card.name === '桃')
    const equip = findCard(game, (card) => card.category === 'equipment')
    giveHand(game, 'p0', [peach, equip])
    expect(forcedIdentityFor(game.state, 'p0', peach), '基本牌不改写').toBeNull()
    expect(forcedIdentityFor(game.state, 'p0', equip), '装备牌不改写').toBeNull()
  })

  it('转出来的雷杀无次数限制，但实体杀仍受限', () => {
    const game = gameWith(FIVE)
    setUpYin(game)
    const tricks = Object.values(game.state.cards).filter((card) => card.category === 'trick' && !card.virtual)
      .slice(0, 2).map((card) => card.id)
    const realSlash = findCard(game, (card) => card.name === '杀')
    giveHand(game, 'p0', [...tricks, realSlash])
    game.state.turnUsage.slashUses = 1  // 普通次数已经用掉

    const slashActions = game.legalActions('p0').filter((action) => (
      action.kind === 'use-card' && (action as { asCardName?: string }).asCardName === '杀'
    ))
    const usedCardIds = new Set(slashActions.flatMap((action) => (action as { cardIds?: string[] }).cardIds ?? []))
    for (const trick of tricks) {
      expect(usedCardIds, '龙怒雷杀不受次数限制').toContain(trick)
    }
    expect(usedCardIds, '实体杀仍受次数限制，出不了').not.toContain(realSlash)
  })
})

describe('龙怒：本回合结束后失效', () => {
  it('回合结束清除强制改写，阴阳状态保留', () => {
    const game = gameWith(FIVE)
    const owner = playerOf(game, 'p0')
    owner.hp = 6
    owner.maxHp = 6
    enterPlayPhase(game, 'p0')
    const red = findCard(game, (card) => card.color === 'red' && card.category === 'basic')
    giveHand(game, 'p0', [red])
    expect(forcedIdentityFor(game.state, 'p0', red)).toBeTruthy()

    game.state.phase = 'finish'
    game.state.pendingRequests = []
    game.advancePhase()
    drain(game)

    expect(forcedIdentityFor(game.state, 'p0', red), '回合结束清除').toBeNull()
    expect(conversionStateOf(game.state, 'p0', 'longnu'), '阴阳状态不清除').toBe('yin')
  })
})

describe('结营', () => {
  it('游戏开始时就处于连环状态', () => {
    const game = gameWith(FIVE)
    expect(playerOf(game, 'p0').chained, '开局连环').toBe(true)
  })

  it('解除他连环的效果无效（铁索、技能都不行）', () => {
    const game = gameWith(FIVE)
    expect(playerOf(game, 'p0').chained).toBe(true)
    setChained(game as never, 'p0', 'tiesuo', false)
    expect(playerOf(game, 'p0').chained, '铁索解除无效').toBe(true)
    setChained(game as never, 'p0', 'some-skill', false)
    expect(playerOf(game, 'p0').chained, '技能解除也无效').toBe(true)
    // 别人不受这个锁影响
    setChained(game as never, 'p1', 'tiesuo', true)
    setChained(game as never, 'p1', 'tiesuo', false)
    expect(playerOf(game, 'p1').chained, '别人照常能被解除').toBe(false)
  })

  it('受到属性伤害结算后重新进入连环', () => {
    const game = gameWith(FIVE)
    playerOf(game, 'p0').hp = 6
    playerOf(game, 'p0').maxHp = 6
    expect(playerOf(game, 'p0').chained).toBe(true)
    game.damage({ sourceId: 'p1', targetId: 'p0', amount: 1, nature: 'fire', cardName: null })
    drain(game)
    expect(playerOf(game, 'p0').chained, '属性伤害结算后重新横置').toBe(true)
  })

  it('同一条传导链不会重复打到神刘备', () => {
    const game = gameWith(FIVE)
    for (const playerId of ['p0', 'p1', 'p2'] as const) {
      playerOf(game, playerId).hp = 8
      playerOf(game, playerId).maxHp = 8
      setChained(game as never, playerId, 'setup', true)
    }
    const before = playerOf(game, 'p0').hp
    game.damage({ sourceId: 'p3', targetId: 'p0', amount: 1, nature: 'fire', cardName: null })
    drain(game)
    // 起点吃 1 点；如果重新横置把自己加回同一条链，这里会掉 2 点甚至死循环
    expect(playerOf(game, 'p0').hp, '同一条链只打一次').toBe(before - 1)
  })

  it('所有连环角色手牌上限 +2，不只是神刘备', () => {
    const game = gameWith(FIVE)
    playerOf(game, 'p1').hp = 4
    playerOf(game, 'p1').maxHp = 4
    setChained(game as never, 'p1', 'setup', false)
    const plain = maxCardsOf(game.state, 'p1')
    setChained(game as never, 'p1', 'setup', true)
    expect(maxCardsOf(game.state, 'p1'), '连环之后 +2').toBe(plain + 2)
    setChained(game as never, 'p1', 'setup', false)
    expect(maxCardsOf(game.state, 'p1'), '解除之后立刻失去').toBe(plain)
  })

  it('结束阶段令一名其他角色进入连环，不是切换', () => {
    const game = gameWith(FIVE)
    setChained(game as never, 'p1', 'setup', true)
    game.state.currentPlayerId = 'p0'
    game.state.normalTurnPlayerId = 'p0'
    game.state.currentTurnKind = 'normal'
    game.state.phase = 'discard'
    game.state.skippedPhases = []
    game.state.judgedDelayedCards = []
    game.state.pendingRequests = []
    game.advancePhase()

    const request = pending(game)
    expect(String(request?.prompt)).toContain('结营')
    // 选一个已经连环的：不能把他解除
    game.respond({ requestId: request.id, playerId: 'p0', payload: { targetIds: ['p1'] } })
    expect(playerOf(game, 'p1').chained, '已连环的不会被解除').toBe(true)
    assertCardConservation(game.state)
  })
})
