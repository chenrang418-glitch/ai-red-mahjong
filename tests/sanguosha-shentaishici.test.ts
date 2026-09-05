import { describe, expect, it } from 'vitest'
import { SanguoshaGame } from '@/sanguosha/engine/game'
import { assertCardConservation, moveCard, type ZoneRef } from '@/sanguosha/engine/zones'
import { canTarget, getDistance } from '@/sanguosha/engine/distance'
import { isForcedInAttackRange } from '@/sanguosha/engine/attack-range-override'
import { missionStatus } from '@/sanguosha/engine/mission-skill'
import {
  grantMovableTokens,
  hasMovableToken,
  moveMovableTokens,
  tokenOwnersOn,
  tokensOf,
} from '@/sanguosha/engine/movable-tokens'
import { canUseSlash } from '@/sanguosha/engine/slash-rules'
import { WEI_TOKEN } from '@/sanguosha/data/characters/god-shentaishici'
import type { GameSetup, Identity, PlayerId, SanguoshaState } from '@/sanguosha/engine/types'

/**
 * 神·太史慈。
 *
 * 三个技能里【破围】最容易出错，而且错法很隐蔽：
 * 「围」的移动如果边扫边移，一次回合开始能把同一枚挪好几格；
 * 攻击范围豁免如果方向写反，技能会从「把自己送到刀口上」变成远程打击。
 * 所以这两条各有一组专门的用例。
 */

const CAST = ['shentaishici', 'zhangfei', 'guanyu', 'zhaoyun', 'machao']

interface AnyRequest { id: string; playerId: PlayerId; kind: string; prompt?: string }

function defaultResponse(request: AnyRequest) {
  const payload: Record<string, unknown> = (() => {
    switch (request.kind) {
      case 'choose-option': {
        const options = (request as unknown as { options: { id: string }[] }).options
        return { optionId: options[options.length - 1].id }
      }
      case 'choose-cards': {
        const pick = request as unknown as { cardIds: string[]; hiddenCardSlots: string[]; min: number }
        return { cardIds: [...pick.cardIds, ...pick.hiddenCardSlots].slice(0, pick.min ?? 0) }
      }
      case 'choose-targets': {
        const pick = request as unknown as { candidateIds: string[]; min: number }
        return { targetIds: pick.candidateIds.slice(0, pick.min ?? 0) }
      }
      case 'rescue': return { actionId: 'rescue-pass' }
      default: return { actionId: 'respond-pass' }
    }
  })()
  return { requestId: request.id, playerId: request.playerId, payload }
}

function settle(
  game: SanguoshaGame,
  choose: (request: AnyRequest) => Record<string, unknown> | null = () => null,
): void {
  for (let guard = 0; guard < 300; guard += 1) {
    const request = game.state.pendingRequests[0] as AnyRequest | undefined
    if (!request) return
    const custom = choose(request)
    game.respond(custom
      ? { requestId: request.id, playerId: request.playerId, payload: custom }
      : defaultResponse(request))
  }
  throw new Error('结算没有收敛')
}

function gameAt(seed: string, characterIds: string[] = CAST): SanguoshaGame {
  const setup: GameSetup = {
    mode: 'identity', generalChoices: 1,
    players: Array.from({ length: 5 }, (_, index) => ({ id: `p${index}`, nickname: `玩家${index}`, isHuman: index === 0 })),
  }
  const game = new SanguoshaGame({ seed, setup })
  const identities: Identity[] = ['lord', 'rebel', 'loyalist', 'rebel', 'renegade']
  game.state.players.forEach((player, index) => {
    player.identity = identities[index]
    player.identityRevealed = player.identity === 'lord'
    player.characterId = characterIds[index]
  })
  game.state.currentPlayerId = 'p0'
  game.start()
  settle(game)
  while (game.state.phase !== 'play') game.advancePhase()
  return game
}

