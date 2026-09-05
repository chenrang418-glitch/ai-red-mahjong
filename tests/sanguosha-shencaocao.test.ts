import { describe, expect, it } from 'vitest'
import { SanguoshaGame } from '@/sanguosha/engine/game'
import { assertGameInvariants } from '@/sanguosha/engine/invariants'
import { assertCardConservation, moveCard } from '@/sanguosha/engine/zones'
import { getDistance } from '@/sanguosha/engine/distance'
import type { CardId, GameSetup, Identity, PlayerId } from '@/sanguosha/engine/types'

/**
 * 神曹操。本项目自研表述。**原版**。
 *
 * 三条最容易写错、也最值得钉死的：
 *
 * 1. **每 1 点伤害一次独立机会**。2 点伤害 = 两次归心 = 翻两次面，翻回正面。
 * 2. **每名有牌的其他角色各拿一张**，不是全场只拿一张。
 * 3. **区域含判定区**，而且手牌必须是暗的——不能先看见牌面再挑。
 *
 * 另外钉一条版本锁：归心是**逐名选择**，不是 2016 OL 的随机获得。
 */

function gameWith(characterIds: string[], seed = 'shencaocao'): SanguoshaGame {
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
  const owner = playerOf(game, playerId)
  for (const cardId of [...owner.zones.hand]) {
    moveCard(game.state, cardId, { kind: 'hand', playerId }, { kind: 'discardPile' })
  }
}

function giveHand(game: SanguoshaGame, playerId: PlayerId, cardIds: CardId[]): void {
  for (const cardId of cardIds) {
    detach(game, cardId)
    playerOf(game, playerId).zones.hand.push(cardId)
  }
}

function findCard(game: SanguoshaGame, match: (card: { name: string; suit: string; id: string }) => boolean): CardId {
  const card = Object.values(game.state.cards).find((candidate) => match(candidate as never))
  if (!card) throw new Error('找不到符合条件的牌')
  return card.id
}

/** 清空所有人的区域，让每个用例自己摆场面。 */
function clearEveryone(game: SanguoshaGame): void {
  for (const player of game.state.players) {
    clearHand(game, player.id)
    for (const cardId of [...player.zones.judgingArea]) {
      moveCard(game.state, cardId, { kind: 'judgingArea', playerId: player.id }, { kind: 'discardPile' })
    }
    for (const [slot, equipped] of Object.entries(player.zones.equipment)) {
      if (equipped) {
        moveCard(game.state, equipped, { kind: 'equipment', playerId: player.id, slot: slot as never }, { kind: 'discardPile' })
      }
    }
  }
}

/** 把归心的「是否发动」问完，返回是否真的被问了。 */
function answerGuixinPrompt(game: SanguoshaGame, answer: 'yes' | 'no'): boolean {
  const request = pending(game)
  if (!request || !String(request.prompt).includes('归心')) return false
  game.respond({ requestId: request.id, playerId: request.playerId, payload: { optionId: answer } })
  return true
}

/** 逐名拿牌：每次都拿第一个候选，直到归心结束。 */
function takeAllGuixinCards(game: SanguoshaGame, limit = 20): number {
  let taken = 0
  let guard = 0
  while (guard < limit) {
    const request = pending(game)
    if (!request || request.kind !== 'choose-cards' || !String(request.prompt).includes('归心')) break
    const pool = [...(request as { cardIds: string[] }).cardIds, ...(request as { hiddenCardSlots: string[] }).hiddenCardSlots]
    game.respond({ requestId: request.id, playerId: request.playerId, payload: { cardIds: [pool[0]] } })
    taken += 1
    guard += 1
  }
  return taken
}

/**
 * 造成伤害并排空技能队列。
 *
 * 归心是**排队**发问的（每 1 点伤害排一次），而 `game.damage()` 是测试直接调的
 * 裸入口、不会 settle。真实牌局里伤害总发生在 act / respond / advancePhase 内部，
 * 那些出口都会 settle。这里手动推一下，和既有的左慈测试同一套写法。
 */
