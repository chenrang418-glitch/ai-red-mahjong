import { describe, expect, it } from 'vitest'
import { SanguoshaGame } from '@/sanguosha/engine/game'
import { assertGameInvariants } from '@/sanguosha/engine/invariants'
import { assertCardConservation, moveCard } from '@/sanguosha/engine/zones'
import { killedInTurn } from '@/sanguosha/engine/turn-kills'
import { getSkillRuntime } from '@/sanguosha/engine/skills/runtime'
import { REN_MARK } from '@/sanguosha/data/characters/god-shensimayi'
import type { CardId, GameSetup, Identity, PlayerId } from '@/sanguosha/engine/types'

/**
 * 神司马懿。经典「神话再临·神」。
 *
 * 最要紧的四条：
 *
 * 1. 忍戒**按点数**：受到 3 点伤害得 3 枚忍；弃牌阶段弃 3 张手牌得 3 枚。
 * 2. 拜印是觉醒技，只觉醒一次，减 1 点体力上限并获得【极略】。
 * 3. 极略**不是永久获得五个技能**，每次移去 1 枚忍借用一次；取消不扣忍。
 * 4. 连破按**回合实例**记账：同一回合杀多人只有一次机会，
 *    在别人的回合里杀人同样算，额外回合不推乱正常座次。
 */