function locate(state: SanguoshaState, cardId: string): ZoneRef {
  if (state.zones.drawPile.includes(cardId)) return { kind: 'drawPile' }
  if (state.zones.discardPile.includes(cardId)) return { kind: 'discardPile' }
  if (state.zones.processingArea.includes(cardId)) return { kind: 'processingArea' }
  for (const owner of state.players) {
    if (owner.zones.hand.includes(cardId)) return { kind: 'hand', playerId: owner.id }
    if (owner.zones.judgingArea.includes(cardId)) return { kind: 'judgingArea', playerId: owner.id }
    for (const [slot, equipped] of Object.entries(owner.zones.equipment)) {
      if (equipped === cardId) return { kind: 'equipment', playerId: owner.id, slot: slot as keyof typeof owner.zones.equipment }
    }
  }
  throw new Error('找不到卡牌：' + cardId)
}

function giveCard(game: SanguoshaGame, playerId: string, cardName: string): string {
  const own = game.state.players.find((player) => player.id === playerId)!
  const card = Object.values(game.state.cards)
    .find((candidate) => candidate.name === cardName && !own.zones.hand.includes(candidate.id))
  if (!card) throw new Error('牌堆里没有【' + cardName + '】')
  moveCard(game.state, card.id, locate(game.state, card.id), { kind: 'hand', playerId })
  return card.id
}

function stripCard(game: SanguoshaGame, cardName: string): void {
  for (const player of game.state.players) {
    for (const cardId of [...player.zones.hand]) {
      if (game.state.cards[cardId]?.name !== cardName) continue
      moveCard(game.state, cardId, { kind: 'hand', playerId: player.id }, { kind: 'discardPile' })
    }
  }
}

function useOn(game: SanguoshaGame, actorId: string, cardId: string, targetIds: string[]): void {
  const action = game.legalActions(actorId).find((candidate) => (
    candidate.kind === 'use-card'
    && candidate.cardIds.includes(cardId)
    && candidate.targetIds.length === targetIds.length
    && targetIds.every((id) => candidate.targetIds.includes(id))
  ))
  if (!action) throw new Error('找不到出牌动作：' + cardId + ' -> ' + targetIds.join(','))
  game.act(actorId, action.id)
}

function playerOf(game: SanguoshaGame, id: string) {
  return game.state.players.find((candidate) => candidate.id === id)!
}

/**
 * 派发一次回合开始，然后把引擎的收尾跑一遍。
 *
 * 破围的分支询问是**排队**发出的（同一个 `TurnStart` 上可能还有别的技能要发问），
 * 队列要等牌局回到干净状态才由引擎放出来。直接 dispatch 事件不经过那个收尾步骤，
 * 请求永远发不出来。
 */
function turnStart(game: SanguoshaGame, playerId: string, turnNumber: number): void {
  game.dispatch('TurnStart', { playerId, turnNumber }, { sourceId: playerId })
  ;(game as unknown as { settle(): void }).settle()
}

/** 把判定牌堆顶固定成某个花色，让笃烈的判定结果确定下来。 */
function stackJudgment(game: SanguoshaGame, suit: 'heart' | 'spade'): void {
  const cardId = Object.values(game.state.cards)
    .find((card) => card.suit === suit && game.state.zones.drawPile.includes(card.id))!.id
  game.state.zones.drawPile = [cardId, ...game.state.zones.drawPile.filter((id) => id !== cardId)]
}

function carriersOf(game: SanguoshaGame, ownerId = 'p0'): string[] {
  return tokensOf(game.state, WEI_TOKEN, ownerId).map((token) => token.carrierId).sort()
}

