import { drawCards } from './draw'
import type { EventContext, GameEvent, GameEventName } from './events'
import { checkIdentityVictory } from './modes/identity'
import type { GameResponse, RescueRequest } from './requests'
import { validateResponse } from './requests'
import { recover } from './recover'
import { adjustDamageAmount } from './equipment'
import type { GameRng } from './rng'
import type { CardId, DamageNature, EquipmentSlot, PlayerId, PlayerState, SanguoshaState } from './types'
import { moveCard } from './zones'

export interface DamageOptions {
  sourceId?: PlayerId | null
  targetId: PlayerId
  amount?: number
  nature?: DamageNature
  /** 造成这次伤害的牌名。装备特效要靠它区分「【杀】造成的伤害」和别的伤害。 */
  cardName?: string | null
  /** 造成这次伤害的实体牌。奸雄这类「获得造成伤害的牌」的技能要靠它定位。 */
  cardId?: CardId | null
}

interface InternalDamageOptions extends DamageOptions {
  chainTransfer?: boolean
}

export interface DamageEngineHost {
  state: SanguoshaState
  rng: GameRng
  dispatch(
    name: GameEventName,
    payload?: Record<string, unknown>,
    metadata?: Omit<GameEvent, 'id' | 'seq' | 'name' | 'payload'>,
  ): EventContext
}

const EQUIPMENT_SLOTS: readonly EquipmentSlot[] = ['weapon', 'armor', 'offensiveHorse', 'defensiveHorse']

function player(state: SanguoshaState, playerId: PlayerId): PlayerState {
  const found = state.players.find((candidate) => candidate.id === playerId)
  if (!found) throw new Error(`玩家不存在：${playerId}`)
  return found
}

function amountAfter(context: EventContext): number {
  const amount = context.event.payload.amount
  if (typeof amount !== 'number' || !Number.isInteger(amount) || amount < 0) throw new Error('伤害事件产生了非法伤害值')
  return amount
}

function dispatchDamageTiming(
  host: DamageEngineHost,
  name: GameEventName,
  sourceId: PlayerId | null,
  targetId: PlayerId,
  amount: number,
  nature: DamageNature,
  cardId: CardId | null = null,
): EventContext {
  return host.dispatch(
    name,
    { amount, cardId },
    { sourceId: sourceId ?? undefined, targetId, damageNature: nature, cardIds: cardId ? [cardId] : undefined },
  )
}

function rescueOrder(state: SanguoshaState): PlayerId[] {
  const current = player(state, state.currentPlayerId)
  const order: PlayerId[] = []
  for (let offset = 0; offset < state.players.length; offset += 1) {
    const candidate = state.players[(current.seat + offset) % state.players.length]
    if (candidate.alive) order.push(candidate.id)
  }
  return order
}

function chainedTargetsAfter(state: SanguoshaState, targetId: PlayerId): PlayerId[] {
  const target = player(state, targetId)
  const result: PlayerId[] = []
  for (let offset = 1; offset < state.players.length; offset += 1) {
    const candidate = state.players[(target.seat + offset) % state.players.length]
    if (candidate.alive && candidate.chained) result.push(candidate.id)
  }
  return result
}

function rescueActionIds(state: SanguoshaState, responderId: PlayerId, dyingPlayerId: PlayerId): string[] {
  const responder = player(state, responderId)
  const usable = responder.zones.hand.filter((cardId) => {
    const name = state.cards[cardId]?.name
    return name === '桃' || (name === '酒' && responderId === dyingPlayerId)
  })
  return [...usable.map((cardId) => `rescue-card:${cardId}`), 'rescue-pass']
}

function removePendingRescue(state: SanguoshaState): void {
  if (!state.dying?.requestId) return
  state.pendingRequests = state.pendingRequests.filter((request) => request.id !== state.dying!.requestId)
  state.dying.requestId = null
}

function requestCurrentRescuer(host: DamageEngineHost): void {
  const dying = host.state.dying
  if (!dying) return
  const target = player(host.state, dying.playerId)
  if (target.hp > 0) {
    host.dispatch('QuitDying', { playerId: target.id, hp: target.hp }, { targetId: target.id })
    host.state.dying = null
    return
  }
  if (dying.responderIndex >= dying.responderOrder.length) {
    resolveDeath(host, dying.playerId, dying.sourceId)
    return
  }

  const responderId = dying.responderOrder[dying.responderIndex]
  const ask = host.dispatch(
    'AskForPeach',
    { responderId, dyingPlayerId: target.id, requiredRecover: 1 - target.hp },
    { sourceId: responderId, targetId: target.id },
  )
  const request: RescueRequest = {
    id: `request-${ask.event.seq}`,
    kind: 'rescue',
    playerId: responderId,
    prompt: `${target.nickname}濒死，需要回复至至少 1 点体力`,
    timeoutMs: 30_000,
    optional: true,
    dyingPlayerId: target.id,
    actionIds: rescueActionIds(host.state, responderId, target.id),
    requiredRecover: 1 - target.hp,
  }
  host.state.pendingRequests.push(request)
  dying.requestId = request.id
}

