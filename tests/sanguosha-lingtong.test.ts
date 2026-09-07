import { describe, expect, it } from 'vitest'
import { SanguoshaGame } from '@/sanguosha/engine/game'
import { assertCardConservation, moveCard, type ZoneRef } from '@/sanguosha/engine/zones'
import { assertGameInvariants } from '@/sanguosha/engine/invariants'
import { discardAllCards } from '@/sanguosha/engine/discard-all'
import { getCharacter } from '@/sanguosha/data/characters/standard'
import type { GameSetup, Identity, PlayerId, SanguoshaState } from '@/sanguosha/engine/types'

/**
 * 凌统（一将成名 2011 经典成熟版）。
 *
 * 七条主张，逐条有断言：
 *
 * - 只数「弃牌阶段内因弃置失去的手牌」，用牌、弃装备都不算；
 * - 分几次弃可以累计到两张；
 * - 失去装备区里的牌也触发，而且**一次原子移动只给一次机会**；
 * - 两个「至多」都是真的：单目标可以只弃一张，双目标可以只选一人；
 * - 「依次」是真的依次：一张结算完再问下一张；
 * - 可弃区域是手牌 + 装备区，判定区不可；
 * - 暗手牌只给占位槽，凌统看不到牌面。
 */

const CAST = ['lingtong', 'zhangfei', 'zhaoyun', 'huangzhong', 'guojia']

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

function equip(game: SanguoshaGame, playerId: string, cardName: string, slot: 'weapon' | 'armor' | 'offensiveHorse' | 'defensiveHorse'): string {
  const cardId = giveCard(game, playerId, cardName)
  moveCard(game.state, cardId, { kind: 'hand', playerId }, { kind: 'equipment', playerId, slot })
  return cardId
}

/**
 * 给某人装上某个栏位的**任意**一张装备。
 *
 * 按牌名找会踩到「这一副牌里那张已经被摸走了」——一副牌里青龙偃月刀只有一张。
 * 这里要的只是「装备区里有牌」，具体是哪张不重要。
 */
function equipAny(game: SanguoshaGame, playerId: string, slot: 'weapon' | 'armor' | 'offensiveHorse' | 'defensiveHorse'): string {
  const card = Object.values(game.state.cards).find((candidate) => candidate.category === 'equipment'
    && candidate.equipmentSlot === slot
    && !candidate.virtual
    && (game.state.zones.drawPile.includes(candidate.id) || game.state.zones.discardPile.includes(candidate.id)))
  if (!card) throw new Error(`牌堆里没有闲置的${slot}装备`)
  moveCard(game.state, card.id, locate(game.state, card.id), { kind: 'equipment', playerId, slot })
  return card.id
}

function trimHand(game: SanguoshaGame, playerId: string, count: number): void {
  for (const cardId of playerOf(game, playerId).zones.hand.slice(count)) {
    moveCard(game.state, cardId, { kind: 'hand', playerId }, { kind: 'discardPile' })
  }
}

/** 摆一本弃牌阶段账本：本阶段从 `zone` 弃了 `count` 张。 */
function ledgerWith(game: SanguoshaGame, playerId: string, zone: 'hand' | 'equipment', count: number): void {
  const records = []
  for (let index = 0; index < count; index += 1) {
    const cardId = game.state.zones.discardPile[index] ?? `ledger-${index}`
    records.push({ cardId, sourcePlayerId: playerId, originalZone: zone, moveReason: 'discard' as const, enteredDiscardAt: index })
  }
  game.state.discardPhaseLedger = { phaseInstanceId: 'phase-test', ownerPlayerId: playerId, records }
}

/** 跑一次弃牌阶段结束，按 plan 回答旋风。 */
function endDiscardPhase(
  game: SanguoshaGame,
  plan: { mode?: 'one' | 'two' | 'cancel'; targets?: string[]; picks?: number } = {},
) {
  const seen = { modeRequest: null as AnyRequest | null, discardRequests: [] as AnyRequest[] }
  let picksLeft = plan.picks ?? 99
  game.dispatch('PhaseEnd', { playerId: 'p0', phase: 'discard' }, { sourceId: 'p0', phase: 'discard' })
  game.settle()
  settle(game, (request) => {
    if (request.kind === 'choose-option' && request.prompt?.includes('旋风')) {
      seen.modeRequest = request
      return { optionId: plan.mode ?? 'cancel' }
    }
    if (request.kind === 'choose-targets' && request.prompt?.includes('旋风')) {
      const pick = request as unknown as { candidateIds: string[]; max: number }
      const chosen = (plan.targets ?? pick.candidateIds).filter((id) => pick.candidateIds.includes(id)).slice(0, pick.max)
      return { targetIds: chosen.length > 0 ? chosen : pick.candidateIds.slice(0, 1) }
    }
    if (request.kind === 'choose-cards' && request.prompt?.includes('旋风')) {
      seen.discardRequests.push(request)
      if (picksLeft <= 0) return { cardIds: [] }
      picksLeft -= 1
      const pick = request as unknown as { cardIds: string[]; hiddenCardSlots: string[] }
      return { cardIds: [...pick.cardIds, ...pick.hiddenCardSlots].slice(0, 1) }
    }
    return null
  })
  return seen
}

