import { describe, expect, it } from 'vitest'
import { SanguoshaGame } from '@/sanguosha/engine/game'
import { getSkillRuntime } from '@/sanguosha/engine/skills/runtime'
import { moveCard } from '@/sanguosha/engine/zones'
import { cardPlayable } from '@/sanguosha/engine/card-play-lock'
import { ALL_CHARACTERS } from '@/sanguosha/data/characters/standard'
import type { LegalAction } from '@/sanguosha/engine/actions'
import type { PlayerId } from '@/sanguosha/engine/types'
import '@/sanguosha/data/characters/historical-batch63'

const CANMOU = 'canmou-xinchang-b63'
const CONGJIAN = 'congjian-xinchang-b63'
const XIJUE = 'xi-jue-zhanghulecheng-b63'
const FULUE = 'fulue-peiyuanshao-b63'
const TAOHUAI = 'taohuai-duanwei-b63'
const MEIYAN = 'meiyan-qiaoguolao-b63'
const ZUOBAO = 'zuobao-qiaoguolao-b63'
const SAYING = 'saying-sunyuan-b63'
const XINGZUO = 'xingzuo-ruanyu-b63'
const MIAOXIAN = 'miaoxian-ruanyu-b63'
const ZEXING = 'zexing-tangtang-b63'
const HEXU = 'hexu-dongyuan-b63'
const JIAOYING = 'jiaoying-fanyufeng-b63'
const BAZHAN = 'bazhan-fanyufeng-b63'
const CHENGEN = 'chengen-dongyuan-b63'

function gameFor(seed: string): SanguoshaGame {
  const game = new SanguoshaGame({ seed, setup: {
    mode: 'identity', generalChoices: 1,
    players: Array.from({ length: 5 }, (_, index) => ({ id: `${seed}-${index}`, nickname: `玩家${index}`, isHuman: true })),
  } })
  game.state.status = 'playing'
  game.state.pendingRequests = []
  game.state.players.forEach((player) => { player.characterId = null })
  return game
}

function moveFromDeckToHand(game: SanguoshaGame, playerId: PlayerId, predicate: (id: string) => boolean): string {
  const cardId = game.state.zones.drawPile.find(predicate)
  if (!cardId) throw new Error('牌堆中缺少测试所需牌')
  moveCard(game.state, cardId, { kind: 'drawPile' }, { kind: 'hand', playerId })
  return cardId
}

function useAction(game: SanguoshaGame, playerId: PlayerId, cardId: string, targetIds: PlayerId[]): Extract<LegalAction, { kind: 'use-card' }> {
  return {
    id: `test-use:${cardId}`, kind: 'use-card', playerId, cardIds: [cardId], targetIds,
    targetMin: 1, targetMax: 1, asCardName: game.state.cards[cardId]!.name, label: '测试使用锦囊',
  }
}

function pending(game: SanguoshaGame) {
  const request = game.state.pendingRequests.at(-1)
  if (!request) throw new Error('预期出现待处理请求')
  return request
}

function giveOpinion(game: SanguoshaGame, playerId: PlayerId, suit: 'heart' | 'spade' | 'club', rank: number): string {
  const cardId = game.state.zones.drawPile.find((id) => game.state.cards[id]?.suit === suit)
  if (!cardId) throw new Error(`牌堆中缺少${suit}测试牌`)
  moveCard(game.state, cardId, { kind: 'drawPile' }, { kind: 'hand', playerId })
  game.state.cards[cardId]!.rank = rank
  return cardId
}

function submitOpinions(game: SanguoshaGame, selections: Record<PlayerId, string | undefined>): void {
  for (const request of [...game.state.pendingRequests]) {
    const cardId = selections[request.playerId]
    if (!cardId && (request.kind !== 'choose-cards' || request.cardIds.length !== 0)) throw new Error(`缺少玩家${request.playerId}的意见牌`)
    game.respond({ requestId: request.id, playerId: request.playerId, payload: { cardIds: cardId ? [cardId] : [] } })
  }
}

