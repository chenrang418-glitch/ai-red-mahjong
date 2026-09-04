import { describe, expect, it } from 'vitest'
import { SanguoshaGame } from '@/sanguosha/engine/game'
import { assertGameInvariants } from '@/sanguosha/engine/invariants'
import { assertCardConservation, moveCard } from '@/sanguosha/engine/zones'
import { DAWU_STATE, KUANGFENG_STATE, applyTargetState, hasTargetState } from '@/sanguosha/engine/target-state'
import { loseHp } from '@/sanguosha/engine/hp'
import type { GameSetup, Identity, PlayerId } from '@/sanguosha/engine/types'

/**
 * 神诸葛亮。经典「神话再临·神」版本。
 *
 * 三条重点：
 *
 * 1. **「星」是扣置的**：只有神诸葛亮自己看得到牌面，别人只看得到张数。
 *    经典七星**没有「手牌上限 +7」**，星也不计入手牌。
 * 2. **换星是原子操作**，而且不产生「失去牌 / 获得牌」的时机——
 *    否则屯田、枭姬、行殇、固政会被错误触发。
 * 3. **狂风只加火伤、大雾只防非雷伤**，两者都持续到神诸葛亮下回合开始前，
 *    而且**不是一次性**：期间每次伤害都生效。
 */

function gameWith(characterIds: string[], seed = 'shenzhugeliang'): SanguoshaGame {
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
  return game
}

function drainRequests(game: SanguoshaGame, limit = 20): void {
  let guard = 0
  while (game.state.pendingRequests.length > 0 && guard < limit) {
    const request = game.state.pendingRequests[0]
    const payload = request.kind === 'choose-cards'
      ? { cardIds: [] }
      : request.kind === 'choose-targets'
        ? { targetIds: [] }
        : request.kind === 'rescue' || request.kind === 'respond-card'
          ? { actionId: request.actionIds[request.actionIds.length - 1] }
          : { optionId: 'no' }
    game.respond({ requestId: request.id, playerId: request.playerId, payload })
    guard += 1
  }
}

function pending(game: SanguoshaGame) {
  return game.state.pendingRequests[0]
}

function playerOf(game: SanguoshaGame, playerId: PlayerId) {
  return game.state.players.find((player) => player.id === playerId)!
}

function starsOf(game: SanguoshaGame, playerId: PlayerId): string[] {
  return playerOf(game, playerId).characterPiles.qixing ?? []
}

/** 进入结束阶段（狂风 / 大雾挂在这里）。 */
function enterFinish(game: SanguoshaGame, playerId: PlayerId): void {
  game.state.currentPlayerId = playerId
  game.state.normalTurnPlayerId = playerId
  game.state.currentTurnKind = 'normal'
  game.state.phase = 'discard'
  game.state.skippedPhases = []
  game.state.judgedDelayedCards = []
  game.advancePhase()
}

const FIVE = ['shenzhugeliang', 'zhangfei', 'zhangfei', 'zhangfei', 'zhangfei']

describe('七星：开局的「星」', () => {
  it('开局把牌堆顶七张扣置为「星」，是真实移动', () => {
    const game = gameWith(FIVE)
    expect(starsOf(game, 'p0'), '开局七张星').toHaveLength(7)
    for (const cardId of starsOf(game, 'p0')) {
      expect(game.state.zones.drawPile, '星不该还留在牌堆里').not.toContain(cardId)
    }
    assertCardConservation(game.state)
  })

  it('「星」不计入手牌，也不影响手牌上限', () => {
    const game = gameWith(FIVE)
    drainRequests(game)
    const owner = playerOf(game, 'p0')
    expect(owner.zones.hand, '星不在手牌里').not.toContain(starsOf(game, 'p0')[0])
    // 经典七星没有手牌上限加成：上限仍然等于当前体力
    const view = game.viewFor('p0')
    expect(view.players.find((player) => player.id === 'p0')!.handCount).toBe(owner.zones.hand.length)
  })

  it('隐私：只有神诸葛亮自己看得到星的牌面，别人只看得到张数', () => {
    const game = gameWith(FIVE)
    const own = game.viewFor('p0').players.find((player) => player.id === 'p0')!
    expect(own.characterPiles.qixing, '自己看得到七张牌面').toHaveLength(7)
    expect(own.characterPileCounts.qixing).toBe(7)

    const outsider = game.viewFor('p2').players.find((player) => player.id === 'p0')!
    expect(outsider.characterPiles.qixing, '别人拿不到牌面').toEqual([])
    expect(outsider.characterPileCounts.qixing, '但看得到张数').toBe(7)
  })

  it('隐私在序列化恢复之后仍然成立', () => {
    const game = gameWith(FIVE)
    const restored = SanguoshaGame.restore(JSON.parse(JSON.stringify(game.serialize())))
    expect(restored.viewFor('p0').players.find((player) => player.id === 'p0')!.characterPiles.qixing).toHaveLength(7)
    expect(restored.viewFor('p2').players.find((player) => player.id === 'p0')!.characterPiles.qixing).toEqual([])
    expect(restored.viewFor('p2').players.find((player) => player.id === 'p0')!.characterPileCounts.qixing).toBe(7)
  })
})

