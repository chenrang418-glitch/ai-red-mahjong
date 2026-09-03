import { describe, expect, it } from 'vitest'
import { SanguoshaGame } from '@/sanguosha/engine/game'
import { executeUseCardAction } from '@/sanguosha/engine/cards/basic'
import { useAction } from '@/sanguosha/engine/cards/host'
import { resolveDamage } from '@/sanguosha/engine/damage'
import { assertGameInvariants } from '@/sanguosha/engine/invariants'
import { assertCardConservation } from '@/sanguosha/engine/zones'
import type { GameResponse, ChooseOptionRequest, ChooseCardsRequest, RespondCardRequest } from '@/sanguosha/engine/requests'
import type { GameSetup, Identity, PlayerId } from '@/sanguosha/engine/types'

const RULE = 'ligui:rule'
const RESENTMENT = 'xinzheng:resentment'
const AFFECTED_COUNT = 'ligui:affected-count'
const ANGER_ACTIVE = 'xinzheng:anger-active'
const DRUNK = 'zuinao:drunk'

function gameWith(characterIds: string[], seed = 'yixing-shanshui'): SanguoshaGame {
  const setup: GameSetup = {
    mode: 'identity', generalChoices: 1,
    players: characterIds.map((_, index) => ({ id: `p${index}`, nickname: `玩家${index}`, isHuman: false })),
  }
  const game = new SanguoshaGame({ seed, setup })
  const identities: Identity[] = ['lord', 'rebel', 'loyalist', 'rebel', 'renegade', 'rebel', 'loyalist', 'rebel']
  game.state.players.forEach((player, index) => {
    player.identity = identities[index]
    player.characterId = characterIds[index]
  })
  game.state.currentPlayerId = 'p0'
  game.start()
  return game
}

function player(game: SanguoshaGame, id: PlayerId) {
  return game.state.players.find((candidate) => candidate.id === id)!
}

function request(game: SanguoshaGame) {
  return game.state.pendingRequests[0]
}

function answer(game: SanguoshaGame, payload: Record<string, unknown>): void {
  const current = request(game)
  if (!current) throw new Error('没有待回答请求')
  game.respond({ requestId: current.id, playerId: current.playerId, payload })
}

function chooseRule(game: SanguoshaGame, optionId: 'wine' | 'limit' | 'study' | 'none'): void {
  const current = request(game) as ChooseOptionRequest
  expect(current?.prompt).toContain('【立规】')
  answer(game, { optionId })
}

function settle(game: SanguoshaGame): void {
  ;(game as unknown as { settle(): void }).settle()
}

function detach(game: SanguoshaGame, cardId: string): void {
  game.state.zones.drawPile = game.state.zones.drawPile.filter((id) => id !== cardId)
  game.state.zones.discardPile = game.state.zones.discardPile.filter((id) => id !== cardId)
  game.state.zones.processingArea = game.state.zones.processingArea.filter((id) => id !== cardId)
  for (const target of game.state.players) {
    target.zones.hand = target.zones.hand.filter((id) => id !== cardId)
    target.zones.judgingArea = target.zones.judgingArea.filter((id) => id !== cardId)
    for (const slot of Object.keys(target.zones.equipment) as Array<keyof typeof target.zones.equipment>) {
      if (target.zones.equipment[slot] === cardId) target.zones.equipment[slot] = null
    }
  }
}

function findCards(game: SanguoshaGame, name: string, count = 1): string[] {
  const cards = Object.values(game.state.cards).filter((card) => card.name === name).slice(0, count)
  if (cards.length < count) throw new Error(`没有足够的【${name}】`)
  return cards.map((card) => card.id)
}

function give(game: SanguoshaGame, playerId: PlayerId, cardIds: string[]): void {
  for (const cardId of cardIds) {
    detach(game, cardId)
    player(game, playerId).zones.hand.push(cardId)
  }
}

