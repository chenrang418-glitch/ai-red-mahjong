import { describe, expect, it } from 'vitest'
import { SanguoshaGame } from '@/sanguosha/engine/game'
import { assertCardConservation, moveCard } from '@/sanguosha/engine/zones'
import {
  DAWU_STATE, KUANGFENG_STATE,
  applyTargetState, applyTargetStateDamage, clearTargetState, clearTargetStatesOf,
  expireTargetStates, hasTargetState, targetStatesOf,
} from '@/sanguosha/engine/target-state'
import type { GameSetup, Identity, PlayerId } from '@/sanguosha/engine/types'

/**
 * 神将第一批用到的**公共机制**，脱离具体武将单独钉住。
 *
 * 这些机制是为神将做的，但它们不属于任何一名神将：标记、临时状态、
 * 弃牌阶段账本、扣置专属牌堆的隐藏。之后的神将（以及普通武将）都会复用。
 * 所以在武将测试之外，还要有一层不认武将 id 的测试——
 * 否则以后重构机制时，只会看到某个武将的测试红了，看不出是机制本身破了。
 */

function newGame(seed = 'god-mechanisms'): SanguoshaGame {
  const setup: GameSetup = {
    mode: 'identity', generalChoices: 1,
    players: Array.from({ length: 5 }, (_, index) => ({ id: `p${index}`, nickname: `玩家${index}`, isHuman: false })),
  }
  const game = new SanguoshaGame({ seed, setup })
  const identities: Identity[] = ['lord', 'rebel', 'loyalist', 'rebel', 'renegade']
  game.state.players.forEach((player, index) => {
    player.identity = identities[index]
    player.characterId = 'zhangfei'
  })
  game.start()
  return game
}

function playerOf(game: SanguoshaGame, playerId: PlayerId) {
  return game.state.players.find((player) => player.id === playerId)!
}

describe('公共机制：标记（marks）', () => {
  it('标记是计数，落在权威 state 上，会下发也能重连', () => {
    const game = newGame()
    playerOf(game, 'p1').marks.nightmare = 2
    const view = game.viewFor('p0').players.find((player) => player.id === 'p1')!
    expect(view.marks.nightmare, '标记对所有人公开').toBe(2)

    const restored = SanguoshaGame.restore(JSON.parse(JSON.stringify(game.serialize())))
    expect(playerOf(restored, 'p1').marks.nightmare, '重连之后还在').toBe(2)
  })
})