describe('七星：换星', () => {
  /** 跑到开局那次换星询问。 */
  function reachSwap(game: SanguoshaGame) {
    let guard = 0
    while (guard < 20) {
      const request = pending(game)
      if (!request) break
      if (request.playerId === 'p0' && String(request.prompt).includes('七星')) return request
      const payload = request.kind === 'choose-cards'
        ? { cardIds: [] }
        : request.kind === 'choose-targets' ? { targetIds: [] } : { optionId: 'no' }
      game.respond({ requestId: request.id, playerId: request.playerId, payload })
      guard += 1
    }
    return null
  }

  it('开局提供一次换星，选 0 张就什么都不换', () => {
    const game = gameWith(FIVE)
    const request = reachSwap(game)
    expect(request, '开局应当提供换星机会').toBeTruthy()
    expect(request!.min, '可以一张都不换').toBe(0)
    const starsBefore = [...starsOf(game, 'p0')]
    game.respond({ requestId: request!.id, playerId: 'p0', payload: { cardIds: [] } })
    expect(starsOf(game, 'p0')).toEqual(starsBefore)
  })

  it('换两张：手牌与星等量互换，且不触发「失去 / 获得牌」时机', () => {
    const game = gameWith(FIVE)
    const request = reachSwap(game)!
    const owner = playerOf(game, 'p0')
    const handBefore = [...owner.zones.hand]
    const starsBefore = [...starsOf(game, 'p0')]
    const handPicked = handBefore.slice(0, 2)

    // 只要有 LoseCard / GainCard 就说明走了错误的事件路径
    const leaked: string[] = []
    game.events.on('LoseCard', () => { leaked.push('LoseCard') })
    game.events.on('GainCard', () => { leaked.push('GainCard') })

    game.respond({ requestId: request.id, playerId: 'p0', payload: { cardIds: handPicked } })
    const starRequest = pending(game)
    expect(starRequest.kind).toBe('choose-cards')
    expect(starRequest.min, '必须选等量的星').toBe(2)
    const starPicked = starsBefore.slice(0, 2)
    game.respond({ requestId: starRequest.id, playerId: 'p0', payload: { cardIds: starPicked } })

    for (const cardId of handPicked) {
      expect(starsOf(game, 'p0'), '换出去的手牌进了星堆').toContain(cardId)
      expect(owner.zones.hand).not.toContain(cardId)
    }
    for (const cardId of starPicked) {
      expect(owner.zones.hand, '换进来的星进了手牌').toContain(cardId)
      expect(starsOf(game, 'p0')).not.toContain(cardId)
    }
    expect(owner.zones.hand.length, '手牌数不变').toBe(handBefore.length)
    expect(starsOf(game, 'p0').length, '星的数量不变').toBe(starsBefore.length)
    expect(leaked, '七星内部交换不是弃置/获得，不能触发那些时机').toEqual([])
    assertCardConservation(game.state)
  })

  it('摸牌阶段结束时再给一次换星机会', () => {
    const game = gameWith(FIVE)
    drainRequests(game)
    game.state.currentPlayerId = 'p0'
    game.state.normalTurnPlayerId = 'p0'
    game.state.currentTurnKind = 'normal'
    game.state.phase = 'judge'
    game.state.skippedPhases = []
    game.state.judgedDelayedCards = []
    game.advancePhase()  // 进入摸牌阶段并摸牌
    game.advancePhase()  // 离开摸牌阶段 → PhaseEnd('draw')

    const request = pending(game)
    expect(request, '摸完牌之后应当再问一次').toBeTruthy()
    expect(String(request.prompt)).toContain('七星')
  })
})