function discardOwnedCards(host: DamageEngineHost, owner: PlayerState, includeJudgingArea: boolean): void {
  for (const cardId of [...owner.zones.hand]) {
    moveCard(host.state, cardId, { kind: 'hand', playerId: owner.id }, { kind: 'discardPile' })
  }
  for (const slot of EQUIPMENT_SLOTS) {
    const cardId = owner.zones.equipment[slot]
    if (cardId) moveCard(host.state, cardId, { kind: 'equipment', playerId: owner.id, slot }, { kind: 'discardPile' })
  }
  if (includeJudgingArea) {
    for (const cardId of [...owner.zones.judgingArea]) {
      moveCard(host.state, cardId, { kind: 'judgingArea', playerId: owner.id }, { kind: 'discardPile' })
    }
  }
}

function resolveDeath(host: DamageEngineHost, playerId: PlayerId, sourceId: PlayerId | null): void {
  removePendingRescue(host.state)
  const dead = player(host.state, playerId)
  host.dispatch('BeforeDeath', { playerId, sourceId }, { sourceId: sourceId ?? undefined, targetId: playerId })
  if (dead.hp > 0) {
    host.state.dying = null
    host.dispatch('QuitDying', { playerId, hp: dead.hp }, { targetId: playerId })
    return
  }
  // BeforeDeath 技能必须把角色实际回复到存活体力；仅取消事件不能形成 0 体力悬空状态。

  dead.alive = false
  dead.identityRevealed = true
  discardOwnedCards(host, dead, true)
  host.dispatch('Death', { playerId, sourceId, identity: dead.identity }, { sourceId: sourceId ?? undefined, targetId: playerId })
  host.state.dying = null

  const killer = sourceId ? host.state.players.find((candidate) => candidate.id === sourceId && candidate.alive) : undefined
  if (dead.identity === 'rebel' && killer) {
    drawCards(host.state, host.rng, killer.id, 3, (name, payload) => { host.dispatch(name, payload) })
  } else if (dead.identity === 'loyalist' && killer?.identity === 'lord') {
    discardOwnedCards(host, killer, false)
  }

  const result = checkIdentityVictory(host.state.players)
  if (result) {
    host.state.result = result
    host.state.status = 'game-over'
    for (const candidate of host.state.players) candidate.identityRevealed = true
    host.state.pendingRequests = []
    host.state.damageChain = null
  }
}

function resolveSingleDamage(host: DamageEngineHost, options: InternalDamageOptions): void {
  if (host.state.status !== 'playing') throw new Error('只有进行中的牌局可以造成伤害')
  if (host.state.dying) throw new Error('当前濒死流程尚未结束')
  if (host.state.damageChain && !options.chainTransfer) throw new Error('属性伤害传导尚未结束')
  const target = player(host.state, options.targetId)
  if (!target.alive) throw new Error('不能对死亡角色造成伤害')
  const sourceId = options.sourceId ?? null
  if (sourceId) player(host.state, sourceId)
  const nature = options.nature ?? 'normal'
  let amount = options.amount ?? 1
  if (!Number.isInteger(amount) || amount <= 0) throw new Error('伤害值必须是正整数')

  // 装备的数值修正放在技能时机之前：古锭刀 / 藤甲加成、白银狮子封顶都是牌本身的规则，
  // 技能仍然可以在随后的时机里继续改或者直接取消。
  // 裸衣：本回合【杀】和【决斗】伤害 +1。
  // 必须加在 adjustDamageAmount 之前，白银狮子的封顶才仍然是最后一步。
  if (sourceId && (options.cardName === '杀' || options.cardName === '决斗')) {
    const source = host.state.players.find((player) => player.id === sourceId)
    if (source?.marks.luoyi) amount += 1
  }
  amount = adjustDamageAmount(host.state, sourceId, target.id, amount, nature, options.cardName ?? null)
  if (amount <= 0) return

  const cardId = options.cardId ?? null
  for (const timing of ['BeforeDamage', 'DamageCaused', 'DamageInflicted'] as const) {
    const context = dispatchDamageTiming(host, timing, sourceId, target.id, amount, nature, cardId)
    if (context.cancelled) return
    amount = amountAfter(context)
    if (amount === 0) return
  }

  if (!options.chainTransfer && nature !== 'normal' && target.chained) {
    const remainingTargetIds = chainedTargetsAfter(host.state, target.id)
    for (const chained of host.state.players.filter((candidate) => candidate.alive && candidate.chained)) chained.chained = false
    if (remainingTargetIds.length > 0) host.state.damageChain = { sourceId, nature, amount, remainingTargetIds }
  }

  target.hp -= amount
  dispatchDamageTiming(host, 'Damaged', sourceId, target.id, amount, nature, cardId)
  dispatchDamageTiming(host, 'AfterDamage', sourceId, target.id, amount, nature, cardId)
  if (target.hp > 0) return

  enterDying(host, target.id, sourceId, nature)
}

