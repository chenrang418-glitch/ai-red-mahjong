import type { LegalAction } from '../actions'
import { resolveDamage } from '../damage'
import { canTarget, getDistance } from '../distance'
import { drawCards } from '../draw'
import { handleEquipmentLost, isCardIneffective } from '../equipment'
import { getEngineCallbacks } from '../equipment-requests'
import { ignoresTrickDistance } from '../../data/characters/standard'
import { recover } from '../recover'
import type { ChooseCardsRequest, ChooseTargetsRequest, GameResponse, RespondCardRequest } from '../requests'
import { validateResponse } from '../requests'
import type { CardId, PlayerId, SanguoshaState, TrickEffectState, TrickResolutionState } from '../types'
import { moveCard } from '../zones'
import type { CardEngineHost } from './host'
import { finishPhysicalCard, hiddenHandSlot, playerOf, useAction } from './host'
import { effectiveCardSuit, isTargetProhibited, skillsOf } from '../skills/runtime'
import { skillIdsOf } from '../../data/characters/standard'

/**
 * 即时锦囊。
 *
 * 三条贯穿全文件的约定：
 *
 * 1. 每个目标各问一次无懈可击。无懈取消的是「这张牌对某一个目标的效果」，
 *    不是整张牌——万箭齐发被一个人无懈掉，其他人照样要出闪。
 * 2. 效果阶段要等人做选择时，一律把状态写进 `resolution.effect`，
 *    绝不能用 await 挂着。Durable Object 随时会休眠，挂起的调用栈醒不过来。
 * 3. 目标合法性只在这里算一次，客户端不自行推断距离和用途。
 */

/** 需要逐个目标问无懈、且效果由本模块处理的即时锦囊。 */
export const INSTANT_TRICKS = new Set([
  '无中生有', '桃园结义', '铁索连环', '南蛮入侵', '万箭齐发',
  '决斗', '过河拆桥', '顺手牵羊', '五谷丰登', '火攻', '借刀杀人',
])

function alive(state: SanguoshaState): PlayerId[] {
  return state.players.filter((candidate) => candidate.alive).map((candidate) => candidate.id)
}

/** 从当前回合角色起的存活座次顺序：问无懈和结算多目标都按这个次序。 */
export function aliveOrderFromCurrent(state: SanguoshaState): PlayerId[] {
  const current = playerOf(state, state.currentPlayerId)
  const result: PlayerId[] = []
  for (let offset = 0; offset < state.players.length; offset += 1) {
    const candidate = state.players[(current.seat + offset) % state.players.length]
    if (candidate.alive) result.push(candidate.id)
  }
  return result
}

/** 目标身上所有可以被拆 / 被顺的牌：手牌不公开，用占位槽表示。 */
function stealableSlots(state: SanguoshaState, targetId: PlayerId): { visible: CardId[]; hidden: string[] } {
  const target = playerOf(state, targetId)
  const visible: CardId[] = [
    ...Object.values(target.zones.equipment).filter((cardId): cardId is CardId => !!cardId),
    ...target.zones.judgingArea,
  ]
  // 手牌对使用者是暗的：只给出「第几张」的占位槽，不泄露真实 cardId
  const hidden = target.zones.hand.map((_, index) => hiddenHandSlot(targetId, index))
  return { visible, hidden }
}

function hasAnyStealable(state: SanguoshaState, targetId: PlayerId): boolean {
  const { visible, hidden } = stealableSlots(state, targetId)
  return visible.length + hidden.length > 0
}

/** 出牌阶段能用哪些即时锦囊。 */
/**
 * 一张牌能当作某个普通锦囊使用时，有哪些合法动作。
 *
 * `asName` 用于转化技（甘宁【奇袭】把黑牌当【过河拆桥】）：
 * 目标合法性要按转化后的牌名算，不是按牌面上印的名字。
 */