describe('狂风：火焰伤害 +1', () => {
  it('结束阶段移去一张星并指定一名角色', () => {
    const game = gameWith(FIVE)
    drainRequests(game)
    const before = starsOf(game, 'p0').length
    enterFinish(game, 'p0')

    const starRequest = pending(game)
    expect(String(starRequest.prompt)).toContain('狂风')
    game.respond({ requestId: starRequest.id, playerId: 'p0', payload: { cardIds: [starsOf(game, 'p0')[0]] } })
    const targetRequest = pending(game)
    expect(targetRequest.kind).toBe('choose-targets')
    game.respond({ requestId: targetRequest.id, playerId: 'p0', payload: { targetIds: ['p1'] } })

    expect(starsOf(game, 'p0').length, '移去了一张星').toBe(before - 1)
    expect(hasTargetState(game.state, 'p1', KUANGFENG_STATE)).toBe(true)
    assertCardConservation(game.state)
  })

  it('火焰伤害 +1；普通和雷电伤害不受影响', () => {
    const game = gameWith(FIVE)
    drainRequests(game)
    applyTargetState(game.state, 'p1', KUANGFENG_STATE, 'p0', 'kuangfeng')
    playerOf(game, 'p1').hp = 8
    playerOf(game, 'p1').maxHp = 8

    game.damage({ sourceId: 'p2', targetId: 'p1', amount: 1, nature: 'fire', cardName: null })
    expect(playerOf(game, 'p1').hp, '火伤 1 点变 2 点').toBe(6)

    game.damage({ sourceId: 'p2', targetId: 'p1', amount: 1, nature: 'normal', cardName: null })
    expect(playerOf(game, 'p1').hp, '普通伤害不加').toBe(5)

    game.damage({ sourceId: 'p2', targetId: 'p1', amount: 1, nature: 'thunder', cardName: null })
    expect(playerOf(game, 'p1').hp, '雷电伤害不加').toBe(4)
  })

  it('不是一次性：期间每次火焰伤害都 +1', () => {
    const game = gameWith(FIVE)
    drainRequests(game)
    applyTargetState(game.state, 'p1', KUANGFENG_STATE, 'p0', 'kuangfeng')
    playerOf(game, 'p1').hp = 9
    playerOf(game, 'p1').maxHp = 9

    game.damage({ sourceId: 'p2', targetId: 'p1', amount: 1, nature: 'fire', cardName: null })
    game.damage({ sourceId: 'p2', targetId: 'p1', amount: 1, nature: 'fire', cardName: null })
    expect(playerOf(game, 'p1').hp, '两次火伤各 +1，共掉 4 点').toBe(5)
  })
})

