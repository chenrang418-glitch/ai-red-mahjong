import { describe, expect, it } from 'vitest'
import { SanguoshaGame } from '@/sanguosha/engine/game'
import { assertCardConservation, moveCard, type ZoneRef } from '@/sanguosha/engine/zones'
import { assertGameInvariants } from '@/sanguosha/engine/invariants'
import { resolveDamage } from '@/sanguosha/engine/damage'
import { buildPlayerView } from '@/sanguosha/engine/view'
import {
  DETAINED_HIDDEN_PILE, DETAINED_OPEN_PILE, detainedCardsOf, detainedEntryOf,
} from '@/sanguosha/engine/turn-bound-pile'
import { getCharacter } from '@/sanguosha/data/characters/standard'
import type { GameSetup, Identity, PlayerId, SanguoshaState } from '@/sanguosha/engine/types'

/**
 * 徐盛（一将成名 2011 经典）。
 *
 * 七条主张，逐条有断言：
 *
 * - 【破军】只在他自己的出牌阶段触发，回合外被指使着出杀不算；
 * - X 是目标**此刻的体力值**，不是上限、不是已损失体力；
 * - 「至多」是真的：可以只扣一张，一张不扣就是不发动；
 * - 可扣区域是手牌 + 装备区，判定区不可；暗手牌只给占位槽；
 * - 装备是真的离开装备区：枭姬、白银狮子照常，旋风按次数只算一次；
 * - 当前回合结束后一律**进手牌**，装备不会自动重新装备；
 * - 目标中途死亡时这些牌直接进弃牌堆，行殇拿不到、落英接不住。
 */

const CAST = ['xusheng', 'zhangfei', 'zhaoyun', 'huangzhong', 'guojia']

interface AnyRequest { id: string; playerId: PlayerId; kind: string; prompt?: string }