function damageAndSettle(game: SanguoshaGame, options: { sourceId: PlayerId | null; targetId: PlayerId; amount: number }): void {
  game.damage({ ...options, cardName: null })
  ;(game as unknown as { settle(): void }).settle()
}

const FIVE = ['shencaocao', 'zhangfei', 'zhangfei', 'zhangfei', 'zhangfei']

describe('归心：每 1 点伤害一次独立机会', () => {
  it('受到 1 点伤害给 1 次机会', () => {
    const game = gameWith(FIVE)
    clearEveryone(game)
    giveHand(game, 'p1', [findCard(game, (card) => card.name === '杀')])
    playerOf(game, 'p0').hp = 3

    damageAndSettle(game, { sourceId: 'p1', targetId: 'p0', amount: 1 })
    expect(answerGuixinPrompt(game, 'no'), '应该问一次').toBe(true)
    expect(answerGuixinPrompt(game, 'no'), '不该问第二次').toBe(false)
  })

  it('受到 2 点伤害给 2 次独立机会，翻面两次回到正面', () => {
    const game = gameWith(FIVE)
    clearEveryone(game)
    // 两轮归心各拿一张，所以每人要有两张牌，否则第二轮无牌可拿就没有机会
    const pool = Object.values(game.state.cards).slice(0, 4).map((card) => card.id)
    giveHand(game, 'p1', pool.slice(0, 2))
    giveHand(game, 'p2', pool.slice(2, 4))
    playerOf(game, 'p0').hp = 4
    playerOf(game, 'p0').maxHp = 4
    expect(playerOf(game, 'p0').faceDown, '开局正面').toBe(false)

    damageAndSettle(game, { sourceId: 'p1', targetId: 'p0', amount: 2 })

    // 第一次归心
    expect(answerGuixinPrompt(game, 'yes')).toBe(true)
    expect(takeAllGuixinCards(game), '第一轮逐名各拿一张').toBe(2)
    expect(playerOf(game, 'p0').faceDown, '第一次翻到背面').toBe(true)

    // 第二次归心
    expect(answerGuixinPrompt(game, 'yes'), '第二次机会').toBe(true)
    expect(takeAllGuixinCards(game), '第二轮再各拿一张').toBe(2)
    expect(playerOf(game, 'p0').faceDown, '第二次翻回正面').toBe(false)
    expect(playerOf(game, 'p0').zones.hand, '两轮共拿到四张').toHaveLength(4)
    assertCardConservation(game.state)
  })

  it('受到 3 点伤害给 3 次机会', () => {
    const game = gameWith(FIVE)
    clearEveryone(game)
    giveHand(game, 'p1', Object.values(game.state.cards).slice(0, 6).map((card) => card.id))
    playerOf(game, 'p0').hp = 5
    playerOf(game, 'p0').maxHp = 5

    damageAndSettle(game, { sourceId: 'p1', targetId: 'p0', amount: 3 })
    let chances = 0
    while (answerGuixinPrompt(game, 'no')) chances += 1
    expect(chances).toBe(3)
  })

  it('无来源伤害（闪电、崩坏）同样可以发动', () => {
    const game = gameWith(FIVE)
    clearEveryone(game)
    giveHand(game, 'p1', [findCard(game, (card) => card.name === '杀')])
    playerOf(game, 'p0').hp = 3

    damageAndSettle(game, { sourceId: null, targetId: 'p0', amount: 1 })
    expect(answerGuixinPrompt(game, 'no'), '归心不看伤害来源').toBe(true)
  })

  it('没有任何其他角色有牌时不发无意义的请求', () => {
    const game = gameWith(FIVE)
    clearEveryone(game)
    playerOf(game, 'p0').hp = 3
    giveHand(game, 'p0', [findCard(game, (card) => card.name === '杀')])  // 只有自己有牌

    damageAndSettle(game, { sourceId: null, targetId: 'p0', amount: 1 })
    expect(pending(game), '不该有请求').toBeUndefined()
  })

  it('可以放弃，放弃就不翻面', () => {
    const game = gameWith(FIVE)
    clearEveryone(game)
    giveHand(game, 'p1', [findCard(game, (card) => card.name === '杀')])
    playerOf(game, 'p0').hp = 3

    damageAndSettle(game, { sourceId: null, targetId: 'p0', amount: 1 })
    answerGuixinPrompt(game, 'no')
    expect(playerOf(game, 'p0').faceDown, '放弃不翻面').toBe(false)
    expect(playerOf(game, 'p1').zones.hand, '放弃不拿牌').toHaveLength(1)
  })
})