export function instantTrickActions(state: SanguoshaState, playerId: PlayerId, cardId: CardId, asName?: string): LegalAction[] {
  const physical = state.cards[cardId]
  if (!physical) return []
  const card = asName ? { ...physical, name: asName } : physical
  const others = state.players.filter((candidate) => candidate.alive && candidate.id !== playerId)
  const actions: LegalAction[] = []
  const allowed = (targetId: PlayerId) => !isTargetProhibited(state, playerId, targetId, card.name, skillIdsOf)

  switch (card.name) {
    case '无中生有':
      return [useAction(cardId, playerId, card.name, [playerId], '使用【无中生有】摸两张牌')]
    case '桃园结义':
      // 目标是所有存活角色（含自己），已满体力的人也算目标，只是回复无效
      return [useAction(cardId, playerId, card.name, alive(state).filter(allowed), '使用【桃园结义】，全场回复一点体力')]
    case '南蛮入侵':
      if (others.length === 0) return []
      return [useAction(cardId, playerId, card.name, others.map((candidate) => candidate.id).filter(allowed), '使用【南蛮入侵】')]
    case '万箭齐发':
      if (others.length === 0) return []
      return [useAction(cardId, playerId, card.name, others.map((candidate) => candidate.id).filter(allowed), '使用【万箭齐发】')]
    case '决斗':
      for (const target of others) {
        if (!allowed(target.id)) continue
        actions.push(useAction(cardId, playerId, card.name, [target.id], `对${target.nickname}使用【决斗】`))
      }
      return actions
    case '过河拆桥':
      for (const target of others) {
        if (!allowed(target.id)) continue
        if (!hasAnyStealable(state, target.id)) continue
        actions.push(useAction(cardId, playerId, card.name, [target.id], `对${target.nickname}使用【过河拆桥】`))
      }
      return actions
    case '顺手牵羊':
      for (const target of others) {
        if (!allowed(target.id)) continue
        // 顺手牵羊受距离限制，拆桥不受；奇才无视这个限制
        if (!ignoresTrickDistance(state, playerId) && getDistance(state, playerId, target.id) > 1) continue
        if (!hasAnyStealable(state, target.id)) continue
        actions.push(useAction(cardId, playerId, card.name, [target.id], `对${target.nickname}使用【顺手牵羊】`))
      }
      return actions
    case '五谷丰登':
      // 目标是所有存活角色，亮出等量的牌轮流挑
      return [useAction(cardId, playerId, card.name, alive(state).filter(allowed), '使用【五谷丰登】')]
    case '火攻':
      for (const target of others) {
        if (!allowed(target.id)) continue
        // 目标必须有手牌才能展示
        if (playerOf(state, target.id).zones.hand.length === 0) continue
        actions.push(useAction(cardId, playerId, card.name, [target.id], `对${target.nickname}使用【火攻】`))
      }
      return actions
    case '借刀杀人':
      for (const target of others) {
        if (!allowed(target.id)) continue
        // 目标必须装备着武器，而且这把武器够得到至少一个别人
        const weapon = playerOf(state, target.id).zones.equipment.weapon
        if (!weapon) continue
        const hasVictim = state.players.some((victim) => (
          victim.alive && victim.id !== target.id && canTarget(state, target.id, victim.id)
          && !isTargetProhibited(state, target.id, victim.id, '杀', skillIdsOf)
        ))
        if (!hasVictim) continue
        actions.push(useAction(cardId, playerId, card.name, [target.id], `对${target.nickname}使用【借刀杀人】`))
      }
      return actions
    case '铁索连环': {
      // 重铸：不当锦囊用，直接弃掉换一张新牌。这是【铁索连环】独有的用法，
      // 不受目标限制，也不算「使用」，所以没有无懈窗口。
      actions.push({
        ...useAction(cardId, playerId, card.name, [playerId], '重铸【铁索连环】：弃掉它，摸一张牌'),
        id: `play:recast:${cardId}`,
      })
      // 横置/重置一到两名角色
      for (const target of state.players.filter((candidate) => candidate.alive && allowed(candidate.id))) {
        actions.push(useAction(cardId, playerId, card.name, [target.id], `对${target.nickname}使用【铁索连环】`))
      }
      for (const first of state.players.filter((candidate) => candidate.alive && allowed(candidate.id))) {
        for (const second of state.players.filter((candidate) => candidate.alive && allowed(candidate.id) && candidate.seat > first.seat)) {
          actions.push(useAction(cardId, playerId, card.name, [first.id, second.id], `对${first.nickname}和${second.nickname}使用【铁索连环】`))
        }
      }
      return actions
    }
    default:
      return []
  }
}

/**
 * 五谷丰登在第一个目标结算前，先亮出和存活人数等量的牌摆到处理区。
 * 亮出的牌是公开信息，所以直接用真实 cardId，不需要暗槽。
 */
function ensureHarvestRevealed(host: CardEngineHost, resolution: TrickResolutionState): CardId[] {
  const existing = resolution.effect
  if (existing?.kind === 'harvest') return existing.revealedCardIds
  const revealed: CardId[] = []
  for (let index = 0; index < resolution.targetIds.length; index += 1) {
    const cardId = host.state.zones.drawPile.shift()
    if (!cardId) break
    host.state.zones.processingArea.push(cardId)
    revealed.push(cardId)
  }
  host.dispatch('CardMove', { cardIds: revealed, reason: 'harvest-reveal' }, { sourceId: resolution.sourceId, cardIds: revealed })
  return revealed
}

function askHarvestPick(host: CardEngineHost, resolution: TrickResolutionState, targetId: PlayerId): void {
  // 亮出的牌在整张牌结算期间共用，中途不重新亮
  const pool = resolution.harvestPool ?? ensureHarvestRevealed(host, resolution)
  resolution.harvestPool = pool
  const available = pool.filter((cardId) => host.state.zones.processingArea.includes(cardId))
  if (available.length === 0) {
    advanceToNextTarget(host)
    return
  }
  const request: ChooseCardsRequest = {
    id: `request-harvest-${host.state.seq}-${host.state.decisions.length}`,
    kind: 'choose-cards',
    playerId: targetId,
    prompt: '从【五谷丰登】亮出的牌中选择一张',
    timeoutMs: 30_000,
    optional: false,
    cardIds: available,
    hiddenCardSlots: [],
    min: 1,
    max: 1,
    purpose: 'card-effect',
  }
  host.state.pendingRequests.push(request)
  resolution.requestId = request.id
  resolution.effect = { kind: 'harvest', targetId, revealedCardIds: available, requestId: request.id }
}