describe('武将册续开发第63批（正式登记与运行时）', () => {
  it('本批十名均进入正式武将池，且所登记技能都有运行时', () => {
    const names = ['张虎乐綝', '辛敞', '裴元绍', '乔国老', '孙鸢', '阮瑀', '唐棠', '董予安', '段煨', '樊玉凤']
    const characters = names.map((name) => ALL_CHARACTERS.find((character) => character.name === name))
    expect(characters.every(Boolean)).toBe(true)
    for (const character of characters) {
      expect(character!.skills.length).toBeGreaterThan(0)
      for (const skill of character!.skills) expect(getSkillRuntime(skill.id)).toBeDefined()
    }
  })

  it('辛敞【参谋】：由辛敞本人选择合法额外目标，续接原锦囊并保留新目标', () => {
    const game = gameFor('b63-canmou-target')
    const [source, first, extra, , owner] = game.state.players
    game.state.currentPlayerId = source!.id
    game.state.phase = 'play'
    const fireAttack = moveFromDeckToHand(game, source!.id, (id) => game.state.cards[id]?.name === '火攻')
    moveFromDeckToHand(game, source!.id, (id) => game.state.cards[id]?.name !== '火攻')
    moveFromDeckToHand(game, first!.id, (id) => game.state.cards[id]?.name !== '火攻')
    moveFromDeckToHand(game, extra!.id, (id) => game.state.cards[id]?.name !== '火攻')
    const action = useAction(game, source!.id, fireAttack, [first!.id])

    expect(getSkillRuntime(CANMOU)?.interceptPlayAction?.(game as never, owner!.id, action)).toBe(true)
    expect(pending(game)).toMatchObject({ kind: 'choose-option', playerId: owner!.id, skillId: CANMOU })
    game.respond({ requestId: pending(game).id, playerId: owner!.id, payload: { optionId: 'yes' } })
    expect(pending(game)).toMatchObject({ kind: 'choose-targets', playerId: owner!.id, candidateIds: expect.arrayContaining([extra!.id]) })
    game.respond({ requestId: pending(game).id, playerId: owner!.id, payload: { targetIds: [extra!.id] } })

    expect(game.state.cardResolution).toMatchObject({ kind: 'trick', cardId: fireAttack, targetIds: [first!.id, extra!.id] })
  })

  it('辛敞【从鉴】：仅唯一最高体力的其他角色为唯一目标时询问并追加辛敞', () => {
    const game = gameFor('b63-congjian-target')
    const [source, target, , , owner] = game.state.players
    game.state.currentPlayerId = source!.id
    game.state.phase = 'play'
    owner!.hp = 2
    target!.hp = target!.maxHp
    for (const player of game.state.players) if (player.id !== target!.id) player.hp = Math.min(player.hp, 2)
    const fireAttack = moveFromDeckToHand(game, source!.id, (id) => game.state.cards[id]?.name === '火攻')
    moveFromDeckToHand(game, target!.id, (id) => game.state.cards[id]?.name !== '火攻')
    const action = useAction(game, source!.id, fireAttack, [target!.id])

    expect(getSkillRuntime(CANMOU)?.interceptPlayAction?.(game as never, owner!.id, action)).toBe(true)
    expect(pending(game)).toMatchObject({ kind: 'choose-option', skillId: CONGJIAN })
    game.respond({ requestId: pending(game).id, playerId: owner!.id, payload: { optionId: 'yes' } })

    expect(game.state.cardResolution).toMatchObject({ kind: 'trick', cardId: fireAttack, targetIds: [target!.id, owner!.id] })
  })

  it('辛敞【从鉴】：牌造成伤害後仅在整张普通锦囊结算完毕时摸两张牌', () => {
    const game = gameFor('b63-congjian-draw')
    const owner = game.state.players[0]!
    const cardId = moveFromDeckToHand(game, owner.id, (id) => game.state.cards[id]?.name === '火攻')
    const runtime = getSkillRuntime(CONGJIAN)!
    const damaged = runtime.triggers!.find((trigger) => trigger.event === 'DamageSettled')!
    const finished = runtime.triggers!.find((trigger) => trigger.event === 'AfterCardUse')!
    const handBefore = owner.zones.hand.length
    const eventBase = { id: 'test-event', seq: 1, sourceId: game.state.players[1]!.id, targetId: owner.id, cardIds: [cardId], payload: {} }

    damaged.handle(game as never, owner.id, { event: { ...eventBase, name: 'DamageSettled', payload: { finalAmount: 1, cardId, cardName: '火攻' } }, cancelled: false, cancel() {} } as never)
    finished.handle(game as never, owner.id, { event: { ...eventBase, name: 'AfterCardUse', payload: { cardId, cardName: '火攻', targetIds: [owner.id], cancelled: false } }, cancelled: false, cancel() {} } as never)

    expect(owner.zones.hand).toHaveLength(handBefore + 2)
  })

  it('张虎乐綝【袭爵】：开局获四枚爵，伤害按实际扣除体力累计到结束阶段', () => {
    const game = gameFor('b63-xijue-mark')
    const owner = game.state.players[0]!
    const runtime = getSkillRuntime(XIJUE)!
    runtime.onGameStart?.(game as never, owner.id)
    expect(owner.marks['爵']).toBe(4)

    runtime.triggers!.find((trigger) => trigger.event === 'TurnStart')!.handle(game as never, owner.id, {
      event: { id: 'turn', seq: 1, name: 'TurnStart', payload: { playerId: owner.id, turnNumber: game.state.turnNumber } }, cancelled: false, cancel() {},
    } as never)
    runtime.triggers!.find((trigger) => trigger.event === 'DamageSettled')!.handle(game as never, owner.id, {
      event: { id: 'damage', seq: 2, name: 'DamageSettled', sourceId: owner.id, targetId: game.state.players[1]!.id, payload: { requestedAmount: 2, finalAmount: 1 } }, cancelled: false, cancel() {},
    } as never)
    runtime.triggers!.find((trigger) => trigger.event === 'PhaseStart')!.handle(game as never, owner.id, {
      event: { id: 'finish', seq: 3, name: 'PhaseStart', payload: { playerId: owner.id, phase: 'finish' } }, cancelled: false, cancel() {},
    } as never)

    expect(owner.marks['爵']).toBe(5)
  })

  it('张虎乐綝【袭爵】：摸牌阶段拒绝支付保留正常摸牌，接受则支付爵并选择突袭目标', () => {
    const declined = gameFor('b63-xijue-tuxi-decline')
    const owner = declined.state.players[0]!
    const victim = declined.state.players[1]!
    owner.marks['爵'] = 1
    moveFromDeckToHand(declined, victim.id, () => true)
    const runtime = getSkillRuntime(XIJUE)!
    const drawTrigger = runtime.triggers!.find((trigger) => trigger.event === 'DrawPhase')!
    const declinedContext = {
      event: { id: 'draw-decline', seq: 1, name: 'DrawPhase', phase: 'draw', payload: { playerId: owner.id, count: 2 } },
      cancelled: false, cancel() { declinedContext.cancelled = true },
    }
    const beforeDecline = owner.zones.hand.length
    drawTrigger.handle(declined as never, owner.id, declinedContext as never)
    expect(declinedContext.cancelled).toBe(true)
    declined.respond({ requestId: pending(declined).id, playerId: owner.id, payload: { optionId: 'no' } })
    expect(owner.zones.hand).toHaveLength(beforeDecline + 2)
    expect(owner.marks['爵']).toBe(1)

    const accepted = gameFor('b63-xijue-tuxi-accept')
    const taker = accepted.state.players[0]!
    const firstVictim = accepted.state.players[1]!
    const secondVictim = accepted.state.players[2]!
    taker.marks['爵'] = 1
    moveFromDeckToHand(accepted, firstVictim.id, () => true)
    moveFromDeckToHand(accepted, secondVictim.id, () => true)
    const acceptedContext = {
      event: { id: 'draw-accept', seq: 1, name: 'DrawPhase', phase: 'draw', payload: { playerId: taker.id, count: 2 } },
      cancelled: false, cancel() { acceptedContext.cancelled = true },
    }
    drawTrigger.handle(accepted as never, taker.id, acceptedContext as never)
    accepted.respond({ requestId: pending(accepted).id, playerId: taker.id, payload: { optionId: 'yes' } })
    expect(taker.marks['爵']).toBeUndefined()
    expect(pending(accepted)).toMatchObject({ kind: 'choose-targets', min: 1, max: 2 })
    accepted.respond({ requestId: pending(accepted).id, playerId: taker.id, payload: { targetIds: [firstVictim.id, secondVictim.id] } })
    expect(taker.zones.hand).toHaveLength(2)
    expect(firstVictim.zones.hand).toHaveLength(0)
    expect(secondVictim.zones.hand).toHaveLength(0)
  })

  it('张虎乐綝【袭爵】：骁果实际支付基本牌，并由目标选择弃装备摸牌或承受伤害', () => {
    const game = gameFor('b63-xijue-xiaoguo')
    const owner = game.state.players[0]!
    const target = game.state.players[1]!
    owner.marks['爵'] = 1
    const basicId = moveFromDeckToHand(game, owner.id, (id) => game.state.cards[id]?.category === 'basic')
    const equipmentId = game.state.zones.drawPile.find((id) => game.state.cards[id]?.category === 'equipment')!
    const equipment = game.state.cards[equipmentId]!
    moveCard(game.state, equipmentId, { kind: 'drawPile' }, { kind: 'equipment', playerId: target.id, slot: equipment.equipmentSlot! })
    const runtime = getSkillRuntime(XIJUE)!
    runtime.startQueued!(game as never, owner.id, {
      skillId: XIJUE, ownerId: owner.id, step: 'xiaoguo-invoke', data: { targetId: target.id }, remaining: 0,
    } as never)
    game.respond({ requestId: pending(game).id, playerId: owner.id, payload: { optionId: 'yes' } })
    expect(owner.marks['爵']).toBeUndefined()
    expect(pending(game)).toMatchObject({ kind: 'choose-cards', playerId: owner.id, min: 1, max: 1 })
    game.respond({ requestId: pending(game).id, playerId: owner.id, payload: { cardIds: [basicId] } })
    expect(pending(game)).toMatchObject({ kind: 'choose-option', playerId: target.id })
    const handBeforeReward = owner.zones.hand.length
    game.respond({ requestId: pending(game).id, playerId: target.id, payload: { optionId: 'discard' } })
    expect(pending(game)).toMatchObject({ kind: 'choose-cards', playerId: target.id, min: 1, max: 1 })
    game.respond({ requestId: pending(game).id, playerId: target.id, payload: { cardIds: [equipmentId] } })
    expect(owner.zones.hand).toHaveLength(handBeforeReward + 1)
    expect(game.state.zones.discardPile).toEqual(expect.arrayContaining([basicId, equipmentId]))
  })

  it('裴元绍【复掠】：伤害选项绑定本次牌使用并在结算后清除', () => {
    const game = gameFor('b63-fulue-damage')
    const owner = game.state.players[0]!
    const target = game.state.players[1]!
    game.state.currentPlayerId = owner.id
    game.state.phase = 'play'
    const slash = moveFromDeckToHand(game, owner.id, (id) => game.state.cards[id]?.name === '杀')
    const action = { ...useAction(game, owner.id, slash, [target.id]), interceptedSkillKeys: [`${owner.id}:${FULUE}`] }
    const runtime = getSkillRuntime(FULUE)!

    expect(runtime.interceptPlayAction?.(game as never, owner.id, action)).toBe(true)
    expect(pending(game)).toMatchObject({ kind: 'choose-option', options: expect.arrayContaining([expect.objectContaining({ id: 'damage' })]) })
    game.respond({ requestId: pending(game).id, playerId: owner.id, payload: { optionId: 'damage' } })
    expect(runtime.outgoingDamage?.(game.state, owner.id, {
      targetId: target.id, amount: 1, nature: 'normal', cardId: slash, cardName: '杀', chainTransfer: false,
    })).toEqual({ amount: 2 })
    expect(game.state.cardResolution).toMatchObject({ kind: 'slash', cardId: slash, targetId: target.id })

    runtime.triggers!.find((trigger) => trigger.event === 'AfterCardUse')!.handle(game as never, owner.id, {
      event: { id: 'fulue-cleanup', seq: 1, name: 'AfterCardUse', payload: { cardId: slash } }, cancelled: false, cancel() {},
    } as never)
    expect(runtime.outgoingDamage?.(game.state, owner.id, {
      targetId: target.id, amount: 1, nature: 'normal', cardId: slash, cardName: '杀', chainTransfer: false,
    })).toBeNull()
    expect(runtime.interceptPlayAction?.(game as never, owner.id, action)).toBe(false)
  })

  it('裴元绍【复掠】：暗选目标手牌真实获得后继续结算原锦囊', () => {
    const game = gameFor('b63-fulue-gain')
    const [owner, target] = game.state.players
    game.state.currentPlayerId = owner!.id
    game.state.phase = 'play'
    const fireAttack = moveFromDeckToHand(game, owner!.id, (id) => game.state.cards[id]?.name === '火攻')
    const hiddenCard = moveFromDeckToHand(game, target!.id, () => true)
    moveFromDeckToHand(game, target!.id, (id) => id !== hiddenCard)
    const action = { ...useAction(game, owner!.id, fireAttack, [target!.id]), interceptedSkillKeys: [`${owner!.id}:${FULUE}`] }
    const runtime = getSkillRuntime(FULUE)!
    expect(runtime.interceptPlayAction?.(game as never, owner!.id, action)).toBe(true)
    game.respond({ requestId: pending(game).id, playerId: owner!.id, payload: { optionId: 'gain' } })
    expect(pending(game)).toMatchObject({ kind: 'choose-cards', playerId: owner!.id, cardIds: [], hiddenCardSlots: [expect.any(String), expect.any(String)] })
    game.respond({ requestId: pending(game).id, playerId: owner!.id, payload: { cardIds: [pending(game).hiddenCardSlots[0]] } })
    expect(owner!.zones.hand).toContain(hiddenCard)
    expect(target!.zones.hand).not.toContain(hiddenCard)
    expect(game.state.cardResolution).toMatchObject({ kind: 'trick', cardId: fireAttack, targetIds: [target!.id] })
  })

  it('裴元绍【复掠】：原牌无伤后目标可选择合法【杀】，并执行未用的伤害选项', () => {
    const game = gameFor('b63-fulue-counter')
    const owner = game.state.players[0]!
    const target = game.state.players[1]!
    const originalCard = moveFromDeckToHand(game, owner.id, () => true)
    const counterSlash = moveFromDeckToHand(game, target.id, (id) => game.state.cards[id]?.name === '杀')
    const state = game.state as typeof game.state & {
      fulueModesThisTurn?: Record<string, { turnNumber: number; modes: Array<'damage' | 'gain'> }>
      fuluePendingCard?: Record<string, { ownerId: string; targetId: string; mode: 'damage' | 'gain'; turnNumber: number }>
    }
    state.fulueModesThisTurn = { [owner.id]: { turnNumber: state.turnNumber, modes: ['gain'] } }
    state.fuluePendingCard = { [originalCard]: { ownerId: owner.id, targetId: target.id, mode: 'gain', turnNumber: state.turnNumber } }
    const runtime = getSkillRuntime(FULUE)!
    runtime.triggers!.find((trigger) => trigger.event === 'AfterCardUse')!.handle(game as never, owner.id, {
      event: { id: 'fulue-no-damage', seq: 1, name: 'AfterCardUse', payload: { cardId: originalCard } }, cancelled: false, cancel() {},
    } as never)
    expect(pending(game)).toMatchObject({ kind: 'choose-option', playerId: target.id })
    game.respond({ requestId: pending(game).id, playerId: target.id, payload: { optionId: 'yes' } })
    const slashChoice = pending(game)
    expect(slashChoice).toMatchObject({ kind: 'choose-option', playerId: target.id, options: [expect.objectContaining({ id: expect.any(String) })] })
    const slashActionId = (slashChoice as { options: Array<{ id: string }> }).options[0]!.id
    game.respond({ requestId: slashChoice.id, playerId: target.id, payload: { optionId: slashActionId } })
    expect(game.state.cardResolution).toMatchObject({ kind: 'slash', cardId: counterSlash, sourceId: target.id, targetId: owner.id })
    expect(runtime.globalOutgoingDamage?.(game.state, owner.id, target.id, {
      targetId: owner.id, amount: 1, nature: 'normal', cardId: counterSlash, cardName: '杀', chainTransfer: false,
    })).toEqual({ amount: 2 })
  })

  it('段煨【讨怀】：阳取唯一最大牌、阴取唯一最小牌，摸牌后正确交替', () => {
    const game = gameFor('b63-taohuai-toggle')
    const owner = game.state.players[0]!
    const target = game.state.players[1]!
    const cards = [0, 1, 2].map(() => moveFromDeckToHand(game, owner.id, () => true))
    game.state.cards[cards[0]!]!.rank = 13
    game.state.cards[cards[1]!]!.rank = 8
    game.state.cards[cards[2]!]!.rank = 4
    const runtime = getSkillRuntime(TAOHUAI)!
    const afterUse = runtime.triggers!.find((trigger) => trigger.event === 'AfterCardUse')!

    expect(runtime.interceptPlayAction?.(game as never, owner.id, useAction(game, owner.id, cards[0]!, [target.id]))).toBe(false)
    const handBeforeYang = owner.zones.hand.length
    moveCard(game.state, cards[0]!, { kind: 'hand', playerId: owner.id }, { kind: 'discardPile' })
    afterUse.handle(game as never, owner.id, { event: { id: 'yang', seq: 1, name: 'AfterCardUse', payload: { cardId: cards[0] } }, cancelled: false, cancel() {} } as never)
    expect(owner.zones.hand).toHaveLength(handBeforeYang)
    expect(game.state.conversionStates[`${owner.id}:${TAOHUAI}`]).toBe('yin')

    const minimum = cards[2]!
    for (const id of owner.zones.hand) game.state.cards[id]!.rank = id === minimum ? 1 : 10
    expect(runtime.interceptPlayAction?.(game as never, owner.id, useAction(game, owner.id, minimum, [target.id]))).toBe(false)
    const handBeforeYin = owner.zones.hand.length
    moveCard(game.state, minimum, { kind: 'hand', playerId: owner.id }, { kind: 'discardPile' })
    afterUse.handle(game as never, owner.id, { event: { id: 'yin', seq: 2, name: 'AfterCardUse', payload: { cardId: minimum } }, cancelled: false, cancel() {} } as never)
    expect(owner.zones.hand).toHaveLength(handBeforeYin)
    expect(game.state.conversionStates[`${owner.id}:${TAOHUAI}`]).toBe('yang')
  })

  it('段煨【讨怀】：未达当前牌点时弃牌是可选的，只有实际弃牌后才切换状态', () => {
    const game = gameFor('b63-taohuai-discard')
    const owner = game.state.players[0]!
    const target = game.state.players[1]!
    const usedCard = moveFromDeckToHand(game, owner.id, () => true)
    const costCard = moveFromDeckToHand(game, owner.id, () => true)
    const secondUse = moveFromDeckToHand(game, owner.id, () => true)
    game.state.cards[usedCard]!.rank = 3
    game.state.cards[costCard]!.rank = 12
    const runtime = getSkillRuntime(TAOHUAI)!
    const trigger = runtime.triggers!.find((entry) => entry.event === 'AfterCardUse')!
    runtime.interceptPlayAction?.(game as never, owner.id, useAction(game, owner.id, usedCard, [target.id]))
    moveCard(game.state, usedCard, { kind: 'hand', playerId: owner.id }, { kind: 'discardPile' })
    trigger.handle(game as never, owner.id, { event: { id: 'mismatch', seq: 1, name: 'AfterCardUse', payload: { cardId: usedCard } }, cancelled: false, cancel() {} } as never)
    expect(pending(game)).toMatchObject({ kind: 'choose-cards', optional: true, min: 0, max: 1 })
    game.respond({ requestId: pending(game).id, playerId: owner.id, payload: { cardIds: [] } })
    expect(game.state.conversionStates[`${owner.id}:${TAOHUAI}`]).toBeUndefined()

    game.state.cards[secondUse]!.rank = 3
    game.state.cards[costCard]!.rank = 12
    runtime.interceptPlayAction?.(game as never, owner.id, useAction(game, owner.id, secondUse, [target.id]))
    moveCard(game.state, secondUse, { kind: 'hand', playerId: owner.id }, { kind: 'discardPile' })
    trigger.handle(game as never, owner.id, { event: { id: 'mismatch-cost', seq: 2, name: 'AfterCardUse', payload: { cardId: secondUse } }, cancelled: false, cancel() {} } as never)
    game.respond({ requestId: pending(game).id, playerId: owner.id, payload: { cardIds: [costCard] } })
    expect(game.state.zones.discardPile).toContain(costCard)
    expect(game.state.conversionStates[`${owner.id}:${TAOHUAI}`]).toBe('yin')
  })

  it('乔国老【媒言】：同时秘密议事并按意见牌点数总和结算，红色结果获得红色意见牌', () => {
    const game = gameFor('b63-qiaoguolao-meiyan')
    const owner = game.state.players[0]!
    const redVoter = game.state.players[1]!
    for (const player of game.state.players) player.hp = 1
    owner.hp = 3
    redVoter.hp = 3
    const ownerBlack = giveOpinion(game, owner.id, 'club', 2)
    const redOpinion = giveOpinion(game, redVoter.id, 'heart', 12)
    game.state.phase = 'play'
    game.state.currentPlayerId = owner.id

    getSkillRuntime(MEIYAN)!.invokeActive!(game as never, owner.id)
    expect(game.state.pendingRequests).toHaveLength(2)
    expect(game.state.pendingRequests.every((request) => request.kind === 'choose-cards')).toBe(true)
    submitOpinions(game, { [owner.id]: ownerBlack, [redVoter.id]: redOpinion })

    expect(pending(game)).toMatchObject({ skillId: ZUOBAO, kind: 'choose-option' })
    game.respond({ requestId: pending(game).id, playerId: owner.id, payload: { optionId: 'decline' } })
    expect(owner.zones.hand).toContain(redOpinion)
    expect(redVoter.zones.hand).not.toContain(redOpinion)
  })

  it('乔国老【作保】：限定技将黑桃意见按红桃计入点数议事', () => {
    const game = gameFor('b63-qiaoguolao-zuobao')
    const owner = game.state.players[0]!
    const redVoter = game.state.players[1]!
    const blackVoter = game.state.players[2]!
    for (const player of game.state.players) player.hp = 1
    owner.hp = redVoter.hp = blackVoter.hp = 3
    const spadeOpinion = giveOpinion(game, owner.id, 'spade', 4)
    const redOpinion = giveOpinion(game, redVoter.id, 'heart', 6)
    const blackOpinion = giveOpinion(game, blackVoter.id, 'club', 7)
    game.state.phase = 'play'
    game.state.currentPlayerId = owner.id

    getSkillRuntime(MEIYAN)!.invokeActive!(game as never, owner.id)
    submitOpinions(game, { [owner.id]: spadeOpinion, [redVoter.id]: redOpinion, [blackVoter.id]: blackOpinion })
    expect(pending(game)).toMatchObject({ skillId: ZUOBAO, kind: 'choose-option' })
    game.respond({ requestId: pending(game).id, playerId: owner.id, payload: { optionId: 'use' } })

    expect(owner.usedLimitedSkills).toContain(ZUOBAO)
    expect(owner.zones.hand).toContain(redOpinion)
    expect(redVoter.zones.hand).not.toContain(redOpinion)
  })

  it('乔国老【妁语】：议事结果为红时弃置意见牌并将当前杀转移至未参与者', () => {
    const game = gameFor('b63-qiaoguolao-zhuoyu')
    const owner = game.state.players[0]!
    const target = game.state.players[1]!
    const source = game.state.players[2]!
    const newTarget = game.state.players[3]!
    for (const player of game.state.players) player.hp = 1
    owner.hp = 3
    target.hp = 2
    newTarget.hp = newTarget.maxHp
    const ownerOpinion = giveOpinion(game, owner.id, 'heart', 9)
    const targetOpinion = giveOpinion(game, target.id, 'heart', 8)
    const sourceOpinion = giveOpinion(game, source.id, 'club', 1)
    const slash = moveFromDeckToHand(game, source.id, (id) => game.state.cards[id]?.name === '杀')
    moveCard(game.state, slash, { kind: 'hand', playerId: source.id }, { kind: 'processingArea' })
    game.state.cardResolution = {
      kind: 'slash', cardId: slash, sourceId: source.id, targetId: target.id,
      damageNature: 'normal', damageAmount: 1, stage: 'awaiting-dodge', interceptsDone: [],
      extraCardIds: [], remainingTargetIds: [], requestId: null, dodgeRemaining: 1,
      noDodge: false, targetCancelled: false, surrogate: null,
    }
    const runtime = getSkillRuntime('zhuoyu-qiaoguolao-b63')!
    expect(runtime.interceptBystanderTarget?.(game as never, owner.id, {
      sourceId: source.id, targetId: target.id, cardId: slash, cardName: '杀', category: 'basic',
    })).toBe(true)
    game.state.cardResolution.stage = 'awaiting-intercept'
    game.respond({ requestId: pending(game).id, playerId: owner.id, payload: { optionId: 'yes' } })
    submitOpinions(game, { [owner.id]: ownerOpinion, [target.id]: targetOpinion, [source.id]: sourceOpinion })
    game.respond({ requestId: pending(game).id, playerId: owner.id, payload: { optionId: 'decline' } })
    expect(pending(game)).toMatchObject({ kind: 'choose-targets', playerId: owner.id })
    game.respond({ requestId: pending(game).id, playerId: owner.id, payload: { targetIds: [newTarget.id] } })

    expect(game.state.cardResolution).toMatchObject({ kind: 'slash', targetId: newTarget.id, stage: 'awaiting-dodge' })
    expect(game.state.zones.discardPile).toEqual(expect.arrayContaining([ownerOpinion, targetOpinion, sourceOpinion]))
  })

  it('孙鸢【飒影】：获得区域牌后，超出其攻击范围时建立仅本轮有效的双向杀距离豁免', () => {
    const game = gameFor('b63-sunyuan-saying-range')
    const owner = game.state.players[0]!
    const target = game.state.players[2]!
    const equipmentId = game.state.zones.drawPile.find((id) => game.state.cards[id]?.category === 'equipment')!
    const equipment = game.state.cards[equipmentId]!
    moveCard(game.state, equipmentId, { kind: 'drawPile' }, { kind: 'equipment', playerId: target.id, slot: equipment.equipmentSlot! })
    const runtime = getSkillRuntime(SAYING)!
    runtime.triggers!.find((trigger) => trigger.event === 'PhaseStart')!.handle(game as never, owner.id, {
      event: { id: 'saying-start', seq: 1, name: 'PhaseStart', payload: { playerId: owner.id, phase: 'play' } }, cancelled: false, cancel() {},
    } as never)
    game.respond({ requestId: pending(game).id, playerId: owner.id, payload: { targetIds: [target.id] } })
    game.respond({ requestId: pending(game).id, playerId: owner.id, payload: { cardIds: [equipmentId] } })

    expect(owner.zones.hand).toContain(equipmentId)
    expect(target.zones.equipment[equipment.equipmentSlot!]).toBeNull()
    expect(runtime.globalSlashIgnoresDistanceTo?.(game.state, owner.id, owner.id, target.id)).toBe(true)
    expect(runtime.globalSlashIgnoresDistanceTo?.(game.state, owner.id, target.id, owner.id)).toBe(true)
  })

  it('阮瑀【兴作】：替换底牌位置，并在结束阶段执行全手牌换底牌与超三张失去体力', () => {
    const game = gameFor('b63-ruanyu-xingzuo')
    const owner = game.state.players[0]!
    const target = game.state.players[1]!
    const originalBottom = [...game.state.zones.drawPile.slice(-3)]
    const protectedFromBottom = new Set(originalBottom)
    const targetHand = Array.from({ length: 4 }, () => moveFromDeckToHand(game, target.id, (id) => !protectedFromBottom.has(id)))
    const replacement = moveFromDeckToHand(game, owner.id, (id) => !protectedFromBottom.has(id))
    const runtime = getSkillRuntime(XINGZUO)!
    const phaseStart = runtime.triggers!.find((trigger) => trigger.event === 'PhaseStart')!

    phaseStart.handle(game as never, owner.id, {
      event: { id: 'xingzuo-play', seq: 1, name: 'PhaseStart', payload: { playerId: owner.id, phase: 'play' } }, cancelled: false, cancel() {},
    } as never)
    game.respond({ requestId: pending(game).id, playerId: owner.id, payload: { cardIds: [originalBottom[2]!] } })
    game.respond({ requestId: pending(game).id, playerId: owner.id, payload: { cardIds: [replacement] } })
    expect(game.state.zones.drawPile.at(-1)).toBe(replacement)
    expect(owner.zones.hand).toContain(originalBottom[2]!)

    phaseStart.handle(game as never, owner.id, {
      event: { id: 'xingzuo-finish', seq: 2, name: 'PhaseStart', payload: { playerId: owner.id, phase: 'finish' } }, cancelled: false, cancel() {},
    } as never)
    game.respond({ requestId: pending(game).id, playerId: owner.id, payload: { targetIds: [target.id] } })

    expect(target.zones.hand).toHaveLength(3)
    expect(game.state.zones.drawPile.slice(-targetHand.length)).toEqual(targetHand)
    expect(owner.hp).toBe(owner.maxHp - 1)
  })

  it('阮瑀【妙弦】：唯一黑牌可当即时普通锦囊且成功使用后本回合关闭；唯一红牌使用时摸牌', () => {
    const blackGame = gameFor('b63-ruanyu-miaoxian-black')
    const blackOwner = blackGame.state.players[0]!
    const blackCard = moveFromDeckToHand(blackGame, blackOwner.id, (id) => blackGame.state.cards[id]?.color === 'black')
    moveFromDeckToHand(blackGame, blackOwner.id, (id) => blackGame.state.cards[id]?.color === 'red')
    const runtime = getSkillRuntime(MIAOXIAN)!
    const viewAs = runtime.viewAs!(blackGame.state, blackOwner.id)
    expect(viewAs).toEqual(expect.arrayContaining([expect.objectContaining({ cardId: blackCard, asCardName: '火攻' })]))
    expect(viewAs.some((option) => option.asCardName === '闪电')).toBe(false)
    runtime.triggers!.find((trigger) => trigger.event === 'CardUsed')!.handle(blackGame as never, blackOwner.id, {
      event: { id: 'miaoxian-black-use', seq: 1, name: 'CardUsed', sourceId: blackOwner.id, sourceSkillId: MIAOXIAN, payload: { cardId: blackCard, cardName: '火攻' } }, cancelled: false, cancel() {},
    } as never)
    expect(blackOwner.turnUsedSkills).toContain(MIAOXIAN)
    expect(runtime.viewAs!(blackGame.state, blackOwner.id)).toEqual([])

    const redGame = gameFor('b63-ruanyu-miaoxian-red')
    const redOwner = redGame.state.players[0]!
    const redCard = moveFromDeckToHand(redGame, redOwner.id, (id) => redGame.state.cards[id]?.color === 'red')
    moveFromDeckToHand(redGame, redOwner.id, (id) => redGame.state.cards[id]?.color === 'black')
    const redRuntime = getSkillRuntime(MIAOXIAN)!
    redRuntime.interceptPlayAction!(redGame as never, redOwner.id, useAction(redGame, redOwner.id, redCard, []))
    moveCard(redGame.state, redCard, { kind: 'hand', playerId: redOwner.id }, { kind: 'processingArea' })
    const handBefore = redOwner.zones.hand.length
    redRuntime.triggers!.find((trigger) => trigger.event === 'CardUsed')!.handle(redGame as never, redOwner.id, {
      event: { id: 'miaoxian-red-use', seq: 1, name: 'CardUsed', sourceId: redOwner.id, payload: { cardId: redCard, cardName: '杀' } }, cancelled: false, cancel() {},
    } as never)
    expect(redOwner.zones.hand).toHaveLength(handBefore + 1)
  })

  it('唐棠【择行】：目标选失去体力后可继续选不同角色，同一回合不能重复选择目标', () => {
    const game = gameFor('b63-tangtang-zexing-repeat')
    const [owner, first, second] = game.state.players
    game.state.currentPlayerId = owner!.id
    game.state.phase = 'play'
    const shown = moveFromDeckToHand(game, owner!.id, () => true)
    const runtime = getSkillRuntime(ZEXING)!

    runtime.invokeActive!(game as never, owner!.id)
    game.respond({ requestId: pending(game).id, playerId: owner!.id, payload: { cardIds: [shown] } })
    expect(game.state.decisions.at(-1)?.kind).toBe('choose-cards')
    expect(pending(game)).toMatchObject({ kind: 'choose-targets', candidateIds: expect.arrayContaining([first!.id, second!.id]) })
    game.respond({ requestId: pending(game).id, playerId: owner!.id, payload: { targetIds: [first!.id] } })
    game.respond({ requestId: pending(game).id, playerId: first!.id, payload: { optionId: 'lose-hp' } })

    expect(first!.hp).toBe(first!.maxHp - 1)
    expect(pending(game)).toMatchObject({ kind: 'choose-targets', candidateIds: expect.arrayContaining([second!.id]) })
    expect((pending(game) as { candidateIds: PlayerId[] }).candidateIds).not.toContain(first!.id)
    game.respond({ requestId: pending(game).id, playerId: owner!.id, payload: { targetIds: [second!.id] } })
    game.respond({ requestId: pending(game).id, playerId: second!.id, payload: { optionId: 'lose-hp' } })
    expect(pending(game)).toMatchObject({ kind: 'choose-targets', candidateIds: expect.not.arrayContaining([first!.id, second!.id]) })
  })

  it('董予安【和煦】：按非伤害牌类别计手牌上限，伤害锦囊不计且同类只加一次', () => {
    const game = gameFor('b63-dongyuan-hexu')
    const owner = game.state.players[0]!
    moveFromDeckToHand(game, owner.id, (id) => game.state.cards[id]?.category === 'basic')
    moveFromDeckToHand(game, owner.id, (id) => game.state.cards[id]?.category === 'equipment')
    moveFromDeckToHand(game, owner.id, (id) => game.state.cards[id]?.name === '无中生有')
    moveFromDeckToHand(game, owner.id, (id) => game.state.cards[id]?.name === '火攻')
    expect(getSkillRuntime(HEXU)!.maxCardsBonus!(game.state, owner.id)).toBe(3)
  })

  it('樊玉凤【醮影】：其他角色取得其手牌后，统一禁止使用/打出同色手牌，并在未再用牌的回合结束触发摸至五张', () => {
    const game = gameFor('b63-fanyufeng-jiaoying')
    const owner = game.state.players[0]!
    const recipient = game.state.players[1]!
    const gained = moveFromDeckToHand(game, owner.id, (id) => game.state.cards[id]?.color === 'red')
    moveCard(game.state, gained, { kind: 'hand', playerId: owner.id }, { kind: 'hand', playerId: recipient.id })
    const runtime = getSkillRuntime(JIAOYING)!
    runtime.triggers!.find((trigger) => trigger.event === 'HandCardLeft')!.handle(game as never, owner.id, {
      event: { id: 'jiaoying-transfer', seq: 1, name: 'HandCardLeft', payload: { playerId: owner.id, cardId: gained, destination: { kind: 'hand', playerId: recipient.id } } }, cancelled: false, cancel() {},
    } as never)
    const sameColor = moveFromDeckToHand(game, recipient.id, (id) => game.state.cards[id]?.color === 'red')
    expect(cardPlayable(game.state, recipient.id, gained)).toBe(false)
    expect(cardPlayable(game.state, recipient.id, sameColor, { forResponse: true })).toBe(false)

    runtime.triggers!.find((trigger) => trigger.event === 'TurnEnd')!.handle(game as never, owner.id, {
      event: { id: 'jiaoying-end', seq: 2, name: 'TurnEnd', payload: { playerId: recipient.id, turnNumber: game.state.turnNumber } }, cancelled: false, cancel() {},
    } as never)
    game.respond({ requestId: pending(game).id, playerId: owner.id, payload: { targetIds: [recipient.id] } })
    expect(recipient.zones.hand).toHaveLength(5)
  })

  it('樊玉凤【把盏】：阳态交牌后转换为阴态，酒/红桃可选择令收牌者复原武将牌', () => {
    const game = gameFor('b63-fanyufeng-bazhan')
    const owner = game.state.players[0]!
    const target = game.state.players[1]!
    game.state.currentPlayerId = owner.id
    game.state.phase = 'play'
    const heart = moveFromDeckToHand(game, owner.id, (id) => game.state.cards[id]?.suit === 'heart')
    target.faceDown = true
    target.chained = true
    getSkillRuntime(BAZHAN)!.invokeActive!(game as never, owner.id)
    game.respond({ requestId: pending(game).id, playerId: owner.id, payload: { targetIds: [target.id] } })
    game.respond({ requestId: pending(game).id, playerId: owner.id, payload: { cardIds: [heart] } })
    expect(target.zones.hand).toContain(heart)
    expect(game.state.conversionStates[`${owner.id}:${BAZHAN}`]).toBe('yin')
    expect(pending(game)).toMatchObject({ kind: 'choose-option', skillId: BAZHAN })
    game.respond({ requestId: pending(game).id, playerId: owner.id, payload: { optionId: 'restore' } })
    expect(target.faceDown).toBe(false)
    expect(target.chained).toBe(false)
  })

  it('董予安【承恩】：回合结束条件满足时真实拼点；赢后可无距离使用拼点【杀】', () => {
    const game = gameFor('b63-dongyuan-chengen')
    const owner = game.state.players[0]!
    const opponent = game.state.players[1]!
    const remote = game.state.players[3]!
    owner.characterId = 'dongyuan-b63'
    owner.zones.hand = []
    opponent.zones.hand = []
    const pindianSlash = moveFromDeckToHand(game, owner.id, (id) => game.state.cards[id]?.name === '杀')
    game.state.cards[pindianSlash]!.rank = 13
    const opponentCard = moveFromDeckToHand(game, opponent.id, () => true)
    game.state.cards[opponentCard]!.rank = 1
    game.state.currentPlayerId = remote.id

    getSkillRuntime(CHENGEN)!.triggers!.find((trigger) => trigger.event === 'TurnEnd')!.handle(game as never, owner.id, {
      event: { id: 'chengen-turn-end', seq: 1, name: 'TurnEnd', payload: { playerId: remote.id, turnNumber: game.state.turnNumber } }, cancelled: false, cancel() {},
    } as never)
    game.respond({ requestId: pending(game).id, playerId: owner.id, payload: { targetIds: [opponent.id] } })
    for (const request of [...game.state.pendingRequests]) {
      const cardId = request.playerId === owner.id ? pindianSlash : opponentCard
      game.respond({ requestId: request.id, playerId: request.playerId, payload: { cardIds: [cardId] } })
    }

    expect(pending(game)).toMatchObject({ kind: 'choose-option', skillId: CHENGEN })
    const useSlash = (pending(game) as { options: Array<{ id: string; label: string }> }).options.find((option) => option.label.includes(remote.nickname))
    expect(useSlash).toBeDefined()
    game.respond({ requestId: pending(game).id, playerId: owner.id, payload: { optionId: useSlash!.id } })
    expect(game.state.cardResolution).toMatchObject({ kind: 'slash', cardId: pindianSlash, sourceId: owner.id, targetId: remote.id })
  })
})
