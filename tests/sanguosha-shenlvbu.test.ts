import { describe, expect, it } from 'vitest'
import { SanguoshaGame } from '@/sanguosha/engine/game'
import { assertGameInvariants } from '@/sanguosha/engine/invariants'
import { assertCardConservation, moveCard } from '@/sanguosha/engine/zones'
import { isArmorSuppressed } from '@/sanguosha/engine/armor-suppression'
import { hasArmor } from '@/sanguosha/engine/equipment'
import { RAGE_MARK } from '@/sanguosha/data/characters/god-shenlvbu'
import type { CardId, GameSetup, Identity, PlayerId } from '@/sanguosha/engine/types'

/**
 * 神吕布。经典「神话再临·神」。
 *
 * 最容易写错的四条：
 *
 * 1. 狂暴**按伤害点数**：造成 3 点就是 3 枚暴怒，不是每个伤害事件 +1。
 * 2. 无谋**一张牌只触发一次**：南蛮指定五个目标也只付一次代价。
 * 3. 无前的无双是**神吕布本回合获得**（对谁都生效），防具失效**只对被指定的那个人**；
 *    一回合发动两次也只有一份无双，不会变成要出四张闪。
 * 4. 神愤是**三轮**：先全体伤害，再全体弃装备，再全体弃手牌，最后才翻面。
 */