function clearHand(game: SanguoshaGame, playerId: PlayerId): void {
  const owner = player(game, playerId)
  game.state.zones.discardPile.push(...owner.zones.hand)
  owner.zones.hand = []
}

function setPlay(game: SanguoshaGame, playerId: PlayerId): void {
  game.state.currentPlayerId = playerId
  game.state.phase = 'play'
  game.state.pendingRequests = []
  game.state.skillResolution = null
  game.state.cardResolution = null
  game.state.turnUsage = { slashUses: 0, wineUses: 0, wineDamageBonus: 0 }
}

function useCard(game: SanguoshaGame, playerId: PlayerId, cardId: string, name: string, targetId = playerId): void {
  const action = game.legalActions(playerId).find((candidate) => candidate.kind === 'use-card'
    && candidate.cardIds.includes(cardId) && candidate.asCardName === name && candidate.targetIds.includes(targetId))
  if (!action) throw new Error(`找不到${playerId}使用【${name}】的动作`)
  game.act(playerId, action.id)
}

function passCardResponse(game: SanguoshaGame): void {
  const current = request(game) as RespondCardRequest
  const pass = current.actionIds.find((id) => id.includes('pass'))
  if (!pass) throw new Error('响应请求没有放弃动作')
  answer(game, { actionId: pass })
}

function invariants(game: SanguoshaGame): void {
  assertCardConservation(game.state)
  assertGameInvariants(game.state)
}