/**
 * 进入濒死并开始求桃。
 *
 * 伤害之外也会用到——技能造成的「失去体力」同样可能把人打到 0 体力，
 * 那时候必须走同一条路，不能让技能自己判死。
 */
export function enterDying(host: DamageEngineHost, playerId: PlayerId, sourceId: PlayerId | null = null, nature: DamageNature = 'normal'): void {
  const target = player(host.state, playerId)
  if (!target.alive || target.hp > 0) return
  if (host.state.dying) throw new Error('已有濒死流程正在进行')
  host.state.dying = {
    playerId,
    sourceId,
    damageNature: nature,
    responderOrder: rescueOrder(host.state),
    responderIndex: 0,
    requestId: null,
  }
  host.dispatch('EnterDying', { playerId, hp: target.hp }, { sourceId: sourceId ?? undefined, targetId: playerId, damageNature: nature })
  requestCurrentRescuer(host)
}

export function resolveDamage(host: DamageEngineHost, options: DamageOptions): void {
  resolveSingleDamage(host, options)
  if (!host.state.dying) resumeDamageChain(host)
}

/** 濒死流程结束后继续同一批属性传导；每名目标仍独立经过伤害时机。 */
export function resumeDamageChain(host: DamageEngineHost): void {
  while (host.state.damageChain && !host.state.dying && host.state.status === 'playing') {
    const chain = host.state.damageChain
    const targetId = chain.remainingTargetIds.shift()
    if (!targetId) {
      host.state.damageChain = null
      return
    }
    if (!player(host.state, targetId).alive) continue
    resolveSingleDamage(host, {
      sourceId: chain.sourceId,
      targetId,
      amount: chain.amount,
      nature: chain.nature,
      chainTransfer: true,
    })
  }
}

export function resolveRescueResponse(host: DamageEngineHost, request: RescueRequest, response: GameResponse): void {
  const dying = host.state.dying
  if (!dying || dying.requestId !== request.id) throw new Error('濒死 Request 已经过期')
  const validationError = validateResponse(request, response)
  if (validationError) throw new Error(validationError)
  const actionId = (response.payload as { actionId: string }).actionId
  removePendingRescue(host.state)
  host.state.decisions.push({
    index: host.state.decisions.length,
    requestId: request.id,
    playerId: response.playerId,
    kind: request.kind,
    payload: structuredClone(response.payload),
  })

  if (actionId === 'rescue-pass') {
    dying.responderIndex += 1
    requestCurrentRescuer(host)
    return
  }

  const cardId = actionId.slice('rescue-card:'.length)
  const responder = player(host.state, response.playerId)
  if (!responder.zones.hand.includes(cardId) || !request.actionIds.includes(actionId)) throw new Error('救援牌不属于响应玩家')
  const card = host.state.cards[cardId]
  if (!card || (card.name !== '桃' && !(card.name === '酒' && responder.id === dying.playerId))) throw new Error('该牌不能用于当前救援')
  moveCard(host.state, cardId, { kind: 'hand', playerId: responder.id }, { kind: 'processingArea' })
  host.dispatch('CardResponded', { playerId: responder.id, cardId, cardName: card.name }, { sourceId: responder.id, targetId: dying.playerId, cardIds: [cardId] })
  moveCard(host.state, cardId, { kind: 'processingArea' }, { kind: 'discardPile' })
  const target = player(host.state, dying.playerId)
  recover(host, target.id, 1, responder.id)
  requestCurrentRescuer(host)
}