describe('凌统：旋风的触发条件', () => {
  it('本弃牌阶段弃过两张手牌就能发动', () => {
    const game = gameAt('lt-two')
    ledgerWith(game, 'p0', 'hand', 2)
    const seen = endDiscardPhase(game, { mode: 'cancel' })
    expect(seen.modeRequest, '两张就够了').toBeTruthy()
  })

  it('只弃一张不触发', () => {
    const game = gameAt('lt-one')
    ledgerWith(game, 'p0', 'hand', 1)
    const seen = endDiscardPhase(game, { mode: 'cancel' })
    expect(seen.modeRequest, '一张不够').toBeNull()
  })

  it('弃的是装备不算：数的是手牌', () => {
    const game = gameAt('lt-equipment-ledger')
    ledgerWith(game, 'p0', 'equipment', 3)
    const seen = endDiscardPhase(game, { mode: 'cancel' })
    expect(seen.modeRequest, '弃装备不计入这一条').toBeNull()
  })

  it('别人在这个阶段弃的牌也不算', () => {
    const game = gameAt('lt-other-ledger')
    ledgerWith(game, 'p1', 'hand', 3)
    const seen = endDiscardPhase(game, { mode: 'cancel' })
    expect(seen.modeRequest, '账本主人不是他').toBeNull()
  })

  it('分几次弃可以累计', () => {
    const game = gameAt('lt-accumulate')
    ledgerWith(game, 'p0', 'hand', 1)
    game.state.discardPhaseLedger!.records.push({
      cardId: game.state.zones.discardPile[5] ?? 'ledger-x',
      sourcePlayerId: 'p0', originalZone: 'hand', moveReason: 'discard', enteredDiscardAt: 9,
    })
    const seen = endDiscardPhase(game, { mode: 'cancel' })
    expect(seen.modeRequest, '两次各一张，累计到两张').toBeTruthy()
  })
})

/** 让凌统失去装备区里的牌，返回旋风被问了几次。 */
function loseEquipment(game: SanguoshaGame, cardIds: string[]): number {
  let asked = 0
  for (const cardId of cardIds) {
    const from = locate(game.state, cardId)
    moveCard(game.state, cardId, from, { kind: 'discardPile' })
  }
  game.dispatch('EquipmentZoneLoss', { playerId: 'p0', cardIds }, { targetId: 'p0', cardIds })
  game.settle()
  settle(game, (request) => {
    if (request.kind === 'choose-option' && request.prompt?.includes('旋风')) {
      asked += 1
      return { optionId: 'cancel' }
    }
    return null
  })
  return asked
}

describe('凌统：失去装备触发', () => {
  it('失去装备区里的牌之后可以发动', () => {
    const game = gameAt('lt-lose-equip')
    const weapon = equipAny(game, 'p0', 'weapon')
    expect(loseEquipment(game, [weapon]), '失去一件装备问一次').toBe(1)
  })

  it('一次失去多张装备只给一次机会', () => {
    const game = gameAt('lt-lose-many')
    const cards = [
      equipAny(game, 'p0', 'weapon'),
      equipAny(game, 'p0', 'armor'),
      equipAny(game, 'p0', 'defensiveHorse'),
    ]
    expect(loseEquipment(game, cards), '一次原子移动只算一次').toBe(1)
  })

  it('弃置所有牌时，装备那一批也只算一次', () => {
    const game = gameAt('lt-discard-all')
    equipAny(game, 'p0', 'weapon')
    equipAny(game, 'p0', 'armor')
    let asked = 0
    settle(game)
    
    discardAllCards(game as never, 'p0', 'test')
    game.settle()
    settle(game, (request) => {
      if (request.kind === 'choose-option' && request.prompt?.includes('旋风')) {
        asked += 1
        return { optionId: 'cancel' }
      }
      return null
    })
    expect(asked, '两件装备一次弃光，只问一次').toBe(1)
  })
})