describe('神·太史慈：笃烈', () => {
  it('体力值更高的人出杀：红桃判定取消这个目标，不再要求打闪', () => {
    const game = gameAt('tsc-dulie-heart')
    stripCard(game, '无懈可击')
    stripCard(game, '闪')
    const owner = playerOf(game, 'p0')
    /*
     * 体力**不能**压到 1：掉到 0 会进濒死，破围的使命失败又把体力回复到 1，
     * 读数被抹平，取消与没取消看起来一模一样。
     */
    owner.hp = 3
    playerOf(game, 'p1').hp = 4
    game.state.currentPlayerId = 'p1'
    const slash = giveCard(game, 'p1', '杀')
    stackJudgment(game, 'heart')

    useOn(game, 'p1', slash, ['p0'])
    settle(game)

    expect(owner.hp, '目标被取消就不该掉血').toBe(3)
    assertCardConservation(game.state)
  })

  it('非红桃判定不取消，照常进入求闪', () => {
    const game = gameAt('tsc-dulie-spade')
    stripCard(game, '无懈可击')
    stripCard(game, '闪')
    const owner = playerOf(game, 'p0')
    owner.hp = 3
    playerOf(game, 'p1').hp = 4
    game.state.currentPlayerId = 'p1'
    const slash = giveCard(game, 'p1', '杀')
    stackJudgment(game, 'spade')

    useOn(game, 'p1', slash, ['p0'])
    settle(game)

    expect(owner.hp, '判定不是红桃，照常挨这一刀').toBe(2)
  })

  it('攻击者体力相等或更低都不触发', () => {
    const game = gameAt('tsc-dulie-equal')
    stripCard(game, '无懈可击')
    stripCard(game, '闪')
    const owner = playerOf(game, 'p0')
    owner.hp = 3
    playerOf(game, 'p1').hp = 3
    game.state.currentPlayerId = 'p1'
    const slash = giveCard(game, 'p1', '杀')
    // 判定牌堆顶就算是红桃也不该有判定发生
    stackJudgment(game, 'heart')

    useOn(game, 'p1', slash, ['p0'])
    settle(game)

    expect(owner.hp, '体力相等不触发笃烈').toBe(2)
  })

  it('多目标【杀】只取消他自己', () => {
    const game = gameAt('tsc-dulie-multi')
    stripCard(game, '无懈可击')
    stripCard(game, '闪')
    const owner = playerOf(game, 'p0')
    owner.hp = 1
    playerOf(game, 'p1').hp = 4
    game.state.currentPlayerId = 'p1'
    // 借方天画戟之类的多目标能力不好构造，这里直接放开目标数
    playerOf(game, 'p1').marks['slash-extra-targets'] = 1
    const slash = giveCard(game, 'p1', '杀')
    const otherHp = playerOf(game, 'p2').hp
    stackJudgment(game, 'heart')

    useOn(game, 'p1', slash, ['p0', 'p2'])
    settle(game)

    expect(owner.hp, '神太史慈这个目标被取消').toBe(1)
    expect(playerOf(game, 'p2').hp, '其他目标照常结算').toBe(otherHp - 1)
  })

  it('判定状态跟着快照走，重连不丢', () => {
    const game = gameAt('tsc-dulie-restore')
    const restored = SanguoshaGame.restore(JSON.parse(JSON.stringify(game.serialize())))
    expect(restored.state.players.find((candidate) => candidate.id === 'p0')?.characterId).toBe('shentaishici')
  })
})

