import { canUseCardAs } from './forced-identity'
import { multiCardGrantedAs } from './multi-card-viewas'
import { resolveDamage } from './damage'
import type { EventContext, GameEvent, GameEventName } from './events'
import type { ChooseCardsRequest, GameResponse, RespondCardRequest } from './requests'
import { validateResponse } from './requests'
import type { GameRng } from './rng'
import { skipPhase } from './turn'
import type { CardId, PlayerId, SanguoshaState, Suit } from './types'
import { effectiveCardName, moveCard } from './zones'
import { effectiveCardSuit, skillsOf, type SkillHost } from './skills/runtime'
import { NULLIFICATION_TIMEOUT_MS, nullificationCardIds } from './nullification'
import { GUHUO_RESPOND_ACTION, canGuhuoRespond, guhuoGrantedAs } from './guhuo-response'
import { responseViewAsOptions, skillIdsOf } from '../data/characters/standard'

/**
 * 判定引擎的宿主。
 *
 * 要求整个 SkillHost 而不只是 state/rng/dispatch：判定结束后的续接可能继续发问
 * （洛神判定为黑色就再问一次），改判窗口本身也要能挂起。
 */
export interface JudgmentEngineHost extends SkillHost {
  state: SanguoshaState
  rng: GameRng
  dispatch(
    name: GameEventName,
    payload?: Record<string, unknown>,
    metadata?: Omit<GameEvent, 'id' | 'seq' | 'name' | 'payload'>,
  ): EventContext
}

/** 判定的最终结果。花色和颜色是**修正后**的，不是印刷值。 */
export interface JudgmentOutcome {
  id: CardId
  name: string
  suit: Suit
  color: 'red' | 'black'
  rank: number
}

type JudgmentContinuation = (host: JudgmentEngineHost, judged: JudgmentOutcome, data: Record<string, unknown>) => void

/**
 * 判定结束之后要做什么。
 *
 * 用字符串 tag 而不是回调，是因为中间可能插进一个改判询问，
 * 而 Durable Object 在等回答时会休眠——闭包活不过休眠，字符串活得下来。
 */
const continuations = new Map<string, JudgmentContinuation>()