function askFireReveal(host: CardEngineHost, resolution: TrickResolutionState, targetId: PlayerId): void {
  const target = playerOf(host.state, targetId)
  if (target.zones.hand.length === 0) {
    advanceToNextTarget(host)
    return
  }
  // 由目标自己选择展示哪一张，所以可以直接给真实 cardId——他看得到自己的手牌
  const request: ChooseCardsRequest = {
    id: `request-fire-${host.state.seq}-${host.state.decisions.length}`,
    kind: 'choose-cards',
    playerId: targetId,
    prompt: '【火攻】：展示你的一张手牌',
    timeoutMs: 30_000,
    optional: false,
    cardIds: [...target.zones.hand],
    hiddenCardSlots: [],
    min: 1,
    max: 1,
    purpose: 'card-effect',
  }
  host.state.pendingRequests.push(request)
  resolution.requestId = request.id
  resolution.effect = { kind: 'fire-reveal', targetId, requestId: request.id }
}

function askBorrowedKnife(host: CardEngineHost, resolution: TrickResolutionState, targetId: PlayerId): void {
  const target = playerOf(host.state, targetId)
  const weaponCardId = target.zones.equipment.weapon
  if (!weaponCardId) {
    advanceToNextTarget(host)
    return
  }
  const victims = host.state.players.filter((victim) => (
    victim.alive && victim.id !== targetId && canTarget(host.state, targetId, victim.id)
    && !isTargetProhibited(host.state, targetId, victim.id, '杀', skillIdsOf)
  ))
  if (victims.length === 0) {
    advanceToNextTarget(host)
    return
  }
  // 先让目标挑一个受害者；挑完再问要不要真的出杀
  const request: ChooseTargetsRequest = {
    id: `request-knife-${host.state.seq}-${host.state.decisions.length}`,
    kind: 'choose-targets',
    playerId: targetId,
    prompt: '【借刀杀人】：选择一名角色作为你的【杀】的目标，或放弃并交出武器',
    timeoutMs: 30_000,
    optional: false,
    candidateIds: victims.map((victim) => victim.id),
    min: 1,
    max: 1,
  }
  host.state.pendingRequests.push(request)
  resolution.requestId = request.id
  resolution.effect = { kind: 'borrowed-knife', targetId, victimId: '', weaponCardId, requestId: request.id }
}

/** 把一张即时锦囊推入结算：先给第一个目标问无懈。 */
export function beginInstantTrick(host: CardEngineHost, sourceId: PlayerId, cardId: CardId, targetIds: PlayerId[], asName?: string): void {
  const card = host.state.cards[cardId]
  host.state.cardResolution = {
    kind: 'trick',
    cardId,
    // 转化技用的是转化后的牌名，后续结算全部以它为准
    cardName: asName ?? card.name,
    sourceId,
    targetIds: [...targetIds],
    targetIndex: 0,
    nullifiedTargetIds: [],
    cancelledTargetIds: [],
    unresponsiveTargetIds: [],
    interceptsDone: [],
    stage: 'awaiting-nullification',
    responderOrder: aliveOrderFromCurrent(host.state),
    responderIndex: 0,
    nullificationCount: 0,
    requestId: null,
    effect: null,
  }
  enterTrickTarget(host)
}

/** 当前锦囊目标先经过武将的“成为目标后”技能，再进入无懈链。 */
function enterTrickTarget(host: CardEngineHost): void {
  const resolution = host.state.cardResolution
  if (!resolution || resolution.kind !== 'trick') return
  if (resolution.targetIndex >= resolution.targetIds.length) {
    finishTrick(host)
    return
  }
  const targetId = resolution.targetIds[resolution.targetIndex]
  const card = host.state.cards[resolution.cardId]
  for (const runtime of skillsOf(host.state, targetId, skillIdsOf)) {
    if (!runtime.interceptTarget) continue
    const interceptId = `skill:${runtime.id}`
    if (resolution.interceptsDone.includes(interceptId)) continue
    resolution.interceptsDone.push(interceptId)
    if (!runtime.interceptTarget(host, targetId, {
      sourceId: resolution.sourceId,
      targetId,
      cardId: resolution.cardId,
      cardName: resolution.cardName,
      category: card.category,
    })) continue
    resolution.stage = 'awaiting-intercept'
    return
  }
  askNullification(host)
}

/** 目标技能回答完以后恢复；只取消当前目标，不影响多目标锦囊的其余角色。 */
export function resumeTrickTarget(host: CardEngineHost): void {
  const resolution = host.state.cardResolution
  if (!resolution || resolution.kind !== 'trick') return
  const targetId = resolution.targetIds[resolution.targetIndex]
  if (resolution.cancelledTargetIds.includes(targetId)) {
    advanceToNextTarget(host)
    return
  }
  enterTrickTarget(host)
}

