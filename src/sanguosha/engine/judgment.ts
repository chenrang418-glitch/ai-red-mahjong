import { resolveDamage } from './damage'
import type { EventContext, GameEvent, GameEventName } from './events'
import type { GameResponse, RespondCardRequest } from './requests'
import { validateResponse } from './requests'
import type { GameRng } from './rng'
import { skipPhase } from './turn'
import type { CardId, PlayerId, SanguoshaState } from './types'
import { moveCard } from './zones'

export interface JudgmentEngineHost {
  state: SanguoshaState
  rng: GameRng
  dispatch(
    name: GameEventName,
    payload?: Record<string, unknown>,
    metadata?: Omit<GameEvent, 'id' | 'seq' | 'name' | 'payload'>,
  ): EventContext
}

function player(state: SanguoshaState, playerId: PlayerId) {
  const found = state.players.find((candidate) => candidate.id === playerId)
  if (!found) throw new Error(`玩家不存在：${playerId}`)
  return found
}

function aliveOrderFromCurrent(state: SanguoshaState): PlayerId[] {
  const current = player(state, state.currentPlayerId)
  const result: PlayerId[] = []
  for (let offset = 0; offset < state.players.length; offset += 1) {
    const candidate = state.players[(current.seat + offset) % state.players.length]
    if (candidate.alive) result.push(candidate.id)
  }
  return result
}

/**
 * 走一次完整判定并返回判定牌。
 *
 * 抽出来给八卦阵这类「不在判定区、但要用判定结果」的效果复用；
 * 之后司马懿【鬼才】这种改判技能也挂在 JudgeResult 时机上，只改这一处。
 */
export function performJudgment(host: JudgmentEngineHost, playerId: PlayerId, reason: string) {
  host.dispatch('JudgeStart', { playerId, reason }, { targetId: playerId })
  const judgeCardId = takeJudgmentCard(host)
  const judgeCard = host.state.cards[judgeCardId]
  host.dispatch('JudgeResult', { playerId, reason, judgeCardId, suit: judgeCard.suit, rank: judgeCard.rank, color: judgeCard.color }, { targetId: playerId, cardIds: [judgeCardId] })
  host.dispatch('JudgeEnd', { playerId, reason, judgeCardId }, { targetId: playerId, cardIds: [judgeCardId] })
  moveCard(host.state, judgeCardId, { kind: 'processingArea' }, { kind: 'discardPile' })
  return judgeCard
}

function takeJudgmentCard(host: JudgmentEngineHost): CardId {
  if (host.state.zones.drawPile.length === 0) {
    if (host.state.zones.discardPile.length === 0) throw new Error('没有可用于判定的牌')
    host.state.zones.drawPile.push(...host.rng.shuffle(host.state.zones.discardPile))
    host.state.zones.discardPile.length = 0
  }
  const cardId = host.state.zones.drawPile[0]
  moveCard(host.state, cardId, { kind: 'drawPile' }, { kind: 'processingArea' })
  return cardId
}

function nextLightningTarget(state: SanguoshaState, ownerId: PlayerId): PlayerId {
  const owner = player(state, ownerId)
  for (let offset = 1; offset < state.players.length; offset += 1) {
    const candidate = state.players[(owner.seat + offset) % state.players.length]
    const hasLightning = candidate.zones.judgingArea.some((cardId) => state.cards[cardId]?.name === '闪电')
    if (candidate.alive && !hasLightning) return candidate.id
  }
  return ownerId
}

function moveCancelledDelayed(host: JudgmentEngineHost, ownerId: PlayerId, delayedCardId: CardId): void {
  if (host.state.cards[delayedCardId].name === '闪电') {
    moveCard(host.state, delayedCardId, { kind: 'processingArea' }, { kind: 'judgingArea', playerId: nextLightningTarget(host.state, ownerId) })
  } else moveCard(host.state, delayedCardId, { kind: 'processingArea' }, { kind: 'discardPile' })
}

function finishLightningDamage(host: JudgmentEngineHost): void {
  const judgment = host.state.judgment
  if (!judgment || judgment.stage !== 'awaiting-damage') return
  if (host.state.zones.processingArea.includes(judgment.delayedCardId)) {
    moveCard(host.state, judgment.delayedCardId, { kind: 'processingArea' }, { kind: 'discardPile' })
  }
  host.state.judgment = null
}

function applyDelayedEffect(host: JudgmentEngineHost, ownerId: PlayerId, delayedCardId: CardId): void {
  const delayed = host.state.cards[delayedCardId]
  host.dispatch('JudgeStart', { playerId: ownerId, delayedCardId, delayedCardName: delayed.name }, { targetId: ownerId, cardIds: [delayedCardId], phase: 'judge' })
  const judgeCardId = takeJudgmentCard(host)
  const judgeCard = host.state.cards[judgeCardId]
  host.dispatch('JudgeResult', { playerId: ownerId, delayedCardId, judgeCardId, suit: judgeCard.suit, rank: judgeCard.rank }, { targetId: ownerId, cardIds: [judgeCardId], phase: 'judge' })
  host.dispatch('JudgeEnd', { playerId: ownerId, delayedCardId, judgeCardId }, { targetId: ownerId, cardIds: [judgeCardId], phase: 'judge' })
  moveCard(host.state, judgeCardId, { kind: 'processingArea' }, { kind: 'discardPile' })

  if (delayed.name === '乐不思蜀') {
    if (judgeCard.suit !== 'heart') skipPhase(host.state, 'play')
    moveCard(host.state, delayedCardId, { kind: 'processingArea' }, { kind: 'discardPile' })
  } else if (delayed.name === '兵粮寸断') {
    if (judgeCard.suit !== 'club') skipPhase(host.state, 'draw')
    moveCard(host.state, delayedCardId, { kind: 'processingArea' }, { kind: 'discardPile' })
  } else if (delayed.name === '闪电') {
    if (judgeCard.suit === 'spade' && judgeCard.rank >= 2 && judgeCard.rank <= 9) {
      host.state.judgment = { playerId: ownerId, delayedCardId, stage: 'awaiting-damage' }
      resolveDamage(host, { targetId: ownerId, amount: 3, nature: 'thunder', cardName: '闪电', cardId: delayedCardId })
      if (!host.state.dying && !host.state.damageChain) finishLightningDamage(host)
    } else {
      moveCard(host.state, delayedCardId, { kind: 'processingArea' }, { kind: 'judgingArea', playerId: nextLightningTarget(host.state, ownerId) })
    }
  } else {
    moveCard(host.state, delayedCardId, { kind: 'processingArea' }, { kind: 'discardPile' })
    throw new Error(`未知延时锦囊：${delayed.name}`)
  }
}