export function registerJudgmentContinuation(tag: string, run: JudgmentContinuation): void {
  if (continuations.has(tag)) throw new Error(`判定续接重复注册：${tag}`)
  continuations.set(tag, run)
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
 * 走一次判定。
 *
 * 判定分三段：翻牌 -> 逐人询问改判 -> 结算并跑续接。
 * **没有任何人能改判时（绝大多数牌局），三段在同一次调用里走完**，
 * 行为和以前的同步版本完全一样；有人能改判才会挂起等回答。
 *
 * 因为可能挂起，结果不能再靠返回值传出去，调用方要把「判定之后做什么」
 * 注册成一个续接并在这里给出 tag。
 */
export function performJudgment(
  host: JudgmentEngineHost,
  playerId: PlayerId,
  reason: string,
  continuation: { tag: string; data?: Record<string, unknown> },
): void {
  if (!continuations.has(continuation.tag)) throw new Error(`判定续接未注册：${continuation.tag}`)
  if (host.state.retrial) throw new Error('上一次判定的改判窗口还没结束')
  host.dispatch('JudgeStart', { playerId, reason }, { targetId: playerId })
  const judgeCardId = takeJudgmentCard(host)
  host.state.retrial = {
    playerId,
    reason,
    tag: continuation.tag,
    data: continuation.data ?? {},
    judgeCardId,
    // 改判从当前回合角色开始按座位顺序问，和无懈可击一致
    responderOrder: aliveOrderFromCurrent(host.state),
    responderIndex: 0,
    requestId: '',
  }
  askNextRetrial(host)
}

/** 某人现在能拿哪些牌来改判这次判定。空数组表示他这次插不上手。 */
function retrialCandidates(state: SanguoshaState, responderId: PlayerId, judgingPlayerId: PlayerId): CardId[] {
  const responder = state.players.find((candidate) => candidate.id === responderId)
  if (!responder?.alive) return []
  return skillsOf(state, responderId, skillIdsOf)
    .flatMap((runtime) => runtime.retrial?.(state, responderId, judgingPlayerId) ?? [])
}

/**
 * 找下一个能改判的人来问。
 *
 * 一个人都问不到就直接结算——这条路径覆盖了绝大多数牌局，
 * 保证没有改判技能在场时判定仍然是一次同步调用。
 */
function askNextRetrial(host: JudgmentEngineHost): void {
  const retrial = host.state.retrial
  if (!retrial) return
  while (retrial.responderIndex < retrial.responderOrder.length) {
    const responderId = retrial.responderOrder[retrial.responderIndex]
    const candidates = retrialCandidates(host.state, responderId, retrial.playerId)
    if (candidates.length === 0) { retrial.responderIndex += 1; continue }
    const judgeCard = host.state.cards[retrial.judgeCardId]
    const request: ChooseCardsRequest = {
      id: `request-retrial-${host.state.seq}-${host.state.decisions.length}-${retrial.responderIndex}`,
      kind: 'choose-cards',
      playerId: responderId,
      prompt: `${player(host.state, retrial.playerId).nickname}的【${retrial.reason}】判定翻出【${judgeCard.name}】，是否打出一张牌代替判定牌`,
      timeoutMs: 25_000,
      optional: true,
      cardIds: candidates,
      hiddenCardSlots: [],
      // min 为 0：不选就是放弃。optional 只影响界面，校验看的是 min
      min: 0,
      max: 1,
      purpose: 'retrial',
      retrial: {
        judgingPlayerId: retrial.playerId,
        reason: retrial.reason,
        cardName: judgeCard.name,
        suit: effectiveCardSuit(host.state, retrial.playerId, retrial.judgeCardId, skillIdsOf),
        rank: judgeCard.rank,
      },
    }
    host.state.pendingRequests.push(request)
    retrial.requestId = request.id
    return
  }
  finishJudgment(host)
}

/** 改判窗口关闭：算出最终花色、派发结果、跑续接。 */
function finishJudgment(host: JudgmentEngineHost): void {
  const retrial = host.state.retrial
  if (!retrial) return
  const { playerId, reason, judgeCardId, tag, data } = retrial
  const judgeCard = host.state.cards[judgeCardId]
  const suit = effectiveCardSuit(host.state, playerId, judgeCardId, skillIdsOf)
  const color = suit === 'heart' || suit === 'diamond' ? 'red' : 'black'
  host.dispatch('JudgeResult', { playerId, reason, judgeCardId, suit, rank: judgeCard.rank, color }, { targetId: playerId, cardIds: [judgeCardId] })
  host.dispatch('JudgeEnd', { playerId, reason, judgeCardId }, { targetId: playerId, cardIds: [judgeCardId] })
  moveCard(host.state, judgeCardId, { kind: 'processingArea' }, { kind: 'discardPile' })
  // 先清空再跑续接：续接里可能又发起一次判定（洛神连判）
  host.state.retrial = null
  const run = continuations.get(tag)
  if (!run) throw new Error(`判定续接未注册：${tag}`)
  run(host, { id: judgeCardId, name: judgeCard.name, suit, color, rank: judgeCard.rank }, data)
}

/** 处理改判的回答。选空数组＝放弃，选一张＝替换判定牌。 */
export function resolveRetrialResponse(host: JudgmentEngineHost, request: ChooseCardsRequest, response: GameResponse): void {
  const retrial = host.state.retrial
  if (!retrial || retrial.requestId !== request.id) throw new Error('改判 Request 已经过期')
  const validationError = validateResponse(request, response)
  if (validationError) throw new Error(validationError)
  const cardIds = (response.payload as { cardIds: string[] }).cardIds
  host.state.pendingRequests = host.state.pendingRequests.filter((candidate) => candidate.id !== request.id)
  host.state.decisions.push({ index: host.state.decisions.length, requestId: request.id, playerId: response.playerId, kind: request.kind, payload: structuredClone(response.payload) })
  retrial.requestId = ''

  if (cardIds.length === 0) {
    retrial.responderIndex += 1
    askNextRetrial(host)
    return
  }

  const replacementId = cardIds[0]
  const source = player(host.state, response.playerId)
  if (!source.zones.hand.includes(replacementId)) throw new Error('改判用的牌不在手牌里')
  // 旧判定牌进弃牌堆，新牌顶上。两张牌都在处理区停留过，牌张守恒不会破
  moveCard(host.state, retrial.judgeCardId, { kind: 'processingArea' }, { kind: 'discardPile' })
  moveCard(host.state, replacementId, { kind: 'hand', playerId: response.playerId }, { kind: 'processingArea' })
  retrial.judgeCardId = replacementId
  host.dispatch('CardResponded', { playerId: response.playerId, cardId: replacementId, cardName: host.state.cards[replacementId].name, reason: '改判' }, { sourceId: response.playerId, targetId: retrial.playerId, cardIds: [replacementId] })
  // 换了牌就重新从头问一遍：别人（以及他自己）可以对新的判定牌再改一次
  retrial.responderIndex = 0
  askNextRetrial(host)
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
    const hasLightning = candidate.zones.judgingArea.some((cardId) => effectiveCardName(state, cardId) === '闪电')
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

/**
 * 延时锦囊的判定。判定本身可能因为改判而挂起，所以结算写在续接里。
 *
 * 判定理由直接用锦囊名，界面上「判定【乐不思蜀】」就是这么来的。
 */
function applyDelayedEffect(host: JudgmentEngineHost, ownerId: PlayerId, delayedCardId: CardId): void {
  // 一律按「被当作什么用」结算：转化技可以把一张红桃当【乐不思蜀】放进判定区，
  // 那时候牌面上印的名字是无关的
  const delayedName = effectiveCardName(host.state, delayedCardId)
  performJudgment(host, ownerId, delayedName, { tag: DELAYED_TRICK_TAG, data: { ownerId, delayedCardId, delayedName } })
}

const DELAYED_TRICK_TAG = 'delayed-trick'

registerJudgmentContinuation(DELAYED_TRICK_TAG, (host, judged, data) => {
  const ownerId = data.ownerId as PlayerId
  const delayedCardId = data.delayedCardId as CardId
  const delayedName = data.delayedName as string

  if (delayedName === '乐不思蜀') {
    if (judged.suit !== 'heart') skipPhase(host.state, 'play')
    moveCard(host.state, delayedCardId, { kind: 'processingArea' }, { kind: 'discardPile' })
  } else if (delayedName === '兵粮寸断') {
    if (judged.suit !== 'club') skipPhase(host.state, 'draw')
    moveCard(host.state, delayedCardId, { kind: 'processingArea' }, { kind: 'discardPile' })
  } else if (delayedName === '闪电') {
    if (judged.suit === 'spade' && judged.rank >= 2 && judged.rank <= 9) {
      host.state.judgment = { playerId: ownerId, delayedCardId, stage: 'awaiting-damage' }
      resolveDamage(host, { targetId: ownerId, amount: 3, nature: 'thunder', cardName: '闪电', cardId: delayedCardId })
      if (!host.state.dying && !host.state.damageChain) finishLightningDamage(host)
    } else {
      moveCard(host.state, delayedCardId, { kind: 'processingArea' }, { kind: 'judgingArea', playerId: nextLightningTarget(host.state, ownerId) })
    }
  } else {
    moveCard(host.state, delayedCardId, { kind: 'processingArea' }, { kind: 'discardPile' })
    throw new Error(`未知延时锦囊：${delayedName}`)
  }
  // 判定区可能还压着别的延时锦囊，接着往下走
  if (!host.state.judgment && !host.state.retrial && !host.state.dying && !host.state.damageChain && host.state.status === 'playing') {
    processRemaining(host)
  }
})

function requestCurrentNullification(host: JudgmentEngineHost): void {
  const judgment = host.state.judgment
  if (!judgment || judgment.stage !== 'awaiting-nullification') return
  if (judgment.responderIndex >= judgment.responderOrder.length) {
    const cancelled = judgment.nullificationCount % 2 === 1
    const { playerId, delayedCardId } = judgment
    host.state.judgment = null
    if (cancelled) {
      moveCancelledDelayed(host, playerId, delayedCardId)
      if (!host.state.judgment && !host.state.dying && !host.state.damageChain && host.state.status === 'playing') processRemaining(host)
    } else {
      // 判定可能停在改判询问上，推进判定区的活交给续接，这里不能抢着做
      applyDelayedEffect(host, playerId, delayedCardId)
    }
    return
  }
  const responderId = judgment.responderOrder[judgment.responderIndex]
  // 死人、刚打出无懈的人都跳过；**手上没有无懈的人根本不问**——
  // 这里原来是不分青红皂白挨个问一遍，每张延时锦囊都要空转一整圈，
  // 判定阶段因此卡很久（用户报的「太繁琐」）。
  const cardIds = judgment.lastNullifierId === responderId ? [] : [...new Set([
    ...nullificationCardIds(host.state, responderId),
    ...responseViewAsOptions(host.state, responderId, '无懈可击').map((option) => option.cardId),
  ])]
  const canGuhuo = judgment.lastNullifierId !== responderId
    && canGuhuoRespond(host.state, responderId, '无懈可击', skillIdsOf)
  if (cardIds.length === 0 && !canGuhuo) {
    judgment.responderIndex += 1
    requestCurrentNullification(host)
    return
  }
  const actionIds = cardIds
    .filter((cardId) => canUseCardAs(host.state, responderId, cardId, '无懈可击'))
    .map((cardId) => `respond-nullification:${cardId}`)
  actionIds.push('respond-pass')
  if (canGuhuo) actionIds.push(GUHUO_RESPOND_ACTION)
  const request: RespondCardRequest = {
    id: `request-judge-${host.state.seq}-${host.state.decisions.length}-${judgment.responderIndex}`,
    kind: 'respond-card',
    playerId: responderId,
    prompt: `是否对判定区的【${host.state.cards[judgment.delayedCardId].name}】使用【无懈可击】`,
    timeoutMs: NULLIFICATION_TIMEOUT_MS,
    optional: true,
    actionIds,
    requiredCardName: '无懈可击',
  }
  host.state.pendingRequests.push(request)
  judgment.requestId = request.id
}

function processRemaining(host: JudgmentEngineHost): void {
  const owner = player(host.state, host.state.currentPlayerId)
  if (host.state.judgment || host.state.retrial || host.state.dying || host.state.damageChain || owner.zones.judgingArea.length === 0) return
  // 本回合判过的不再判：闪电判定失败后可能又转回自己的判定区（场上没有别人
  // 能接手时），不记账就会在同一个判定阶段里把它反复判下去，直接卡死。
  const judged = host.state.judgedDelayedCards ?? (host.state.judgedDelayedCards = [])
  const delayedCardId = [...owner.zones.judgingArea].reverse().find((cardId) => !judged.includes(cardId))
  if (!delayedCardId) return
  judged.push(delayedCardId)
  moveCard(host.state, delayedCardId, { kind: 'judgingArea', playerId: owner.id }, { kind: 'processingArea' })
  host.state.judgment = {
    playerId: owner.id,
    delayedCardId,
    stage: 'awaiting-nullification',
    responderOrder: aliveOrderFromCurrent(host.state),
    responderIndex: 0,
    nullificationCount: 0,
    declinedAllIds: [],
    lastNullifierId: null,
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
    // 蛊惑成立的那一瞬间，那张牌被临时报成【无懈可击】，沿用这里原有的校验
    const granted = guhuoGrantedAs(host.state, response.playerId, cardId) === '无懈可击'
      || multiCardGrantedAs(host.state, response.playerId, cardId) === '无懈可击'
    const converted = responseViewAsOptions(host.state, response.playerId, '无懈可击')
      .some((option) => option.cardId === cardId)
    if (!responder.zones.hand.includes(cardId) || (!granted && !converted && host.state.cards[cardId]?.name !== '无懈可击')) {
      throw new Error('响应牌不是该玩家持有的无懈可击')
    }
  }
  host.state.pendingRequests = host.state.pendingRequests.filter((candidate) => candidate.id !== request.id)
  host.state.decisions.push({ index: host.state.decisions.length, requestId: request.id, playerId: response.playerId, kind: request.kind, payload: structuredClone(response.payload) })
  if (cardId) {
    moveCard(host.state, cardId, { kind: 'hand', playerId: response.playerId }, { kind: 'processingArea' })
    host.dispatch('CardResponded', { playerId: response.playerId, cardId, cardName: '无懈可击' }, { sourceId: response.playerId, targetId: judgment.playerId, cardIds: [cardId] })
    moveCard(host.state, cardId, { kind: 'processingArea' }, { kind: 'discardPile' })
    judgment.nullificationCount += 1
    // 记下是谁打的：下一圈跳过他自己，别让人对自己刚打出的无懈再问一次
    judgment.lastNullifierId = response.playerId
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
  // 改判窗口开着的时候什么都不做：那一步在等玩家回答，不是卡住了
  if (!host.state.judgment || host.state.retrial || host.state.dying || host.state.damageChain) return
  if (host.state.judgment.stage === 'awaiting-damage') finishLightningDamage(host)
  if (!host.state.judgment && !host.state.retrial && host.state.status === 'playing') processRemaining(host)
}