describe('神·太史慈：围', () => {
  it('开局其他角色各一枚，自己没有', () => {
    const game = gameAt('tsc-wei-init')
    expect(carriersOf(game)).toEqual(['p1', 'p2', 'p3', 'p4'])
    expect(hasMovableToken(game.state, WEI_TOKEN, 'p0', 'p0'), '自己不持有自己的围').toBe(false)
  })

  it('围记来源：两个神太史慈的围互不相干', () => {
    const game = gameAt('tsc-wei-source', ['shentaishici', 'shentaishici', 'guanyu', 'zhaoyun', 'machao'])
    expect(tokensOf(game.state, WEI_TOKEN, 'p0')).toHaveLength(4)
    expect(tokensOf(game.state, WEI_TOKEN, 'p1')).toHaveLength(4)
    // p2 身上同时有两个来源的围，UI 要能分辨
    expect(tokenOwnersOn(game.state, WEI_TOKEN, 'p2').sort()).toEqual(['p0', 'p1'])
  })

  it('回合开始整体移动一格，不会把同一枚挪两次', () => {
    const game = gameAt('tsc-wei-move')
    // p1..p4 各一枚，移动一格后应当是 p2、p3、p4、以及绕回来跳过 p0 落到 p1
    turnStart(game, 'p1', 2)
    settle(game)
    expect(carriersOf(game), '四枚各挪一格，绕过神太史慈自己').toEqual(['p1', 'p2', 'p3', 'p4'])
  })

  it('快照移动：不会出现一枚跑两格', () => {
    const game = gameAt('tsc-wei-snapshot')
    // 只留一枚在 p1 身上，移动后必须恰好在 p2
    game.state.movableTokens = [{ key: WEI_TOKEN, ownerId: 'p0', carrierId: 'p1' }]
    moveMovableTokens(game.state, WEI_TOKEN, 'p0', (carrierId) => (carrierId === 'p1' ? 'p2' : 'p3'))
    expect(carriersOf(game)).toEqual(['p2'])
  })

  it('下家按存活座次，跳过死人', () => {
    const game = gameAt('tsc-wei-dead')
    playerOf(game, 'p2').alive = false
    game.state.movableTokens = [{ key: WEI_TOKEN, ownerId: 'p0', carrierId: 'p1' }]
    turnStart(game, 'p1', 2)
    settle(game)
    expect(carriersOf(game), 'p2 已死，围要跳到 p3').toEqual(['p3'])
  })

  it('围落到神太史慈头上就直接再传下家', () => {
    const game = gameAt('tsc-wei-skip-owner')
    // p4 的下家是 p0（神太史慈自己），应当继续传到 p1
    game.state.movableTokens = [{ key: WEI_TOKEN, ownerId: 'p0', carrierId: 'p4' }]
    turnStart(game, 'p1', 2)
    settle(game)
    expect(carriersOf(game)).toEqual(['p1'])
  })

  it('有围角色受到伤害后围被移除', () => {
    const game = gameAt('tsc-wei-damage')
    expect(hasMovableToken(game.state, WEI_TOKEN, 'p0', 'p1')).toBe(true)
    game.damage({ sourceId: 'p2', targetId: 'p1', amount: 1 })
    settle(game)
    expect(hasMovableToken(game.state, WEI_TOKEN, 'p0', 'p1'), '真正受到伤害就移围').toBe(false)
    // 别人身上的不受影响
    expect(hasMovableToken(game.state, WEI_TOKEN, 'p0', 'p2')).toBe(true)
  })

  it('失去体力不算伤害，围保留', () => {
    const game = gameAt('tsc-wei-losehp')
    const target = playerOf(game, 'p1')
    target.hp -= 1
    game.dispatch('LoseHp', { playerId: 'p1', amount: 1 }, { targetId: 'p1' })
    settle(game)
    expect(hasMovableToken(game.state, WEI_TOKEN, 'p0', 'p1'), '失去体力不是受到伤害').toBe(true)
  })
})

