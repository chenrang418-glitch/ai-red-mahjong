import { describe, expect, it } from 'vitest'
import { SanguoshaGame } from '@/sanguosha/engine/game'
import { assertGameInvariants } from '@/sanguosha/engine/invariants'
import { assertCardConservation, moveCard } from '@/sanguosha/engine/zones'
import { queueExtraTurn } from '@/sanguosha/engine/turn'
import { ownedSkillIds } from '@/sanguosha/engine/skills/runtime'
import { skillIdsOf } from '@/sanguosha/data/characters/standard'
import type { GameSetup, Identity, PlayerId, Suit, TurnPhase } from '@/sanguosha/engine/types'

/**
 * 山包·刘禅。本项目自研表述。3 体力。
 *
 * **绝对不是界刘禅**——放权没有「手牌上限等于体力上限」之类的强化。
 *
 * 这一组最要紧的是额外回合的两条不变量：
 * 1. **额外回合不推进正常座次**，被插队的人的正常回合不能被吃掉；
 * 2. **额外回合是完整回合**，六个阶段、翻面规则、觉醒、限一次重置全都照常。
 */

function gameWith(characterIds: string[], seed = 'liushan'): SanguoshaGame {
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

function findCard(game: SanguoshaGame, match: (card: { id: string; name: string; suit: Suit; category: string }) => boolean): string {
  const card = Object.values(game.state.cards).find((candidate) => match(candidate))
  if (!card) throw new Error('这副牌里找不到符合条件的牌')
  return card.id
}

function detach(game: SanguoshaGame, cardId: string): void {
  game.state.zones.drawPile = game.state.zones.drawPile.filter((id) => id !== cardId)
  game.state.zones.discardPile = game.state.zones.discardPile.filter((id) => id !== cardId)
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

const ORDER: readonly TurnPhase[] = ['prepare', 'judge', 'draw', 'play', 'discard', 'finish']

function advanceTo(game: SanguoshaGame, playerId: PlayerId, phase: TurnPhase): void {
  game.state.currentPlayerId = playerId
  game.state.normalTurnPlayerId = playerId
  game.state.currentTurnKind = 'normal'
  game.state.phase = ORDER[ORDER.indexOf(phase) - 1]
  game.state.skippedPhases = []
  game.state.judgedDelayedCards = []
  game.advancePhase()
}

const FIVE = ['liushan', 'zhangfei', 'zhangfei', 'zhangfei', 'zhangfei']

describe('享乐：攻击者要付一张基本牌', () => {
  /**
   * 让 p1 对刘禅使用一张【杀】，停在享乐的付费询问上。
   *
   * `spare` 是**打出【杀】之后**手上还剩的牌——享乐要的代价从这里出。
   * 只给一张杀的话，杀一打出去手上就空了，走的是「没有基本牌可付」那条分支。
   */
  function slashLiushan(game: SanguoshaGame, spare: string[] = []): void {
    game.state.currentPlayerId = 'p1'
    game.state.phase = 'play'
    const slash = findCard(game, (card) => card.name === '杀')
    clearHand(game, 'p1')
    giveHand(game, 'p1', [slash, ...spare])
    const action = game.legalActions('p1').find((candidate) => (
      candidate.kind === 'use-card' && candidate.asCardName === '杀' && candidate.targetIds.includes('p0')
    ))
    if (!action) throw new Error('p1 打不到刘禅')
    game.act('p1', action.id)
  }

  it('请求发给攻击者，不是刘禅', () => {
    const game = gameWith(FIVE)
    slashLiushan(game, [findCard(game, (card) => card.name === '桃')])
    const ask = pending(game)
    expect(ask?.kind).toBe('choose-cards')
    expect(ask.playerId, '付代价的是攻击者').toBe('p1')
    expect(String(ask.prompt)).toContain('享乐')
  })

  it('候选只有基本牌：锦囊和装备不能付', () => {
    const game = gameWith(FIVE)
    const peach = findCard(game, (card) => card.name === '桃')
    const trick = findCard(game, (card) => card.name === '无中生有')
    const weapon = findCard(game, (card) => card.name === '诸葛连弩')
    const slash = findCard(game, (card) => card.name === '杀')
    clearHand(game, 'p1')
    giveHand(game, 'p1', [slash, peach, trick, weapon])

    game.state.currentPlayerId = 'p1'
    game.state.phase = 'play'
    const action = game.legalActions('p1').find((candidate) => (
      candidate.kind === 'use-card' && candidate.asCardName === '杀' && candidate.targetIds.includes('p0')
    ))!
    game.act('p1', action.id)

    const ask = pending(game)
    expect(ask.cardIds).toContain(peach)
    expect(ask.cardIds, '锦囊不是基本牌').not.toContain(trick)
    expect(ask.cardIds, '装备不是基本牌').not.toContain(weapon)
  })

  it('付了基本牌：这张杀照常结算，刘禅要求闪', () => {
    const game = gameWith(FIVE)
    slashLiushan(game, [findCard(game, (card) => card.name === '桃')])
    const ask = pending(game)
    expect(ask.playerId).toBe('p1')
    game.respond({ requestId: ask.id, playerId: 'p1', payload: { cardIds: [ask.cardIds[0]] } })

    const dodge = pending(game)
    expect(dodge?.kind, '付了代价这张杀就照常往下走').toBe('respond-card')
    expect(dodge.playerId).toBe('p0')
    expect(dodge.requiredCardName).toBe('闪')
  })

  it('不付：这张杀对刘禅无效，连闪都不用出，也不掉血', () => {
    const game = gameWith(FIVE)
    clearHand(game, 'p0')
    const hpBefore = playerOf(game, 'p0').hp
    slashLiushan(game, [findCard(game, (card) => card.name === '桃')])

    const ask = pending(game)
    game.respond({ requestId: ask.id, playerId: 'p1', payload: { cardIds: [] } })

    expect(pending(game), '不付代价就直接结束，不该再问刘禅要闪').toBeUndefined()
    expect(playerOf(game, 'p0').hp, '这张杀对刘禅无效').toBe(hpBefore)
    assertCardConservation(game.state)
    assertGameInvariants(game.state)
  })

  it('攻击者一张基本牌都没有：不弹只能拒绝的窗口，直接无效', () => {
    const game = gameWith(FIVE)
    const slash = findCard(game, (card) => card.name === '杀')
    const trick = findCard(game, (card) => card.name === '无中生有')
    clearHand(game, 'p1')
    giveHand(game, 'p1', [slash, trick])
    clearHand(game, 'p0')
    const hpBefore = playerOf(game, 'p0').hp

    game.state.currentPlayerId = 'p1'
    game.state.phase = 'play'
    const action = game.legalActions('p1').find((candidate) => (
      candidate.kind === 'use-card' && candidate.asCardName === '杀' && candidate.targetIds.includes('p0')
    ))!
    game.act('p1', action.id)

    // 杀本身是唯一的基本牌，但它已经被打出去了，手上只剩锦囊
    expect(pending(game), '没有基本牌可付就直接判无效').toBeUndefined()
    expect(playerOf(game, 'p0').hp).toBe(hpBefore)
  })

  it('非【杀】不触发享乐', () => {
    const game = gameWith(FIVE)
    const duel = findCard(game, (card) => card.name === '决斗')
    clearHand(game, 'p1')
    giveHand(game, 'p1', [duel])
    game.state.currentPlayerId = 'p1'
    game.state.phase = 'play'
    const action = game.legalActions('p1').find((candidate) => (
      candidate.kind === 'use-card' && candidate.asCardName === '决斗' && candidate.targetIds.includes('p0')
    ))
    if (action) {
      game.act('p1', action.id)
      const request = pending(game)
      if (request) expect(String(request.prompt), '决斗不该触发享乐').not.toContain('享乐')
    }
  })
})

describe('放权：跳过出牌阶段', () => {
  it('出牌阶段开始前询问，放弃则正常出牌', () => {
    const game = gameWith(FIVE)
    advanceTo(game, 'p0', 'play')
    const ask = pending(game)
    expect(ask?.kind).toBe('choose-option')
    expect(String(ask.prompt)).toContain('放权')
    game.respond({ requestId: ask.id, playerId: 'p0', payload: { optionId: 'no' } })
    expect(game.state.skippedPhases).not.toContain('play')
    expect(game.state.phase).toBe('play')
  })

  it('发动后是真正的 Phase Skip，走公共 skippedPhases', () => {
    const game = gameWith(FIVE)
    advanceTo(game, 'p0', 'play')
    game.respond({ requestId: pending(game).id, playerId: 'p0', payload: { optionId: 'yes' } })
    expect(game.state.skippedPhases, '必须是真跳过，不是进了出牌阶段自动 pass').toContain('play')
    expect(game.state.phase, '直接进了弃牌阶段').not.toBe('play')
  })

  it('仍然经过弃牌阶段和结束阶段', () => {
    const game = gameWith(FIVE)
    const seen: string[] = []
    game.events.on('PhaseStart', (context) => {
      const payload = context.event.payload as { phase?: string; playerId?: string }
      if (payload.playerId === 'p0' && payload.phase) seen.push(payload.phase)
    })
    advanceTo(game, 'p0', 'play')
    game.respond({ requestId: pending(game).id, playerId: 'p0', payload: { optionId: 'yes' } })
    expect(seen, '跳过的是出牌阶段，弃牌阶段照常').toContain('discard')
    expect(seen).not.toContain('play')
  })
})

describe('放权：结束阶段兑现额外回合', () => {
  /** 发动放权并推进到结束阶段。 */
  function fangquanToFinish(game: SanguoshaGame): void {
    advanceTo(game, 'p0', 'play')
    game.respond({ requestId: pending(game).id, playerId: 'p0', payload: { optionId: 'yes' } })
    // 跳过出牌之后停在弃牌阶段；把弃牌请求（如果有）跑掉再进结束阶段
    let guard = 0
    while (game.state.phase !== 'finish' && guard < 8) {
      const request = pending(game)
      if (request) {
        const payload = request.kind === 'choose-cards'
          ? { cardIds: [...request.cardIds, ...request.hiddenCardSlots].slice(0, request.min) }
          : { optionId: 'no' }
        game.respond({ requestId: request.id, playerId: request.playerId, payload })
      } else {
        game.advancePhase()
      }
      guard += 1
    }
  }

  it('结束阶段问弃一张手牌，支付只能是手牌', () => {
    const game = gameWith(FIVE)
    clearHand(game, 'p0')
    const weapon = findCard(game, (card) => card.name === '诸葛连弩')
    detach(game, weapon)
    playerOf(game, 'p0').zones.equipment.weapon = weapon
    giveHand(game, 'p0', [findCard(game, (card) => card.name === '桃')])

    fangquanToFinish(game)
    const ask = pending(game)
    expect(ask?.kind).toBe('choose-cards')
    expect(String(ask.prompt)).toContain('放权')
    expect(ask.cardIds, '装备不能用来支付放权').not.toContain(weapon)
  })

  it('没有手牌时不弹空窗口，放权到此为止', () => {
    const game = gameWith(FIVE)
    clearHand(game, 'p0')
    fangquanToFinish(game)
    expect(pending(game), '没手牌就兑现不了，不该弹一个填不了的请求').toBeUndefined()
    expect(game.state.extraTurns.length).toBe(0)
  })

  it('弃牌并指定目标后，额外回合进入队列', () => {
    const game = gameWith(FIVE)
    clearHand(game, 'p0')
    giveHand(game, 'p0', [findCard(game, (card) => card.name === '桃')])
    fangquanToFinish(game)

    const pay = pending(game)
    game.respond({ requestId: pay.id, playerId: 'p0', payload: { cardIds: [pay.cardIds[0]] } })
    const target = pending(game)
    expect(target?.kind).toBe('choose-targets')
    expect(target.candidateIds, '只能给其他角色').not.toContain('p0')
    game.respond({ requestId: target.id, playerId: 'p0', payload: { targetIds: ['p2'] } })

    expect(game.state.extraTurns.map((entry) => entry.playerId)).toEqual(['p2'])
    assertCardConservation(game.state)
  })
})

describe('额外回合的调度不变量', () => {
  it('额外回合不推进正常座次：被插队的人不会被吃掉一个回合', () => {
    const game = gameWith(FIVE)
    // 刘禅（p0）的回合结束，正常应当轮到 p1；先给 p3 排一个额外回合
    game.state.currentPlayerId = 'p0'
    game.state.normalTurnPlayerId = 'p0'
    game.state.currentTurnKind = 'normal'
    game.state.phase = 'finish'
    queueExtraTurn(game.state, 'p3', { skillId: 'fangquan', playerId: 'p0' })

    game.advancePhase()
    expect(game.state.currentPlayerId, '先跑额外回合').toBe('p3')
    expect(game.state.currentTurnKind).toBe('extra')
    expect(game.state.normalTurnPlayerId, '额外回合不许动正常座次').toBe('p0')

    // 额外回合跑完，正常座次应当回到 p1，而不是从 p3 往后数
    game.state.phase = 'finish'
    game.state.pendingRequests = []
    game.advancePhase()
    expect(game.state.currentPlayerId, 'p1 的正常回合不能被吃掉').toBe('p1')
    expect(game.state.currentTurnKind).toBe('normal')
  })

  it('排队时活着、轮到时已死的额外回合被丢弃，座次照常', () => {
    const game = gameWith(FIVE)
    game.state.currentPlayerId = 'p0'
    game.state.normalTurnPlayerId = 'p0'
    game.state.currentTurnKind = 'normal'
    game.state.phase = 'finish'
    queueExtraTurn(game.state, 'p3')
    playerOf(game, 'p3').alive = false

    game.advancePhase()
    expect(game.state.currentPlayerId, '死人的额外回合直接跳过').toBe('p1')
    expect(game.state.currentTurnKind).toBe('normal')
  })

  it('队列能排多个，不会只留下最后一个', () => {
    const game = gameWith(FIVE)
    queueExtraTurn(game.state, 'p2')
    queueExtraTurn(game.state, 'p3')
    expect(game.state.extraTurns.map((entry) => entry.playerId)).toEqual(['p2', 'p3'])
  })

  it('额外回合是完整回合：六个阶段照常，回合限一次被重置', () => {
    const game = gameWith(FIVE)
    playerOf(game, 'p2').turnUsedSkills = ['tiaoxin']
    game.state.currentPlayerId = 'p0'
    game.state.normalTurnPlayerId = 'p0'
    game.state.currentTurnKind = 'normal'
    game.state.phase = 'finish'
    queueExtraTurn(game.state, 'p2')

    game.advancePhase()
    expect(game.state.currentPlayerId).toBe('p2')
    expect(game.state.phase, '额外回合从准备阶段开始').toBe('prepare')
    expect(playerOf(game, 'p2').turnUsedSkills, '新回合要重置「回合限一次」').toEqual([])
  })

  it('背面朝上的角色拿到额外回合：翻回正面并跳过整个回合', () => {
    const game = gameWith(FIVE)
    playerOf(game, 'p2').faceDown = true
    game.state.currentPlayerId = 'p0'
    game.state.normalTurnPlayerId = 'p0'
    game.state.currentTurnKind = 'normal'
    game.state.phase = 'finish'
    queueExtraTurn(game.state, 'p2')

    game.advancePhase()
    expect(playerOf(game, 'p2').faceDown, '额外回合同样消耗翻面').toBe(false)
    expect(game.state.skippedPhases.length, '整个回合被跳过').toBeGreaterThan(0)
  })

  it('额外回合队列可以序列化恢复', () => {
    const game = gameWith(FIVE)
    queueExtraTurn(game.state, 'p2', { skillId: 'fangquan', playerId: 'p0' })
    const restored = SanguoshaGame.restore(JSON.parse(JSON.stringify(game.serialize())))
    expect(restored.state.extraTurns.map((entry) => entry.playerId)).toEqual(['p2'])
    expect(restored.state.normalTurnPlayerId).toBeTruthy()
  })
})

describe('若愚：主公觉醒技', () => {
  function enterPrepare(game: SanguoshaGame, playerId: PlayerId): void {
    game.state.currentPlayerId = playerId
    game.state.phase = 'prepare'
    game.emit('PhaseStart', { playerId, phase: 'prepare' })
    game.settle()
  }

  it('不是主公就永不觉醒，哪怕血最少', () => {
    const game = gameWith(FIVE)
    playerOf(game, 'p0').identity = 'rebel'
    playerOf(game, 'p0').hp = 1
    enterPrepare(game, 'p0')
    expect(playerOf(game, 'p0').awakenedSkills, '若愚是主公技').not.toContain('ruoyu')
  })

  it('是主公但血不是最少：不觉醒', () => {
    const game = gameWith(FIVE)
    const owner = playerOf(game, 'p0')
    owner.hp = 3
    for (const id of ['p1', 'p2', 'p3', 'p4']) playerOf(game, id).hp = 1
    enterPrepare(game, 'p0')
    expect(owner.awakenedSkills).not.toContain('ruoyu')
  })

  it('唯一最低：觉醒，+1 上限、回复 1 点、获得激将', () => {
    const game = gameWith(FIVE)
    const owner = playerOf(game, 'p0')
    owner.hp = 1
    const maxBefore = owner.maxHp
    for (const id of ['p1', 'p2', 'p3', 'p4']) playerOf(game, id).hp = 4

    enterPrepare(game, 'p0')
    expect(owner.awakenedSkills).toContain('ruoyu')
    expect(owner.maxHp).toBe(maxBefore + 1)
    expect(owner.hp, '加上限不会自动回满，所以还要单独回 1 点').toBe(2)
    expect(ownedSkillIds(game.state, 'p0', skillIdsOf)).toContain('jijiang')
    assertGameInvariants(game.state)
  })

  it('并列最低也算「全场最少」，不要求唯一最低', () => {
    const game = gameWith(FIVE)
    const owner = playerOf(game, 'p0')
    owner.hp = 2
    playerOf(game, 'p1').hp = 2
    for (const id of ['p2', 'p3', 'p4']) playerOf(game, id).hp = 4

    enterPrepare(game, 'p0')
    expect(owner.awakenedSkills, '并列最少也要觉醒').toContain('ruoyu')
  })

  it('死亡角色不参与最低血量比较', () => {
    const game = gameWith(FIVE)
    const owner = playerOf(game, 'p0')
    owner.hp = 2
    const dead = playerOf(game, 'p1')
    dead.hp = 1
    dead.alive = false
    for (const id of ['p2', 'p3', 'p4']) playerOf(game, id).hp = 4

    enterPrepare(game, 'p0')
    expect(owner.awakenedSkills, '死人的 1 血不该挡住觉醒').toContain('ruoyu')
  })

  it('只觉醒一次', () => {
    const game = gameWith(FIVE)
    const owner = playerOf(game, 'p0')
    owner.hp = 1
    for (const id of ['p1', 'p2', 'p3', 'p4']) playerOf(game, id).hp = 4
    enterPrepare(game, 'p0')
    const maxAfter = owner.maxHp

    owner.hp = 1
    enterPrepare(game, 'p0')
    expect(owner.maxHp, '觉醒一局只有一次').toBe(maxAfter)
  })

  it('获得的激将是刘备那一个主公技，序列化后仍在', () => {
    const game = gameWith(FIVE)
    const owner = playerOf(game, 'p0')
    owner.hp = 1
    for (const id of ['p1', 'p2', 'p3', 'p4']) playerOf(game, id).hp = 4
    enterPrepare(game, 'p0')

    const restored = SanguoshaGame.restore(JSON.parse(JSON.stringify(game.serialize())))
    expect(restored.state.players.find((player) => player.id === 'p0')!.grantedSkills).toContain('jijiang')
    expect(ownedSkillIds(restored.state, 'p0', skillIdsOf)).toContain('jijiang')
  })
})
