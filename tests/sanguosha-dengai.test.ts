import { describe, expect, it } from 'vitest'
import { SanguoshaGame } from '@/sanguosha/engine/game'
import { assertGameInvariants } from '@/sanguosha/engine/invariants'
import { assertCardConservation, moveCard } from '@/sanguosha/engine/zones'
import { getDistance } from '@/sanguosha/engine/distance'
import { ownedSkillIds } from '@/sanguosha/engine/skills/runtime'
import { skillIdsOf } from '@/sanguosha/data/characters/standard'
import type { GameSetup, Identity, PlayerId, Suit } from '@/sanguosha/engine/types'

/**
 * 山包·邓艾。经典「神话再临·山」首版。
 *
 * 这一组守四件容易做反的事：
 *
 * 1. **屯田只在回合外**，判据是「当前回合角色不是邓艾」而不是阶段字段；
 * 2. **距离减的是 `toOthers`**——邓艾更容易够到别人，别人打他的距离不变；
 * 3. **凿险是觉醒技**：条件成立即强制发动，一局一次，不问玩家；
 * 4. **急袭的底牌是「田」本身**，从武将牌上直接使用，不路过手牌。
 */

function gameWith(characterIds: string[], seed = 'dengai'): SanguoshaGame {
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

function fieldsOf(game: SanguoshaGame, playerId: PlayerId): string[] {
  return playerOf(game, playerId).characterPiles.tuntian ?? []
}

function findCard(game: SanguoshaGame, match: (card: { id: string; name: string; suit: Suit; category: string }) => boolean): string {
  const card = Object.values(game.state.cards).find((candidate) => match(candidate))
  if (!card) throw new Error('这副牌里找不到符合条件的牌')
  return card.id
}

/** 把某张牌顶到牌堆顶，让下一次判定必定翻到它。 */
function stackJudgment(game: SanguoshaGame, cardId: string): void {
  game.state.zones.drawPile = game.state.zones.drawPile.filter((id) => id !== cardId)
  game.state.zones.discardPile = game.state.zones.discardPile.filter((id) => id !== cardId)
  for (const player of game.state.players) {
    player.zones.hand = player.zones.hand.filter((id) => id !== cardId)
  }
  game.state.zones.drawPile.unshift(cardId)
}

/** 直接往邓艾武将牌上摆 N 张「田」，跳过判定流程。 */
function giveFields(game: SanguoshaGame, playerId: PlayerId, count: number): string[] {
  const placed: string[] = []
  for (let index = 0; index < count; index += 1) {
    const cardId = game.state.zones.drawPile[0]
    moveCard(game.state, cardId, { kind: 'drawPile' }, { kind: 'characterPile', playerId, pile: 'tuntian' })
    placed.push(cardId)
  }
  return placed
}

/**
 * 在回合外让邓艾失去一张手牌，触发屯田。
 *
 * 屯田走的是延后队列，所以要 `settle` 一次才会真正弹出询问——
 * 这里用引擎自己的 `advancePhase` 之外的路径不方便，直接派发 LoseCard 再让
 * 引擎把队列跑干净。
 */
function loseCardOutOfTurn(game: SanguoshaGame, ownerId: PlayerId): string {
  game.state.currentPlayerId = ownerId === 'p0' ? 'p1' : 'p0'
  const owner = playerOf(game, ownerId)
  const cardId = owner.zones.hand[0]
  moveCard(game.state, cardId, { kind: 'hand', playerId: ownerId }, { kind: 'discardPile' })
  game.emit('LoseCard', { playerId: ownerId, cardIds: [cardId], reason: '测试' })
  game.settle()
  return cardId
}

const FIVE = ['dengai', 'zhangfei', 'zhangfei', 'zhangfei', 'zhangfei']

describe('屯田的触发条件', () => {
  it('回合外失去牌后弹出询问，可以放弃', () => {
    const game = gameWith(FIVE)
    loseCardOutOfTurn(game, 'p0')
    const ask = pending(game)
    expect(ask?.kind).toBe('choose-option')
    expect(ask.playerId).toBe('p0')
    expect(String(ask.prompt)).toContain('屯田')
    game.respond({ requestId: ask.id, playerId: 'p0', payload: { optionId: 'no' } })
    expect(fieldsOf(game, 'p0').length, '放弃就不该有田').toBe(0)
  })

  it('自己回合内失去牌不触发', () => {
    const game = gameWith(FIVE)
    game.state.currentPlayerId = 'p0'
    const owner = playerOf(game, 'p0')
    const cardId = owner.zones.hand[0]
    moveCard(game.state, cardId, { kind: 'hand', playerId: 'p0' }, { kind: 'discardPile' })
    game.emit('LoseCard', { playerId: 'p0', cardIds: [cardId], reason: '测试' })
    game.settle()
    expect(pending(game), '回合内不该触发屯田').toBeUndefined()
  })

  it('一次失去多张牌只触发一次判定，不是每张各来一次', () => {
    const game = gameWith(FIVE)
    game.state.currentPlayerId = 'p1'
    const owner = playerOf(game, 'p0')
    const two = owner.zones.hand.slice(0, 2)
    for (const cardId of two) moveCard(game.state, cardId, { kind: 'hand', playerId: 'p0' }, { kind: 'discardPile' })
    game.emit('LoseCard', { playerId: 'p0', cardIds: two, reason: '测试' })
    game.settle()

    const ask = pending(game)
    expect(ask?.kind).toBe('choose-option')
    game.respond({ requestId: ask.id, playerId: 'p0', payload: { optionId: 'no' } })
    // 放弃之后不该还排着第二条屯田询问
    expect(pending(game), '一次失去牌事件只给一次机会').toBeUndefined()
  })

  it('别人失去牌不触发邓艾的屯田', () => {
    const game = gameWith(FIVE)
    game.state.currentPlayerId = 'p2'
    const other = playerOf(game, 'p1')
    const cardId = other.zones.hand[0]
    moveCard(game.state, cardId, { kind: 'hand', playerId: 'p1' }, { kind: 'discardPile' })
    game.emit('LoseCard', { playerId: 'p1', cardIds: [cardId], reason: '测试' })
    game.settle()
    expect(pending(game)).toBeUndefined()
  })
})

describe('屯田的判定结果', () => {
  function judgeWith(game: SanguoshaGame, suit: Suit): string {
    const judge = findCard(game, (card) => card.suit === suit)
    stackJudgment(game, judge)
    loseCardOutOfTurn(game, 'p0')
    const ask = pending(game)
    game.respond({ requestId: ask.id, playerId: 'p0', payload: { optionId: 'yes' } })
    return judge
  }

  it('判定不为红桃：判定牌成为「田」，不进弃牌堆', () => {
    const game = gameWith(FIVE)
    const judge = judgeWith(game, 'spade')
    expect(fieldsOf(game, 'p0')).toContain(judge)
    expect(game.state.zones.discardPile, '田不该同时留在弃牌堆').not.toContain(judge)
    assertCardConservation(game.state)
    assertGameInvariants(game.state)
  })

  it('判定为红桃：不成为田，判定牌照常进弃牌堆', () => {
    const game = gameWith(FIVE)
    const judge = judgeWith(game, 'heart')
    expect(fieldsOf(game, 'p0')).not.toContain(judge)
    expect(game.state.zones.discardPile).toContain(judge)
    assertCardConservation(game.state)
  })

  it('梅花和方片同样成为田——只有红桃不算', () => {
    for (const suit of ['club', 'diamond'] as Suit[]) {
      const game = gameWith(FIVE)
      const judge = judgeWith(game, suit)
      expect(fieldsOf(game, 'p0'), `${suit} 应该成为田`).toContain(judge)
    }
  })
})

describe('屯田的距离修正', () => {
  it('减少的是「邓艾到别人」的距离，别人到邓艾不变', () => {
    const game = gameWith(FIVE)
    const before = getDistance(game.state, 'p0', 'p2')
    const beforeInbound = getDistance(game.state, 'p2', 'p0')

    giveFields(game, 'p0', 1)
    expect(getDistance(game.state, 'p0', 'p2'), '邓艾够得更远').toBe(Math.max(1, before - 1))
    expect(getDistance(game.state, 'p2', 'p0'), '别人打邓艾的距离不变').toBe(beforeInbound)
  })

  it('田越多减得越多，但距离下限是 1', () => {
    const game = gameWith(FIVE)
    giveFields(game, 'p0', 5)
    for (const targetId of ['p1', 'p2', 'p3', 'p4']) {
      expect(getDistance(game.state, 'p0', targetId), `到 ${targetId} 的距离不能低于 1`).toBeGreaterThanOrEqual(1)
    }
    expect(getDistance(game.state, 'p0', 'p2')).toBe(1)
  })

  it('0 张田时没有任何修正', () => {
    const game = gameWith(FIVE)
    const plain = gameWith(['zhangfei', 'zhangfei', 'zhangfei', 'zhangfei', 'zhangfei'])
    expect(getDistance(game.state, 'p0', 'p2')).toBe(getDistance(plain.state, 'p0', 'p2'))
  })
})

describe('凿险：觉醒技', () => {
  function enterPrepare(game: SanguoshaGame, playerId: PlayerId): void {
    game.state.currentPlayerId = playerId
    game.state.phase = 'prepare'
    game.emit('PhaseStart', { playerId, phase: 'prepare' })
    game.settle()
  }

  it('田不足三张不觉醒，也不弹任何询问', () => {
    const game = gameWith(FIVE)
    giveFields(game, 'p0', 2)
    enterPrepare(game, 'p0')
    expect(playerOf(game, 'p0').awakenedSkills).not.toContain('zaoxian')
    expect(pending(game), '觉醒技不问玩家要不要').toBeUndefined()
  })

  it('田满三张：强制觉醒，减 1 体力上限并获得【急袭】', () => {
    const game = gameWith(FIVE)
    const owner = playerOf(game, 'p0')
    const maxHpBefore = owner.maxHp
    giveFields(game, 'p0', 3)
    enterPrepare(game, 'p0')

    expect(owner.awakenedSkills, '觉醒记账由引擎统一做').toContain('zaoxian')
    expect(owner.maxHp).toBe(maxHpBefore - 1)
    expect(owner.grantedSkills, '获得急袭').toContain('jixi')
    expect(ownedSkillIds(game.state, 'p0', skillIdsOf), '技能归属要算上授予的').toContain('jixi')
    assertGameInvariants(game.state)
  })

  it('四张田也一样觉醒；已经觉醒过就不会再触发第二次', () => {
    const game = gameWith(FIVE)
    const owner = playerOf(game, 'p0')
    giveFields(game, 'p0', 4)
    enterPrepare(game, 'p0')
    const afterFirst = owner.maxHp
    expect(owner.awakenedSkills).toContain('zaoxian')

    enterPrepare(game, 'p0')
    expect(owner.maxHp, '觉醒一局只有一次，不能反复减上限').toBe(afterFirst)
  })

  it('觉醒前没有急袭——不能开局就用', () => {
    const game = gameWith(FIVE)
    giveFields(game, 'p0', 3)
    expect(ownedSkillIds(game.state, 'p0', skillIdsOf), '觉醒之前不该拥有急袭').not.toContain('jixi')
  })

  it('觉醒状态可以序列化恢复', () => {
    const game = gameWith(FIVE)
    giveFields(game, 'p0', 3)
    enterPrepare(game, 'p0')

    const restored = SanguoshaGame.restore(JSON.parse(JSON.stringify(game.serialize())))
    const owner = restored.state.players.find((player) => player.id === 'p0')!
    expect(owner.awakenedSkills).toContain('zaoxian')
    expect(owner.grantedSkills).toContain('jixi')
    expect(ownedSkillIds(restored.state, 'p0', skillIdsOf)).toContain('jixi')
  })
})

describe('急袭：把「田」当顺手牵羊使用', () => {
  function awaken(game: SanguoshaGame): string[] {
    const fields = giveFields(game, 'p0', 3)
    game.state.currentPlayerId = 'p0'
    game.state.phase = 'prepare'
    game.emit('PhaseStart', { playerId: 'p0', phase: 'prepare' })
    game.settle()
    return fields
  }

  it('觉醒后出牌阶段能用田打出顺手牵羊，底牌就是那张田', () => {
    const game = gameWith(FIVE)
    const fields = awaken(game)
    game.state.phase = 'play'
    // 目标要有牌可拿，而且要在距离内——屯田本身就把距离压到 1 了
    const actions = game.legalActions('p0')
    const jixi = actions.find((action) => action.kind === 'use-card' && action.label?.includes('急袭'))
    expect(jixi, '觉醒后应该生成急袭动作').toBeTruthy()
    // 动作带的是 cardIds 数组，底牌必须是武将牌上的那张田本身
    expect(fields).toContain((jixi as { cardIds: string[] }).cardIds[0])
    expect((jixi as { asCardName: string }).asCardName).toBe('顺手牵羊')
  })

  it('急袭消耗的田真的离开武将牌，且不凭空造牌', () => {
    const game = gameWith(FIVE)
    const fields = awaken(game)
    game.state.phase = 'play'
    const before = fieldsOf(game, 'p0').length
    const actions = game.legalActions('p0')
    const jixi = actions.find((action) => action.kind === 'use-card' && action.label?.includes('急袭'))
    if (!jixi) throw new Error('没有生成急袭动作')

    game.act('p0', jixi.id)
    // 结算过程中可能要选牌，把请求跑完
    let guard = 0
    while (game.state.pendingRequests.length > 0 && guard < 20) {
      const request = game.state.pendingRequests[0]
      /*
       * 顺手牵羊会牵出无懈可击窗口，可能还有濒死求桃——这两种请求要的都是
       * `actionId` 而不是 `optionId`，一律选最后一项（`respond-pass` / 放弃）。
       */
      const payload = request.kind === 'choose-cards'
        ? { cardIds: [request.cardIds[0] ?? request.hiddenCardSlots[0]] }
        : request.kind === 'choose-targets'
          ? { targetIds: request.candidateIds.slice(0, Math.max(request.min, 1)) }
          : request.kind === 'rescue' || request.kind === 'respond-card'
            ? { actionId: request.actionIds[request.actionIds.length - 1] }
            : { optionId: 'no' }
      game.respond({ requestId: request.id, playerId: request.playerId, payload })
      guard += 1
    }

    expect(fieldsOf(game, 'p0').length, '用掉的田要离开武将牌').toBeLessThan(before)
    expect(fields.length).toBe(3)
    assertCardConservation(game.state)
    assertGameInvariants(game.state)
  })

  it('没觉醒时不产生急袭动作', () => {
    const game = gameWith(FIVE)
    giveFields(game, 'p0', 3)
    game.state.currentPlayerId = 'p0'
    game.state.phase = 'play'
    const actions = game.legalActions('p0')
    expect(actions.some((action) => action.label?.includes('急袭')), '没觉醒就不该有急袭').toBe(false)
  })

  it('田是公开的：PlayerView 里别人也看得到具体牌面', () => {
    const game = gameWith(FIVE)
    giveFields(game, 'p0', 2)
    const view = game.viewFor('p1')
    const dengai = view.players.find((player) => player.id === 'p0')!
    expect(dengai.characterPiles.tuntian?.length, '田对所有人公开').toBe(2)
  })
})