describe('归心：每名有牌的其他角色各获得一张', () => {
  it('三名角色都有牌就拿三张，不是全场只拿一张', () => {
    const game = gameWith(FIVE)
    clearEveryone(game)
    const cards = Object.values(game.state.cards).slice(0, 3).map((card) => card.id)
    giveHand(game, 'p1', [cards[0]])
    giveHand(game, 'p2', [cards[1]])
    giveHand(game, 'p3', [cards[2]])
    playerOf(game, 'p0').hp = 3

    damageAndSettle(game, { sourceId: null, targetId: 'p0', amount: 1 })
    answerGuixinPrompt(game, 'yes')
    const taken = takeAllGuixinCards(game)

    expect(taken, '逐名各问一次').toBe(3)
    expect(playerOf(game, 'p0').zones.hand, '各拿一张共三张').toHaveLength(3)
    for (const playerId of ['p1', 'p2', 'p3'] as const) {
      expect(playerOf(game, playerId).zones.hand, `${playerId} 的牌被拿走`).toHaveLength(0)
    }
    assertCardConservation(game.state)
  })

  it('没有牌的角色被跳过，不发空请求', () => {
    const game = gameWith(FIVE)
    clearEveryone(game)
    giveHand(game, 'p2', [findCard(game, (card) => card.name === '杀')])
    playerOf(game, 'p0').hp = 3

    damageAndSettle(game, { sourceId: null, targetId: 'p0', amount: 1 })
    answerGuixinPrompt(game, 'yes')
    expect(takeAllGuixinCards(game), '只有 p2 有牌').toBe(1)
  })

  it('每名角色一张，多手牌的也只拿一张', () => {
    const game = gameWith(FIVE)
    clearEveryone(game)
    giveHand(game, 'p1', Object.values(game.state.cards).slice(0, 5).map((card) => card.id))
    playerOf(game, 'p0').hp = 3

    damageAndSettle(game, { sourceId: null, targetId: 'p0', amount: 1 })
    answerGuixinPrompt(game, 'yes')
    takeAllGuixinCards(game)
    expect(playerOf(game, 'p0').zones.hand, '只拿一张').toHaveLength(1)
    expect(playerOf(game, 'p1').zones.hand, '剩下四张还在').toHaveLength(4)
  })
})

