import { reshuffleDrawPile } from './deck'
import { canUseCardAs } from './forced-identity'
import { delayedTrickHitsForPlayer } from './delayed-trick-rules'
import { MULTI_VIEWAS_ACTION, canMultiCardViewAs, multiCardGrantedAs } from './multi-card-viewas'
import { resolveDamage } from './damage'
import type { EventContext, GameEvent, GameEventName } from './events'
import type { ChooseCardsRequest, GameResponse, RespondCardRequest } from './requests'
import { validateResponse } from './requests'
import type { GameRng } from './rng'
import { retainJudgmentCard, shouldRetainJudgment } from './judgment-retention'
import { movePickedCard } from './card-pick'
import { isJudgmentAreaAbolished } from './judgment-area'
import { skipPhase } from './turn'
import type { CardId, PlayerId, SanguoshaState, Suit } from './types'
import { effectiveCardName, locateOwnedCard, moveCard } from './zones'
import { effectiveCardSuit, effectiveJudgmentRank, overrideJudgmentSuitOf, skillsOf, type SkillHost } from './skills/runtime'
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
  const judgeCardId = forcedJudgmentCard(host, playerId) ?? takeJudgmentCard(host)
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
  const runtimes = skillsOf(state, responderId, skillIdsOf)
  const candidates = runtimes.flatMap((runtime) => runtime.retrial?.(state, responderId, judgingPlayerId) ?? [])
  if (state.zones.drawPile.length && runtimes.some((runtime) => runtime.retrialDrawPileTop?.(state, responderId, judgingPlayerId)))
    candidates.push(state.zones.drawPile[0])
  return [...new Set(candidates)]
}