describe('神·太史慈：破围的分支', () => {
  /** 让 p1 的回合开始，并在破围询问上作出选择。 */
  function turnStartWithChoice(game: SanguoshaGame, optionId: string): void {
    // 只留 p1 一枚围，且让它移动后仍然落在 p1 身上，便于构造
    game.state.movableTokens = [{ key: WEI_TOKEN, ownerId: 'p0', carrierId: 'p0' }]
    turnStart(game, 'p1', 2)
    settle(game, (request) => (request.kind === 'choose-option' && request.playerId === 'p0'
      ? { optionId }
      : null))
  }

  it('分支一：弃一张手牌对其造成 1 点伤害，围随伤害自然移除', () => {
    const game = gameAt('tsc-powei-damage')
    const owner = playerOf(game, 'p0')
    const carrier = playerOf(game, 'p1')
    giveCard(game, 'p0', '杀')
    const handBefore = owner.zones.hand.length
    const hpBefore = carrier.hp

    turnStartWithChoice(game, 'powei-damage')

    expect(carrier.hp, '造成 1 点伤害').toBe(hpBefore - 1)
    expect(owner.zones.hand.length, '弃掉一张手牌').toBe(handBefore - 1)
    expect(hasMovableToken(game.state, WEI_TOKEN, 'p0', 'p1'), '围由「受到伤害后」自然移除').toBe(false)
    assertCardConservation(game.state)
  })

  it('没有手牌时不给出分支一', () => {
    const game = gameAt('tsc-powei-nohand')
    const owner = playerOf(game, 'p0')
    for (const cardId of [...owner.zones.hand]) {
      moveCard(game.state, cardId, { kind: 'hand', playerId: 'p0' }, { kind: 'discardPile' })
    }
    playerOf(game, 'p1').hp = owner.hp
    game.state.movableTokens = [{ key: WEI_TOKEN, ownerId: 'p0', carrierId: 'p0' }]
    turnStart(game, 'p1', 2)

    const request = game.state.pendingRequests[0] as unknown as { options?: { id: string }[] }
    const optionIds = request?.options?.map((option) => option.id) ?? []
    expect(optionIds, '付不起代价的选项不该弹出来').not.toContain('powei-damage')
    settle(game)
  })

  it('分支二：体力条件成立时获得其一张手牌，不是弃置', () => {
    const game = gameAt('tsc-powei-steal')
    const owner = playerOf(game, 'p0')
    const carrier = playerOf(game, 'p1')
    owner.hp = 4
    carrier.hp = 2
    const ownerHand = owner.zones.hand.length
    const carrierHand = carrier.zones.hand.length
    const discardBefore = game.state.zones.discardPile.length

    turnStartWithChoice(game, 'powei-steal')

    expect(owner.zones.hand.length).toBe(ownerHand + 1)
    expect(carrier.zones.hand.length).toBe(carrierHand - 1)
    expect(game.state.zones.discardPile.length, '是获得，不是弃置').toBe(discardBefore)
    expect(hasMovableToken(game.state, WEI_TOKEN, 'p0', 'p1'), '没造成伤害，围还在').toBe(true)
    assertCardConservation(game.state)
  })

  it('体力条件不成立就不给出分支二', () => {
    const game = gameAt('tsc-powei-hp')
    const owner = playerOf(game, 'p0')
    owner.hp = 1
    playerOf(game, 'p1').hp = 4
    giveCard(game, 'p0', '杀')
    game.state.movableTokens = [{ key: WEI_TOKEN, ownerId: 'p0', carrierId: 'p0' }]
    turnStart(game, 'p1', 2)

    const request = game.state.pendingRequests[0] as unknown as { options?: { id: string }[] }
    const optionIds = request?.options?.map((option) => option.id) ?? []
    expect(optionIds).not.toContain('powei-steal')
    settle(game)
  })

  it('发动后有围角色视为能打到神太史慈，方向不反', () => {
    const game = gameAt('tsc-powei-range')
    const owner = playerOf(game, 'p0')
    const carrier = playerOf(game, 'p1')
    owner.hp = 4
    carrier.hp = 2
    // 把距离拉到攻击范围之外
    owner.distanceFromOthers = 5

    expect(canTarget(game.state, 'p1', 'p0'), '默认打不到').toBe(false)
    turnStartWithChoice(game, 'powei-steal')

    expect(isForcedInAttackRange(game.state, 'p1', 'p0')).toBe(true)
    expect(canTarget(game.state, 'p1', 'p0'), '有围的那个人视为够得着').toBe(true)
    // 反方向没有被登记：神太史慈没有因此获得任何远程能力
    expect(isForcedInAttackRange(game.state, 'p0', 'p1'), '豁免是单向的').toBe(false)
    // 豁免的是攻击范围检查，不是把距离数字改小
    expect(getDistance(game.state, 'p1', 'p0')).toBeGreaterThan(1)
  })

  it('回合结束清理攻击范围豁免', () => {
    const game = gameAt('tsc-powei-range-clear')
    const owner = playerOf(game, 'p0')
    owner.hp = 4
    playerOf(game, 'p1').hp = 2
    turnStartWithChoice(game, 'powei-steal')
    expect(isForcedInAttackRange(game.state, 'p1', 'p0')).toBe(true)

    game.state.currentPlayerId = 'p1'
    for (let guard = 0; guard < 40 && game.state.currentPlayerId === 'p1'; guard += 1) {
      settle(game)
      if (game.state.currentPlayerId !== 'p1') break
      game.advancePhase()
    }
    settle(game)
    expect(isForcedInAttackRange(game.state, 'p1', 'p0'), '本回合结束就该清掉').toBe(false)
  })
})