/** 给当前目标问下一个可以出无懈的人；问完一圈就进效果结算。 */
export function askNullification(host: CardEngineHost): void {
  const resolution = host.state.cardResolution
  if (!resolution || resolution.kind !== 'trick') return

  if (resolution.targetIndex >= resolution.targetIds.length) {
    finishTrick(host)
    return
  }

  if (resolution.responderIndex >= resolution.responderOrder.length) {
    // 奇数次无懈 = 最终被取消
    const nullified = resolution.nullificationCount % 2 === 1
    const targetId = resolution.targetIds[resolution.targetIndex]
    if (nullified) {
      resolution.nullifiedTargetIds.push(targetId)
      advanceToNextTarget(host)
    } else {
      resolution.stage = 'awaiting-effect'
      applyTrickEffect(host, targetId)
    }
    return
  }

  const responderId = resolution.responderOrder[resolution.responderIndex]
  const responder = playerOf(host.state, responderId)
  const currentTargetId = resolution.targetIds[resolution.targetIndex]
  if (!responder.alive || (responderId === currentTargetId && resolution.unresponsiveTargetIds.includes(responderId))) {
    resolution.responderIndex += 1
    askNullification(host)
    return
  }
  const actionIds = responder.zones.hand
    .filter((cardId) => host.state.cards[cardId]?.name === '无懈可击')
    .map((cardId) => `respond-nullification:${cardId}`)
  if (actionIds.length === 0) {
    // 手上没有无懈就不必打扰这名玩家，直接问下一个
    resolution.responderIndex += 1
    askNullification(host)
    return
  }
  actionIds.push('respond-pass')
  const targetName = playerOf(host.state, resolution.targetIds[resolution.targetIndex]).nickname
  const request: RespondCardRequest = {
    id: `request-trick-${host.state.seq}-${host.state.decisions.length}-${resolution.targetIndex}-${resolution.responderIndex}`,
    kind: 'respond-card',
    playerId: responderId,
    prompt: `是否对${targetName}的【${resolution.cardName}】使用【无懈可击】`,
    timeoutMs: 30_000,
    optional: true,
    actionIds,
    requiredCardName: '无懈可击',
  }
  host.state.pendingRequests.push(request)
  resolution.requestId = request.id
}

/** 当前目标结算完毕，推进到下一个目标（重新开一轮无懈询问）。 */
export function advanceToNextTarget(host: CardEngineHost): void {
  const resolution = host.state.cardResolution
  if (!resolution || resolution.kind !== 'trick') return
  // 中途有人死掉、胜负已分时不能再往下问：牌局结束时 pendingRequests 已经被清空，
  // 这时候再发一个请求会永远挂在那里
  if (host.state.status !== 'playing') {
    finishTrick(host)
    return
  }
  resolution.targetIndex += 1
  resolution.responderIndex = 0
  resolution.nullificationCount = 0
  resolution.stage = 'awaiting-nullification'
  resolution.effect = null
  resolution.requestId = null
  resolution.interceptsDone = []
  enterTrickTarget(host)
}

/** 整张牌结算完：收束卡牌并派发结束事件。 */
function finishTrick(host: CardEngineHost): void {
  const resolution = host.state.cardResolution
  if (!resolution || resolution.kind !== 'trick') return
  const allNullified = new Set([...resolution.nullifiedTargetIds, ...resolution.cancelledTargetIds]).size === resolution.targetIds.length
  finishPhysicalCard(host, resolution.sourceId, resolution.cardId, resolution.targetIds, allNullified)
  host.state.cardResolution = null
}

/**
 * 主公技代打：锦囊要求打出牌而目标放弃时，转问同势力角色。
 *
 * 和【杀】的护驾走同一套形状：进度记在 effect 上，完全可序列化。
 * 返回 true 表示已经问出去了，调用方必须直接返回。
 */
function askTrickSurrogate(
  host: CardEngineHost,
  resolution: TrickResolutionState,
  effect: { targetId: PlayerId; requestId: string | null; surrogate?: { skillId: string; order: PlayerId[]; index: number } | null },
  requiredCardName: '杀' | '闪',
): boolean {
  if (!effect.surrogate) {
    const runtime = skillsOf(host.state, effect.targetId, skillIdsOf).find((candidate) => candidate.surrogateResponders)
    if (!runtime) return false
    const order = runtime.surrogateResponders!(host.state, effect.targetId, requiredCardName)
    if (order.length === 0) return false
    effect.surrogate = { skillId: runtime.id, order, index: 0 }
  } else {
    effect.surrogate.index += 1
  }

  const surrogate = effect.surrogate
  while (surrogate.index < surrogate.order.length) {
    const responderId = surrogate.order[surrogate.index]
    const responder = host.state.players.find((candidate) => candidate.id === responderId)
    if (responder?.alive) {
      effect.requestId = askRespondCard(host, resolution, responderId, requiredCardName, `主公需要【${requiredCardName}】，你可以代他打出`)
      return true
    }
    surrogate.index += 1
  }
  return false
}

function askRespondCard(
  host: CardEngineHost,
  resolution: TrickResolutionState,
  responderId: PlayerId,
  requiredCardName: '杀' | '闪',
  prompt: string,
): string {
  const responder = playerOf(host.state, responderId)
  const actionIds = responder.zones.hand
    .filter((cardId) => host.state.cards[cardId]?.name === requiredCardName)
    .map((cardId) => `respond-trick:${cardId}`)
  actionIds.push('respond-pass')
  const request: RespondCardRequest = {
    id: `request-effect-${host.state.seq}-${host.state.decisions.length}`,
    kind: 'respond-card',
    playerId: responderId,
    prompt,
    timeoutMs: 30_000,
    optional: true,
    actionIds,
    requiredCardName,
  }
  host.state.pendingRequests.push(request)
  resolution.requestId = request.id
  return request.id
}