describe('大雾：防止非雷电伤害', () => {
  it('结束阶段移去 X 张星并选择 X 名角色', () => {
    const game = gameWith(FIVE)
    drainRequests(game)
    enterFinish(game, 'p0')
    // 先把狂风那一问放掉
    game.respond({ requestId: pending(game).id, playerId: 'p0', payload: { cardIds: [] } })

    const starRequest = pending(game)
    expect(String(starRequest.prompt)).toContain('大雾')
    const stars = starsOf(game, 'p0').slice(0, 2)
    game.respond({ requestId: starRequest.id, playerId: 'p0', payload: { cardIds: stars } })
    const targetRequest = pending(game)
    expect(targetRequest.min, '选等量的角色').toBe(2)
    game.respond({ requestId: targetRequest.id, playerId: 'p0', payload: { targetIds: ['p1', 'p2'] } })

    expect(hasTargetState(game.state, 'p1', DAWU_STATE)).toBe(true)
    expect(hasTargetState(game.state, 'p2', DAWU_STATE)).toBe(true)
    assertCardConservation(game.state)
  })

  it('防止普通和火焰伤害，雷电照常打进来', () => {
    const game = gameWith(FIVE)
    drainRequests(game)
    applyTargetState(game.state, 'p1', DAWU_STATE, 'p0', 'dawu')
    playerOf(game, 'p1').hp = 6
    playerOf(game, 'p1').maxHp = 6

    game.damage({ sourceId: 'p2', targetId: 'p1', amount: 2, nature: 'normal', cardName: null })
    expect(playerOf(game, 'p1').hp, '普通伤害被防住').toBe(6)

    game.damage({ sourceId: 'p2', targetId: 'p1', amount: 2, nature: 'fire', cardName: null })
    expect(playerOf(game, 'p1').hp, '火焰伤害也被防住').toBe(6)

    game.damage({ sourceId: 'p2', targetId: 'p1', amount: 2, nature: 'thunder', cardName: null })
    expect(playerOf(game, 'p1').hp, '雷电伤害照常').toBe(4)
  })

  it('失去体力不是伤害，大雾管不着', () => {
    const game = gameWith(FIVE)
    drainRequests(game)
    applyTargetState(game.state, 'p1', DAWU_STATE, 'p0', 'dawu')
    const before = playerOf(game, 'p1').hp
    loseHp(game, 'p1', 1, '测试')
    expect(playerOf(game, 'p1').hp, '失去体力不受大雾影响').toBe(before - 1)
  })

  it('大雾优先于狂风：同时挂着时火焰伤害被防住而不是被加成', () => {
    const game = gameWith(FIVE)
    drainRequests(game)
    applyTargetState(game.state, 'p1', KUANGFENG_STATE, 'p0', 'kuangfeng')
    applyTargetState(game.state, 'p1', DAWU_STATE, 'p0', 'dawu')
    const before = playerOf(game, 'p1').hp
    game.damage({ sourceId: 'p2', targetId: 'p1', amount: 1, nature: 'fire', cardName: null })
    expect(playerOf(game, 'p1').hp, '被防住就没有「这次伤害」可加').toBe(before)
  })
})

describe('状态的失效与清理', () => {
  it('持续到施加者的下一个回合开始前', () => {
    const game = gameWith(FIVE)
    drainRequests(game)
    applyTargetState(game.state, 'p1', DAWU_STATE, 'p0', 'dawu')

    // 别人的回合开始不清除
    game.state.currentPlayerId = 'p0'
    game.state.normalTurnPlayerId = 'p0'
    game.state.currentTurnKind = 'normal'
    game.state.phase = 'finish'
    game.state.pendingRequests = []
    game.advancePhase()
    expect(hasTargetState(game.state, 'p1', DAWU_STATE), '换到别人回合时还在').toBe(true)

    // 一直走到施加者（p0）的下一个回合开始
    let guard = 0
    while (game.state.currentPlayerId !== 'p0' && guard < 10) {
      game.state.phase = 'finish'
      game.state.pendingRequests = []
      game.advancePhase()
      guard += 1
    }
    expect(hasTargetState(game.state, 'p1', DAWU_STATE), '施加者下回合开始时清除').toBe(false)
  })

  it('施加者死亡时，他施加的状态一并收掉', () => {
    const game = gameWith(FIVE)
    drainRequests(game)
    applyTargetState(game.state, 'p1', DAWU_STATE, 'p0', 'dawu')
    playerOf(game, 'p0').hp = 1
    game.damage({ sourceId: null, targetId: 'p0', amount: 5, cardName: null })
    // 把可能的求桃跑掉
    drainRequests(game)
    expect(playerOf(game, 'p0').alive).toBe(false)
    expect(
      hasTargetState(game.state, 'p1', DAWU_STATE),
      '施加者死了就再也不会有「他的下一个回合」，留着等于永久生效',
    ).toBe(false)
    assertGameInvariants(game.state)
  })
})