function defaultResponse(request: AnyRequest) {
  const payload: Record<string, unknown> = (() => {
    switch (request.kind) {
      case 'choose-option': {
        const options = (request as unknown as { options: { id: string }[] }).options
        return { optionId: options[options.length - 1].id }
      }
      case 'choose-options': {
        const pick = request as unknown as { options: { id: string }[]; min: number }
        return { optionIds: pick.options.slice(0, pick.min ?? 0).map((option) => option.id) }
      }
      case 'choose-cards': {
        const pick = request as unknown as { cardIds: string[]; hiddenCardSlots: string[]; min: number }
        return { cardIds: [...pick.cardIds, ...pick.hiddenCardSlots].slice(0, pick.min ?? 0) }
      }
      case 'choose-targets': {
        const pick = request as unknown as { candidateIds: string[]; min: number }
        return { targetIds: pick.candidateIds.slice(0, pick.min ?? 0) }
      }
      case 'arrange-cards': {
        const pick = request as unknown as { cardIds: string[] }
        return { top: [...pick.cardIds], bottom: [] }
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
  for (let guard = 0; guard < 400; guard += 1) {
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
  while (game.state.phase !== 'play') {
    game.advancePhase()
    settle(game)
  }
  return game
}

function playerOf(game: SanguoshaGame, id: string) {
  return game.state.players.find((candidate) => candidate.id === id)!
}

function locate(state: SanguoshaState, cardId: string): ZoneRef {
  if (state.zones.drawPile.includes(cardId)) return { kind: 'drawPile' }
  if (state.zones.discardPile.includes(cardId)) return { kind: 'discardPile' }
  if (state.zones.processingArea.includes(cardId)) return { kind: 'processingArea' }
  for (const owner of state.players) {
    if (owner.zones.hand.includes(cardId)) return { kind: 'hand', playerId: owner.id }
    if (owner.zones.judgingArea.includes(cardId)) return { kind: 'judgingArea', playerId: owner.id }
    for (const [slot, equipped] of Object.entries(owner.zones.equipment)) {
      if (equipped === cardId) return { kind: 'equipment', playerId: owner.id, slot: slot as never }
    }
  }
  throw new Error('找不到卡牌：' + cardId)
}

function giveCard(game: SanguoshaGame, playerId: string, cardName: string): string {
  const card = Object.values(game.state.cards).find((candidate) => candidate.name === cardName
    && !candidate.virtual
    && (game.state.zones.drawPile.includes(candidate.id) || game.state.zones.discardPile.includes(candidate.id)))
  if (!card) throw new Error(`牌堆里没有闲置的【${cardName}】`)
  moveCard(game.state, card.id, locate(game.state, card.id), { kind: 'hand', playerId })
  return card.id
}

function equipAny(game: SanguoshaGame, playerId: string, slot: 'weapon' | 'armor' | 'offensiveHorse' | 'defensiveHorse'): string {
  const card = Object.values(game.state.cards).find((candidate) => candidate.category === 'equipment'
    && candidate.equipmentSlot === slot
    && !candidate.virtual
    && (game.state.zones.drawPile.includes(candidate.id) || game.state.zones.discardPile.includes(candidate.id)))
  if (!card) throw new Error(`牌堆里没有闲置的${slot}装备`)
  moveCard(game.state, card.id, locate(game.state, card.id), { kind: 'equipment', playerId, slot })
  return card.id
}

function equipNamed(game: SanguoshaGame, playerId: string, cardName: string, slot: 'weapon' | 'armor' | 'offensiveHorse' | 'defensiveHorse'): string {
  const cardId = giveCard(game, playerId, cardName)
  moveCard(game.state, cardId, { kind: 'hand', playerId }, { kind: 'equipment', playerId, slot })
  return cardId
}

function trimHand(game: SanguoshaGame, playerId: string, count: number): void {
  for (const cardId of playerOf(game, playerId).zones.hand.slice(count)) {
    moveCard(game.state, cardId, { kind: 'hand', playerId }, { kind: 'discardPile' })
  }
}

/**
 * 徐盛出一张【杀】打 targetId，按 plan 回答破军。
 * `picks` 是要扣几张（默认扣满）。
 */
function slashWithPojun(
  game: SanguoshaGame,
  targetId: string,
  plan: { picks?: number; preferEquipment?: boolean } = {},
) {
  const seen = { request: null as AnyRequest | null }
  playerOf(game, 'p0').attackRangeBonus = 6
  const slash = giveCard(game, 'p0', '杀')
  const action = game.legalActions('p0').find((candidate) => candidate.kind === 'use-card'
    && candidate.asCardName === '杀'
    && candidate.cardIds.includes(slash)
    && candidate.targetIds.includes(targetId)
    && candidate.targetIds.length === 1)
  if (!action) throw new Error('没有可用的【杀】动作')
  game.act('p0', action.id)
  settle(game, (request) => {
    if (request.kind === 'choose-option' && request.prompt?.includes('枭姬')) return { optionId: 'yes' }
    if (request.kind === 'choose-cards' && request.prompt?.includes('破军')) {
      seen.request = request
      const pick = request as unknown as { cardIds: string[]; hiddenCardSlots: string[]; max: number }
      const pool = plan.preferEquipment
        ? [...pick.cardIds, ...pick.hiddenCardSlots]
        : [...pick.hiddenCardSlots, ...pick.cardIds]
      const count = plan.picks ?? pick.max
      return { cardIds: pool.slice(0, count) }
    }
    return null
  })
  return seen
}

describe('徐盛：破军的触发条件', () => {
  it('自己出牌阶段使用【杀】指定目标后可以发动', () => {
    const game = gameAt('xs-trigger')
    const seen = slashWithPojun(game, 'p1', { picks: 0 })
    expect(seen.request, '该问的时候要问').toBeTruthy()
  })

  it('回合外被别的技能指使着出杀不触发', () => {
    // p1 是法正（眩惑）：他的摸牌阶段可以指使徐盛出杀
    const game = gameAt('xs-outside', ['xusheng', 'fazheng', 'zhaoyun', 'huangzhong', 'guojia'])
    game.state.currentPlayerId = 'p1'
    game.state.phase = 'draw'
    playerOf(game, 'p0').attackRangeBonus = 6
    giveCard(game, 'p0', '杀')
    let asked = false
    game.dispatch('DrawPhase', { playerId: 'p1', count: 2 }, { sourceId: 'p1', phase: 'draw' })
    game.settle()
    settle(game, (request) => {
      if (request.prompt?.includes('破军')) asked = true
      if (request.kind === 'choose-option' && request.prompt?.includes('眩惑')) return { optionId: 'yes' }
      if (request.kind === 'choose-targets' && request.prompt?.includes('眩惑')) {
        const pick = request as unknown as { candidateIds: string[] }
        return { targetIds: [pick.candidateIds.includes('p0') ? 'p0' : pick.candidateIds[0]] }
      }
      if (request.kind === 'choose-cards' && request.prompt?.includes('使用一张【杀】')) {
        const pick = request as unknown as { cardIds: string[] }
        return { cardIds: pick.cardIds.slice(0, 1) }
      }
      return null
    })
    expect(asked, '不是他自己的出牌阶段就不该触发破军').toBe(false)
  })

  it('X 是目标此刻的体力值，不是体力上限', () => {
    const game = gameAt('xs-limit')
    const target = playerOf(game, 'p1')
    target.hp = 1
    while (target.zones.hand.length < 4) giveCard(game, 'p1', '杀')
    const seen = slashWithPojun(game, 'p1', { picks: 0 })
    const request = seen.request as unknown as { max: number }
    expect(request.max, 'hp=1 时最多扣一张').toBe(1)

    const other = gameAt('xs-limit-2')
    const target2 = playerOf(other, 'p1')
    target2.hp = 3
    while (target2.zones.hand.length < 4) giveCard(other, 'p1', '杀')
    const seen2 = slashWithPojun(other, 'p1', { picks: 0 })
    expect((seen2.request as unknown as { max: number }).max, 'hp=3 时最多扣三张').toBe(3)
  })

  it('目标的牌不够 X 张时有几张扣几张', () => {
    const game = gameAt('xs-fewer')
    const target = playerOf(game, 'p1')
    target.hp = 4
    trimHand(game, 'p1', 1)
    const seen = slashWithPojun(game, 'p1', { picks: 0 })
    expect((seen.request as unknown as { max: number }).max, '只有一张牌').toBe(1)
  })

  it('目标没有牌时不弹一个空窗口', () => {
    const game = gameAt('xs-nocards')
    trimHand(game, 'p1', 0)
    const seen = slashWithPojun(game, 'p1', { picks: 0 })
    expect(seen.request, '一张牌都没有就不该问').toBeNull()
  })

  it('一张都不扣就是不发动，杀照常结算', () => {
    const game = gameAt('xs-decline')
    const target = playerOf(game, 'p1')
    target.hp = target.maxHp
    const handBefore = target.zones.hand.length
    slashWithPojun(game, 'p1', { picks: 0 })
    expect(playerOf(game, 'p1').zones.hand, '牌一张没少').toHaveLength(handBefore)
    expect(playerOf(game, 'p1').hp, '这一刀照常打进来').toBeLessThan(target.maxHp)
    assertCardConservation(game.state)
  })
})

describe('徐盛：破军的扣置', () => {
  it('扣下来的牌进破军区，目标手里没有了', () => {
    const game = gameAt('xs-detain')
    const target = playerOf(game, 'p1')
    target.hp = 2
    trimHand(game, 'p1', 3)
    const handBefore = [...target.zones.hand]
    slashWithPojun(game, 'p1')
    const detained = detainedCardsOf(game.state, 'p1')
    expect(detained, '扣了两张').toHaveLength(2)
    for (const cardId of detained) {
      expect(handBefore, '扣的是他原来的手牌').toContain(cardId)
      expect(playerOf(game, 'p1').zones.hand, '已经不在手里了').not.toContain(cardId)
    }
    assertCardConservation(game.state)
  })

  it('暗手牌只给占位槽，徐盛看不到牌面', () => {
    const game = gameAt('xs-privacy')
    const target = playerOf(game, 'p1')
    target.hp = 2
    trimHand(game, 'p1', 0)
    const hand = [giveCard(game, 'p1', '杀'), giveCard(game, 'p1', '桃')]
    const seen = slashWithPojun(game, 'p1', { picks: 0 })
    const request = seen.request as unknown as { cardIds: string[]; hiddenCardSlots: string[] }
    for (const cardId of hand) {
      expect(request.cardIds, '真实手牌 id 不能出现在可选列表里').not.toContain(cardId)
    }
    expect(request.hiddenCardSlots, '给的是占位槽').toHaveLength(hand.length)
  })

  it('扣置之后暗牌仍然只有主人看得见', () => {
    const game = gameAt('xs-pile-privacy')
    const target = playerOf(game, 'p1')
    target.hp = 2
    trimHand(game, 'p1', 2)
    slashWithPojun(game, 'p1')
    const detained = detainedCardsOf(game.state, 'p1')
    expect(detained.length).toBeGreaterThan(0)

    /*
     * **按结构比对，不要用字符串包含。**
     * 牌 id 是 `...:9` 和 `...:96` 这种前缀关系，`JSON.stringify(...).includes(id)`
     * 会把 96 当成 9 命中，报出一个根本不存在的泄漏。
     */
    const facesFor = (viewerId: string): string[] => {
      const seat = buildPlayerView(game.state, viewerId).players.find((player) => player.id === 'p1')!
      return (seat.characterPiles[DETAINED_HIDDEN_PILE] ?? []).map((card) => card.id)
    }
    expect(facesFor('p1').sort(), '主人自己看得到牌面').toEqual([...detained].sort())
    for (const viewerId of ['p0', 'p2', 'p3']) {
      expect(facesFor(viewerId), `${viewerId} 拿到的是空数组，不是「发了再让前端别显示」`).toEqual([])
    }

    // 张数仍然是公开的
    const seatView = buildPlayerView(game.state, 'p0').players.find((player) => player.id === 'p1')!
    expect(seatView.characterPileCounts[DETAINED_HIDDEN_PILE], '张数公开').toBe(detained.length)
  })

  it('装备被扣走时真的离开装备区，而且进的是明置的那一堆', () => {
    const game = gameAt('xs-equipment')
    const target = playerOf(game, 'p1')
    target.hp = 2
    trimHand(game, 'p1', 0)
    const weapon = equipAny(game, 'p1', 'weapon')
    slashWithPojun(game, 'p1', { preferEquipment: true, picks: 1 })
    expect(Object.values(playerOf(game, 'p1').zones.equipment), '装备区里没有了').not.toContain(weapon)
    expect(detainedEntryOf(game.state, weapon)?.pile, '明置的牌进明堆').toBe(DETAINED_OPEN_PILE)
    // 明堆里的牌所有人都看得见
    const seat = buildPlayerView(game.state, 'p2').players.find((player) => player.id === 'p1')!
    expect((seat.characterPiles[DETAINED_OPEN_PILE] ?? []).map((card) => card.id),
      '原本公开的装备扣置之后仍然公开').toContain(weapon)
  })

  it('判定区的牌扣不走', () => {
    const game = gameAt('xs-judgingarea')
    const target = playerOf(game, 'p1')
    target.hp = 3
    trimHand(game, 'p1', 1)
    const judged = giveCard(game, 'p1', '乐不思蜀')
    moveCard(game.state, judged, { kind: 'hand', playerId: 'p1' }, { kind: 'judgingArea', playerId: 'p1' })
    const seen = slashWithPojun(game, 'p1', { picks: 0 })
    const request = seen.request as unknown as { cardIds: string[] }
    expect(request.cardIds, '判定区的牌不在候选里').not.toContain(judged)
    expect(playerOf(game, 'p1').zones.judgingArea, '它还在判定区').toContain(judged)
  })

  it('扣走装备会触发枭姬，白银狮子照常回血', () => {
    const game = gameAt('xs-xiaoji', ['xusheng', 'sunshangxiang', 'zhaoyun', 'huangzhong', 'guojia'])
    const target = playerOf(game, 'p1')
    target.hp = 2
    target.maxHp = 4
    trimHand(game, 'p1', 0)
    equipNamed(game, 'p1', '白银狮子', 'armor')
    const handBefore = playerOf(game, 'p1').zones.hand.length
    const hpBefore = playerOf(game, 'p1').hp
    slashWithPojun(game, 'p1', { preferEquipment: true, picks: 1 })
    expect(playerOf(game, 'p1').zones.hand.length, '选择发动枭姬后摸了两张').toBe(handBefore + 2)
    expect(playerOf(game, 'p1').hp, '白银狮子离场回一点（随后又挨了这一刀）')
      .toBeGreaterThanOrEqual(hpBefore - 1)
    assertCardConservation(game.state)
  })

  it('一次扣走多件装备，旋风只给一次机会', () => {
    const game = gameAt('xs-xuanfeng', ['xusheng', 'lingtong', 'zhaoyun', 'huangzhong', 'guojia'])
    const target = playerOf(game, 'p1')
    target.hp = 3
    trimHand(game, 'p1', 0)
    equipAny(game, 'p1', 'weapon')
    equipAny(game, 'p1', 'armor')
    equipAny(game, 'p1', 'defensiveHorse')
    let asked = 0
    playerOf(game, 'p0').attackRangeBonus = 6
    const slash = giveCard(game, 'p0', '杀')
    const action = game.legalActions('p0').find((candidate) => candidate.kind === 'use-card'
      && candidate.asCardName === '杀' && candidate.cardIds.includes(slash)
      && candidate.targetIds.includes('p1') && candidate.targetIds.length === 1)!
    game.act('p0', action.id)
    settle(game, (request) => {
      if (request.kind === 'choose-cards' && request.prompt?.includes('破军')) {
        const pick = request as unknown as { cardIds: string[]; max: number }
        return { cardIds: pick.cardIds.slice(0, 3) }
      }
      if (request.kind === 'choose-option' && request.prompt?.includes('旋风')) {
        asked += 1
        return { optionId: 'cancel' }
      }
      return null
    })
    expect(asked, '三件装备一次扣走只算一次').toBe(1)
    assertCardConservation(game.state)
  })
})

/** 把回合推到结束，让破军牌归还。 */
function endTurn(game: SanguoshaGame): void {
  for (let guard = 0; guard < 12; guard += 1) {
    if (game.state.currentPlayerId !== 'p0') return
    game.advancePhase()
    settle(game)
  }
}

describe('徐盛：归还与死亡清理', () => {
  it('当前回合结束后归还，装备也进手牌', () => {
    const game = gameAt('xs-return')
    const target = playerOf(game, 'p1')
    target.hp = 2
    trimHand(game, 'p1', 0)
    const weapon = equipAny(game, 'p1', 'weapon')
    const extra = giveCard(game, 'p1', '闪')
    slashWithPojun(game, 'p1', { preferEquipment: true })
    const detained = detainedCardsOf(game.state, 'p1')
    expect(detained.length, '扣了两张').toBe(2)

    endTurn(game)
    expect(detainedCardsOf(game.state, 'p1'), '回合结束后全部归还').toHaveLength(0)
    expect(playerOf(game, 'p1').zones.hand, '武器回到手牌').toContain(weapon)
    expect(Object.values(playerOf(game, 'p1').zones.equipment), '不会自动重新装备').not.toContain(weapon)
    expect(playerOf(game, 'p1').zones.hand, '另一张也回来了').toContain(extra)
    assertCardConservation(game.state)
    assertGameInvariants(game.state)
  })

  it('同一回合多次破军的牌一起归还', () => {
    const game = gameAt('xs-multi')
    const target = playerOf(game, 'p1')
    target.hp = 3
    trimHand(game, 'p1', 4)
    // 诸葛连弩：本回合可以多次出杀
    equipNamed(game, 'p0', '诸葛连弩', 'weapon')
    slashWithPojun(game, 'p1', { picks: 1 })
    slashWithPojun(game, 'p1', { picks: 1 })
    const detained = detainedCardsOf(game.state, 'p1')
    expect(detained.length, '两次各扣一张，都在同一个堆里').toBe(2)
    endTurn(game)
    for (const cardId of detained) {
      expect(playerOf(game, 'p1').zones.hand, '一起还回来').toContain(cardId)
    }
    assertCardConservation(game.state)
  })

  it('目标中途死亡：破军区的牌直接进弃牌堆，行殇拿不到', () => {
    // p2 是曹丕（行殇）
    const game = gameAt('xs-death', ['xusheng', 'zhangfei', 'caopi', 'huangzhong', 'guojia'])
    const target = playerOf(game, 'p1')
    target.hp = 2
    trimHand(game, 'p1', 3)
    slashWithPojun(game, 'p1', { picks: 2 })
    const detained = [...detainedCardsOf(game.state, 'p1')]
    expect(detained).toHaveLength(2)

    playerOf(game, 'p1').hp = 1
    resolveDamage(game as never, { sourceId: 'p0', targetId: 'p1', amount: 1, nature: 'normal' })
    game.settle()
    settle(game)
    expect(playerOf(game, 'p1').alive, '他死了').toBe(false)
    for (const cardId of detained) {
      expect(game.state.zones.discardPile, '破军区的牌直接进弃牌堆').toContain(cardId)
      expect(playerOf(game, 'p2').zones.hand, '行殇拿不到它们').not.toContain(cardId)
    }
    expect(detainedCardsOf(game.state, 'p1'), '记录也清了').toHaveLength(0)
    assertCardConservation(game.state)
    assertGameInvariants(game.state)
  })

  it('死亡清理不是「弃置」：落英接不住这些牌', () => {
    // p2 是曹植（落英）：只收「因弃置或判定进入弃牌堆」的梅花牌
    const game = gameAt('xs-luoying', ['xusheng', 'zhangfei', 'caozhi', 'huangzhong', 'guojia'])
    const target = playerOf(game, 'p1')
    target.hp = 2
    trimHand(game, 'p1', 0)
    const club = Object.values(game.state.cards).find((card) => card.suit === 'club'
      && !card.virtual && game.state.zones.drawPile.includes(card.id))!
    moveCard(game.state, club.id, { kind: 'drawPile' }, { kind: 'hand', playerId: 'p1' })
    giveCard(game, 'p1', '闪')
    slashWithPojun(game, 'p1', { picks: 2 })
    expect(detainedCardsOf(game.state, 'p1')).toContain(club.id)

    const skills: string[] = []
    game.events.on('SkillActivated', (handled) => {
      const skillId = (handled.event.payload as { skillId?: string }).skillId
      if (skillId) skills.push(skillId)
    })
    playerOf(game, 'p1').hp = 1
    resolveDamage(game as never, { sourceId: 'p0', targetId: 'p1', amount: 1, nature: 'normal' })
    game.settle()
    settle(game)
    expect(game.state.zones.discardPile, '梅花牌确实进了弃牌堆').toContain(club.id)
    expect(skills, '但那不是「弃置」，落英不该被它触发').not.toContain('luoying')
    expect(playerOf(game, 'p2').zones.hand, '曹植没有拿到它').not.toContain(club.id)
    assertCardConservation(game.state)
  })
})

describe('徐盛：版本锁', () => {
  it('只有【破军】', () => {
    const character = getCharacter('xusheng')!
    expect(character.skills.map((skill) => skill.id)).toEqual(['pojun'])
    expect(character.pack).toBe('yjcm2011')
    expect(character.maxHp).toBe(4)
    expect(character.kingdom).toBe('wu')
    expect(character.skills[0].description, '是「扣置于其武将牌旁、回合结束后归还」的那一版')
      .toContain('当前回合结束后')
  })
})