function gameWith(characterIds: string[], seed = 'shensimayi'): SanguoshaGame {
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

function ren(game: SanguoshaGame, playerId: PlayerId): number {
  return playerOf(game, playerId).marks[REN_MARK] ?? 0
}

function settle(game: SanguoshaGame): void {
  ;(game as unknown as { settle(): void }).settle()
}

function damageAndSettle(game: SanguoshaGame, options: { sourceId: PlayerId | null; targetId: PlayerId; amount: number }): void {
  game.damage({ ...options, cardName: null })
  settle(game)
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

/** 跑一个完整的弃牌阶段，弃掉 count 张手牌。 */
function runDiscardPhase(game: SanguoshaGame, playerId: PlayerId, count: number): void {
  game.state.currentPlayerId = playerId
  game.state.normalTurnPlayerId = playerId
  game.state.currentTurnKind = 'normal'
  game.state.phase = 'play'
  game.state.skippedPhases = []
  game.state.judgedDelayedCards = []
  playerOf(game, playerId).hp = Math.max(1, playerOf(game, playerId).zones.hand.length - count)
  game.advancePhase()  // → 弃牌阶段
  const request = pending(game)
  if (request?.kind === 'choose-cards') {
    const cards = (request as unknown as { cardIds: string[]; min: number })
    game.respond({ requestId: request.id, playerId, payload: { cardIds: cards.cardIds.slice(0, cards.min) } })
  }
  if (game.state.phase === 'discard') game.advancePhase()
}

const FIVE = ['shensimayi', 'zhangfei', 'zhangfei', 'zhangfei', 'zhangfei']

describe('忍戒', () => {
  it('受到 1 点伤害得 1 枚忍，受到 3 点得 3 枚', () => {
    const game = gameWith(FIVE)
    playerOf(game, 'p0').hp = 9
    playerOf(game, 'p0').maxHp = 9
    expect(ren(game, 'p0'), '开局没有忍').toBe(0)

    damageAndSettle(game, { sourceId: 'p1', targetId: 'p0', amount: 1 })
    expect(ren(game, 'p0')).toBe(1)

    damageAndSettle(game, { sourceId: 'p1', targetId: 'p0', amount: 3 })
    expect(ren(game, 'p0'), '按点数，不是每次事件 +1').toBe(4)
  })

  it('弃牌阶段弃置手牌后按张数得忍', () => {
    const game = gameWith(FIVE)
    clearHand(game, 'p0')
    const pool = Object.values(game.state.cards).filter((card) => card.category === 'basic').slice(0, 5).map((card) => card.id)
    giveHand(game, 'p0', pool)
    playerOf(game, 'p0').maxHp = 5

    runDiscardPhase(game, 'p0', 3)
    expect(ren(game, 'p0'), '弃了几张就得几枚').toBeGreaterThan(0)
    expect(ren(game, 'p0')).toBe(3)
  })

  it('弃置装备不算，只算从手牌区弃置的', () => {
    const game = gameWith(FIVE)
    clearHand(game, 'p0')
    const armor = Object.values(game.state.cards).find((card) => card.equipmentSlot === 'armor')!.id
    detach(game, armor)
    playerOf(game, 'p0').zones.equipment.armor = armor
    playerOf(game, 'p0').maxHp = 5
    playerOf(game, 'p0').hp = 5

    // 手牌为空，弃牌阶段不会弃任何手牌
    runDiscardPhase(game, 'p0', 0)
    expect(ren(game, 'p0'), '装备还在，也没弃手牌').toBe(0)
  })

  it('忍进序列化，重连不丢', () => {
    const game = gameWith(FIVE)
    playerOf(game, 'p0').marks[REN_MARK] = 5
    const restored = SanguoshaGame.restore(JSON.parse(JSON.stringify(game.serialize())))
    expect(ren(restored, 'p0')).toBe(5)
  })
})

describe('拜印', () => {
  function runPreparePhase(game: SanguoshaGame, playerId: PlayerId): void {
    game.state.currentPlayerId = playerId
    game.state.normalTurnPlayerId = playerId
    game.state.currentTurnKind = 'normal'
    game.state.phase = 'finish'
    game.state.pendingRequests = []
    game.state.skippedPhases = []
    game.state.judgedDelayedCards = []
    game.advancePhase()  // 结束阶段 → 下一名角色的准备阶段
    // 走到 p0 的准备阶段
    let guard = 0
    while (game.state.currentPlayerId !== playerId && guard < 10) {
      game.state.phase = 'finish'
      game.state.pendingRequests = []
      game.advancePhase()
      guard += 1
    }
  }

  it('3 枚忍不觉醒，4 枚才觉醒', () => {
    const game = gameWith(FIVE)
    playerOf(game, 'p0').marks[REN_MARK] = 3
    runPreparePhase(game, 'p0')
    expect(playerOf(game, 'p0').grantedSkills ?? [], '3 枚不够').not.toContain('jilue')

    playerOf(game, 'p0').marks[REN_MARK] = 4
    runPreparePhase(game, 'p0')
    expect(playerOf(game, 'p0').grantedSkills ?? [], '4 枚觉醒').toContain('jilue')
  })

  it('觉醒时减 1 点体力上限', () => {
    const game = gameWith(FIVE)
    const before = playerOf(game, 'p0').maxHp
    playerOf(game, 'p0').marks[REN_MARK] = 4
    runPreparePhase(game, 'p0')
    expect(playerOf(game, 'p0').maxHp, '减 1 点上限').toBe(before - 1)
  })

  it('只觉醒一次', () => {
    const game = gameWith(FIVE)
    playerOf(game, 'p0').marks[REN_MARK] = 8
    runPreparePhase(game, 'p0')
    const afterFirst = playerOf(game, 'p0').maxHp
    runPreparePhase(game, 'p0')
    expect(playerOf(game, 'p0').maxHp, '第二次准备阶段不再减上限').toBe(afterFirst)
    expect((playerOf(game, 'p0').grantedSkills ?? []).filter((id) => id === 'jilue'), '只授予一份')
      .toHaveLength(1)
  })

  it('觉醒状态可序列化', () => {
    const game = gameWith(FIVE)
    playerOf(game, 'p0').marks[REN_MARK] = 4
    runPreparePhase(game, 'p0')
    const restored = SanguoshaGame.restore(JSON.parse(JSON.stringify(game.serialize())))
    expect(playerOf(restored, 'p0').grantedSkills ?? []).toContain('jilue')
  })
})

describe('极略', () => {
  /** 直接把神司马懿摆成已觉醒。 */
  function awaken(game: SanguoshaGame, renCount: number): void {
    const owner = playerOf(game, 'p0')
    owner.grantedSkills = [...(owner.grantedSkills ?? []), 'jilue']
    owner.marks[REN_MARK] = renCount
  }

  it('不是永久获得那五个技能，只授予了一个【极略】', () => {
    const game = gameWith(FIVE)
    awaken(game, 4)
    const granted = playerOf(game, 'p0').grantedSkills ?? []
    expect(granted, '只有极略').toEqual(['jilue'])
    for (const borrowed of ['guicai', 'fangzhu', 'jizhi', 'zhiheng', 'wansha']) {
      expect(granted, `不该永久拥有 ${borrowed}`).not.toContain(borrowed)
    }
  })

  it('没有忍时不能发动', () => {
    const game = gameWith(FIVE)
    awaken(game, 0)
    game.state.currentPlayerId = 'p0'
    game.state.normalTurnPlayerId = 'p0'
    game.state.currentTurnKind = 'normal'
    game.state.phase = 'play'
    game.state.skippedPhases = []
    const actions = game.legalActions('p0').filter((action) => action.kind === 'invoke-skill'
      && String((action as { skillId?: string }).skillId).startsWith('jilue'))
    expect(actions, '0 枚忍时没有极略动作').toHaveLength(0)
  })

  it('极略·制衡：有忍时出牌阶段出现，发动后扣 1 枚', () => {
    const game = gameWith(FIVE)
    awaken(game, 3)
    const pool = Object.values(game.state.cards).filter((card) => card.category === 'basic').slice(0, 3).map((card) => card.id)
    clearHand(game, 'p0')
    giveHand(game, 'p0', pool)
    game.state.currentPlayerId = 'p0'
    game.state.normalTurnPlayerId = 'p0'
    game.state.currentTurnKind = 'normal'
    game.state.phase = 'play'
    game.state.skippedPhases = []

    const action = game.legalActions('p0').find((candidate) => candidate.kind === 'invoke-skill'
      && (candidate as { skillId?: string }).skillId === 'jilue')
    expect(action, '应当有极略·制衡').toBeTruthy()
    game.act('p0', action!.id)

    // 制衡自己会问弃哪些牌
    const request = pending(game)
    expect(request?.kind).toBe('choose-cards')
    game.respond({ requestId: request.id, playerId: 'p0', payload: { cardIds: [pool[0]] } })
    expect(ren(game, 'p0'), '发动之后扣 1 枚忍').toBe(2)
    assertCardConservation(game.state)
  })

  it('极略·放逐：受到伤害后由放逐自己发问，忍戒先结算', () => {
    const game = gameWith(FIVE)
    awaken(game, 0)
    playerOf(game, 'p0').hp = 4
    playerOf(game, 'p0').maxHp = 6  // 已损失体力 > 0，放逐才有意义

    damageAndSettle(game, { sourceId: 'p1', targetId: 'p0', amount: 1 })
    // 忍戒先给了 1 枚忍，所以 0 枚忍受伤之后可以立刻发动放逐
    expect(ren(game, 'p0'), '忍戒先结算').toBeGreaterThanOrEqual(1)
    const request = pending(game)
    expect(String(request?.prompt), '放逐自己的问句').toContain('放逐')
  })

  it('极略·放逐：放弃不扣忍', () => {
    const game = gameWith(FIVE)
    awaken(game, 2)
    playerOf(game, 'p0').hp = 4
    playerOf(game, 'p0').maxHp = 6

    damageAndSettle(game, { sourceId: 'p1', targetId: 'p0', amount: 1 })
    const before = ren(game, 'p0')
    const request = pending(game)
    if (request && String(request.prompt).includes('放逐')) {
      game.respond({ requestId: request.id, playerId: 'p0', payload: { optionId: 'no' } })
    }
    expect(ren(game, 'p0'), '放弃不扣忍').toBe(before)
  })

  it('极略·完杀：出牌阶段开始时花 1 枚，本回合持续', () => {
    const game = gameWith(FIVE)
    awaken(game, 2)
    game.state.currentPlayerId = 'p0'
    game.state.normalTurnPlayerId = 'p0'
    game.state.currentTurnKind = 'normal'
    game.state.phase = 'draw'
    game.state.skippedPhases = []
    game.state.judgedDelayedCards = []
    game.advancePhase()  // → 出牌阶段

    const request = pending(game)
    expect(String(request?.prompt), '出牌阶段开始时问').toContain('完杀')
    game.respond({ requestId: request.id, playerId: 'p0', payload: { optionId: 'yes' } })
    expect(ren(game, 'p0'), '扣 1 枚').toBe(1)
    expect(playerOf(game, 'p0').temporaryGrantedSkills.map((entry) => entry.skillId), '本回合持有完杀')
      .toContain('wansha')
  })

  it('极略·完杀：回合结束时清理', () => {
    const game = gameWith(FIVE)
    awaken(game, 2)
    game.state.currentPlayerId = 'p0'
    game.state.normalTurnPlayerId = 'p0'
    game.state.currentTurnKind = 'normal'
    game.state.phase = 'draw'
    game.state.skippedPhases = []
    game.state.judgedDelayedCards = []
    game.advancePhase()
    game.respond({ requestId: pending(game).id, playerId: 'p0', payload: { optionId: 'yes' } })

    game.state.phase = 'finish'
    game.state.pendingRequests = []
    game.advancePhase()
    expect(playerOf(game, 'p0').temporaryGrantedSkills.map((entry) => entry.skillId))
      .not.toContain('wansha')
  })

  it('极略·鬼才：有忍时才出现在改判候选里', () => {
    const game = gameWith(FIVE)
    awaken(game, 0)
    clearHand(game, 'p0')
    giveHand(game, 'p0', [Object.values(game.state.cards)[0].id])
    // 0 枚忍时不提供改判
    expect(getSkillRuntime('jilue')!.retrial!(game.state, 'p0', 'p1'), '0 枚忍没有候选').toHaveLength(0)

    playerOf(game, 'p0').marks[REN_MARK] = 1
    expect(getSkillRuntime('jilue')!.retrial!(game.state, 'p0', 'p1').length, '有忍才有候选')
      .toBeGreaterThan(0)
  })
})

describe('连破', () => {
  function endTurnOf(game: SanguoshaGame, playerId: PlayerId): void {
    game.state.currentPlayerId = playerId
    game.state.normalTurnPlayerId = playerId === 'p0' ? playerId : game.state.normalTurnPlayerId
    game.state.phase = 'finish'
    game.state.pendingRequests = []
    game.state.skippedPhases = []
    game.state.judgedDelayedCards = []
    game.advancePhase()
  }

  it('自己回合内杀人，回合结束后可以连破', () => {
    const game = gameWith(FIVE)
    game.state.currentPlayerId = 'p0'
    game.state.normalTurnPlayerId = 'p0'
    game.state.currentTurnKind = 'normal'
    game.state.phase = 'play'
    playerOf(game, 'p1').hp = 1
    clearHand(game, 'p1')

    damageAndSettle(game, { sourceId: 'p0', targetId: 'p1', amount: 3 })
    while (pending(game)) {
      const request = pending(game)
      game.respond({
        requestId: request.id, playerId: request.playerId,
        payload: request.kind === 'rescue' || request.kind === 'respond-card'
          ? { actionId: (request as unknown as { actionIds: string[] }).actionIds.slice(-1)[0] }
          : { optionId: 'no', cardIds: [], targetIds: [] },
      })
    }
    expect(playerOf(game, 'p1').alive).toBe(false)
    expect(killedInTurn(game.state, 'p0', game.state.turnNumber), '账本记下了这次击杀').toBe(true)

    endTurnOf(game, 'p0')
    const request = pending(game)
    expect(String(request?.prompt), '回合结束后问连破').toContain('连破')
  })

  it('同一回合杀多人只产生一次机会', () => {
    const game = gameWith(FIVE)
    game.state.currentPlayerId = 'p0'
    game.state.normalTurnPlayerId = 'p0'
    game.state.currentTurnKind = 'normal'
    game.state.phase = 'play'
    for (const playerId of ['p1', 'p2'] as const) {
      playerOf(game, playerId).hp = 1
      clearHand(game, playerId)
      damageAndSettle(game, { sourceId: 'p0', targetId: playerId, amount: 3 })
      while (pending(game)) {
        const request = pending(game)
        game.respond({
          requestId: request.id, playerId: request.playerId,
          payload: request.kind === 'rescue' || request.kind === 'respond-card'
            ? { actionId: (request as unknown as { actionIds: string[] }).actionIds.slice(-1)[0] }
            : { optionId: 'no', cardIds: [], targetIds: [] },
        })
      }
    }

    endTurnOf(game, 'p0')
    let prompts = 0
    while (pending(game) && String(pending(game).prompt).includes('连破')) {
      game.respond({ requestId: pending(game).id, playerId: 'p0', payload: { optionId: 'no' } })
      prompts += 1
    }
    expect(prompts, '杀两个人也只问一次').toBe(1)
  })

  it('没杀人不触发', () => {
    const game = gameWith(FIVE)
    game.state.currentPlayerId = 'p0'
    game.state.normalTurnPlayerId = 'p0'
    game.state.currentTurnKind = 'normal'
    endTurnOf(game, 'p0')
    const request = pending(game)
    expect(request && String(request.prompt).includes('连破'), '没杀人不该问').toBeFalsy()
  })

  it('发动后排的是额外回合，不推乱正常座次', () => {
    const game = gameWith(FIVE)
    game.state.currentPlayerId = 'p0'
    game.state.normalTurnPlayerId = 'p0'
    game.state.currentTurnKind = 'normal'
    game.state.phase = 'play'
    playerOf(game, 'p1').hp = 1
    clearHand(game, 'p1')
    damageAndSettle(game, { sourceId: 'p0', targetId: 'p1', amount: 3 })
    while (pending(game)) {
      const request = pending(game)
      game.respond({
        requestId: request.id, playerId: request.playerId,
        payload: request.kind === 'rescue' || request.kind === 'respond-card'
          ? { actionId: (request as unknown as { actionIds: string[] }).actionIds.slice(-1)[0] }
          : { optionId: 'no', cardIds: [], targetIds: [] },
      })
    }

    const normalBefore = game.state.normalTurnPlayerId
    endTurnOf(game, 'p0')
    const request = pending(game)
    expect(String(request?.prompt)).toContain('连破')
    game.respond({ requestId: request.id, playerId: 'p0', payload: { optionId: 'yes' } })

    /*
     * 额外回合可能已经被 settle 立刻取走并开始了，所以两种情况都算数：
     * 还排在队列里，或者已经变成当前的额外回合。
     * 要紧的是**正常座次游标没被推乱**。
     */
    const queued = (game.state.extraTurns?.length ?? 0) > 0
    const running = game.state.currentTurnKind === 'extra' && game.state.currentPlayerId === 'p0'
    expect(queued || running, '额外回合已排队或已开始').toBe(true)
    expect(game.state.normalTurnPlayerId, '正常座次游标没被推乱').toBe(normalBefore)
    assertGameInvariants(game.state)
  })

  it('回合内击杀账本按回合实例记，跨回合不残留', () => {
    const game = gameWith(FIVE)
    game.state.turnNumber = 10
    game.state.currentPlayerId = 'p1'
    game.state.status = 'playing'
    // 在 p1 的回合里 p0 杀了 p2
    playerOf(game, 'p2').hp = 1
    clearHand(game, 'p2')
    damageAndSettle(game, { sourceId: 'p0', targetId: 'p2', amount: 3 })
    while (pending(game)) {
      const request = pending(game)
      game.respond({
        requestId: request.id, playerId: request.playerId,
        payload: request.kind === 'rescue' || request.kind === 'respond-card'
          ? { actionId: (request as unknown as { actionIds: string[] }).actionIds.slice(-1)[0] }
          : { optionId: 'no', cardIds: [], targetIds: [] },
      })
    }
    expect(killedInTurn(game.state, 'p0', 10), '在别人回合里杀的也算').toBe(true)
    expect(killedInTurn(game.state, 'p0', 11), '别的回合不算').toBe(false)
  })
})
