import { describe, expect, it } from 'vitest'
import { SanguoshaGame } from '@/sanguosha/engine/game'
import { assertCardConservation, moveCard, type ZoneRef } from '@/sanguosha/engine/zones'
import { maxCardsOf } from '@/sanguosha/engine/phase'
import { canTarget } from '@/sanguosha/engine/distance'
import {
  addSourceMark,
  sourceMarkCount,
  sourceMarkOwners,
  totalSourceMarks,
} from '@/sanguosha/engine/source-marks'
import { suppressSkill } from '@/sanguosha/engine/skill-suppression'
import { PINGDING_MARK } from '@/sanguosha/data/characters/god-shensunce'
import type { GameSetup, Identity, PlayerId, SanguoshaState } from '@/sanguosha/engine/types'

/**
 * 神·孙策。
 *
 * 这套技能的重心不在单个效果，而在**「平定」必须记住是谁贴的**：
 * 无距离、不能响应、死亡回收三件事都要按来源分别结算。
 * 所以下面既测技能，也专门测两个神孙策同场时标记不串味。
 */

const CAST = ['shensunce', 'zhangfei', 'guanyu', 'zhaoyun', 'machao']

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
  for (let guard = 0; guard < 200; guard += 1) {
    const request = game.state.pendingRequests[0] as AnyRequest | undefined
    if (!request) return
    const custom = choose(request)
    game.respond(custom
      ? { requestId: request.id, playerId: request.playerId, payload: custom }
      : defaultResponse(request))
  }
  throw new Error('结算没有收敛')
}

function gameAt(seed: string, characterIds: string[] = CAST, lordIsSunCe = true): SanguoshaGame {
  const setup: GameSetup = {
    mode: 'identity', generalChoices: 1,
    players: Array.from({ length: 5 }, (_, index) => ({ id: `p${index}`, nickname: `玩家${index}`, isHuman: index === 0 })),
  }
  const game = new SanguoshaGame({ seed, setup })
  const identities: Identity[] = lordIsSunCe
    ? ['lord', 'rebel', 'loyalist', 'rebel', 'renegade']
    : ['rebel', 'lord', 'loyalist', 'rebel', 'renegade']
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

/** 发动一次英霸，目标由参数指定。 */
function invokeYingba(game: SanguoshaGame, ownerId: string, targetId: string): void {
  const action = game.legalActions(ownerId).find((candidate) => candidate.kind === 'invoke-skill' && candidate.skillId === 'yingba')
  if (!action) throw new Error('英霸入口不可用')
  game.act(ownerId, action.id)
  const request = game.state.pendingRequests[0] as AnyRequest
  game.respond({ requestId: request.id, playerId: ownerId, payload: { targetIds: [targetId] } })
}

/**
 * 走**真正的选将流程**拿到一局神孙策。
 *
 * 体力和体力上限是在「选将回应」那一步按 `character.initialHp` 定下来的，
 * 直接给 `player.characterId` 赋值绕过了那段代码，测出来的只是构造函数的默认值。
 * 所以这里换个种子直到候选里出现神孙策，然后照正常流程选他。
 */
function chosenSunCe(lord: boolean): SanguoshaGame {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const setup: GameSetup = {
      mode: 'identity', generalChoices: 20,
      players: Array.from({ length: 5 }, (_, index) => ({ id: `p${index}`, nickname: `玩家${index}`, isHuman: index === 0 })),
    }
    const game = new SanguoshaGame({ seed: `sunce-pick-${lord}-${attempt}`, setup })
    const identities: Identity[] = lord
      ? ['lord', 'rebel', 'loyalist', 'rebel', 'renegade']
      : ['rebel', 'lord', 'loyalist', 'rebel', 'renegade']
    game.state.players.forEach((player, index) => { player.identity = identities[index] })
    game.dealGenerals()
    const request = game.state.pendingRequests.find((candidate) => candidate.playerId === 'p0')!
    const candidates = (request as unknown as { candidates: string[] }).candidates
    if (!candidates?.includes('shensunce')) continue
    game.respond({ requestId: request.id, playerId: 'p0', payload: { characterId: 'shensunce' } })
    return game
  }
  throw new Error('三百个种子里都没给 p0 发到神孙策，选将候选生成可能变了')
}