describe('公共机制：临时角色状态', () => {
  it('同名同源不叠加，只刷新时间', () => {
    const game = newGame()
    applyTargetState(game.state, 'p1', DAWU_STATE, 'p0', 'dawu')
    applyTargetState(game.state, 'p1', DAWU_STATE, 'p0', 'dawu')
    expect(targetStatesOf(game.state, 'p1').filter((entry) => entry.name === DAWU_STATE)).toHaveLength(1)
  })

  it('不同来源可以各挂一份', () => {
    const game = newGame()
    applyTargetState(game.state, 'p1', DAWU_STATE, 'p0', 'dawu')
    applyTargetState(game.state, 'p1', DAWU_STATE, 'p2', 'dawu')
    expect(targetStatesOf(game.state, 'p1')).toHaveLength(2)
    expect(hasTargetState(game.state, 'p1', DAWU_STATE)).toBe(true)
  })

  it('只在施加者的下一个回合开始时到期，施加它的那个回合不算', () => {
    const game = newGame()
    game.state.turnNumber = 7
    applyTargetState(game.state, 'p1', KUANGFENG_STATE, 'p0', 'kuangfeng')

    // 同一回合内（比如神诸葛亮自己结束阶段之后）不该被清掉
    expireTargetStates(game.state, 'p0')
    expect(hasTargetState(game.state, 'p1', KUANGFENG_STATE), '施加的那个回合不到期').toBe(true)

    // 别人的回合开始也不清
    game.state.turnNumber = 8
    expireTargetStates(game.state, 'p3')
    expect(hasTargetState(game.state, 'p1', KUANGFENG_STATE)).toBe(true)

    // 施加者的下一个回合开始才清
    game.state.turnNumber = 12
    expireTargetStates(game.state, 'p0')
    expect(hasTargetState(game.state, 'p1', KUANGFENG_STATE)).toBe(false)
  })

  it('死亡清理同时收掉「挂在他身上的」和「由他施加的」', () => {
    const game = newGame()
    applyTargetState(game.state, 'p1', DAWU_STATE, 'p0', 'dawu')   // p0 施加
    applyTargetState(game.state, 'p0', DAWU_STATE, 'p2', 'dawu')   // 挂在 p0 身上
    applyTargetState(game.state, 'p3', DAWU_STATE, 'p2', 'dawu')   // 与 p0 无关
    clearTargetStatesOf(game.state, 'p0')
    expect(hasTargetState(game.state, 'p1', DAWU_STATE), '他施加的没了').toBe(false)
    expect(hasTargetState(game.state, 'p0', DAWU_STATE), '挂他身上的也没了').toBe(false)
    expect(hasTargetState(game.state, 'p3', DAWU_STATE), '无关的保留').toBe(true)
  })

  it('伤害修正：防止优先于加成，且不消耗状态', () => {
    const game = newGame()
    applyTargetState(game.state, 'p1', KUANGFENG_STATE, 'p0', 'kuangfeng')

    expect(applyTargetStateDamage(game.state, 'p1', 1, 'fire')).toMatchObject({ amount: 2, amplifiedBy: KUANGFENG_STATE })
    expect(applyTargetStateDamage(game.state, 'p1', 1, 'fire').amount, '第二次照样 +1').toBe(2)
    expect(applyTargetStateDamage(game.state, 'p1', 1, 'normal').amount).toBe(1)
    expect(applyTargetStateDamage(game.state, 'p1', 1, 'thunder').amount).toBe(1)

    applyTargetState(game.state, 'p1', DAWU_STATE, 'p0', 'dawu')
    expect(applyTargetStateDamage(game.state, 'p1', 1, 'fire')).toMatchObject({ amount: 0, preventedBy: DAWU_STATE })
    expect(applyTargetStateDamage(game.state, 'p1', 2, 'normal').amount).toBe(0)
    expect(applyTargetStateDamage(game.state, 'p1', 2, 'thunder').amount, '雷电不防').toBe(2)
  })

  it('可以显式清除，也能序列化往返', () => {
    const game = newGame()
    applyTargetState(game.state, 'p1', DAWU_STATE, 'p0', 'dawu')
    const restored = SanguoshaGame.restore(JSON.parse(JSON.stringify(game.serialize())))
    expect(hasTargetState(restored.state, 'p1', DAWU_STATE), '重连之后状态还在').toBe(true)
    expect(clearTargetState(restored.state, 'p1', DAWU_STATE)).toBe(true)
    expect(clearTargetState(restored.state, 'p1', DAWU_STATE), '清过一次就没得清了').toBe(false)
  })

  it('旧存档没有 targetStates 字段时不炸', () => {
    const game = newGame()
    const stored = JSON.parse(JSON.stringify(game.serialize()))
    delete stored.targetStates
    const restored = SanguoshaGame.restore(stored)
    expect(hasTargetState(restored.state, 'p1', DAWU_STATE)).toBe(false)
    expect(() => applyTargetState(restored.state, 'p1', DAWU_STATE, 'p0')).not.toThrow()
    expect(hasTargetState(restored.state, 'p1', DAWU_STATE)).toBe(true)
  })
})

describe('公共机制：扣置的武将专属牌堆', () => {
  it('列入 hiddenCharacterPiles 的牌堆只对拥有者可见，其他人只拿到张数', () => {
    const game = newGame()
    const owner = playerOf(game, 'p0')
    const cards = game.state.zones.drawPile.slice(0, 3)
    owner.characterPiles.secret = []
    owner.hiddenCharacterPiles = ['secret']
    for (const cardId of cards) {
      moveCard(game.state, cardId, { kind: 'drawPile' }, { kind: 'characterPile', playerId: 'p0', pile: 'secret' })
    }

    const own = game.viewFor('p0').players.find((player) => player.id === 'p0')!
    expect(own.characterPiles.secret).toHaveLength(3)
    const outsider = game.viewFor('p1').players.find((player) => player.id === 'p0')!
    expect(outsider.characterPiles.secret, '别人看不到牌面').toEqual([])
    expect(outsider.characterPileCounts.secret, '但看得到张数').toBe(3)
    assertCardConservation(game.state)
  })

  it('没有列入 hiddenCharacterPiles 的牌堆照常公开（比如田丰的「义」）', () => {
    const game = newGame()
    const owner = playerOf(game, 'p0')
    const cards = game.state.zones.drawPile.slice(0, 2)
    owner.characterPiles.open = []
    for (const cardId of cards) {
      moveCard(game.state, cardId, { kind: 'drawPile' }, { kind: 'characterPile', playerId: 'p0', pile: 'open' })
    }
    const outsider = game.viewFor('p1').players.find((player) => player.id === 'p0')!
    expect(outsider.characterPiles.open, '公开牌堆别人看得到牌面').toHaveLength(2)
  })
})