/** 有没有人强制指定了这次判定牌（张宝【咒缚】）。第一个给出结果的生效。 */
function forcedJudgmentCard(host: JudgmentEngineHost, judgingPlayerId: PlayerId): CardId | null {
  for (const owner of host.state.players) {
    if (!owner.alive) continue
    for (const runtime of skillsOf(host.state, owner.id, skillIdsOf)) {
      const cardId = runtime.forcedJudgmentCard?.(host, owner.id, judgingPlayerId)
      if (cardId) return cardId
    }
  }
  return null
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
    const askId = skillsOf(host.state, responderId, skillIdsOf)
      .map((runtime) => runtime.retrialDecidedBy?.(host.state, responderId, retrial.playerId))
      .find((id): id is PlayerId => !!id) ?? responderId
    retrial.sourceId = responderId
    const request: ChooseCardsRequest = {
      id: `request-retrial-${host.state.seq}-${host.state.decisions.length}-${retrial.responderIndex}`,
      kind: 'choose-cards',
      playerId: askId,
      prompt: `${player(host.state, retrial.playerId).nickname}的【${retrial.reason}】判定翻出【${judgeCard.name}】，是否用${askId === responderId ? '' : `${player(host.state, responderId).nickname}的`}一张牌代替判定牌`,
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
  const { playerId, judgeCardId } = retrial
  const suit = overrideJudgmentSuitOf(host.state, playerId, effectiveCardSuit(host.state, playerId, judgeCardId, skillIdsOf), skillIdsOf)
  for (const owner of host.state.players) {
    if (!owner.alive || !owner.characterId) continue
    for (const runtime of skillsOf(host.state, owner.id, skillIdsOf)) {
      if (runtime.beforeJudgmentResult?.(host, owner.id, judgeCardId, suit)) return
    }
  }
  completeJudgment(host, suit, effectiveJudgmentRank(host.state, playerId, judgeCardId, skillIdsOf))
}

/** 完成一个已翻开的判定结果；交互式结果改写在回答后从这里续接。 */
export function resumeJudgmentResult(host: JudgmentEngineHost, suit: Suit): void {
  const retrial = host.state.retrial
  if (!retrial) throw new Error('判定结果改写已经过期')
  completeJudgment(host, overrideJudgmentSuitOf(host.state, retrial.playerId, suit, skillIdsOf), effectiveJudgmentRank(host.state, retrial.playerId, retrial.judgeCardId, skillIdsOf))
}

function completeJudgment(host: JudgmentEngineHost, suit: Suit, rank: number): void {
  const retrial = host.state.retrial
  if (!retrial) return
  const { playerId, reason, judgeCardId, tag, data } = retrial
  const judgeCard = host.state.cards[judgeCardId]
  const color = suit === 'heart' || suit === 'diamond' ? 'red' : 'black'
  host.dispatch('JudgeResult', { playerId, reason, judgeCardId, suit, rank, color }, { targetId: playerId, cardIds: [judgeCardId] })
  host.dispatch('JudgeEnd', { playerId, reason, judgeCardId }, { targetId: playerId, cardIds: [judgeCardId] })
  /*
   * 暂存中的判定不进弃牌堆，留在处理区等技能统一处置（神郭嘉【慧识】）。
   * 按续接 tag 认领，不能把别的技能顺手插进来的判定也收走。
   * 改判换下来的旧牌在改判当场就进了弃牌堆，走不到这里——所以这里收到的
   * 一定只有最终生效的那一张。
   */
  if (shouldRetainJudgment(host.state, tag)) retainJudgmentCard(host.state, judgeCardId, suit)
  // 判定牌用完了：显式标明原因，处理区进弃牌堆光看来源区分不出是用过的牌还是判定牌
  else moveCard(host.state, judgeCardId, { kind: 'processingArea' }, { kind: 'discardPile' }, { discardReason: 'judgment' })
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
  const sourceId = retrial.sourceId ?? response.playerId
  const sourceZone = locateOwnedCard(host.state, sourceId, replacementId, { includeCharacterPiles: true })
  const fromDrawPile = !sourceZone && host.state.zones.drawPile[0] === replacementId
  /*
   * 大多数改判技能（鬼才）只报手牌做候选，这里仍然优先走手牌；
   * 少数技能（神品）候选可以来自装备区，统一交给 movePickedCard 定位，
   * 顺带处理装备离场——具体能选哪些区域由各技能自己的 retrial() 候选决定。
   */
  // 旧判定牌进弃牌堆，新牌顶上。两张牌都在处理区停留过，牌张守恒不会破
  // 被改判换下来的那一张同样是「因判定进入弃牌堆」
  moveCard(host.state, retrial.judgeCardId, { kind: 'processingArea' }, { kind: 'discardPile' }, { discardReason: 'judgment' })
  if (fromDrawPile) moveCard(host.state, replacementId, { kind: 'drawPile' }, { kind: 'processingArea' })
  else if (!movePickedCard(host, sourceId, replacementId, { kind: 'processingArea' })) throw new Error('改判用的牌不在合法区域里')
  retrial.judgeCardId = replacementId
  host.dispatch('CardResponded', { playerId: sourceId, cardId: replacementId, cardName: host.state.cards[replacementId].name, reason: '改判', fromKind: fromDrawPile ? 'drawPile' : sourceZone?.kind }, { sourceId, targetId: retrial.playerId, cardIds: [replacementId] })
  // 换了牌就重新从头问一遍：别人（以及他自己）可以对新的判定牌再改一次
  retrial.responderIndex = 0
  askNextRetrial(host)
}

function takeJudgmentCard(host: JudgmentEngineHost): CardId {
  if (host.state.zones.drawPile.length === 0) {
    // 判定牌也走公共重洗，洗牌痕迹只有一处来源
    if (reshuffleDrawPile(host.state, host.rng, (name, payload) => { host.dispatch(name, payload) }) === 0) {
      throw new Error('没有可用于判定的牌')
    }
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
    if (candidate.alive && !isJudgmentAreaAbolished(state, candidate.id) && !hasLightning) return candidate.id
  }
  return ownerId
}

function moveCancelledDelayed(host: JudgmentEngineHost, ownerId: PlayerId, delayedCardId: CardId): void {
  if (host.state.cards[delayedCardId].name === '闪电') {
    const targetId = nextLightningTarget(host.state, ownerId)
    if (isJudgmentAreaAbolished(host.state, targetId)) moveCard(host.state, delayedCardId, { kind: 'processingArea' }, { kind: 'discardPile' })
    else moveCard(host.state, delayedCardId, { kind: 'processingArea' }, { kind: 'judgingArea', playerId: targetId })
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

  // 命中判断走公共规则，表现层用的是同一份，两边不会漂移
  const hit = delayedTrickHitsForPlayer(host.state, ownerId, delayedName, judged.suit, judged.rank)
  if (delayedName === '乐不思蜀') {
    if (hit) skipPhase(host.state, 'play')
    moveCard(host.state, delayedCardId, { kind: 'processingArea' }, { kind: 'discardPile' })
  } else if (delayedName === '兵粮寸断') {
    if (hit) skipPhase(host.state, 'draw')
    moveCard(host.state, delayedCardId, { kind: 'processingArea' }, { kind: 'discardPile' })
  } else if (delayedName === '闪电') {
    if (hit) {
      host.state.judgment = { playerId: ownerId, delayedCardId, stage: 'awaiting-damage' }
      resolveDamage(host, { targetId: ownerId, amount: 3, nature: 'thunder', cardName: '闪电', cardId: delayedCardId })
      if (!host.state.dying && !host.state.damageChain) finishLightningDamage(host)
    } else {
      const targetId = nextLightningTarget(host.state, ownerId)
      if (isJudgmentAreaAbolished(host.state, targetId)) moveCard(host.state, delayedCardId, { kind: 'processingArea' }, { kind: 'discardPile' })
      else moveCard(host.state, delayedCardId, { kind: 'processingArea' }, { kind: 'judgingArea', playerId: targetId })
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
  const canMultiCardRespond = judgment.lastNullifierId !== responderId
    && canMultiCardViewAs(host.state, responderId, '无懈可击')
  if (cardIds.length === 0 && !canGuhuo && !canMultiCardRespond) {
    judgment.responderIndex += 1
    requestCurrentNullification(host)
    return
  }
  const actionIds = cardIds
    .filter((cardId) => canUseCardAs(host.state, responderId, cardId, '无懈可击'))
    .map((cardId) => `respond-nullification:${cardId}`)
  actionIds.push('respond-pass')
  if (canGuhuo) actionIds.push(GUHUO_RESPOND_ACTION)
  if (canMultiCardRespond) actionIds.push(MULTI_VIEWAS_ACTION)
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
    host.dispatch('CardResponded', { playerId: response.playerId, cardId, cardName: '无懈可击', fromKind: 'hand' }, { sourceId: response.playerId, targetId: judgment.playerId, cardIds: [cardId] })
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