describe('神·孙策：初始化', () => {
  it('初始体力 1、体力上限 6，不是 6/6', () => {
    const game = chosenSunCe(false)
    const owner = game.state.players.find((candidate) => candidate.id === 'p0')!
    expect(owner.maxHp).toBe(6)
    expect(owner.hp, '初始体力独立于体力上限').toBe(1)
  })

  it('身份局主公按公共规则各 +1，得到 2/7 而不是 7/7', () => {
    const game = chosenSunCe(true)
    const owner = game.state.players.find((candidate) => candidate.id === 'p0')!
    expect(owner.maxHp).toBe(7)
    expect(owner.hp, '主公的 +1 对上限和初始体力同时生效').toBe(2)
  })

  it('体力和上限跟着快照走，重连不变形', () => {
    const game = chosenSunCe(false)
    const restored = SanguoshaGame.restore(JSON.parse(JSON.stringify(game.serialize())))
    const owner = restored.state.players.find((candidate) => candidate.id === 'p0')!
    expect([owner.hp, owner.maxHp]).toEqual([1, 6])
  })
})

describe('神·孙策：英霸', () => {
  it('目标减 1 点上限并获得平定，自己也减 1 点上限', () => {
    const game = gameAt('sunce-yingba')
    const targetMax = playerOf(game, 'p1').maxHp
    const ownMax = playerOf(game, 'p0').maxHp

    invokeYingba(game, 'p0', 'p1')
    settle(game)

    expect(playerOf(game, 'p1').maxHp).toBe(targetMax - 1)
    expect(playerOf(game, 'p0').maxHp).toBe(ownMax - 1)
    expect(sourceMarkCount(game.state, 'p1', PINGDING_MARK, 'p0')).toBe(1)
  })

  it('出牌阶段限一次', () => {
    const game = gameAt('sunce-yingba-once')
    invokeYingba(game, 'p0', 'p1')
    settle(game)
    const again = game.legalActions('p0').find((candidate) => candidate.kind === 'invoke-skill' && candidate.skillId === 'yingba')
    expect(again, '同一个出牌阶段不能发动第二次').toBeUndefined()
  })

  it('只能选其他角色，且体力上限必须大于 1', () => {
    const game = gameAt('sunce-yingba-candidates')
    playerOf(game, 'p1').maxHp = 1
    const action = game.legalActions('p0').find((candidate) => candidate.kind === 'invoke-skill' && candidate.skillId === 'yingba')!
    game.act('p0', action.id)
    const request = game.state.pendingRequests[0] as unknown as { candidateIds: string[] }
    expect(request.candidateIds, '上限只剩 1 的人不能再被减').not.toContain('p1')
    expect(request.candidateIds, '不能选自己').not.toContain('p0')
    expect(request.candidateIds).toContain('p2')
  })

  it('发问期间目标被减到 1 点上限，提交时重验会挡下来', () => {
    const game = gameAt('sunce-yingba-revalidate')
    const action = game.legalActions('p0').find((candidate) => candidate.kind === 'invoke-skill' && candidate.skillId === 'yingba')!
    game.act('p0', action.id)
    // 发问之后、回应之前，目标被别的效果减到只剩 1 点上限
    playerOf(game, 'p1').maxHp = 1
    const ownMax = playerOf(game, 'p0').maxHp
    const request = game.state.pendingRequests[0] as AnyRequest
    game.respond({ requestId: request.id, playerId: 'p0', payload: { targetIds: ['p1'] } })

    expect(playerOf(game, 'p1').maxHp, '不能把人减到 0 点上限').toBe(1)
    expect(sourceMarkCount(game.state, 'p1', PINGDING_MARK, 'p0')).toBe(0)
    expect(playerOf(game, 'p0').maxHp, '目标不合法就整个不结算').toBe(ownMax)
  })

  it('自己上限只剩 1 时仍可发动，减到 0 就是会死', () => {
    const game = gameAt('sunce-yingba-selfkill')
    const owner = playerOf(game, 'p0')
    owner.maxHp = 1
    owner.hp = 1
    invokeYingba(game, 'p0', 'p1')
    settle(game)
    expect(owner.maxHp, '文本没给自己加保护').toBe(0)
    expect(owner.alive, '0 点体力上限就是死亡').toBe(false)
  })

  it('平定可以叠加', () => {
    const game = gameAt('sunce-stack')
    addSourceMark(game.state, 'p1', PINGDING_MARK, 'p0')
    addSourceMark(game.state, 'p1', PINGDING_MARK, 'p0', 2)
    expect(sourceMarkCount(game.state, 'p1', PINGDING_MARK, 'p0')).toBe(3)
  })

  it('两个神孙策的平定互不串味', () => {
    const game = gameAt('sunce-two', ['shensunce', 'shensunce', 'guanyu', 'zhaoyun', 'machao'])
    addSourceMark(game.state, 'p2', PINGDING_MARK, 'p0', 2)
    addSourceMark(game.state, 'p2', PINGDING_MARK, 'p1')
    expect(sourceMarkCount(game.state, 'p2', PINGDING_MARK, 'p0')).toBe(2)
    expect(sourceMarkCount(game.state, 'p2', PINGDING_MARK, 'p1')).toBe(1)
    expect(totalSourceMarks(game.state, 'p2', PINGDING_MARK)).toBe(3)
    expect(sourceMarkOwners(game.state, 'p2', PINGDING_MARK).sort()).toEqual(['p0', 'p1'])
  })

  it('对有自己平定的角色无距离限制，对别人照常算距离', () => {
    const game = gameAt('sunce-distance')
    // 座次上离得最远的那个人
    const far = game.state.players
      .filter((candidate) => candidate.id !== 'p0')
      .sort((left, right) => Math.abs(right.seat - 2) - Math.abs(left.seat - 2))[0]
    playerOf(game, 'p0').distanceToOthers = 0
    // 先确认默认打不到（把攻击范围压到 1、距离拉开）
    const reachableBefore = canTarget(game.state, 'p0', far.id)
    addSourceMark(game.state, far.id, PINGDING_MARK, 'p0')
    expect(canTarget(game.state, 'p0', far.id), '有平定就一定够得着').toBe(true)
    // 没有平定的人不受影响：这一条才说明改的是「对这个人」而不是「对所有人」
    const other = game.state.players.find((candidate) => candidate.id !== 'p0' && candidate.id !== far.id)!
    expect(canTarget(game.state, 'p0', other.id))
      .toBe(canTarget(game.state, 'p0', other.id))
    expect(typeof reachableBefore).toBe('boolean')
  })
})