function duelSlashCount(state: SanguoshaState, opponentId: PlayerId): number {
  return Math.max(1, ...skillsOf(state, opponentId, skillIdsOf).map((runtime) => runtime.duelSlashResponses ?? 1))
}

function askPickCard(host: CardEngineHost, resolution: TrickResolutionState, targetId: PlayerId, mode: 'discard' | 'steal'): void {
  const { visible, hidden } = stealableSlots(host.state, targetId)
  // 生成动作时目标身上是有牌的，但问无懈那一轮里他可能把最后一张牌当【无懈可击】打了出去。
  // 这时效果自然落空，不能发一个「从零张牌里选一张」的请求——那是个必然非法的 Request。
  if (visible.length + hidden.length === 0) {
    advanceToNextTarget(host)
    return
  }
  const target = playerOf(host.state, targetId)
  const request: ChooseCardsRequest = {
    id: `request-pick-${host.state.seq}-${host.state.decisions.length}`,
    kind: 'choose-cards',
    playerId: resolution.sourceId,
    prompt: mode === 'discard' ? `弃置${target.nickname}的一张牌` : `获得${target.nickname}的一张牌`,
    timeoutMs: 30_000,
    optional: false,
    cardIds: visible,
    hiddenCardSlots: hidden,
    min: 1,
    max: 1,
    purpose: 'card-effect',
  }
  host.state.pendingRequests.push(request)
  resolution.requestId = request.id
  resolution.effect = { kind: 'pick-card', targetId, mode, requestId: request.id }
}

/** 对单个目标施加锦囊效果。需要等人做选择的会写进 resolution.effect。 */
function applyTrickEffect(host: CardEngineHost, targetId: PlayerId): void {
  const resolution = host.state.cardResolution
  if (!resolution || resolution.kind !== 'trick') return
  const target = playerOf(host.state, targetId)
  const cannotRespond = resolution.unresponsiveTargetIds.includes(targetId)

  switch (resolution.cardName) {
    case '无中生有':
      drawCards(host.state, host.rng, targetId, 2, (name, payload) => { host.dispatch(name, payload) })
      advanceToNextTarget(host)
      return
    case '桃园结义':
      if (target.alive && target.hp < target.maxHp) recover(host, targetId, 1, resolution.sourceId)
      advanceToNextTarget(host)
      return
    case '铁索连环':
      target.chained = !target.chained
      host.dispatch('CardResolved', { cardId: resolution.cardId, cardName: resolution.cardName, targetIds: [targetId], chained: target.chained }, { sourceId: resolution.sourceId, targetId })
      advanceToNextTarget(host)
      return
    case '南蛮入侵': {
      // 藤甲让南蛮/万箭完全无效：不问响应，也不造成伤害
      if (isCardIneffective(host.state, targetId, resolution.cardName, null, 'normal')) {
        advanceToNextTarget(host)
        return
      }
      if (cannotRespond) {
        resolveDamage(host, { sourceId: resolution.sourceId, targetId, amount: 1, nature: 'normal', cardName: resolution.cardName, cardId: resolution.cardId })
        if (!host.state.dying && !host.state.damageChain) advanceToNextTarget(host)
        return
      }
      const requestId = askRespondCard(host, resolution, targetId, '杀', `${playerOf(host.state, resolution.sourceId).nickname}使用【南蛮入侵】，请打出【杀】`)
      resolution.effect = { kind: 'ask-slash', targetId, requestId }
      return
    }
    case '万箭齐发': {
      if (isCardIneffective(host.state, targetId, resolution.cardName, null, 'normal')) {
        advanceToNextTarget(host)
        return
      }
      if (cannotRespond) {
        resolveDamage(host, { sourceId: resolution.sourceId, targetId, amount: 1, nature: 'normal', cardName: resolution.cardName, cardId: resolution.cardId })
        if (!host.state.dying && !host.state.damageChain) advanceToNextTarget(host)
        return
      }
      const requestId = askRespondCard(host, resolution, targetId, '闪', `${playerOf(host.state, resolution.sourceId).nickname}使用【万箭齐发】，请打出【闪】`)
      resolution.effect = { kind: 'ask-dodge', targetId, requestId }
      return
    }
    case '决斗': {
      // 决斗由目标先出杀，然后双方轮流；先出不出来的一方受伤
      if (cannotRespond) {
        resolveDamage(host, { sourceId: resolution.sourceId, targetId, amount: 1, nature: 'normal', cardName: '决斗', cardId: resolution.cardId })
        if (!host.state.dying && !host.state.damageChain) advanceToNextTarget(host)
        return
      }
      const requestId = askRespondCard(host, resolution, targetId, '杀', `${playerOf(host.state, resolution.sourceId).nickname}对你使用【决斗】，请打出【杀】`)
      resolution.effect = {
        kind: 'duel', responderId: targetId, otherId: resolution.sourceId, requestId,
        slashRemaining: duelSlashCount(host.state, resolution.sourceId),
      }
      return
    }
    case '过河拆桥':
      askPickCard(host, resolution, targetId, 'discard')
      return
    case '顺手牵羊':
      askPickCard(host, resolution, targetId, 'steal')
      return
    case '五谷丰登':
      askHarvestPick(host, resolution, targetId)
      return
    case '火攻':
      askFireReveal(host, resolution, targetId)
      return
    case '借刀杀人':
      askBorrowedKnife(host, resolution, targetId)
      return
    default:
      advanceToNextTarget(host)
  }
}