function requestCurrentNullification(host: JudgmentEngineHost): void {
  const judgment = host.state.judgment
  if (!judgment || judgment.stage !== 'awaiting-nullification') return
  if (judgment.responderIndex >= judgment.responderOrder.length) {
    const cancelled = judgment.nullificationCount % 2 === 1
    const { playerId, delayedCardId } = judgment
    host.state.judgment = null
    if (cancelled) moveCancelledDelayed(host, playerId, delayedCardId)
    else applyDelayedEffect(host, playerId, delayedCardId)
    if (!host.state.judgment && !host.state.dying && !host.state.damageChain && host.state.status === 'playing') processRemaining(host)
    return
  }
  const responderId = judgment.responderOrder[judgment.responderIndex]
  const responder = player(host.state, responderId)
  const actionIds = responder.zones.hand
    .filter((cardId) => host.state.cards[cardId]?.name === '无懈可击')
    .map((cardId) => `respond-nullification:${cardId}`)
  actionIds.push('respond-pass')
  const request: RespondCardRequest = {
    id: `request-judge-${host.state.seq}-${host.state.decisions.length}-${judgment.responderIndex}`,
    kind: 'respond-card',
    playerId: responderId,
    prompt: `是否对判定区的【${host.state.cards[judgment.delayedCardId].name}】使用【无懈可击】`,
    timeoutMs: 30_000,
    optional: true,
    actionIds,
    requiredCardName: '无懈可击',
  }
  host.state.pendingRequests.push(request)
  judgment.requestId = request.id
}

function processRemaining(host: JudgmentEngineHost): void {
  const owner = player(host.state, host.state.currentPlayerId)
  if (host.state.judgment || host.state.dying || host.state.damageChain || owner.zones.judgingArea.length === 0) return
  const delayedCardId = owner.zones.judgingArea.at(-1)!
  moveCard(host.state, delayedCardId, { kind: 'judgingArea', playerId: owner.id }, { kind: 'processingArea' })
  host.state.judgment = {
    playerId: owner.id,
    delayedCardId,
    stage: 'awaiting-nullification',
    responderOrder: aliveOrderFromCurrent(host.state),
    responderIndex: 0,
    nullificationCount: 0,
    requestId: '',
  }
  requestCurrentNullification(host)
}

export function resolveJudgmentResponse(host: JudgmentEngineHost, request: RespondCardRequest, response: GameResponse): void {
  const judgment = host.state.judgment
  if (!judgment || judgment.stage !== 'awaiting-nullification' || judgment.requestId !== request.id) throw new Error('判定无懈 Request 已经过期')
  const validationError = validateResponse(request, response)
  if (validationError) throw new Error(validationError)
  const actionId = (response.payload as { actionId: string }).actionId
  let cardId: string | null = null
  if (actionId !== 'respond-pass') {
    if (!actionId.startsWith('respond-nullification:')) throw new Error('响应 action 类型不匹配')
    cardId = actionId.slice('respond-nullification:'.length)
    const responder = player(host.state, response.playerId)
    if (!responder.zones.hand.includes(cardId) || host.state.cards[cardId]?.name !== '无懈可击') throw new Error('响应牌不是该玩家持有的无懈可击')
  }
  host.state.pendingRequests = host.state.pendingRequests.filter((candidate) => candidate.id !== request.id)
  host.state.decisions.push({ index: host.state.decisions.length, requestId: request.id, playerId: response.playerId, kind: request.kind, payload: structuredClone(response.payload) })
  if (cardId) {
    moveCard(host.state, cardId, { kind: 'hand', playerId: response.playerId }, { kind: 'processingArea' })
    host.dispatch('CardResponded', { playerId: response.playerId, cardId, cardName: '无懈可击' }, { sourceId: response.playerId, targetId: judgment.playerId, cardIds: [cardId] })
    moveCard(host.state, cardId, { kind: 'processingArea' }, { kind: 'discardPile' })
    judgment.nullificationCount += 1
    judgment.responderIndex = 0
  } else judgment.responderIndex += 1
  judgment.requestId = ''
  requestCurrentNullification(host)
}

export function beginJudgmentPhase(host: JudgmentEngineHost): void {
  if (host.state.phase !== 'judge') throw new Error('当前不是判定阶段')
  processRemaining(host)
}

export function resumeJudgment(host: JudgmentEngineHost): void {
  if (!host.state.judgment || host.state.dying || host.state.damageChain) return
  if (host.state.judgment.stage === 'awaiting-damage') finishLightningDamage(host)
  if (!host.state.judgment && host.state.status === 'playing') processRemaining(host)
}