describe('奕星【立规】', () => {
  it('每轮可以选择不立规，当前轮无规则效果', () => {
    const game = gameWith(['yixing', 'caocao', 'liubei', 'sunquan', 'lvbu'])
    chooseRule(game, 'none')
    expect(player(game, 'p0').marks[RULE]).toBe(0)
    invariants(game)
  })

  it('不立规不产生影响或怨，下一轮仍会重新询问', () => {
    const game = gameWith(['yixing', 'caocao', 'liubei', 'sunquan', 'lvbu'], 'none-next-round')
    chooseRule(game, 'none')
    setPlay(game, 'p1')
    clearHand(game, 'p1')
    const [wine] = findCards(game, '酒')
    give(game, 'p1', [wine])
    useCard(game, 'p1', wine, '酒')
    expect(player(game, 'p0').marks[AFFECTED_COUNT]).toBe(0)
    expect(player(game, 'p0').marks[RESENTMENT]).toBeUndefined()
    game.dispatch('TurnStart', { playerId: 'p0', turnNumber: game.state.turnNumber + 5 }, { sourceId: 'p0' })
    settle(game)
    expect((request(game) as ChooseOptionRequest).prompt).toContain('【立规】')
    answer(game, { optionId: 'study' })
    expect(player(game, 'p0').marks[RULE]).toBe(3)
    invariants(game)
  })

  it('禁酒可额外弃牌正常结算，也可拒绝并消耗无效的酒', () => {
    const paid = gameWith(['yixing', 'caocao', 'liubei', 'sunquan', 'lvbu'], 'wine-paid')
    chooseRule(paid, 'wine')
    setPlay(paid, 'p1')
    clearHand(paid, 'p1')
    const [wine] = findCards(paid, '酒')
    const [cost] = findCards(paid, '闪')
    give(paid, 'p1', [wine, cost])
    useCard(paid, 'p1', wine, '酒')
    expect((request(paid) as ChooseCardsRequest).min).toBe(0)
    answer(paid, { cardIds: [cost] })
    expect(paid.state.turnUsage.wineUses).toBe(1)
    expect(paid.state.turnUsage.wineDamageBonus).toBe(1)

    const refused = gameWith(['yixing', 'caocao', 'liubei', 'sunquan', 'lvbu'], 'wine-refused')
    chooseRule(refused, 'wine')
    setPlay(refused, 'p1')
    clearHand(refused, 'p1')
    const [wine2] = findCards(refused, '酒')
    const [cost2] = findCards(refused, '闪')
    give(refused, 'p1', [wine2, cost2])
    useCard(refused, 'p1', wine2, '酒')
    answer(refused, { cardIds: [] })
    expect(refused.state.turnUsage.wineUses).toBe(0)
    expect(refused.state.zones.discardPile).toContain(wine2)
    expect(player(refused, 'p0').marks['ligui:affected:p1']).toBeTruthy()
    invariants(refused)
  })

  it('限行在第三张牌完整结算后禁止继续主动用牌', () => {
    const game = gameWith(['yixing', 'caocao', 'liubei', 'sunquan', 'lvbu'], 'limit')
    chooseRule(game, 'limit')
    setPlay(game, 'p1')
    clearHand(game, 'p1')
    const equipment = Object.values(game.state.cards).filter((card) => card.category === 'equipment').slice(0, 4).map((card) => card.id)
    give(game, 'p1', equipment)
    for (const cardId of equipment.slice(0, 3)) useCard(game, 'p1', cardId, game.state.cards[cardId].name)
    expect(game.legalActions('p1').some((action) => action.kind === 'use-card')).toBe(false)
    expect(player(game, 'p0').marks['ligui:affected:p1']).toBeTruthy()
    invariants(game)
  })

  it('限行生效后，多步技能遗留的过期用牌续接安全失效而不崩房间', () => {
    const game = gameWith(['yixing', 'yuji', 'liubei', 'sunquan', 'lvbu'], 'limit-stale-action')
    chooseRule(game, 'limit')
    setPlay(game, 'p1')
    clearHand(game, 'p1')
    const [wine] = findCards(game, '酒')
    give(game, 'p1', [wine])
    player(game, 'p1').marks['ligui:play-blocked:p0'] = game.state.turnNumber
    expect(game.legalActions('p1').some((action) => action.id === 'skill:guhuo')).toBe(false)
    expect(game.legalActions('p1').some((action) => action.id.startsWith('skill:equip:'))).toBe(false)
    const stale = useAction(wine, 'p1', '酒', ['p1'], '过期的多步用牌续接')
    if (stale.kind !== 'use-card') throw new Error('动作构造失败')
    expect(() => executeUseCardAction(game, 'p1', stale)).not.toThrow()
    expect(player(game, 'p1').zones.hand).toContain(wine)
    expect(game.state.turnUsage.wineUses).toBe(0)
    invariants(game)
  })

  it('静习在回合外首次打出牌后只要求弃置一次', () => {
    const game = gameWith(['yixing', 'caocao', 'liubei', 'sunquan', 'lvbu'], 'study')
    chooseRule(game, 'study')
    clearHand(game, 'p1')
    const [first, second] = findCards(game, '闪', 2)
    give(game, 'p1', [first, second])
    game.dispatch('CardResponded', { playerId: 'p1', cardId: first, cardName: '闪' }, { sourceId: 'p1', cardIds: [first] })
    settle(game)
    expect((request(game) as ChooseCardsRequest).prompt).toContain('静习')
    answer(game, { cardIds: [second] })
    expect(player(game, 'p0').marks['ligui:affected:p1']).toBeTruthy()
    game.dispatch('CardResponded', { playerId: 'p1', cardId: first, cardName: '闪' }, { sourceId: 'p1', cardIds: [first] })
    settle(game)
    expect(game.state.pendingRequests).toHaveLength(0)
    invariants(game)
  })

  it('同一角色同轮只计一次受影响人数', () => {
    const game = gameWith(['yixing', 'caocao', 'liubei', 'sunquan', 'lvbu'], 'unique')
    chooseRule(game, 'wine')
    setPlay(game, 'p1')
    clearHand(game, 'p1')
    const wines = findCards(game, '酒', 2)
    const costs = findCards(game, '闪', 2)
    give(game, 'p1', [...wines, ...costs])
    for (let index = 0; index < 2; index += 1) {
      game.state.turnUsage.wineUses = 0
      useCard(game, 'p1', wines[index], '酒')
      answer(game, { cardIds: [costs[index]] })
    }
    expect(player(game, 'p0').marks[AFFECTED_COUNT]).toBe(1)
    invariants(game)
  })

  it('每3名不同角色受影响才获得1怨并重新计数', () => {
    const game = gameWith(['yixing', 'caocao', 'liubei', 'sunquan', 'lvbu'], 'three-affected')
    chooseRule(game, 'wine')
    const wines = findCards(game, '酒', 3)
    for (const [index, actorId] of ['p1', 'p2', 'p3'].entries()) {
      setPlay(game, actorId)
      clearHand(game, actorId)
      give(game, actorId, [wines[index]])
      useCard(game, actorId, wines[index], '酒')
    }
    expect(player(game, 'p0').marks[RESENTMENT]).toBe(1)
    expect(player(game, 'p0').marks[AFFECTED_COUNT]).toBe(0)
    expect(player(game, 'p0').marks[ANGER_ACTIVE]).toBeUndefined()
    invariants(game)
  })

  it('奕星为主公时善水始终只支付一份禁酒代价', () => {
    for (const rule of ['none', 'wine'] as const) {
      const game = gameWith(['yixing', 'shanshui', 'liubei', 'sunquan', 'lvbu'], `suppression-${rule}`)
      chooseRule(game, rule)
      setPlay(game, 'p1')
      clearHand(game, 'p1')
      const [wine] = findCards(game, '酒')
      const [cost] = findCards(game, '闪')
      give(game, 'p1', [wine, cost])
      useCard(game, 'p1', wine, '酒')
      const tax = request(game) as ChooseCardsRequest
      expect(tax.max).toBe(1)
      answer(game, { cardIds: [cost] })
      expect(game.state.turnUsage.wineUses).toBe(1)
      invariants(game)
    }
  })
})