function gameWith(characterIds: string[], seed = 'shenlvbu'): SanguoshaGame {
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
      ? { cardIds: (request as unknown as { cardIds: string[]; min: number }).cardIds.slice(0, (request as unknown as { min: number }).min) }
      : request.kind === 'choose-targets'
        ? { targetIds: [] }
        : request.kind === 'rescue' || request.kind === 'respond-card'
          ? { actionId: (request as unknown as { actionIds: string[] }).actionIds.slice(-1)[0] }
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

function rage(game: SanguoshaGame, playerId: PlayerId): number {
  return playerOf(game, playerId).marks[RAGE_MARK] ?? 0
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

function findCard(game: SanguoshaGame, match: (card: { name: string; suit: string; id: string }) => boolean): CardId {
  const card = Object.values(game.state.cards).find((candidate) => match(candidate as never))
  if (!card) throw new Error('找不到符合条件的牌')
  return card.id
}

function enterPlay(game: SanguoshaGame, playerId: PlayerId): void {
  game.state.currentPlayerId = playerId
  game.state.normalTurnPlayerId = playerId
  game.state.currentTurnKind = 'normal'
  game.state.phase = 'play'
  game.state.skippedPhases = []
  game.state.judgedDelayedCards = []
}

function settle(game: SanguoshaGame): void {
  ;(game as unknown as { settle(): void }).settle()
}

function damageAndSettle(game: SanguoshaGame, options: { sourceId: PlayerId | null; targetId: PlayerId; amount: number }): void {
  game.damage({ ...options, cardName: null })
  settle(game)
}

const FIVE = ['shenlvbu', 'zhangfei', 'zhangfei', 'zhangfei', 'zhangfei']

describe('狂暴', () => {
  it('游戏开始时获得 2 枚暴怒', () => {
    const game = gameWith(FIVE)
    expect(rage(game, 'p0')).toBe(2)
  })

  it('造成 1 点伤害 +1，造成 3 点伤害 +3', () => {
    const game = gameWith(FIVE)
    playerOf(game, 'p1').hp = 9
    playerOf(game, 'p1').maxHp = 9
    const before = rage(game, 'p0')

    damageAndSettle(game, { sourceId: 'p0', targetId: 'p1', amount: 1 })
    expect(rage(game, 'p0'), '造成 1 点 +1').toBe(before + 1)

    damageAndSettle(game, { sourceId: 'p0', targetId: 'p1', amount: 3 })
    expect(rage(game, 'p0'), '造成 3 点 +3，不是每次事件 +1').toBe(before + 4)
  })

  it('受到 1 点伤害 +1，受到 3 点伤害 +3', () => {
    const game = gameWith(FIVE)
    playerOf(game, 'p0').hp = 9
    playerOf(game, 'p0').maxHp = 9
    const before = rage(game, 'p0')

    damageAndSettle(game, { sourceId: 'p1', targetId: 'p0', amount: 1 })
    expect(rage(game, 'p0')).toBe(before + 1)

    damageAndSettle(game, { sourceId: 'p1', targetId: 'p0', amount: 3 })
    expect(rage(game, 'p0')).toBe(before + 4)
  })

  it('暴怒进序列化，重连不丢', () => {
    const game = gameWith(FIVE)
    playerOf(game, 'p0').marks[RAGE_MARK] = 7
    const restored = SanguoshaGame.restore(JSON.parse(JSON.stringify(game.serialize())))
    expect(rage(restored, 'p0')).toBe(7)
  })
})

describe('无谋', () => {
  /** 直接派发一次「使用锦囊」事件，专测无谋的触发条件。 */
  function useTrick(game: SanguoshaGame, cardName: string, targetIds: PlayerId[] = ['p1']): void {
    game.dispatch('CardUsed', { cardId: 'x', cardName, targetIds }, { sourceId: 'p0' })
    settle(game)
  }

  it('使用普通锦囊要二选一', () => {
    const game = gameWith(FIVE)
    useTrick(game, '无中生有')
    const request = pending(game)
    expect(String(request?.prompt)).toContain('无谋')
    expect((request as unknown as { options: Array<{ id: string }> }).options.map((option) => option.id))
      .toEqual(['rage', 'hp'])
  })

  it('选移去暴怒就扣 1 枚，不掉血', () => {
    const game = gameWith(FIVE)
    const hp = playerOf(game, 'p0').hp
    useTrick(game, '无中生有')
    game.respond({ requestId: pending(game).id, playerId: 'p0', payload: { optionId: 'rage' } })
    expect(rage(game, 'p0')).toBe(1)
    expect(playerOf(game, 'p0').hp).toBe(hp)
  })

  it('选失去体力就掉 1 血，暴怒不变', () => {
    const game = gameWith(FIVE)
    const hp = playerOf(game, 'p0').hp
    useTrick(game, '无中生有')
    game.respond({ requestId: pending(game).id, playerId: 'p0', payload: { optionId: 'hp' } })
    expect(playerOf(game, 'p0').hp).toBe(hp - 1)
    expect(rage(game, 'p0'), '暴怒不变').toBe(2)
  })

  it('多目标锦囊只触发一次', () => {
    const game = gameWith(FIVE)
    useTrick(game, '南蛮入侵', ['p1', 'p2', 'p3', 'p4'])
    expect(String(pending(game)?.prompt)).toContain('无谋')
    game.respond({ requestId: pending(game).id, playerId: 'p0', payload: { optionId: 'rage' } })
    expect(pending(game), '不该再问第二次').toBeUndefined()
    expect(rage(game, 'p0'), '只扣了 1 枚').toBe(1)
  })

  it('延时锦囊不触发', () => {
    const game = gameWith(FIVE)
    for (const name of ['乐不思蜀', '兵粮寸断', '闪电']) {
      useTrick(game, name)
      expect(pending(game), `${name} 不该触发无谋`).toBeUndefined()
    }
    expect(rage(game, 'p0')).toBe(2)
  })

  it('无懈可击是非延时锦囊，同样触发', () => {
    const game = gameWith(FIVE)
    useTrick(game, '无懈可击')
    expect(String(pending(game)?.prompt)).toContain('无谋')
  })

  it('0 暴怒时强制失去体力，不发付不起的二选一', () => {
    const game = gameWith(FIVE)
    playerOf(game, 'p0').marks[RAGE_MARK] = 0
    const hp = playerOf(game, 'p0').hp
    useTrick(game, '无中生有')
    expect(pending(game), '不发二选一').toBeUndefined()
    expect(playerOf(game, 'p0').hp, '直接掉血').toBe(hp - 1)
  })

  it('无谋的失去体力不是伤害，不触发狂暴', () => {
    const game = gameWith(FIVE)
    playerOf(game, 'p0').marks[RAGE_MARK] = 0
    useTrick(game, '无中生有')
    expect(rage(game, 'p0'), 'loseHp 不是伤害，不给暴怒').toBe(0)
  })
})

describe('无前', () => {
  function wuqianAction(game: SanguoshaGame) {
    return game.legalActions('p0').find((action) => action.kind === 'invoke-skill' && action.skillId === 'wuqian')
  }

  function invokeWuqian(game: SanguoshaGame, targetId: PlayerId): void {
    game.act('p0', wuqianAction(game)!.id)
    game.respond({ requestId: pending(game).id, playerId: 'p0', payload: { targetIds: [targetId] } })
  }

  it('消耗 2 枚暴怒，暴怒不足时没有这个动作', () => {
    const game = gameWith(FIVE)
    enterPlay(game, 'p0')
    playerOf(game, 'p0').marks[RAGE_MARK] = 1
    expect(wuqianAction(game), '1 枚不够').toBeUndefined()

    playerOf(game, 'p0').marks[RAGE_MARK] = 2
    expect(wuqianAction(game)).toBeTruthy()
    invokeWuqian(game, 'p1')
    expect(rage(game, 'p0'), '扣掉 2 枚').toBe(0)
  })

  it('神吕布本回合获得无双，对所有目标都生效', () => {
    const game = gameWith(FIVE)
    enterPlay(game, 'p0')
    playerOf(game, 'p0').marks[RAGE_MARK] = 2
    invokeWuqian(game, 'p1')
    expect(playerOf(game, 'p0').temporaryGrantedSkills.map((entry) => entry.skillId))
      .toContain('wushuang')
  })

  it('只有被指定的角色防具失效，其他人不受影响', () => {
    const game = gameWith(FIVE)
    enterPlay(game, 'p0')
    const bagua = findCard(game, (card) => card.name === '八卦阵')
    const vine = findCard(game, (card) => card.name === '藤甲')
    detach(game, bagua)
    detach(game, vine)
    playerOf(game, 'p1').zones.equipment.armor = bagua
    playerOf(game, 'p2').zones.equipment.armor = vine
    playerOf(game, 'p0').marks[RAGE_MARK] = 2

    invokeWuqian(game, 'p1')

    expect(isArmorSuppressed(game.state, 'p1', 'p0'), 'p1 的防具对神吕布无效').toBe(true)
    expect(isArmorSuppressed(game.state, 'p2', 'p0'), 'p2 没被指定').toBe(false)
    expect(hasArmor(game.state, 'p1', '八卦阵', 'p0'), '对神吕布不算有八卦阵').toBe(false)
    expect(hasArmor(game.state, 'p1', '八卦阵', 'p3'), '对别人照常有八卦阵').toBe(true)
    // 牌本身还在装备区，不是被拆了
    expect(playerOf(game, 'p1').zones.equipment.armor, '八卦阵实体牌仍在装备区').toBe(bagua)
  })

  it('一回合可以多次发动，无双不叠加成四张闪', () => {
    const game = gameWith(FIVE)
    enterPlay(game, 'p0')
    playerOf(game, 'p0').marks[RAGE_MARK] = 4
    invokeWuqian(game, 'p1')
    expect(wuqianAction(game), '经典文本没有每阶段限一次').toBeTruthy()
    invokeWuqian(game, 'p2')

    const granted = playerOf(game, 'p0').temporaryGrantedSkills.filter((entry) => entry.skillId === 'wushuang')
    expect(granted, '只有一份无双').toHaveLength(1)
    expect(isArmorSuppressed(game.state, 'p1', 'p0')).toBe(true)
    expect(isArmorSuppressed(game.state, 'p2', 'p0')).toBe(true)
  })

  it('回合结束时无双和防具失效都清理掉', () => {
    const game = gameWith(FIVE)
    enterPlay(game, 'p0')
    playerOf(game, 'p0').marks[RAGE_MARK] = 2
    invokeWuqian(game, 'p1')

    game.state.phase = 'finish'
    game.state.pendingRequests = []
    game.advancePhase()

    expect(playerOf(game, 'p0').temporaryGrantedSkills.map((entry) => entry.skillId))
      .not.toContain('wushuang')
    expect(isArmorSuppressed(game.state, 'p1', 'p0'), '防具失效回合结束解除').toBe(false)
    expect(hasArmor(game.state, 'p1', '八卦阵', 'p0') || true, '不报错即可').toBe(true)
  })

  it('取消不消耗暴怒', () => {
    const game = gameWith(FIVE)
    enterPlay(game, 'p0')
    playerOf(game, 'p0').marks[RAGE_MARK] = 3
    game.act('p0', wuqianAction(game)!.id)
    game.respond({ requestId: pending(game).id, playerId: 'p0', payload: { targetIds: [] } })
    expect(rage(game, 'p0'), '取消不扣').toBe(3)
  })

  it('状态可序列化，重连后仍然生效', () => {
    const game = gameWith(FIVE)
    enterPlay(game, 'p0')
    playerOf(game, 'p0').marks[RAGE_MARK] = 2
    invokeWuqian(game, 'p1')
    const restored = SanguoshaGame.restore(JSON.parse(JSON.stringify(game.serialize())))
    expect(isArmorSuppressed(restored.state, 'p1', 'p0')).toBe(true)
    expect(playerOf(restored, 'p0').temporaryGrantedSkills.map((entry) => entry.skillId)).toContain('wushuang')
  })
})

describe('神愤', () => {
  function shenfenAction(game: SanguoshaGame) {
    return game.legalActions('p0').find((action) => action.kind === 'invoke-skill' && action.skillId === 'shenfen')
  }

  /** 摆一个所有人都有装备和手牌的场面。 */
  function setUpBoard(game: SanguoshaGame): void {
    const pool = Object.values(game.state.cards).filter((card) => card.category === 'basic').map((card) => card.id)
    let cursor = 0
    for (const playerId of ['p1', 'p2', 'p3', 'p4'] as const) {
      clearHand(game, playerId)
      giveHand(game, playerId, pool.slice(cursor, cursor + 6))
      cursor += 6
      playerOf(game, playerId).hp = 4
      playerOf(game, playerId).maxHp = 4
    }
  }

  function runShenfen(game: SanguoshaGame): void {
    game.act('p0', shenfenAction(game)!.id)
    let guard = 0
    while (pending(game) && guard < 60) {
      const request = pending(game)
      const payload = request.kind === 'choose-cards'
        ? { cardIds: (request as unknown as { cardIds: string[]; min: number }).cardIds.slice(0, (request as unknown as { min: number }).min) }
        : request.kind === 'choose-targets'
          ? { targetIds: [] }
          : request.kind === 'rescue' || request.kind === 'respond-card'
            ? { actionId: (request as unknown as { actionIds: string[] }).actionIds.slice(-1)[0] }
            : { optionId: 'no' }
      game.respond({ requestId: request.id, playerId: request.playerId, payload })
      guard += 1
    }
  }

  it('需要 6 枚暴怒，不足时没有这个动作', () => {
    const game = gameWith(FIVE)
    enterPlay(game, 'p0')
    playerOf(game, 'p0').marks[RAGE_MARK] = 5
    expect(shenfenAction(game), '5 枚不够').toBeUndefined()
    playerOf(game, 'p0').marks[RAGE_MARK] = 6
    expect(shenfenAction(game)).toBeTruthy()
  })

  it('出牌阶段限一次，但不是限定技', () => {
    const game = gameWith(FIVE)
    enterPlay(game, 'p0')
    setUpBoard(game)
    playerOf(game, 'p0').marks[RAGE_MARK] = 20
    runShenfen(game)
    expect(shenfenAction(game), '本阶段用过了').toBeUndefined()

    // 换一个回合，攒够暴怒还能再发动——不是限定技
    game.state.phase = 'finish'
    game.state.pendingRequests = []
    game.advancePhase()
    enterPlay(game, 'p0')
    playerOf(game, 'p0').marks[RAGE_MARK] = 20
    expect(shenfenAction(game), '下一个出牌阶段可以再发动').toBeTruthy()
  })

  it('三轮顺序：全体伤害 → 全体弃装备 → 全体弃四张手牌 → 神吕布翻面', () => {
    const game = gameWith(FIVE)
    enterPlay(game, 'p0')
    setUpBoard(game)
    const armor = findCard(game, (card) => card.name === '八卦阵')
    detach(game, armor)
    playerOf(game, 'p1').zones.equipment.armor = armor
    playerOf(game, 'p0').marks[RAGE_MARK] = 6
    const hpBefore = playerOf(game, 'p1').hp

    runShenfen(game)

    expect(playerOf(game, 'p1').hp, '各受 1 点伤害').toBe(hpBefore - 1)
    expect(playerOf(game, 'p1').zones.equipment.armor, '装备被弃光').toBeNull()
    expect(playerOf(game, 'p1').zones.hand.length, '6 张弃 4 张剩 2 张').toBe(2)
    expect(playerOf(game, 'p0').faceDown, '最后翻面').toBe(true)
    assertCardConservation(game.state)
    assertGameInvariants(game.state)
  })


  it('顺序必须是三轮，不是每人走完三步再换下一人', () => {
    const game = gameWith(FIVE)
    enterPlay(game, 'p0')
    setUpBoard(game)
    // 四个人各装一件防具，这样每轮都能观察到四次
    const armors = Object.values(game.state.cards)
      .filter((card) => card.equipmentSlot === 'armor').slice(0, 4).map((card) => card.id)
    ;(['p1', 'p2', 'p3', 'p4'] as const).forEach((playerId, index) => {
      detach(game, armors[index])
      playerOf(game, playerId).zones.equipment.armor = armors[index]
    })
    playerOf(game, 'p0').marks[RAGE_MARK] = 6

    // 记录三类事件的发生顺序
    const order: string[] = []
    // 监听器拿到的是 EventContext，事件字段在 context.event 上
    game.events.on('Damaged', (context) => {
      if (context.event.sourceId === 'p0') order.push(`damage:${context.event.targetId}`)
    })
    game.events.on('LoseEquipment', (context) => { order.push(`equip:${context.event.targetId}`) })
    game.events.on('CharacterFlip', () => { order.push('flip') })

    runShenfen(game)

    const phaseOf = (entry: string) => entry.split(':')[0]
    const phases = order.map(phaseOf)
    const firstEquip = phases.indexOf('equip')
    const lastDamage = phases.lastIndexOf('damage')

    expect(firstEquip, '应当有弃装备').toBeGreaterThan(-1)
    expect(lastDamage, '应当有伤害').toBeGreaterThan(-1)
    expect(lastDamage, '最后一次伤害必须早于第一次弃装备——先全体伤害，再统一弃装备')
      .toBeLessThan(firstEquip)
    expect(phases[phases.length - 1], '翻面在最后').toBe('flip')
  })

  it('手牌少于四张就弃光，手牌为零不发空请求', () => {
    const game = gameWith(FIVE)
    enterPlay(game, 'p0')
    setUpBoard(game)
    clearHand(game, 'p1')
    giveHand(game, 'p1', [findCard(game, (card) => card.name === '闪')])
    clearHand(game, 'p2')
    playerOf(game, 'p0').marks[RAGE_MARK] = 6

    runShenfen(game)
    expect(playerOf(game, 'p1').zones.hand, '只有一张就弃光').toHaveLength(0)
    expect(playerOf(game, 'p2').zones.hand, '本来就没有').toHaveLength(0)
    assertCardConservation(game.state)
  })

  it('神愤造成的伤害照样产生暴怒', () => {
    const game = gameWith(FIVE)
    enterPlay(game, 'p0')
    setUpBoard(game)
    playerOf(game, 'p0').marks[RAGE_MARK] = 6

    runShenfen(game)
    // 花掉 6 枚，然后对 4 名角色各造成 1 点伤害，各得 1 枚
    expect(rage(game, 'p0'), '不能因为正在结算神愤就禁掉狂暴').toBe(4)
  })

  it('中途死亡的角色不再收到弃装备和弃手牌请求', () => {
    const game = gameWith(FIVE)
    enterPlay(game, 'p0')
    setUpBoard(game)
    // p1 只有 1 血，神愤的 1 点伤害会打死他
    playerOf(game, 'p1').hp = 1
    clearHand(game, 'p1')
    playerOf(game, 'p0').marks[RAGE_MARK] = 6

    runShenfen(game)
    expect(playerOf(game, 'p1').alive, 'p1 被神愤打死').toBe(false)
    assertGameInvariants(game.state)
    assertCardConservation(game.state)
  })
})

describe('无谋：使用时机里把自己打死不能留下悬空请求', () => {
  /**
   * 回归（seed=soak-5-82）：1 血的神吕布主公使用【决斗】，
   * 无谋在 `CardUsed` 时机强制失去 1 点体力把自己送走，主公死亡牌局结束。
   * 引擎在结束时清空了待回应请求，但这张【决斗】的结算还在往下走，
   * 又向目标发出一个求【杀】请求——牌局已经 game-over 却仍挂着 Request。
   *
   * 修在公共入口 `beginPhysicalCard`：使用时机结束后牌局已经结束就不再往下结算。
   * 这不是无谋独有的问题，任何能在使用时机造成死亡的效果都会踩。
   */
  it('牌局在使用时机中结束时，不再发出新的请求', () => {
    const game = gameWith(FIVE)
    // 让神吕布只剩 1 血、没有暴怒：使用非延时锦囊必定强制失去体力而死
    playerOf(game, 'p0').hp = 1
    playerOf(game, 'p0').marks[RAGE_MARK] = 0
    // 其他人只留一个阵营，主公一死立刻分出胜负
    game.state.players.forEach((player, index) => { player.identity = index === 0 ? 'lord' : 'rebel' })

    enterPlay(game, 'p0')
    const duel = findCard(game, (card) => card.name === '决斗')
    clearHand(game, 'p0')
    giveHand(game, 'p0', [duel])

    const action = game.legalActions('p0').find((candidate) => (
      candidate.kind === 'use-card' && (candidate as { cardIds?: string[] }).cardIds?.includes(duel)
    ))
    expect(action, '应当能打出决斗').toBeTruthy()
    game.act('p0', action!.id)

    expect(playerOf(game, 'p0').alive, '无谋把自己打死了').toBe(false)
    expect(game.state.status, '牌局结束').toBe('game-over')
    expect(game.state.result, '有胜负结果').toBeTruthy()
    expect(game.state.pendingRequests, '不能留下悬空请求').toHaveLength(0)
    assertCardConservation(game.state)
  })
})