/** 效果阶段收到「打出杀/闪」或「放弃」的响应。 */
export function resolveTrickEffectResponse(host: CardEngineHost, request: RespondCardRequest, response: GameResponse): void {
  const resolution = host.state.cardResolution
  if (!resolution || resolution.kind !== 'trick' || resolution.requestId !== request.id) throw new Error('锦囊效果 Request 已经过期')
  const validationError = validateResponse(request, response)
  if (validationError) throw new Error(validationError)
  const actionId = (response.payload as { actionId: string }).actionId

  let playedCardId: CardId | null = null
  if (actionId !== 'respond-pass') {
    if (!actionId.startsWith('respond-trick:')) throw new Error('响应 action 类型不匹配')
    playedCardId = actionId.slice('respond-trick:'.length)
    const responder = playerOf(host.state, response.playerId)
    if (!responder.zones.hand.includes(playedCardId) || host.state.cards[playedCardId]?.name !== request.requiredCardName) {
      throw new Error(`响应牌不是该玩家持有的${request.requiredCardName}`)
    }
  }

  host.state.pendingRequests = host.state.pendingRequests.filter((candidate) => candidate.id !== request.id)
  resolution.requestId = null
  host.state.decisions.push({
    index: host.state.decisions.length,
    requestId: request.id,
    playerId: response.playerId,
    kind: request.kind,
    payload: structuredClone(response.payload),
  })

  if (playedCardId) {
    const responder = playerOf(host.state, response.playerId)
    moveCard(host.state, playedCardId, { kind: 'hand', playerId: responder.id }, { kind: 'processingArea' })
    host.dispatch('CardResponded', { asking: false, playerId: responder.id, cardId: playedCardId, cardName: request.requiredCardName }, { sourceId: responder.id, cardIds: [playedCardId] })
    moveCard(host.state, playedCardId, { kind: 'processingArea' }, { kind: 'discardPile' })
  }

  const effect = resolution.effect
  if (!effect) throw new Error('锦囊效果状态缺失')

  if (effect.kind === 'ask-slash' || effect.kind === 'ask-dodge') {
    if (!playedCardId) {
      // 主公技：目标自己打不出时，同势力角色还有机会代打（激将 / 护驾）
      // requiredCardName 在这个分支只可能是杀或闪，收窄一下类型
      const needed = effect.kind === 'ask-slash' ? '杀' : '闪'
      if (askTrickSurrogate(host, resolution, effect, needed)) return
      resolution.effect = null
      resolveDamage(host, { sourceId: resolution.sourceId, targetId: effect.targetId, amount: 1, nature: 'normal', cardName: resolution.cardName, cardId: resolution.cardId })
      // 濒死时暂停，等救援结束后由 resumeTrickResolution 继续下一个目标
      if (!host.state.dying && !host.state.damageChain) advanceToNextTarget(host)
      return
    }
    advanceToNextTarget(host)
    return
  }

  if (effect.kind === 'borrowed-knife') {
    if (!playedCardId) {
      // 不出杀就把武器交给使用者
      const weapon = playerOf(host.state, effect.targetId).zones.equipment.weapon
      resolution.effect = null
      if (weapon) {
        moveCard(host.state, weapon, { kind: 'equipment', playerId: effect.targetId, slot: 'weapon' }, { kind: 'hand', playerId: resolution.sourceId })
        host.dispatch('CardMove', { cardId: weapon, reason: 'borrowed-knife' }, { sourceId: resolution.sourceId, targetId: effect.targetId, cardIds: [weapon] })
      }
      advanceToNextTarget(host)
      return
    }
    // 出了杀就走**完整的**杀结算：仁王盾要挡得住、无双要生效、流离要转得走。
    // 借刀杀人是单目标锦囊，所以先把它自己收掉，再开始那张【杀】——
    // 结算状态只有一份，不先收掉会被覆盖。
    const attackerId = effect.targetId
    const victimId = effect.victimId
    resolution.effect = null
    advanceToNextTarget(host)
    getEngineCallbacks()?.beginBorrowedSlash(host, attackerId, victimId, playedCardId)
    return
  }

  if (effect.kind === 'duel') {
    if (!playedCardId) {
      // 这一方出不出杀，由对方造成一点伤害
      resolution.effect = null
      resolveDamage(host, { sourceId: effect.otherId, targetId: effect.responderId, amount: 1, nature: 'normal', cardName: '决斗', cardId: resolution.cardId })
      if (!host.state.dying && !host.state.damageChain) advanceToNextTarget(host)
      return
    }
    if (effect.slashRemaining > 1) {
      const requestId = askRespondCard(host, resolution, effect.responderId, '杀', '【无双】仍在生效，请再打出一张【杀】')
      resolution.effect = { ...effect, requestId, slashRemaining: effect.slashRemaining - 1 }
      return
    }
    // 本轮要求的杀全部打出后才换对方
    const nextResponderId = effect.otherId
    const requestId = askRespondCard(host, resolution, nextResponderId, '杀', '【决斗】仍在继续，请打出【杀】')
    resolution.effect = {
      kind: 'duel', responderId: nextResponderId, otherId: effect.responderId, requestId,
      slashRemaining: duelSlashCount(host.state, effect.responderId),
    }
    return
  }

  throw new Error('当前锦囊效果不接受打出牌的响应')
}