function triggerAnger(game: SanguoshaGame): void {
  const yixing = player(game, 'p0')
  yixing.marks[RESENTMENT] = 2
  yixing.marks[AFFECTED_COUNT] = 2
  setPlay(game, 'p1')
  clearHand(game, 'p1')
  const [wine] = findCards(game, '酒')
  give(game, 'p1', [wine])
  useCard(game, 'p1', wine, '酒')
}

describe('奕星【新政·群怒】', () => {
  it('第3枚怨立即触发，并让所有其他存活角色按座次完整选择', () => {
    const game = gameWith(['yixing', 'caocao', 'liubei', 'sunquan', 'lvbu'], 'anger-all')
    chooseRule(game, 'wine')
    for (const id of ['p1', 'p2', 'p3', 'p4']) clearHand(game, id)
    triggerAnger(game)
    expect(player(game, 'p0').marks[ANGER_ACTIVE]).toBe(1)
    expect(player(game, 'p0').marks[RESENTMENT]).toBe(0)
    for (const id of ['p1', 'p2', 'p3', 'p4']) {
      expect(request(game).playerId).toBe(id)
      answer(game, { optionId: 'lose-hp' })
    }
    expect(player(game, 'p0').marks[ANGER_ACTIVE]).toBeUndefined()
    for (const id of ['p1', 'p2', 'p3', 'p4']) expect(player(game, id).hp).toBe(3)
    invariants(game)
  })

  it('到1血后剩余群怒杀仍消耗且可响应，但不再掉血或摸牌', () => {
    const game = gameWith(['yixing', 'caocao', 'liubei', 'sunquan', 'lvbu'], 'anger-lock')
    chooseRule(game, 'wine')
    const slashIds = findCards(game, '杀', 4)
    for (const [index, id] of ['p1', 'p2', 'p3', 'p4'].entries()) {
      clearHand(game, id)
      give(game, id, [slashIds[index]])
    }
    player(game, 'p0').hp = 2
    triggerAnger(game)
    const handBefore = player(game, 'p0').zones.hand.length
    expect(request(game).playerId).toBe('p1')
    answer(game, { optionId: 'lose-hp' })
    for (const id of ['p2', 'p3', 'p4']) {
      expect(request(game).playerId).toBe(id)
      answer(game, { optionId: 'slash' })
      answer(game, { cardIds: [slashIds[Number(id.slice(1)) - 1]] })
      expect((request(game) as RespondCardRequest).requiredCardName).toBe('闪')
      passCardResponse(game)
    }
    expect(player(game, 'p0').hp).toBe(1)
    expect(player(game, 'p0').zones.hand.length).toBe(handBefore + 2)
    for (const slashId of slashIds) expect(game.state.zones.discardPile).toContain(slashId)
    expect(player(game, 'p0').marks[ANGER_ACTIVE]).toBeUndefined()
    resolveDamage(game, { sourceId: 'p1', targetId: 'p0', amount: 1, cardName: '杀' })
    expect(game.state.dying?.playerId).toBe('p0')
  })

  it('群怒中途序列化恢复不会重复已经完成的角色', () => {
    const game = gameWith(['yixing', 'caocao', 'liubei', 'sunquan', 'lvbu'], 'anger-restore')
    chooseRule(game, 'wine')
    for (const id of ['p1', 'p2', 'p3', 'p4']) clearHand(game, id)
    triggerAnger(game)
    answer(game, { optionId: 'lose-hp' })
    expect(request(game).playerId).toBe('p2')
    const restored = SanguoshaGame.restore(game.serialize())
    expect(request(restored).playerId).toBe('p2')
    for (const id of ['p2', 'p3', 'p4']) answer(restored, { optionId: 'lose-hp' })
    expect(player(restored, 'p1').hp).toBe(3)
    expect(player(restored, 'p0').marks[ANGER_ACTIVE]).toBeUndefined()
    invariants(restored)
  })

  it('群怒杀仍可正常打出闪，闪避后继续下一名角色', () => {
    const game = gameWith(['yixing', 'caocao', 'liubei', 'sunquan', 'lvbu'], 'anger-dodge')
    chooseRule(game, 'wine')
    const owner = player(game, 'p0')
    owner.marks[RESENTMENT] = 2
    owner.marks[AFFECTED_COUNT] = 2
    setPlay(game, 'p1')
    clearHand(game, 'p1')
    const [wine] = findCards(game, '酒')
    const [slash] = findCards(game, '杀')
    const [dodge] = findCards(game, '闪')
    give(game, 'p1', [wine, slash])
    give(game, 'p0', [dodge])
    useCard(game, 'p1', wine, '酒')
    answer(game, { cardIds: [] })
    expect(request(game).playerId).toBe('p1')
    answer(game, { optionId: 'slash' })
    answer(game, { cardIds: [slash] })
    const dodgeRequest = request(game) as RespondCardRequest
    const dodgeAction = dodgeRequest.actionIds.find((id) => id.includes(dodge))
    expect(dodgeAction).toBeTruthy()
    answer(game, { actionId: dodgeAction! })
    expect(player(game, 'p0').hp).toBe(player(game, 'p0').maxHp)
    expect(request(game).playerId).toBe('p2')
    invariants(game)
  })
})