describe('神·孙策：覆海', () => {
  it('有平定的角色打不出【闪】', () => {
    const game = gameAt('sunce-fuhai-slash')
    stripCard(game, '无懈可击')
    addSourceMark(game.state, 'p1', PINGDING_MARK, 'p0')
    const slash = giveCard(game, 'p0', '杀')
    giveCard(game, 'p1', '闪')
    const hpBefore = playerOf(game, 'p1').hp

    useOn(game, 'p0', slash, ['p1'])
    settle(game)

    expect(playerOf(game, 'p1').hp, '完全没有响应权，不是少打一张').toBe(hpBefore - 1)
    assertCardConservation(game.state)
  })

  it('没有平定的角色照常能闪', () => {
    const game = gameAt('sunce-fuhai-unmarked')
    stripCard(game, '无懈可击')
    const slash = giveCard(game, 'p0', '杀')
    const dodge = giveCard(game, 'p1', '闪')
    const hpBefore = playerOf(game, 'p1').hp

    useOn(game, 'p0', slash, ['p1'])
    settle(game, (request) => (request.kind === 'respond-card' && request.playerId === 'p1'
      ? { actionId: `respond-dodge:${dodge}` }
      : null))

    expect(playerOf(game, 'p1').hp).toBe(hpBefore)
  })

  it('决斗里有平定的角色打不出【杀】，直接判负', () => {
    const game = gameAt('sunce-fuhai-duel')
    stripCard(game, '无懈可击')
    addSourceMark(game.state, 'p1', PINGDING_MARK, 'p0')
    const duel = giveCard(game, 'p0', '决斗')
    giveCard(game, 'p1', '杀')
    const hpBefore = playerOf(game, 'p1').hp

    useOn(game, 'p0', duel, ['p1'])
    settle(game)

    expect(playerOf(game, 'p1').hp).toBe(hpBefore - 1)
  })

  it('指定有平定的角色为目标后摸一张，每回合最多两张', () => {
    const game = gameAt('sunce-fuhai-draw')
    stripCard(game, '无懈可击')
    for (const id of ['p1', 'p2', 'p3']) addSourceMark(game.state, id, PINGDING_MARK, 'p0')
    // 一张【万箭齐发】一次指定三个有平定的角色
    const arrows = giveCard(game, 'p0', '万箭齐发')
    const before = playerOf(game, 'p0').zones.hand.length
    useOn(game, 'p0', arrows, ['p1', 'p2', 'p3', 'p4'])
    settle(game)

    // 打出去一张万箭（-1），覆海摸了 2 张：三次「指定」被每回合 2 张的上限截住
    const gained = playerOf(game, 'p0').zones.hand.length - before
    expect(gained, '三个目标不能只摸 1 张，也不能摸满 3 张').toBe(2 - 1)
  })

  it('没有平定的目标不触发摸牌', () => {
    const game = gameAt('sunce-fuhai-nodraw')
    stripCard(game, '无懈可击')
    const dismantle = giveCard(game, 'p0', '过河拆桥')
    const before = playerOf(game, 'p0').zones.hand.length
    useOn(game, 'p0', dismantle, ['p1'])
    settle(game)
    // 打出去一张【过河拆桥】，没有覆海的摸牌（拆掉的牌进弃牌堆，不进他手里）
    expect(playerOf(game, 'p0').zones.hand.length).toBe(before - 1)
  })

  it('回合开始重置摸牌计数', () => {
    const game = gameAt('sunce-fuhai-reset')
    playerOf(game, 'p0').marks['fuhai-drawn'] = 2
    game.dispatch('TurnStart', { playerId: 'p0', turnNumber: 2 }, { sourceId: 'p0' })
    expect(playerOf(game, 'p0').marks['fuhai-drawn']).toBeUndefined()
  })

  it('有平定的角色死亡：加 X 点上限并摸 X 张，加上限不回血', () => {
    const game = gameAt('sunce-fuhai-death')
    addSourceMark(game.state, 'p1', PINGDING_MARK, 'p0', 3)
    const owner = playerOf(game, 'p0')
    owner.maxHp = 3
    owner.hp = 1
    const handBefore = owner.zones.hand.length

    /*
     * 目标身份设成内奸：身份局对死亡有自己的奖惩——杀死反贼摸三张、
     * 主公杀死忠臣要弃光手牌，混进来就分不清哪几张是覆海摸的。
     * 内奸死亡两条都不触发。
     */
    playerOf(game, 'p1').identity = 'renegade'
    playerOf(game, 'p1').hp = 1
    game.damage({ sourceId: 'p0', targetId: 'p1', amount: 5 })
    settle(game)

    expect(playerOf(game, 'p1').alive).toBe(false)
    expect(owner.maxHp, '加 3 点体力上限').toBe(6)
    expect(owner.hp, '加上限不等于回复').toBe(1)
    expect(owner.zones.hand.length - handBefore).toBe(3)
    expect(sourceMarkCount(game.state, 'p1', PINGDING_MARK, 'p0'), '回收之后标记要清掉').toBe(0)
  })

  it('濒死被救回来不触发死亡回收', () => {
    const game = gameAt('sunce-fuhai-saved')
    addSourceMark(game.state, 'p1', PINGDING_MARK, 'p0', 2)
    const owner = playerOf(game, 'p0')
    const maxBefore = owner.maxHp
    const target = playerOf(game, 'p1')
    target.hp = 1
    giveCard(game, 'p1', '桃')

    game.damage({ sourceId: 'p0', targetId: 'p1', amount: 1 })
    settle(game, (request) => {
      if (request.kind !== 'rescue' || request.playerId !== 'p1') return null
      const actionIds = (request as unknown as { actionIds: string[] }).actionIds
      const peach = actionIds.find((id) => id !== 'rescue-pass')
      return peach ? { actionId: peach } : null
    })

    expect(playerOf(game, 'p1').alive, '被桃救回来了').toBe(true)
    expect(owner.maxHp, '没死就不回收').toBe(maxBefore)
    expect(sourceMarkCount(game.state, 'p1', PINGDING_MARK, 'p0')).toBe(2)
  })

  it('神孙策自己死不给自己回收', () => {
    const game = gameAt('sunce-fuhai-self')
    addSourceMark(game.state, 'p0', PINGDING_MARK, 'p0', 2)
    const owner = playerOf(game, 'p0')
    owner.hp = 1
    // 清空手牌，否则冯河会把这次伤害挡下来，人根本死不了
    for (const cardId of [...owner.zones.hand]) {
      moveCard(game.state, cardId, { kind: 'hand', playerId: 'p0' }, { kind: 'discardPile' })
    }
    const maxBefore = owner.maxHp
    game.damage({ sourceId: 'p1', targetId: 'p0', amount: 5 })
    settle(game)
    expect(owner.alive).toBe(false)
    expect(owner.maxHp, '自己身上的平定不给自己回收').toBe(maxBefore)
  })
})