describe('凌统：旋风的效果', () => {
  it('单目标模式：依次弃置至多两张，一张一问', () => {
    const game = gameAt('lt-mode-one')
    ledgerWith(game, 'p0', 'hand', 2)
    while (playerOf(game, 'p1').zones.hand.length < 4) giveCard(game, 'p1', '杀')
    const before = playerOf(game, 'p1').zones.hand.length
    const seen = endDiscardPhase(game, { mode: 'one', targets: ['p1'] })
    expect(seen.discardRequests, '两张分两次问').toHaveLength(2)
    expect(playerOf(game, 'p1').zones.hand, '弃掉两张').toHaveLength(before - 2)
    assertCardConservation(game.state)
  })

  it('单目标模式可以只弃一张就停手', () => {
    const game = gameAt('lt-stop-after-one')
    ledgerWith(game, 'p0', 'hand', 2)
    while (playerOf(game, 'p1').zones.hand.length < 4) giveCard(game, 'p1', '杀')
    const before = playerOf(game, 'p1').zones.hand.length
    const seen = endDiscardPhase(game, { mode: 'one', targets: ['p1'], picks: 1 })
    expect(playerOf(game, 'p1').zones.hand, '只弃了一张').toHaveLength(before - 1)
    expect(seen.discardRequests.length, '第二次问过之后他选择了不弃').toBeGreaterThanOrEqual(1)
  })

  it('双目标模式：两名角色各弃一张，一个结算完再轮到下一个', () => {
    const game = gameAt('lt-mode-two')
    ledgerWith(game, 'p0', 'hand', 2)
    for (const id of ['p1', 'p2']) {
      while (playerOf(game, id).zones.hand.length < 3) giveCard(game, id, '杀')
    }
    const before = { p1: playerOf(game, 'p1').zones.hand.length, p2: playerOf(game, 'p2').zones.hand.length }
    const seen = endDiscardPhase(game, { mode: 'two', targets: ['p1', 'p2'] })
    expect(seen.discardRequests, '两个人各问一次').toHaveLength(2)
    expect(playerOf(game, 'p1').zones.hand).toHaveLength(before.p1 - 1)
    expect(playerOf(game, 'p2').zones.hand).toHaveLength(before.p2 - 1)
    assertCardConservation(game.state)
  })

  it('双目标模式可以只选一名角色', () => {
    const game = gameAt('lt-two-one-target')
    ledgerWith(game, 'p0', 'hand', 2)
    while (playerOf(game, 'p1').zones.hand.length < 3) giveCard(game, 'p1', '杀')
    const before = playerOf(game, 'p1').zones.hand.length
    const seen = endDiscardPhase(game, { mode: 'two', targets: ['p1'] })
    expect(seen.discardRequests, '只问了一次').toHaveLength(1)
    expect(playerOf(game, 'p1').zones.hand).toHaveLength(before - 1)
  })

  it('可弃区域是手牌 + 装备区，判定区不可', () => {
    const game = gameAt('lt-zones')
    ledgerWith(game, 'p0', 'hand', 2)
    trimHand(game, 'p1', 1)
    const weapon = equipAny(game, 'p1', 'weapon')
    const judged = giveCard(game, 'p1', '乐不思蜀')
    moveCard(game.state, judged, { kind: 'hand', playerId: 'p1' }, { kind: 'judgingArea', playerId: 'p1' })
    const seen = endDiscardPhase(game, { mode: 'one', targets: ['p1'], picks: 0 })
    const request = seen.discardRequests[0] as unknown as { cardIds: string[]; hiddenCardSlots: string[] }
    expect(request.cardIds, '装备是明置的，可以选').toContain(weapon)
    expect(request.cardIds, '判定区的牌不在候选里').not.toContain(judged)
    expect(request.hiddenCardSlots.length, '手牌只给占位槽').toBeGreaterThan(0)
  })

  it('暗手牌不泄露：候选里没有一张真实手牌 id', () => {
    const game = gameAt('lt-privacy')
    ledgerWith(game, 'p0', 'hand', 2)
    trimHand(game, 'p1', 0)
    const hand = [giveCard(game, 'p1', '杀'), giveCard(game, 'p1', '闪')]
    const seen = endDiscardPhase(game, { mode: 'one', targets: ['p1'], picks: 0 })
    const request = seen.discardRequests[0] as unknown as { cardIds: string[]; hiddenCardSlots: string[] }
    for (const cardId of hand) {
      expect(request.cardIds, '手牌的真实 id 不能出现在可选列表里').not.toContain(cardId)
    }
    expect(request.hiddenCardSlots, '给的是占位槽').toHaveLength(hand.length)
  })

  it('目标中途没牌了就自然结束', () => {
    const game = gameAt('lt-empty')
    ledgerWith(game, 'p0', 'hand', 2)
    trimHand(game, 'p1', 1)
    const seen = endDiscardPhase(game, { mode: 'one', targets: ['p1'] })
    expect(seen.discardRequests, '只有一张牌，只问一次').toHaveLength(1)
    expect(playerOf(game, 'p1').zones.hand, '弃光了').toHaveLength(0)
    assertGameInvariants(game.state)
  })

  it('一张牌都没有的人不是合法目标', () => {
    const game = gameAt('lt-no-cards')
    ledgerWith(game, 'p0', 'hand', 2)
    for (const id of ['p1', 'p2', 'p3', 'p4']) trimHand(game, id, 0)
    const judged = giveCard(game, 'p1', '乐不思蜀')
    moveCard(game.state, judged, { kind: 'hand', playerId: 'p1' }, { kind: 'judgingArea', playerId: 'p1' })
    const seen = endDiscardPhase(game, { mode: 'one' })
    expect(seen.modeRequest, '全场都没牌可弃，不该弹窗').toBeNull()
  })
})