describe('善水【醉闹】【护犊】', () => {
  it('酒后下一杀无距离并由服务器随机追加一个合法目标，结算后清醉', () => {
    const game = gameWith(['shanshui', 'caocao', 'liubei', 'sunquan', 'lvbu'], 'drunk-target')
    setPlay(game, 'p0')
    clearHand(game, 'p0')
    const [wine] = findCards(game, '酒')
    const [slash] = findCards(game, '杀')
    give(game, 'p0', [wine, slash])
    useCard(game, 'p0', wine, '酒')
    expect(player(game, 'p0').marks[DRUNK]).toBe(1)
    useCard(game, 'p0', slash, '杀', 'p1')
    const resolution = game.state.cardResolution
    expect(resolution?.kind).toBe('slash')
    if (resolution?.kind !== 'slash') throw new Error('预期杀结算')
    expect([resolution.targetId, ...resolution.remainingTargetIds]).toHaveLength(2)
    while (game.state.cardResolution) {
      const pending = request(game)
      if (pending.kind === 'choose-option') answer(game, { optionId: 'cancel' })
      else passCardResponse(game)
    }
    expect(player(game, 'p0').marks[DRUNK]).toBeUndefined()
    invariants(game)
  })

  it('醉杀命中平头方块时在原伤害基础上再加1', () => {
    const game = gameWith(['shanshui', 'pingtoufangkuai', 'liubei', 'sunquan', 'lvbu'], 'drunk-pingtou')
    setPlay(game, 'p0')
    clearHand(game, 'p0')
    clearHand(game, 'p1')
    const [wine] = findCards(game, '酒')
    const [slash] = findCards(game, '杀')
    give(game, 'p0', [wine, slash])
    useCard(game, 'p0', wine, '酒')
    const before = player(game, 'p1').hp
    useCard(game, 'p0', slash, '杀', 'p1')
    while (game.state.cardResolution) {
      const pending = request(game)
      if (pending.kind === 'choose-option') answer(game, { optionId: 'cancel' })
      else passCardResponse(game)
    }
    expect(player(game, 'p1').hp).toBe(before - 3)
    invariants(game)
  })

  it('护犊每轮限一次，弃1令其他角色回复1；本轮曾被自己伤害时再摸1', () => {
    const game = gameWith(['shanshui', 'caocao', 'liubei', 'sunquan', 'lvbu'], 'hudu')
    player(game, 'p0').hp = 3
    player(game, 'p1').hp = 2
    const handBefore = player(game, 'p0').zones.hand.length
    resolveDamage(game, { sourceId: 'p0', targetId: 'p1', amount: 1, cardName: '杀' })
    settle(game)
    expect((request(game) as ChooseCardsRequest).prompt).toContain('护犊')
    const cost = (request(game) as ChooseCardsRequest).cardIds[0]
    answer(game, { cardIds: [cost] })
    expect(player(game, 'p1').hp).toBe(2)
    expect(player(game, 'p0').zones.hand.length).toBe(handBefore)
    resolveDamage(game, { sourceId: 'p2', targetId: 'p1', amount: 1, cardName: '杀' })
    settle(game)
    expect(game.state.pendingRequests).toHaveLength(0)
    invariants(game)
  })

  it('护犊等待状态可序列化恢复', () => {
    const game = gameWith(['shanshui', 'caocao', 'liubei', 'sunquan', 'lvbu'], 'hudu-restore')
    player(game, 'p0').hp = 3
    player(game, 'p1').hp = 2
    resolveDamage(game, { sourceId: 'p2', targetId: 'p1', amount: 1, cardName: '杀' })
    settle(game)
    const restored = SanguoshaGame.restore(game.serialize())
    expect((request(restored) as ChooseCardsRequest).prompt).toContain('护犊')
    answer(restored, { cardIds: [] })
    expect(restored.state.pendingRequests).toHaveLength(0)
    invariants(restored)
  })

  it('护犊不能治疗自己，也不会治疗体力高于善水的角色', () => {
    const game = gameWith(['shanshui', 'caocao', 'liubei', 'sunquan', 'lvbu'], 'hudu-boundaries')
    player(game, 'p0').hp = 2
    resolveDamage(game, { sourceId: 'p1', targetId: 'p0', amount: 1, cardName: '杀' })
    settle(game)
    expect(game.state.pendingRequests).toHaveLength(0)
    player(game, 'p1').hp = 4
    player(game, 'p1').maxHp = 5
    resolveDamage(game, { sourceId: 'p2', targetId: 'p1', amount: 1, cardName: '杀' })
    settle(game)
    expect(game.state.pendingRequests).toHaveLength(0)
  })
})