describe('公共机制：弃牌阶段来源账本', () => {
  it('只记录弃牌阶段内、由该阶段角色从手牌区弃掉的牌', () => {
    const game = newGame()
    while (game.state.pendingRequests.length > 0) {
      const request = game.state.pendingRequests[0]
      game.respond({
        requestId: request.id,
        playerId: request.playerId,
        payload: request.kind === 'choose-cards'
          ? { cardIds: [] }
          : request.kind === 'choose-targets' ? { targetIds: [] } : { optionId: 'no' },
      })
    }
    const owner = playerOf(game, 'p0')
    owner.hp = 1  // 手牌上限 1，逼出弃牌
    while (owner.zones.hand.length < 4) {
      moveCard(game.state, game.state.zones.drawPile[0], { kind: 'drawPile' }, { kind: 'hand', playerId: 'p0' })
    }

    game.state.currentPlayerId = 'p0'
    game.state.normalTurnPlayerId = 'p0'
    game.state.currentTurnKind = 'normal'
    game.state.phase = 'play'
    game.state.skippedPhases = []
    game.state.judgedDelayedCards = []
    game.advancePhase()  // → 弃牌阶段

    const ledger = game.state.discardPhaseLedger
    expect(ledger, '进入弃牌阶段就开账本').toBeTruthy()
    expect(ledger!.ownerPlayerId).toBe('p0')
    expect(ledger!.records, '还没弃，账本是空的').toHaveLength(0)

    const request = game.state.pendingRequests[0]
    expect(request?.kind).toBe('choose-cards')
    const discarded = owner.zones.hand.slice(0, request.min)
    game.respond({ requestId: request.id, playerId: 'p0', payload: { cardIds: discarded } })

    const records = game.state.discardPhaseLedger!.records
    expect(records.map((record) => record.cardId).sort()).toEqual([...discarded].sort())
    for (const record of records) {
      expect(record.sourcePlayerId).toBe('p0')
      expect(record.originalZone).toBe('hand')
      expect(record.moveReason).toBe('discard')
    }
  })

  it('弃牌阶段结束后账本清空，不会跨回合累计', () => {
    const game = newGame()
    game.state.discardPhaseLedger = {
      phaseInstanceId: 'x',
      ownerPlayerId: 'p0',
      records: [{ cardId: 'c1', sourcePlayerId: 'p0', originalZone: 'hand', moveReason: 'discard', enteredDiscardAt: 0 }],
    }
    game.state.currentPlayerId = 'p0'
    game.state.normalTurnPlayerId = 'p0'
    game.state.currentTurnKind = 'normal'
    game.state.phase = 'discard'
    game.state.skippedPhases = []
    game.state.judgedDelayedCards = []
    game.advancePhase()
    expect(game.state.discardPhaseLedger, '离开弃牌阶段就清账本').toBeNull()
  })
})

describe('公共机制：开局技能的时序', () => {
  /**
   * 回归：`initializeGameSkills` 一度排在 `startPlaying` 之后，
   * 于是第一个准备阶段的观星先把牌堆顶五张记进快照，七星才把牌堆顶七张拿去当「星」，
   * 观星结算时按旧快照写回——同一张牌同时出现在牌堆和星堆。
   * 这一条钉住「开局技能在第一个回合开始前跑完」。
   */
  it('onGameStart 在第一个回合开始之前跑完，不与首个准备阶段抢公共牌堆', () => {
    const setup: GameSetup = {
      mode: 'identity', generalChoices: 1,
      players: Array.from({ length: 5 }, (_, index) => ({ id: `p${index}`, nickname: `玩家${index}`, isHuman: false })),
    }
    const game = new SanguoshaGame({ seed: 'init-order', setup })
    const identities: Identity[] = ['lord', 'rebel', 'loyalist', 'rebel', 'renegade']
    // p0 观星（准备阶段就要看牌堆顶），p1 七星（开局就要拿走牌堆顶七张）
    const characters = ['zhugeliang', 'shenzhugeliang', 'zhangfei', 'zhangfei', 'zhangfei']
    game.state.players.forEach((player, index) => {
      player.identity = identities[index]
      player.characterId = characters[index]
    })
    game.start()

    expect(playerOf(game, 'p1').characterPiles.qixing, '开局就该有七张星').toHaveLength(7)
    for (const cardId of playerOf(game, 'p1').characterPiles.qixing) {
      expect(game.state.zones.drawPile, '星不能还留在牌堆里').not.toContain(cardId)
    }
    // 把观星那一问答完，再验一次守恒——旧实现正是在这一步把牌写回牌堆的
    const request = game.state.pendingRequests.find((candidate) => candidate.kind === 'arrange-cards')
    if (request) {
      game.respond({
        requestId: request.id, playerId: request.playerId,
        payload: { top: [...(request as { cardIds: string[] }).cardIds], bottom: [] },
      })
    }
    assertCardConservation(game.state)
  })
})