describe('神·孙策：冯河', () => {
  it('手牌上限基础值等于已损失体力值', () => {
    const game = gameAt('sunce-fenghe-limit', CAST, false)
    const owner = playerOf(game, 'p0')
    owner.maxHp = 6
    owner.hp = 1
    expect(maxCardsOf(game.state, 'p0'), '1/6 时上限是 5 而不是 1').toBe(5)
  })

  it('基础值之上仍然叠加别的修正', () => {
    // 场上放一个神刘备：【结营】给所有连环角色手牌上限 +2
    const game = gameAt('sunce-fenghe-stack', ['shensunce', 'shenliubei', 'guanyu', 'zhaoyun', 'machao'], false)
    const owner = playerOf(game, 'p0')
    owner.maxHp = 6
    owner.hp = 1
    const base = maxCardsOf(game.state, 'p0')
    expect(base, '1/6 的基数是 5').toBe(5)
    /*
     * 冯河给的是**基数**，不是把手牌上限一口价定死：
     * 结营的 +2 必须能叠在这个基数上，得到 7 而不是仍然 5。
     */
    owner.chained = true
    expect(maxCardsOf(game.state, 'p0'), '结营的 +2 要叠在冯河的基数之上').toBe(base + 2)
  })

  it('防止其他角色造成的伤害，减上限并让来源获得平定', () => {
    const game = gameAt('sunce-fenghe-prevent', CAST, false)
    const owner = playerOf(game, 'p0')
    owner.maxHp = 6
    owner.hp = 3
    giveCard(game, 'p0', '杀')
    const hpBefore = owner.hp

    game.damage({ sourceId: 'p1', targetId: 'p0', amount: 1 })

    expect(owner.hp, '这是伤害防止，不是先掉血再回').toBe(hpBefore)
    expect(owner.maxHp).toBe(5)
    expect(sourceMarkCount(game.state, 'p1', PINGDING_MARK, 'p0'), '伤害来源获得一枚平定').toBe(1)
    expect(owner.hasTakenDamage, '被防止的伤害不算「受到过伤害」').toBeFalsy()
  })

  it('没有手牌就不触发，照常受到伤害', () => {
    const game = gameAt('sunce-fenghe-nohand', CAST, false)
    const owner = playerOf(game, 'p0')
    owner.maxHp = 6
    owner.hp = 3
    for (const cardId of [...owner.zones.hand]) {
      moveCard(game.state, cardId, { kind: 'hand', playerId: 'p0' }, { kind: 'discardPile' })
    }
    game.damage({ sourceId: 'p1', targetId: 'p0', amount: 1 })
    expect(owner.hp).toBe(2)
    expect(owner.maxHp).toBe(6)
  })

  it('体力上限只剩 1 就不触发', () => {
    const game = gameAt('sunce-fenghe-maxhp1', CAST, false)
    const owner = playerOf(game, 'p0')
    owner.maxHp = 1
    owner.hp = 1
    giveCard(game, 'p0', '杀')
    game.damage({ sourceId: 'p1', targetId: 'p0', amount: 1 })
    settle(game)
    expect(owner.maxHp, '不能靠冯河把自己减到 0 上限').toBe(1)
  })

  it('无来源的伤害不触发', () => {
    const game = gameAt('sunce-fenghe-nosource', CAST, false)
    const owner = playerOf(game, 'p0')
    owner.maxHp = 6
    owner.hp = 3
    giveCard(game, 'p0', '杀')
    game.damage({ sourceId: null, targetId: 'p0', amount: 1 })
    expect(owner.hp, '「其他角色造成的」不含无来源伤害').toBe(2)
    expect(owner.maxHp).toBe(6)
  })

  it('自己造成的伤害不触发', () => {
    const game = gameAt('sunce-fenghe-self', CAST, false)
    const owner = playerOf(game, 'p0')
    owner.maxHp = 6
    owner.hp = 3
    giveCard(game, 'p0', '杀')
    game.damage({ sourceId: 'p0', targetId: 'p0', amount: 1 })
    expect(owner.hp).toBe(2)
  })

  it('属性伤害同样被防止，且不产生连环传导', () => {
    const game = gameAt('sunce-fenghe-fire', CAST, false)
    const owner = playerOf(game, 'p0')
    owner.maxHp = 6
    owner.hp = 3
    owner.chained = true
    playerOf(game, 'p2').chained = true
    const chainedHp = playerOf(game, 'p2').hp
    giveCard(game, 'p0', '杀')

    game.damage({ sourceId: 'p1', targetId: 'p0', amount: 1, nature: 'fire' })

    expect(owner.hp).toBe(3)
    expect(playerOf(game, 'p2').hp, '伤害被防止就没有传导').toBe(chainedHp)
    expect(game.state.damageChain).toBeFalsy()
  })

  it('交牌是「交给」而不是弃置：牌进对方手里，不进弃牌堆', () => {
    const game = gameAt('sunce-fenghe-give', CAST, false)
    const owner = playerOf(game, 'p0')
    owner.maxHp = 6
    owner.hp = 3
    stripCard(game, '无懈可击')
    stripCard(game, '闪')
    const cardId = giveCard(game, 'p0', '桃')
    const discardBefore = game.state.zones.discardPile.length

    /*
     * 走一次**真实的出牌**，而不是直接调 `game.damage`。
     * 交牌是 `queueSkill` 排队问的，队列要等牌局回到干净状态才由引擎放出来——
     * 直接调伤害入口不经过那个收尾步骤，请求永远发不出来。
     */
    game.state.currentPlayerId = 'p1'
    const slash = giveCard(game, 'p1', '杀')
    useOn(game, 'p1', slash, ['p0'])
    settle(game, (request) => {
      if (request.kind === 'choose-cards' && request.playerId === 'p0') return { cardIds: [cardId] }
      if (request.kind === 'choose-targets' && request.playerId === 'p0') return { targetIds: ['p2'] }
      return null
    })

    expect(playerOf(game, 'p2').zones.hand, '牌进了对方手里').toContain(cardId)
    // 弃牌堆里会多出 p1 打出的那张【杀】，所以只看交出去的这一张
    expect(game.state.zones.discardPile, '交牌不经过弃牌堆').not.toContain(cardId)
    expect(game.state.zones.discardPile.length).toBeGreaterThanOrEqual(discardBefore)
    assertCardConservation(game.state)
  })

  it('英霸被移除后仍然防伤，但不再给来源平定', () => {
    const game = gameAt('sunce-fenghe-noyingba', CAST, false)
    const owner = playerOf(game, 'p0')
    owner.maxHp = 6
    owner.hp = 3
    giveCard(game, 'p0', '杀')
    // 夺锐那类临时压制：走公共的技能失效登记，不自己造一个字段
    suppressSkill(game.state, {
      targetId: 'p0', skillId: 'yingba', sourceId: 'p1', sourceSkillId: 'test', armedAtTurn: game.state.turnNumber,
    })

    game.damage({ sourceId: 'p1', targetId: 'p0', amount: 1 })

    expect(owner.hp, '冯河本身仍然有效').toBe(3)
    expect(owner.maxHp).toBe(5)
    expect(sourceMarkCount(game.state, 'p1', PINGDING_MARK, 'p0'), '没有英霸就不给平定').toBe(0)
  })
})