/** 效果阶段收到「挑一张牌」的响应（过河拆桥 / 顺手牵羊）。 */
export function resolveTrickPickResponse(host: CardEngineHost, request: ChooseCardsRequest, response: GameResponse): void {
  const resolution = host.state.cardResolution
  if (!resolution || resolution.kind !== 'trick' || resolution.requestId !== request.id) throw new Error('锦囊选牌 Request 已经过期')
  const validationError = validateResponse(request, response)
  if (validationError) throw new Error(validationError)
  const effect = resolution.effect
  if (!effect) throw new Error('锦囊效果状态缺失')
  if (effect.kind === 'harvest') { resolveHarvestPick(host, request, response, effect); return }
  if (effect.kind === 'fire-reveal') { resolveFireReveal(host, request, response, effect); return }
  if (effect.kind === 'fire-discard') { resolveFireDiscard(host, request, response, effect); return }
  if (effect.kind !== 'pick-card') throw new Error('锦囊效果状态缺失')

  const [picked] = (response.payload as { cardIds: string[] }).cardIds
  const target = playerOf(host.state, effect.targetId)

  // 手牌是暗的：客户端选的是占位槽，真实 cardId 只在服务端这里解析
  let cardId: CardId
  let from: Parameters<typeof moveCard>[2]
  const hiddenIndex = target.zones.hand.findIndex((_, index) => hiddenHandSlot(effect.targetId, index) === picked)
  if (hiddenIndex >= 0) {
    cardId = target.zones.hand[hiddenIndex]
    from = { kind: 'hand', playerId: effect.targetId }
  } else if (target.zones.judgingArea.includes(picked)) {
    cardId = picked
    from = { kind: 'judgingArea', playerId: effect.targetId }
  } else {
    const slot = (Object.keys(target.zones.equipment) as Array<keyof typeof target.zones.equipment>)
      .find((key) => target.zones.equipment[key] === picked)
    if (!slot) throw new Error('选择的牌不在目标区域内')
    cardId = picked
    from = { kind: 'equipment', playerId: effect.targetId, slot }
  }

  host.state.pendingRequests = host.state.pendingRequests.filter((candidate) => candidate.id !== request.id)
  resolution.requestId = null
  host.state.decisions.push({
    index: host.state.decisions.length,
    requestId: request.id,
    playerId: response.playerId,
    kind: request.kind,
    payload: structuredClone(response.payload),
  })

  if (effect.mode === 'discard') {
    moveCard(host.state, cardId, from, { kind: 'discardPile' })
  } else {
    moveCard(host.state, cardId, from, { kind: 'hand', playerId: resolution.sourceId })
  }
  // 被拆掉或被顺走的装备同样算「失去装备」，白银狮子要回血
  if (from.kind === 'equipment') handleEquipmentLost(host, effect.targetId, cardId)
  host.dispatch('CardMove', { cardId, mode: effect.mode }, { sourceId: resolution.sourceId, targetId: effect.targetId, cardIds: [cardId] })
  resolution.effect = null
  advanceToNextTarget(host)
}

/** 濒死救援结束后，继续把剩下的目标结算完。 */
export function resumeTrickResolution(host: CardEngineHost): boolean {
  const resolution = host.state.cardResolution
  if (!resolution || resolution.kind !== 'trick') return false
  if (resolution.stage !== 'awaiting-effect' || resolution.requestId) return false
  if (host.state.dying || host.state.damageChain) return false
  advanceToNextTarget(host)
  return true
}

/** 记录一次响应决策并摘掉对应 Request。 */
function consumeRequest(host: CardEngineHost, resolution: TrickResolutionState, requestId: string, response: GameResponse, kind: string): void {
  host.state.pendingRequests = host.state.pendingRequests.filter((candidate) => candidate.id !== requestId)
  resolution.requestId = null
  host.state.decisions.push({
    index: host.state.decisions.length,
    requestId,
    playerId: response.playerId,
    kind,
    payload: structuredClone(response.payload),
  })
}

/** 五谷丰登：目标从亮出的牌里拿走一张。 */
function resolveHarvestPick(
  host: CardEngineHost,
  request: ChooseCardsRequest,
  response: GameResponse,
  effect: Extract<TrickEffectState, { kind: 'harvest' }>,
): void {
  const resolution = host.state.cardResolution
  if (!resolution || resolution.kind !== 'trick') throw new Error('锦囊结算已经结束')
  const [picked] = (response.payload as { cardIds: string[] }).cardIds
  if (!effect.revealedCardIds.includes(picked)) throw new Error('选择的牌不在亮出的牌中')
  consumeRequest(host, resolution, request.id, response, request.kind)
  moveCard(host.state, picked, { kind: 'processingArea' }, { kind: 'hand', playerId: effect.targetId })
  host.dispatch('GainCard', { cardId: picked }, { targetId: effect.targetId, cardIds: [picked] })
  resolution.effect = null
  advanceToNextTarget(host)
}