describe('归心：三个区域都能拿', () => {
  it('手牌是暗的，只给占位槽不泄露牌面', () => {
    const game = gameWith(FIVE)
    clearEveryone(game)
    const secret = findCard(game, (card) => card.name === '桃')
    giveHand(game, 'p1', [secret])
    playerOf(game, 'p0').hp = 3

    damageAndSettle(game, { sourceId: null, targetId: 'p0', amount: 1 })
    answerGuixinPrompt(game, 'yes')
    const request = pending(game) as unknown as { cardIds: string[]; hiddenCardSlots: string[] }
    expect(request.cardIds, '手牌不能出现在公开候选里').not.toContain(secret)
    expect(request.hiddenCardSlots, '给的是占位槽').toHaveLength(1)
  })

  it('装备区的牌公开可选，拿走时走正常的装备离场', () => {
    const game = gameWith(FIVE)
    clearEveryone(game)
    const armor = findCard(game, (card) => card.name === '八卦阵')
    detach(game, armor)
    playerOf(game, 'p1').zones.equipment.armor = armor
    playerOf(game, 'p0').hp = 3

    const lost: string[] = []
    game.events.on('LoseEquipment', () => { lost.push('LoseEquipment') })

    damageAndSettle(game, { sourceId: null, targetId: 'p0', amount: 1 })
    answerGuixinPrompt(game, 'yes')
    const request = pending(game) as unknown as { cardIds: string[] }
    expect(request.cardIds, '装备是公开的').toContain(armor)
    takeAllGuixinCards(game)

    expect(playerOf(game, 'p0').zones.hand).toContain(armor)
    expect(playerOf(game, 'p1').zones.equipment.armor).toBeNull()
    expect(lost, '装备离场事件要正常发出').not.toHaveLength(0)
    assertCardConservation(game.state)
  })

  it('判定区的牌也能拿（区域里的牌包含判定区）', () => {
    const game = gameWith(FIVE)
    clearEveryone(game)
    const delayed = findCard(game, (card) => card.name === '乐不思蜀')
    detach(game, delayed)
    playerOf(game, 'p1').zones.judgingArea.push(delayed)
    playerOf(game, 'p0').hp = 3

    damageAndSettle(game, { sourceId: null, targetId: 'p0', amount: 1 })
    answerGuixinPrompt(game, 'yes')
    const request = pending(game) as unknown as { cardIds: string[] }
    expect(request.cardIds, '判定区是公开的').toContain(delayed)
    takeAllGuixinCards(game)

    expect(playerOf(game, 'p0').zones.hand).toContain(delayed)
    expect(playerOf(game, 'p1').zones.judgingArea, '判定牌离开判定区').toHaveLength(0)
    assertCardConservation(game.state)
  })
})

describe('归心：中途重新验证', () => {
  it('发动时快照的角色若中途没了牌，就跳过不发空请求', () => {
    const game = gameWith(FIVE)
    clearEveryone(game)
    giveHand(game, 'p1', [findCard(game, (card) => card.name === '杀')])
    giveHand(game, 'p2', [findCard(game, (card) => card.name === '闪')])
    playerOf(game, 'p0').hp = 3

    damageAndSettle(game, { sourceId: null, targetId: 'p0', amount: 1 })
    answerGuixinPrompt(game, 'yes')

    /*
     * 发动时名单是 [p1, p2]，此刻正在问 p1。
     * **在回答 p1 之前**把 p2 的牌清掉——回答之后引擎会立刻问 p2，就来不及了。
     * 这样才真正测到「每处理一名都重新验证」。
     */
    const first = pending(game)
    clearHand(game, 'p2')
    const pool = [...(first as unknown as { cardIds: string[] }).cardIds,
      ...(first as unknown as { hiddenCardSlots: string[] }).hiddenCardSlots]
    game.respond({ requestId: first.id, playerId: 'p0', payload: { cardIds: [pool[0]] } })

    expect(takeAllGuixinCards(game), 'p2 已经没牌了').toBe(0)
    expect(playerOf(game, 'p0').faceDown, '照样翻面收尾').toBe(true)
    assertGameInvariants(game.state)
  })
})