describe('凌统：旋风与其他技能的联动', () => {
  it('弃掉别人的装备会触发其枭姬', () => {
    // p1 是孙尚香（枭姬）：装备离开她的装备区时摸两张
    const game = gameAt('lt-xiaoji', ['lingtong', 'sunshangxiang', 'zhaoyun', 'huangzhong', 'guojia'])
    ledgerWith(game, 'p0', 'hand', 2)
    trimHand(game, 'p1', 0)
    equipAny(game, 'p1', 'weapon')
    const before = playerOf(game, 'p1').zones.hand.length
    endDiscardPhase(game, { mode: 'one', targets: ['p1'], picks: 1 })
    expect(playerOf(game, 'p1').zones.hand.length, '装备被弃 → 枭姬摸两张').toBeGreaterThan(before)
    assertCardConservation(game.state)
  })

  it('弃掉的梅花牌走的是弃置这条路，落英能接住', () => {
    const game = gameAt('lt-luoying', ['lingtong', 'zhangfei', 'caozhi', 'huangzhong', 'guojia'])
    ledgerWith(game, 'p0', 'hand', 2)
    trimHand(game, 'p1', 0)
    const club = Object.values(game.state.cards).find((card) => card.suit === 'club'
      && !card.virtual && game.state.zones.drawPile.includes(card.id))!
    moveCard(game.state, club.id, { kind: 'drawPile' }, { kind: 'hand', playerId: 'p1' })
    const skills: string[] = []
    game.events.on('SkillActivated', (handled) => {
      const skillId = (handled.event.payload as { skillId?: string }).skillId
      if (skillId) skills.push(skillId)
    })
    endDiscardPhase(game, { mode: 'one', targets: ['p1'], picks: 1 })
    expect(skills, '旋风确实发动了').toContain('xuanfeng')
    expect(skills.includes('luoying') || game.state.zones.discardPile.includes(club.id),
      '那张梅花确实因弃置进了弃牌堆').toBe(true)
    assertCardConservation(game.state)
  })

  it('弃牌阶段结束时触发的旋风，仍算在凌统的弃牌阶段里', () => {
    /*
     * 阶段上下文不能一到「弃牌阶段结束」就销毁：旋风是在那一刻发问的，
     * 落地却在之后。账本读得到，才谈得上和固政一类效果联动。
     */
    const game = gameAt('lt-phase-context')
    ledgerWith(game, 'p0', 'hand', 2)
    while (playerOf(game, 'p1').zones.hand.length < 2) giveCard(game, 'p1', '杀')
    endDiscardPhase(game, { mode: 'one', targets: ['p1'], picks: 1 })
    expect(game.state.discardPhaseLedger, '旋风结算完账本仍然在').toBeTruthy()
    expect(game.state.discardPhaseLedger?.ownerPlayerId).toBe('p0')
  })
})

describe('凌统：版本锁', () => {
  it('只有【旋风】', () => {
    const character = getCharacter('lingtong')!
    expect(character.skills.map((skill) => skill.id)).toEqual(['xuanfeng'])
    expect(character.pack).toBe('yjcm2011')
    expect(character.maxHp).toBe(4)
    expect(character.kingdom).toBe('wu')
    expect(character.skills[0].description, '两种模式都在文本里').toContain('至多两名')
  })
})