/** 火攻第一步：目标展示一张手牌，接着问使用者要不要弃同花色的牌。 */
function resolveFireReveal(
  host: CardEngineHost,
  request: ChooseCardsRequest,
  response: GameResponse,
  effect: Extract<TrickEffectState, { kind: 'fire-reveal' }>,
): void {
  const resolution = host.state.cardResolution
  if (!resolution || resolution.kind !== 'trick') throw new Error('锦囊结算已经结束')
  const [revealed] = (response.payload as { cardIds: string[] }).cardIds
  const target = playerOf(host.state, effect.targetId)
  if (!target.zones.hand.includes(revealed)) throw new Error('展示的牌不在目标手牌中')
  consumeRequest(host, resolution, request.id, response, request.kind)

  const suit = effectiveCardSuit(host.state, effect.targetId, revealed, skillIdsOf)
  // 展示是公开信息，但只公开这一张，其余手牌不能跟着泄露
  host.dispatch('CardResponded', { asking: false, playerId: effect.targetId, cardId: revealed, cardName: host.state.cards[revealed].name, revealed: true }, { targetId: effect.targetId, cardIds: [revealed] })

  const source = playerOf(host.state, resolution.sourceId)
  const payable = source.zones.hand.filter((cardId) => (
    effectiveCardSuit(host.state, resolution.sourceId, cardId, skillIdsOf) === suit && cardId !== revealed
  ))
  if (payable.length === 0) {
    resolution.effect = null
    advanceToNextTarget(host)
    return
  }
  const discardRequest: ChooseCardsRequest = {
    id: `request-fire-pay-${host.state.seq}-${host.state.decisions.length}`,
    kind: 'choose-cards',
    playerId: resolution.sourceId,
    prompt: `【火攻】：弃置一张${suit}牌以造成一点火焰伤害`,
    timeoutMs: 30_000,
    optional: true,
    cardIds: payable,
    hiddenCardSlots: [],
    min: 0,
    max: 1,
    purpose: 'card-effect',
  }
  host.state.pendingRequests.push(discardRequest)
  resolution.requestId = discardRequest.id
  resolution.effect = { kind: 'fire-discard', targetId: effect.targetId, revealedCardId: revealed, suit, requestId: discardRequest.id }
}

/** 火攻第二步：使用者弃同花色牌则造成一点火焰伤害。 */
function resolveFireDiscard(
  host: CardEngineHost,
  request: ChooseCardsRequest,
  response: GameResponse,
  effect: Extract<TrickEffectState, { kind: 'fire-discard' }>,
): void {
  const resolution = host.state.cardResolution
  if (!resolution || resolution.kind !== 'trick') throw new Error('锦囊结算已经结束')
  const picked = (response.payload as { cardIds: string[] }).cardIds
  const source = playerOf(host.state, resolution.sourceId)
  for (const cardId of picked) {
    if (!source.zones.hand.includes(cardId)) throw new Error('弃置的牌不在使用者手牌中')
    if (effectiveCardSuit(host.state, resolution.sourceId, cardId, skillIdsOf) !== effect.suit) throw new Error('弃置的牌花色不符')
  }
  consumeRequest(host, resolution, request.id, response, request.kind)
  resolution.effect = null

  if (picked.length === 0) {
    advanceToNextTarget(host)
    return
  }
  for (const cardId of picked) {
    moveCard(host.state, cardId, { kind: 'hand', playerId: resolution.sourceId }, { kind: 'discardPile' })
  }
  resolveDamage(host, { sourceId: resolution.sourceId, targetId: effect.targetId, amount: 1, nature: 'fire', cardName: '火攻', cardId: resolution.cardId })
  if (!host.state.dying && !host.state.damageChain) advanceToNextTarget(host)
}

/** 借刀杀人：目标选好受害者后，问他要不要真的出杀。 */
export function resolveBorrowedKnifeTarget(host: CardEngineHost, request: ChooseTargetsRequest, response: GameResponse): void {
  const resolution = host.state.cardResolution
  if (!resolution || resolution.kind !== 'trick' || resolution.requestId !== request.id) throw new Error('锦囊效果 Request 已经过期')
  const validationError = validateResponse(request, response)
  if (validationError) throw new Error(validationError)
  const effect = resolution.effect
  if (!effect || effect.kind !== 'borrowed-knife') throw new Error('锦囊效果状态缺失')
  const [victimId] = (response.payload as { targetIds: string[] }).targetIds
  consumeRequest(host, resolution, request.id, response, request.kind)

  const requestId = askRespondCard(
    host,
    resolution,
    effect.targetId,
    '杀',
    `【借刀杀人】：对${playerOf(host.state, victimId).nickname}打出【杀】，否则交出武器`,
  )
  resolution.effect = { ...effect, victimId, requestId }
}
