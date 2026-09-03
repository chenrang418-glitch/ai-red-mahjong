import { describe, expect, it } from 'vitest'
import { SanguoshaGame } from '@/sanguosha/engine/game'
import { assertGameInvariants } from '@/sanguosha/engine/invariants'
import { assertCardConservation } from '@/sanguosha/engine/zones'
import type { GameSetup, Identity, PlayerId, Suit } from '@/sanguosha/engine/types'

/**
 * 林包·曹丕【行殇】【放逐】【颂威】。经典首版。
 *
 * 三条最容易做错的地方：
 *
 * 1. **行殇拿到的牌不能先进弃牌堆再捡回来**。死亡清牌之前就要把牌扣住，
 *    否则牌的来源语义全丢了。放弃发动时又必须原样进弃牌堆，
 *    处理区里绝不能留下无主的牌。
 * 2. **放逐是「翻面」不是「翻成背面」**。背面的角色会被翻回正面。
 * 3. **颂威的发动者是那名魏势力角色**，不是曹丕。文本里的「其」指判定的人。
 */

function gameWith(characterIds: string[], seed = 'caopi'): SanguoshaGame {
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

function findCard(game: SanguoshaGame, match: (card: { id: string; name: string; suit: Suit }) => boolean): string {
  const card = Object.values(game.state.cards).find((candidate) => match(candidate))
  if (!card) throw new Error('这副牌里找不到符合条件的牌')
  return card.id
}

function setHand(game: SanguoshaGame, playerId: PlayerId, count: number): void {
  const owner = playerOf(game, playerId)
  while (owner.zones.hand.length > count) game.state.zones.discardPile.push(owner.zones.hand.pop()!)
  while (owner.zones.hand.length < count) owner.zones.hand.push(game.state.zones.drawPile.shift()!)
}

/**
 * 把排队的技能发问放出来。
 *
 * 队列要等牌局往前走一步才抽干（和 sanguosha-damage-skills 同一条约定）。
 * 这里特意从准备阶段推进到判定阶段：判定区是空的，不会顺带冒出别的请求，
 * 也不会像推进到弃牌阶段那样弹一个弃牌窗口把要观察的问句挡住。
 */
function settleQueue(game: SanguoshaGame): void {
  if (game.state.status !== 'playing') return
  if (game.state.pendingRequests.length > 0) return
  game.state.phase = 'prepare'
  game.state.skippedPhases = []
  game.state.judgedDelayedCards = []
  game.advancePhase()
}

/** 把某人打到 0 血并走完濒死（无人相救），返回他死前区域里的全部牌。 */
function killWithoutRescue(game: SanguoshaGame, victimId: PlayerId): string[] {
  const victim = playerOf(game, victimId)
  const owned = [
    ...victim.zones.hand,
    ...Object.values(victim.zones.equipment).filter((id): id is string => Boolean(id)),
    ...victim.zones.judgingArea,
  ]
  victim.hp = 1
  game.damage({ sourceId: 'p1', targetId: victimId, amount: 1, cardName: null })
  // 求桃一律放弃
  for (let guard = 0; guard < 40; guard += 1) {
    const request = pending(game)
    if (!request || request.kind !== 'rescue') break
    game.respond({ requestId: request.id, playerId: request.playerId, payload: { actionId: 'rescue-pass' } })
  }
  // 排队的技能发问要等牌局往前走一步才放出来（和 sanguosha-damage-skills 同一条约定）
  settleQueue(game)
  return owned
}

const FIVE = ['caopi', 'zhangfei', 'zhangfei', 'zhangfei', 'zhangfei']

describe('行殇：获得死亡角色的所有牌', () => {
  it('手牌、装备区、判定区一张不落，而且没有路过弃牌堆', () => {
    const game = gameWith(FIVE)
    setHand(game, 'p0', 0)
    setHand(game, 'p2', 3)
    const victim = playerOf(game, 'p2')
    const weapon = findCard(game, (card) => card.name === '诸葛连弩')
    detach(game, weapon)
    victim.zones.equipment.weapon = weapon
    const le = findCard(game, (card) => card.name === '乐不思蜀')
    detach(game, le)
    victim.zones.judgingArea.push(le)

    const owned = killWithoutRescue(game, 'p2')
    expect(owned.length, '3 手牌 + 1 装备 + 1 判定').toBe(5)

    const ask = pending(game)
    expect(ask?.kind, '应该问曹丕要不要拿').toBe('choose-option')
    expect(ask.playerId).toBe('p0')
    for (const cardId of owned) {
      expect(game.state.zones.discardPile, '还没决定之前不能进弃牌堆').not.toContain(cardId)
      expect(game.state.zones.processingArea, '暂存在处理区').toContain(cardId)
    }

    game.respond({ requestId: ask.id, playerId: 'p0', payload: { optionId: 'yes' } })

    expect(playerOf(game, 'p0').zones.hand.sort()).toEqual([...owned].sort())
    expect(game.state.zones.processingArea, '处理区不能留残牌').toEqual([])
    expect(game.state.deathClaim, '挂账必须清掉').toBeNull()
    assertCardConservation(game.state)
    assertGameInvariants(game.state)
  })

  it('放弃发动时牌全部进弃牌堆，回到正常死亡清牌的结果', () => {
    const game = gameWith(FIVE)
    setHand(game, 'p2', 3)
    const owned = killWithoutRescue(game, 'p2')

    const ask = pending(game)
    game.respond({ requestId: ask.id, playerId: 'p0', payload: { optionId: 'no' } })

    for (const cardId of owned) expect(game.state.zones.discardPile).toContain(cardId)
    expect(game.state.zones.processingArea).toEqual([])
    expect(game.state.deathClaim).toBeNull()
    assertCardConservation(game.state)
    assertGameInvariants(game.state)
  })

  it('死亡角色一张牌都没有时不弹窗', () => {
    const game = gameWith(FIVE)
    setHand(game, 'p2', 0)
    killWithoutRescue(game, 'p2')
    expect(pending(game), '没牌可拿就别问').toBeUndefined()
    assertCardConservation(game.state)
  })

  it('曹丕自己死亡不触发行殇', () => {
    const game = gameWith(FIVE)
    setHand(game, 'p0', 3)
    const owned = killWithoutRescue(game, 'p0')
    expect(pending(game), '自己死了没得发动').toBeUndefined()
    for (const cardId of owned) expect(game.state.zones.discardPile).toContain(cardId)
    assertCardConservation(game.state)
  })

  it('周泰靠不屈活着不算死亡，行殇拿不到牌', () => {
    const game = gameWith(['caopi', 'zhangfei', 'zhoutai', 'zhangfei', 'zhangfei'])
    setHand(game, 'p2', 3)
    const zhoutai = playerOf(game, 'p2')
    zhoutai.hp = 1
    game.damage({ sourceId: 'p1', targetId: 'p2', amount: 1, cardName: null })
    settleQueue(game)
    for (let guard = 0; guard < 40; guard += 1) {
      const request = pending(game)
      if (!request) break
      game.respond({
        requestId: request.id, playerId: request.playerId,
        payload: request.kind === 'rescue' ? { actionId: 'rescue-pass' } : { optionId: 'yes' },
      })
    }
    expect(zhoutai.alive, '不屈让他还活着').toBe(true)
    expect(game.state.deathClaim, '没死就没有死亡牌可认领').toBeNull()
    assertCardConservation(game.state)
  })
})

describe('放逐：摸 X 张牌并翻面', () => {
  /** 让曹丕挨一下，走到放逐的发动询问。 */
  function damageCaopi(game: SanguoshaGame, downTo: number): void {
    playerOf(game, 'p0').hp = downTo + 1
    game.damage({ sourceId: 'p1', targetId: 'p0', amount: 1, cardName: null })
    settleQueue(game)
  }

  it('满血时不触发——受伤后 X 至少是 1，但先确认没受伤时不弹窗', () => {
    const game = gameWith(FIVE)
    // 直接回满再看：没有受伤事件就不会有放逐
    expect(pending(game)).toBeUndefined()
  })

  it('受到一次伤害只问一次，挨两点也只发动一次', () => {
    const game = gameWith(FIVE)
    const caopi = playerOf(game, 'p0')
    caopi.hp = 3
    let asks = 0
    game.events.on('SkillActivated', (context) => {
      if ((context.event.payload as { skillId?: unknown }).skillId === 'fangzhu') asks += 1
    })
    game.damage({ sourceId: 'p1', targetId: 'p0', amount: 2, cardName: null })
    settleQueue(game)
    const ask = pending(game)
    expect(ask?.kind).toBe('choose-option')
    expect(ask.prompt).toContain('放逐')
    game.respond({ requestId: ask.id, playerId: 'p0', payload: { optionId: 'no' } })
    expect(pending(game), '一次伤害事件只问一次').toBeUndefined()
    expect(asks).toBe(0)
  })

  it('X 等于已损失体力值，先摸后翻', () => {
    const game = gameWith(FIVE)
    damageCaopi(game, 1)
    const caopi = playerOf(game, 'p0')
    expect(caopi.hp).toBe(1)
    // 曹丕坐主公位，体力上限会 +1，所以 X 要按真实上限算，不能写死 3
    const x = caopi.maxHp - caopi.hp
    expect(x).toBeGreaterThan(0)
    setHand(game, 'p2', 0)

    game.respond({ requestId: pending(game).id, playerId: 'p0', payload: { optionId: 'yes' } })
    const pick = pending(game)
    expect(pick?.kind).toBe('choose-targets')
    expect(pick.candidateIds, '只能选其他角色').not.toContain('p0')
    game.respond({ requestId: pick.id, playerId: 'p0', payload: { targetIds: ['p2'] } })

    expect(playerOf(game, 'p2').zones.hand.length, 'X = 已损失体力值').toBe(x)
    expect(playerOf(game, 'p2').faceDown, '摸完之后翻面').toBe(true)
    assertCardConservation(game.state)
    assertGameInvariants(game.state)
  })

  it('目标已经背面时会被翻回正面——是「翻面」不是「翻成背面」', () => {
    const game = gameWith(FIVE)
    playerOf(game, 'p2').faceDown = true
    damageCaopi(game, 2)

    game.respond({ requestId: pending(game).id, playerId: 'p0', payload: { optionId: 'yes' } })
    game.respond({ requestId: pending(game).id, playerId: 'p0', payload: { targetIds: ['p2'] } })

    expect(playerOf(game, 'p2').faceDown, '背面翻回正面').toBe(false)
    assertGameInvariants(game.state)
  })

  it('翻面不影响横置状态，两者互相独立', () => {
    const game = gameWith(FIVE)
    playerOf(game, 'p2').chained = true
    damageCaopi(game, 2)
    game.respond({ requestId: pending(game).id, playerId: 'p0', payload: { optionId: 'yes' } })
    game.respond({ requestId: pending(game).id, playerId: 'p0', payload: { targetIds: ['p2'] } })

    expect(playerOf(game, 'p2').faceDown).toBe(true)
    expect(playerOf(game, 'p2').chained, '横置不该被翻面清掉').toBe(true)
  })

  it('可以放弃发动', () => {
    const game = gameWith(FIVE)
    damageCaopi(game, 2)
    game.respond({ requestId: pending(game).id, playerId: 'p0', payload: { optionId: 'no' } })
    expect(pending(game)).toBeUndefined()
    expect(game.state.players.some((player) => player.faceDown)).toBe(false)
  })
})

describe('颂威：其他魏势力角色的黑色判定生效后', () => {
  /** 给某人判定区放一张乐不思蜀，把回合推到他的判定阶段，并把牌堆顶换成指定花色。 */
  function judgeWith(game: SanguoshaGame, ownerId: PlayerId, suit: Suit): void {
    const le = findCard(game, (card) => card.name === '乐不思蜀')
    detach(game, le)
    playerOf(game, ownerId).zones.judgingArea.push(le)
    const top = game.state.zones.drawPile.find((id) => game.state.cards[id].suit === suit)!
    game.state.zones.drawPile = [top, ...game.state.zones.drawPile.filter((id) => id !== top)]
    game.state.currentPlayerId = ownerId
    game.state.phase = 'prepare'
    game.state.skippedPhases = []
    game.state.judgedDelayedCards = []
    game.advancePhase()
    // 无懈一律放弃
    for (let guard = 0; guard < 20; guard += 1) {
      const request = pending(game)
      if (!request || request.kind !== 'respond-card') break
      game.respond({ requestId: request.id, playerId: request.playerId, payload: { actionId: 'respond-pass' } })
    }
  }

  const LORD_CAOPI = ['caopi', 'xuchu', 'zhangfei', 'zhangfei', 'zhangfei']

  it('黑色判定后问的是那名魏势力角色，不是曹丕', () => {
    const game = gameWith(LORD_CAOPI)
    judgeWith(game, 'p1', 'spade')
    const ask = pending(game)
    expect(ask?.kind).toBe('choose-option')
    expect(ask.prompt).toContain('颂威')
    expect(ask.playerId, '决定权在判定的那名魏势力角色手上').toBe('p1')

    const before = playerOf(game, 'p0').zones.hand.length
    game.respond({ requestId: ask.id, playerId: 'p1', payload: { optionId: 'yes' } })
    expect(playerOf(game, 'p0').zones.hand.length, '主公摸一张').toBe(before + 1)
    assertCardConservation(game.state)
  })

  it('红色判定不触发', () => {
    const game = gameWith(LORD_CAOPI)
    judgeWith(game, 'p1', 'heart')
    expect(pending(game)).toBeUndefined()
  })

  it('非魏势力角色的黑色判定不触发', () => {
    const game = gameWith(['caopi', 'zhangfei', 'zhangfei', 'zhangfei', 'zhangfei'])
    judgeWith(game, 'p1', 'spade')
    expect(pending(game), '张飞是蜀，不该触发').toBeUndefined()
  })

  it('曹丕自己的黑色判定不触发——文本是「其他魏势力角色」', () => {
    const game = gameWith(LORD_CAOPI)
    judgeWith(game, 'p0', 'spade')
    expect(pending(game)).toBeUndefined()
  })

  it('曹丕不是主公时颂威不生效', () => {
    const game = gameWith(LORD_CAOPI)
    playerOf(game, 'p0').identity = 'loyalist'
    playerOf(game, 'p1').identity = 'lord'
    judgeWith(game, 'p1', 'spade')
    expect(pending(game), '主公技只在坐主公位时生效').toBeUndefined()
  })

  it('看的是改判之后的最终颜色：鬼才把红改成黑也会触发', () => {
    const game = gameWith(['caopi', 'simayi', 'zhangfei', 'zhangfei', 'zhangfei'])
    // 司马懿是魏，手上留一张黑桃用来改判
    setHand(game, 'p1', 0)
    const spade = findCard(game, (card) => card.suit === 'spade' && card.name !== '乐不思蜀')
    detach(game, spade)
    playerOf(game, 'p1').zones.hand.push(spade)

    judgeWith(game, 'p1', 'heart')
    const retrial = pending(game)
    expect(retrial?.kind, '鬼才应该拿到改判请求').toBe('choose-cards')
    game.respond({ requestId: retrial.id, playerId: 'p1', payload: { cardIds: [spade] } })
    // 改判后可能再问一轮改判，一律放弃
    for (let guard = 0; guard < 20; guard += 1) {
      const request = pending(game)
      if (!request || request.kind !== 'choose-cards') break
      game.respond({ requestId: request.id, playerId: request.playerId, payload: { cardIds: [] } })
    }

    const ask = pending(game)
    expect(ask?.prompt, '最终判定是黑色，颂威应当触发').toContain('颂威')
    expect(ask.playerId).toBe('p1')
    assertCardConservation(game.state)
  })
})