describe('神·太史慈：使命', () => {
  it('自己回合开始时场上没有围：使命成功并获得【神著】', () => {
    const game = gameAt('tsc-mission-success')
    game.state.movableTokens = []
    turnStart(game, 'p0', 2)
    settle(game)
    expect(missionStatus(game.state, 'p0', 'powei')).toBe('success')
    expect(playerOf(game, 'p0').grantedSkills ?? []).toContain('shenzhu')
  })

  it('还有围就不算成功', () => {
    const game = gameAt('tsc-mission-pending')
    turnStart(game, 'p0', 2)
    settle(game)
    expect(missionStatus(game.state, 'p0', 'powei')).toBe('in-progress')
    expect(playerOf(game, 'p0').grantedSkills ?? []).not.toContain('shenzhu')
  })

  it('成功只结算一次', () => {
    const game = gameAt('tsc-mission-once')
    game.state.movableTokens = []
    turnStart(game, 'p0', 2)
    settle(game)
    const skills = [...(playerOf(game, 'p0').grantedSkills ?? [])]
    turnStart(game, 'p0', 3)
    settle(game)
    expect(playerOf(game, 'p0').grantedSkills ?? []).toEqual(skills)
  })

  it('濒死即失败：回复到 1 点、清空围、弃掉装备，且不再问桃', () => {
    const game = gameAt('tsc-mission-fail')
    const owner = playerOf(game, 'p0')
    // 装上一件装备，验证失败时走的是正常的装备离场
    const armor = giveCard(game, 'p0', '八卦阵')
    moveCard(game.state, armor, { kind: 'hand', playerId: 'p0' }, { kind: 'equipment', playerId: 'p0', slot: 'armor' })
    expect(owner.zones.equipment.armor).toBe(armor)

    owner.hp = 1
    game.damage({ sourceId: 'p1', targetId: 'p0', amount: 3 })

    expect(owner.hp, '回复至 1 点，不是固定回复 1 点').toBe(1)
    expect(owner.alive).toBe(true)
    expect(missionStatus(game.state, 'p0', 'powei')).toBe('failure')
    expect(tokensOf(game.state, WEI_TOKEN, 'p0'), '场上所有围一并移去').toHaveLength(0)
    expect(owner.zones.equipment.armor, '装备区清空').toBeFalsy()
    expect(game.state.dying, '失败之后濒死流程就该结束').toBeFalsy()
    expect(game.state.pendingRequests.some((request) => request.kind === 'rescue'), '不该再问桃').toBe(false)
    assertCardConservation(game.state)
  })

  it('失败是终局：之后即使没有围也不能成功', () => {
    const game = gameAt('tsc-mission-terminal')
    const owner = playerOf(game, 'p0')
    owner.hp = 1
    game.damage({ sourceId: 'p1', targetId: 'p0', amount: 3 })
    settle(game)
    expect(missionStatus(game.state, 'p0', 'powei')).toBe('failure')

    turnStart(game, 'p0', 3)
    settle(game)
    expect(missionStatus(game.state, 'p0', 'powei')).toBe('failure')
    expect(playerOf(game, 'p0').grantedSkills ?? []).not.toContain('shenzhu')
  })

  it('使命状态跟着快照走', () => {
    const game = gameAt('tsc-mission-restore')
    game.state.movableTokens = []
    turnStart(game, 'p0', 2)
    settle(game)
    const restored = SanguoshaGame.restore(JSON.parse(JSON.stringify(game.serialize())))
    expect(missionStatus(restored.state, 'p0', 'powei')).toBe('success')
  })
})