describe('飞影', () => {
  it('其他角色到神曹操的距离 +1，神曹操到别人不变', () => {
    const game = gameWith(FIVE)
    const toShen = getDistance(game.state, 'p1', 'p0')
    const fromShen = getDistance(game.state, 'p0', 'p1')
    const baseline = getDistance(game.state, 'p1', 'p2')

    expect(toShen, '别人到神曹操要比同样座次的普通距离多 1').toBe(baseline + 1)
    expect(fromShen, '神曹操到别人不受影响').toBe(baseline)
  })

  it('与 +1 坐骑叠加，不是互相覆盖', () => {
    const game = gameWith(FIVE)
    const before = getDistance(game.state, 'p1', 'p0')
    const horse = findCard(game, (card) => card.name === '+1马' || card.name === '绝影')
    detach(game, horse)
    playerOf(game, 'p0').zones.equipment.defensiveHorse = horse
    expect(getDistance(game.state, 'p1', 'p0'), '坐骑和飞影相加').toBe(before + 1)
  })

  it('与马术等技能修正共存', () => {
    const game = gameWith(['shencaocao', 'machao', 'zhangfei', 'zhangfei', 'zhangfei'])
    // 马超【马术】是 toOthers -1，飞影是 fromOthers +1，两者在同一条加法里抵消
    const withBoth = getDistance(game.state, 'p1', 'p0')
    const plain = getDistance(game.state, 'p1', 'p2')
    expect(withBoth, '马术 -1 与飞影 +1 相抵，回到基础距离').toBe(plain)
  })
})

describe('版本锁：原版归心，不是 2016 OL 随机化', () => {
  it('拿哪张牌由玩家逐名选择，不是随机', () => {
    const game = gameWith(FIVE)
    clearEveryone(game)
    const armor = findCard(game, (card) => card.name === '八卦阵')
    const weapon = findCard(game, (card) => card.name === '诸葛连弩')
    detach(game, armor)
    detach(game, weapon)
    playerOf(game, 'p1').zones.equipment.armor = armor
    playerOf(game, 'p1').zones.equipment.weapon = weapon
    playerOf(game, 'p0').hp = 3

    damageAndSettle(game, { sourceId: null, targetId: 'p0', amount: 1 })
    answerGuixinPrompt(game, 'yes')
    const request = pending(game) as unknown as { cardIds: string[]; min: number; max: number }
    // 随机版不会把候选列出来让人挑；这里必须是一个真正的选择请求
    expect(request.cardIds).toContain(armor)
    expect(request.cardIds).toContain(weapon)
    expect(request.min).toBe(1)
    expect(request.max).toBe(1)

    // 指定拿诸葛连弩，就必须拿到诸葛连弩
    game.respond({ requestId: pending(game).id, playerId: 'p0', payload: { cardIds: [weapon] } })
    expect(playerOf(game, 'p0').zones.hand, '拿到的是玩家选的那张').toContain(weapon)
    expect(playerOf(game, 'p1').zones.equipment.armor, '没选的还在原处').toBe(armor)
  })
})

describe('归心：序列化与重连', () => {
  it('归心进行到一半可以序列化恢复，剩余名单不丢', () => {
    const game = gameWith(FIVE)
    clearEveryone(game)
    giveHand(game, 'p1', [findCard(game, (card) => card.name === '杀')])
    giveHand(game, 'p2', [findCard(game, (card) => card.name === '闪')])
    giveHand(game, 'p3', [findCard(game, (card) => card.name === '桃')])
    playerOf(game, 'p0').hp = 3

    damageAndSettle(game, { sourceId: null, targetId: 'p0', amount: 1 })
    answerGuixinPrompt(game, 'yes')
    // 先拿一名
    const first = pending(game)
    const pool = [...(first as unknown as { cardIds: string[] }).cardIds,
      ...(first as unknown as { hiddenCardSlots: string[] }).hiddenCardSlots]
    game.respond({ requestId: first.id, playerId: 'p0', payload: { cardIds: [pool[0]] } })

    const restored = SanguoshaGame.restore(JSON.parse(JSON.stringify(game.serialize())))
    expect(takeAllGuixinCards(restored), '恢复后继续处理剩下两名').toBe(2)
    expect(playerOf(restored, 'p0').zones.hand, '一共拿到三张').toHaveLength(3)
    expect(playerOf(restored, 'p0').faceDown, '收尾翻面').toBe(true)
    assertCardConservation(restored.state)
  })
})
