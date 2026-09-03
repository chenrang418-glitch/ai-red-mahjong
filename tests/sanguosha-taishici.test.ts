import { describe, expect, it } from 'vitest'
import { SanguoshaGame } from '@/sanguosha/engine/game'
import { assertGameInvariants } from '@/sanguosha/engine/invariants'
import { assertCardConservation, moveCard } from '@/sanguosha/engine/zones'
import { TIANYI, tianyiTargets } from '@/sanguosha/data/characters/fire-taishici'
import { slashRules } from '@/sanguosha/engine/slash-rules'
import { getCharacter } from '@/sanguosha/data/characters/standard'
import type { GameSetup, Identity, LegalAction, PlayerId } from '@/sanguosha/engine/types'

/**
 * 火包·太史慈（经典版本）。
 *
 * 三处最容易做错的地方单独钉住：
 * 1. 【天义】**不能有自己的拼点代码**——它只发起拼点、拿结果、设本回合效果；
 * 2. 「没赢」包含平局，平局同样进禁杀分支；
 * 3. 本回合效果必须在回合结束时自动消失，而且**转化出来的杀也受禁令约束**。
 */

function gameWith(seed = 'taishici', characters?: string[]): SanguoshaGame {
  const list = characters ?? ['taishici', 'zhangfei', 'zhangfei', 'zhangfei', 'zhangfei']
  const setup: GameSetup = {
    mode: 'identity', generalChoices: 1,
    players: Array.from({ length: list.length }, (_, index) => ({ id: `p${index}`, nickname: `玩家${index}`, isHuman: false })),
  }
  const game = new SanguoshaGame({ seed, setup })
  const identities: Identity[] = ['rebel', 'lord', 'loyalist', 'rebel', 'renegade']
  game.state.players.forEach((player, index) => {
    player.identity = identities[index % identities.length]
    player.characterId = list[index]
    const base = getCharacter(list[index])?.maxHp ?? 4
    player.maxHp = base + (player.identity === 'lord' ? 1 : 0)
    player.hp = player.maxHp
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

function answer(game: SanguoshaGame, payload: Record<string, unknown>): void {
  const request = pending(game)
  if (!request) throw new Error('没有待处理请求')
  game.respond({ requestId: request.id, playerId: request.playerId, payload })
}

function clearHand(game: SanguoshaGame, playerId: PlayerId): void {
  const owner = game.state.players.find((player) => player.id === playerId)!
  game.state.zones.discardPile.push(...owner.zones.hand)
  owner.zones.hand = []
}

function giveRank(game: SanguoshaGame, playerId: PlayerId, rank: number): string {
  const cardId = game.state.zones.drawPile.find((id) => game.state.cards[id].rank === rank)
  if (!cardId) throw new Error(`牌堆里没有点数 ${rank} 的牌`)
  moveCard(game.state, cardId, { kind: 'drawPile' }, { kind: 'hand', playerId })
  return cardId
}

function giveSlash(game: SanguoshaGame, playerId: PlayerId): string {
  const cardId = game.state.zones.drawPile.find((id) => {
    const card = game.state.cards[id]
    return card.name === '杀' && !card.damageNature
  })!
  moveCard(game.state, cardId, { kind: 'drawPile' }, { kind: 'hand', playerId })
  return cardId
}

function tianyiAction(game: SanguoshaGame) {
  return game.legalActions('p0').find((action) => action.id === `skill:${TIANYI}`)
}

function slashActions(game: SanguoshaGame): Array<Extract<LegalAction, { kind: 'use-card' }>> {
  return game.legalActions('p0').filter((action): action is Extract<LegalAction, { kind: 'use-card' }> =>
    action.kind === 'use-card' && action.asCardName === '杀')
}

/** 摆好双方拼点牌，跑完一次天义。 */
function runTianyi(game: SanguoshaGame, ownRank: number, opponentRank: number): void {
  const ownCard = giveRank(game, 'p0', ownRank)
  clearHand(game, 'p1')
  const opponentCard = giveRank(game, 'p1', opponentRank)
  game.act('p0', tianyiAction(game)!.id)
  answer(game, { targetIds: ['p1'] })
  const own = game.state.pendingRequests.find((request) => request.playerId === 'p0')!
  game.respond({ requestId: own.id, playerId: 'p0', payload: { cardIds: [ownCard] } })
  const theirs = game.state.pendingRequests.find((request) => request.playerId === 'p1')!
  game.respond({ requestId: theirs.id, playerId: 'p1', payload: { cardIds: [opponentCard] } })
}

describe('太史慈的基础信息', () => {
  it('吴势力、4 体力、火包、一个技能', () => {
    const character = getCharacter('taishici')!
    expect(character.kingdom).toBe('wu')
    expect(character.maxHp).toBe(4)
    expect(character.pack).toBe('fire')
    expect(character.skills.map((skill) => skill.id)).toEqual([TIANYI])
  })
})

describe('天义的发动条件', () => {
  it('没有体力限制——那是驱虎的条件，不能顺手复用（测试 3）', () => {
    const game = gameWith()
    game.state.players[1].hp = 1
    game.state.players[2].hp = 8
    expect(tianyiTargets(game.state, 'p0'), '体力低的也能拼').toContain('p1')
    expect(tianyiTargets(game.state, 'p0')).toContain('p2')
  })

  it('对方没手牌不能选，自己没手牌不能发动（测试 3）', () => {
    const game = gameWith()
    clearHand(game, 'p1')
    expect(tianyiTargets(game.state, 'p0')).not.toContain('p1')
    clearHand(game, 'p0')
    expect(tianyiAction(game)).toBeUndefined()
  })

  it('出牌阶段限一次，取消不消耗（测试 2）', () => {
    const game = gameWith()
    clearHand(game, 'p0')
    giveRank(game, 'p0', 13)
    game.act('p0', tianyiAction(game)!.id)
    answer(game, { targetIds: [] })
    expect(tianyiAction(game), '取消不消耗次数').toBeTruthy()

    runTianyi(game, 13, 7)
    expect(tianyiAction(game), '拼过就不能再来').toBeUndefined()
  })
})

describe('天义拼点获胜', () => {
  it('本回合多一次出杀、多一个目标、无距离限制（测试 4 / 7）', () => {
    const game = gameWith()
    clearHand(game, 'p0')
    runTianyi(game, 13, 7)

    const rules = slashRules(game.state, 'p0')
    expect(rules).toEqual({ extraUses: 1, extraTargets: 1, ignoreDistance: true, prohibited: false })
    assertGameInvariants(game.state)
  })

  it('可以打到距离外的角色（测试 12）', () => {
    const game = gameWith()
    clearHand(game, 'p0')
    // 先把距离拉远，确认正常情况够不着
    game.state.players[0].distanceToOthers = 5
    giveSlash(game, 'p0')
    expect(slashActions(game), '正常情况一个都够不着').toHaveLength(0)

    runTianyi(game, 13, 7)
    const targets = new Set(slashActions(game).flatMap((action) => action.targetIds))
    expect(targets.size, '无距离限制之后全场都能打').toBeGreaterThan(0)
    expect(targets).toContain('p2')
  })

  it('杀可以指定两个目标，且不会把自己列进去（测试 11）', () => {
    const game = gameWith()
    clearHand(game, 'p0')
    runTianyi(game, 13, 7)
    giveSlash(game, 'p0')

    const multi = slashActions(game).filter((action) => action.targetIds.length === 2)
    expect(multi.length, '应当出现双目标的杀').toBeGreaterThan(0)
    for (const action of multi) {
      expect(new Set(action.targetIds).size, '两个目标不能重复').toBe(2)
      expect(action.targetIds).not.toContain('p0')
    }
    // 单目标那条仍然在，玩家可以只打一个
    expect(slashActions(game).some((action) => action.targetIds.length === 1)).toBe(true)
  })

  it('真的能多出一张杀（测试 10）', () => {
    const game = gameWith()
    clearHand(game, 'p0')
    runTianyi(game, 13, 7)
    giveSlash(game, 'p0')
    giveSlash(game, 'p0')

    // 第一张
    const first = slashActions(game).find((action) => action.targetIds.length === 1)!
    game.act('p0', first.id)
    while (pending(game)) answer(game, { actionId: 'respond-pass' })
    expect(game.state.turnUsage.slashUses).toBe(1)
    // 第二张仍然可用
    expect(slashActions(game).length, '天义给了第二次机会').toBeGreaterThan(0)

    const second = slashActions(game).find((action) => action.targetIds.length === 1)!
    game.act('p0', second.id)
    while (pending(game)) answer(game, { actionId: 'respond-pass' })
    expect(game.state.turnUsage.slashUses).toBe(2)
    // 第三张就没有了
    expect(slashActions(game), '只多一次，不是无限').toHaveLength(0)
    assertCardConservation(game.state)
  })

  it('双目标的杀每个目标都独立结算（测试 52 相关）', () => {
    const game = gameWith()
    clearHand(game, 'p0')
    runTianyi(game, 13, 7)
    giveSlash(game, 'p0')
    const hpBefore = game.state.players.map((player) => player.hp)

    const multi = slashActions(game).find((action) => action.targetIds.length === 2)!
    game.act('p0', multi.id)
    let guard = 0
    while (pending(game)) {
      if (guard++ > 10) throw new Error('多目标杀没有收敛')
      answer(game, { actionId: 'respond-pass' })
    }
    const hurt = game.state.players.filter((player, index) => player.hp < hpBefore[index])
    expect(hurt, '两个目标各挨一下').toHaveLength(2)
    assertCardConservation(game.state)
    assertGameInvariants(game.state)
  })
})

describe('天义没赢', () => {
  it('拼点输：本回合不能使用杀（测试 5）', () => {
    const game = gameWith()
    clearHand(game, 'p0')
    giveSlash(game, 'p0')
    expect(slashActions(game).length, '拼点前能出杀').toBeGreaterThan(0)

    runTianyi(game, 3, 12)
    expect(slashRules(game.state, 'p0').prohibited).toBe(true)
    expect(slashActions(game), '禁杀之后一条都没有').toHaveLength(0)
  })

  it('平局按「没赢」处理（测试 6）', () => {
    const game = gameWith()
    clearHand(game, 'p0')
    giveSlash(game, 'p0')
    runTianyi(game, 8, 8)
    expect(slashRules(game.state, 'p0').prohibited, '平局不是什么都不发生').toBe(true)
    expect(slashActions(game)).toHaveLength(0)
  })

  it('禁杀在统一合法性层生效，转化出来的杀也用不了（测试 14）', () => {
    const game = gameWith('taishici-viewas', ['guanyu', 'zhangfei', 'zhangfei', 'zhangfei', 'zhangfei'])
    // 关羽【武圣】能把红牌当杀用；给他天义只是为了拿到禁令
    game.state.players[0].characterId = 'taishici'
    clearHand(game, 'p0')
    const red = game.state.zones.drawPile.find((id) => game.state.cards[id].color === 'red'
      && game.state.cards[id].name !== '杀')!
    moveCard(game.state, red, { kind: 'drawPile' }, { kind: 'hand', playerId: 'p0' })
    giveRank(game, 'p0', 3)
    clearHand(game, 'p1')
    giveRank(game, 'p1', 12)

    game.act('p0', tianyiAction(game)!.id)
    answer(game, { targetIds: ['p1'] })
    const own = game.state.pendingRequests.find((request) => request.playerId === 'p0')!
    game.respond({ requestId: own.id, playerId: 'p0', payload: { cardIds: [game.state.players[0].zones.hand.find((id) => game.state.cards[id].rank === 3)!] } })
    const theirs = game.state.pendingRequests.find((request) => request.playerId === 'p1')!
    game.respond({ requestId: theirs.id, playerId: 'p1', payload: { cardIds: [game.state.players[1].zones.hand[0]] } })

    expect(slashRules(game.state, 'p0').prohibited).toBe(true)
    expect(slashActions(game), '转化杀同样被挡住').toHaveLength(0)
  })

  it('禁的是「使用」，响应打出杀不受影响（测试 15）', () => {
    const game = gameWith()
    clearHand(game, 'p0')
    const kept = giveSlash(game, 'p0')
    runTianyi(game, 3, 12)
    expect(slashRules(game.state, 'p0').prohibited).toBe(true)

    // p1 对太史慈使用决斗：他仍然可以打出【杀】响应
    game.state.currentPlayerId = 'p1'
    const duel = game.state.zones.drawPile.find((id) => game.state.cards[id].name === '决斗')!
    moveCard(game.state, duel, { kind: 'drawPile' }, { kind: 'hand', playerId: 'p1' })
    const action = game.legalActions('p1').find((candidate) => candidate.kind === 'use-card'
      && candidate.cardIds.includes(duel) && candidate.targetIds.includes('p0'))!
    game.act('p1', action.id)
    // 先走完无懈轮询
    let guard = 0
    while (pending(game)?.kind === 'respond-card'
      && (pending(game) as { requiredCardName: string }).requiredCardName === '无懈可击') {
      if (guard++ > 10) throw new Error('无懈轮询没有收敛')
      answer(game, { actionId: 'respond-pass' })
    }
    const request = pending(game)
    expect(request?.playerId).toBe('p0')
    expect(request?.kind === 'respond-card' && request.actionIds, '打出杀不受禁令影响')
      .toContain(`respond-trick:${kept}`)
  })
})

describe('临时效果的生命周期', () => {
  it('回合结束自动清理，下一回合完全不存在（测试 8）', () => {
    const game = gameWith()
    clearHand(game, 'p0')
    runTianyi(game, 13, 7)
    expect(slashRules(game.state, 'p0').extraUses).toBe(1)

    game.state.phase = 'finish'
    game.advancePhase()

    expect(slashRules(game.state, 'p0'), '回合一结束就该干净')
      .toEqual({ extraUses: 0, extraTargets: 0, ignoreDistance: false, prohibited: false })
  })

  it('禁杀同样在回合结束时清掉', () => {
    const game = gameWith()
    clearHand(game, 'p0')
    runTianyi(game, 3, 12)
    expect(slashRules(game.state, 'p0').prohibited).toBe(true)
    game.state.phase = 'finish'
    game.advancePhase()
    expect(slashRules(game.state, 'p0').prohibited).toBe(false)
  })

  it('本回合内刷新仍然保留（测试 9）', () => {
    const game = gameWith()
    clearHand(game, 'p0')
    runTianyi(game, 13, 7)
    const restored = SanguoshaGame.restore(JSON.parse(JSON.stringify(game.serialize())))
    expect(slashRules(restored.state, 'p0')).toEqual({
      extraUses: 1, extraTargets: 1, ignoreDistance: true, prohibited: false,
    })
  })
})

describe('与其他出杀效果的叠加', () => {
  it('诸葛连弩已经无限出杀时，天义不会把它变回有限（测试 51）', () => {
    const game = gameWith()
    clearHand(game, 'p0')
    const crossbow = game.state.zones.drawPile.find((id) => game.state.cards[id].name === '诸葛连弩')!
    moveCard(game.state, crossbow, { kind: 'drawPile' }, { kind: 'equipment', playerId: 'p0', slot: 'weapon' })
    runTianyi(game, 13, 7)
    giveSlash(game, 'p0')

    game.state.turnUsage.slashUses = 5
    expect(slashActions(game).length, '连弩仍然无限').toBeGreaterThan(0)
  })

  it('张飞【咆哮】的无限出杀同样不受影响（测试 50）', () => {
    const game = gameWith('taishici-paoxiao', ['zhangfei', 'zhangfei', 'zhangfei', 'zhangfei', 'zhangfei'])
    clearHand(game, 'p0')
    giveSlash(game, 'p0')
    game.state.turnUsage.slashUses = 3
    expect(slashActions(game).length, '咆哮本来就无限').toBeGreaterThan(0)
  })
})