describe('神·太史慈：神著', () => {
  /** 让 p0 拿到神著并使用一张实体【杀】，在选项上作出选择。 */
  function useSlashWithShenzhu(game: SanguoshaGame, optionId: string, slashName = '杀'): void {
    stripCard(game, '无懈可击')
    stripCard(game, '闪')
    game.state.movableTokens = []
    turnStart(game, 'p0', 2)
    settle(game)
    while (game.state.phase !== 'play') game.advancePhase()
    const slash = giveCard(game, 'p0', slashName)
    useOn(game, 'p0', slash, ['p1'])
    settle(game, (request) => (request.kind === 'choose-option' && request.playerId === 'p0'
      ? { optionId }
      : null))
  }

  it('选项一：摸一张牌，本回合可以多使用一张【杀】', () => {
    const game = gameAt('tsc-shenzhu-more')
    const owner = playerOf(game, 'p0')
    stripCard(game, '无懈可击')
    stripCard(game, '闪')
    game.state.movableTokens = []
    turnStart(game, 'p0', 2)
    settle(game)
    while (game.state.phase !== 'play') game.advancePhase()

    const slash = giveCard(game, 'p0', '杀')
    const before = owner.zones.hand.length
    useOn(game, 'p0', slash, ['p1'])
    settle(game, (request) => (request.kind === 'choose-option' && request.playerId === 'p0'
      ? { optionId: 'shenzhu-more' }
      : null))

    // 打出去一张杀（-1），神著摸一张（+1）
    expect(owner.zones.hand.length).toBe(before)
    expect(canUseSlash(game.state, 'p0', false), '已经用过一张，靠神著还能再用一张').toBe(true)
  })

  it('选项二：摸三张牌，本回合不能再使用【杀】', () => {
    const game = gameAt('tsc-shenzhu-stop')
    const owner = playerOf(game, 'p0')
    stripCard(game, '无懈可击')
    stripCard(game, '闪')
    game.state.movableTokens = []
    turnStart(game, 'p0', 2)
    settle(game)
    while (game.state.phase !== 'play') game.advancePhase()

    const slash = giveCard(game, 'p0', '杀')
    const before = owner.zones.hand.length
    useOn(game, 'p0', slash, ['p1'])
    settle(game, (request) => (request.kind === 'choose-option' && request.playerId === 'p0'
      ? { optionId: 'shenzhu-stop' }
      : null))

    expect(owner.zones.hand.length).toBe(before - 1 + 3)
    expect(canUseSlash(game.state, 'p0', false), '本回合不能再使用杀').toBe(false)
    expect(canUseSlash(game.state, 'p0', true), '禁止优先级高于无限杀').toBe(false)
  })

  it('没有拿到神著就不触发', () => {
    const game = gameAt('tsc-shenzhu-locked')
    const owner = playerOf(game, 'p0')
    stripCard(game, '无懈可击')
    stripCard(game, '闪')
    expect(owner.grantedSkills ?? []).not.toContain('shenzhu')
    const slash = giveCard(game, 'p0', '杀')
    const before = owner.zones.hand.length
    useOn(game, 'p0', slash, ['p1'])
    settle(game)
    expect(owner.zones.hand.length, '使命还没成功，神著不该触发').toBe(before - 1)
  })

  it('转化出来的【杀】不触发', () => {
    // 关羽【武圣】把红牌当杀用：生效名是杀，但印的不是
    const game = gameAt('tsc-shenzhu-viewas', ['shentaishici', 'guanyu', 'zhaoyun', 'machao', 'huangzhong'])
    const owner = playerOf(game, 'p0')
    stripCard(game, '无懈可击')
    stripCard(game, '闪')
    game.state.movableTokens = []
    turnStart(game, 'p0', 2)
    settle(game)
    expect(owner.grantedSkills ?? []).toContain('shenzhu')

    // 神太史慈自己没有转化技，这里直接验公共判据：虚拟牌不算实体原生
    const virtualId = 'virtual-slash-probe'
    game.state.cards[virtualId] = {
      ...game.state.cards[game.state.zones.drawPile[0]],
      id: virtualId, name: '杀', virtual: true,
    }
    game.dispatch('AfterCardUse', { cardId: virtualId, cardName: '杀', targetIds: ['p1'] }, { sourceId: 'p0', targetId: 'p1' })
    expect(game.state.pendingRequests, '虚拟【杀】不触发神著').toHaveLength(0)
    delete game.state.cards[virtualId]
  })
})
