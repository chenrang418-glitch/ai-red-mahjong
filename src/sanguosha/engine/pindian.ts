import { closePrivateZone, moveIntoPrivateZone, moveOutOfPrivateZone, openPrivateZone, privateZoneCards } from './private-zone'
import type { ChooseCardsRequest, GameResponse } from './requests'
import type { CardId, PhysicalCard, PindianState, PlayerId, SanguoshaState } from './types'
import { moveCard } from './zones'

/**
 * 公共拼点。
 *
 * 拼点是「双方各暗选一张手牌、同时亮出、比点数」。三件事必须由这里统一负责，
 * 否则每个用到拼点的技能都会各写一套：
 *
 * 1. **暗选**。复用已有的私有牌区（`private-zone.ts`）——那套东西本来就是为
 *    「先扣一张牌、稍后才揭示」建的，`buildPlayerView` 只把私有区发给它的主人。
 *    **不新建第二套隐藏牌系统。**
 * 2. **可序列化**。整个过程写在 `state.pindian` 里，没有 Promise、闭包和回调。
 *    页面刷新、Worker 休眠、Durable Object 恢复之后能接着走。
 * 3. **结果只有牌和胜负**。拼点引擎不知道「驱虎」「天义」是什么，技能通过
 *    `continuationTag` 注册续接，拿到 `PindianResult` 之后自己决定做什么。
 *
 * 刻意**不做**的事（现有武将都不需要，做了就是负担）：三人拼点、多张牌拼点、
 * 自定义排序、自定义牌区。
 */

export interface PindianResult {
  initiatorId: PlayerId
  opponentId: PlayerId
  initiatorCardId: CardId
  opponentCardId: CardId
  initiatorRank: number
  opponentRank: number
  /** 平局是**独立的一种结果**，不能被迫塞进「谁赢」里。 */
  outcome: 'initiator-win' | 'opponent-win' | 'tie'
  /** 技能发起拼点时带的上下文，原样还回来。 */
  data: Record<string, unknown>
}

export interface PindianHost {
  state: SanguoshaState
  dispatch(name: string, payload?: Record<string, unknown>, metadata?: Record<string, unknown>): unknown
}

export type PindianContinuationResult = 'defer-settlement' | void
type PindianContinuation = (host: PindianHost, result: PindianResult) => PindianContinuationResult

const continuations = new Map<string, PindianContinuation>()

/** 技能注册自己的续接。和多人决定一样按 tag 查，运行时代码不进 GameState。 */
export function registerPindianContinuation(tag: string, run: PindianContinuation): void {
  continuations.set(tag, run)
}

/** 仅供测试重置。 */
export function resetPindianContinuations(): void {
  continuations.clear()
}

/**
 * 拼点用的点数。
 *
 * **A 就是 1。** 牌库里的 rank 本来就是 1~13，直接用。原创武将【牛来】把 A
 * 当 14 是它自己的规则，拼点绝不能复用那套排序。
 */
export function pindianRank(card: Pick<PhysicalCard, 'rank'>): number {
  return card.rank
}

function playerOf(state: SanguoshaState, playerId: PlayerId) {
  return state.players.find((candidate) => candidate.id === playerId)
}

/** 某人现在能不能参与拼点：活着且有手牌。 */
export function canPindian(state: SanguoshaState, playerId: PlayerId): boolean {
  const player = playerOf(state, playerId)
  return Boolean(player?.alive && player.zones.hand.length > 0)
}

/** 这一方暗选的牌放在哪个私有区。 */
function zoneIdFor(pindianId: string, playerId: PlayerId): string {
  return `pindian:${pindianId}:${playerId}`
}

export interface PindianOptions {
  id: string
  initiatorId: PlayerId
  opponentId: PlayerId
  /** 发起技能的 id，用于战报和日志。 */
  reason: string
  continuationTag: string
  data?: Record<string, unknown>
  timeoutMs?: number
}

/**
 * 发起一次拼点。
 *
 * 调用方**必须**先自己确认双方都有手牌（合法性属于技能，不属于拼点）——
 * 规则要求「没有手牌就不能拼点」在技能的可发动判断里挡掉，而不是发动完
 * 再弹一个空的选牌框。这里再兜一次底只是防御。
 */
export function startPindian(host: PindianHost, options: PindianOptions): void {
  if (!continuations.has(options.continuationTag)) throw new Error(`拼点续接未注册：${options.continuationTag}`)
  if (host.state.pindian || host.state.pindianSettlement) throw new Error('上一次拼点还没结束')
  if (!canPindian(host.state, options.initiatorId) || !canPindian(host.state, options.opponentId)) {
    throw new Error('拼点双方都必须有手牌')
  }

  const pindian: PindianState = {
    id: options.id,
    initiatorId: options.initiatorId,
    opponentId: options.opponentId,
    initiatorCardId: null,
    opponentCardId: null,
    reason: options.reason,
    continuationTag: options.continuationTag,
    data: { ...(options.data ?? {}) },
    requestIds: {},
    stage: 'selecting',
  }
  host.state.pindian = pindian

  const initiator = playerOf(host.state, options.initiatorId)!
  const opponent = playerOf(host.state, options.opponentId)!
  host.dispatch('SkillActivated', {
    skillId: options.reason, playerId: options.initiatorId, targetIds: [options.opponentId], result: 'pindian-start',
    logText: `${initiator.nickname}与${opponent.nickname}拼点`,
  }, { sourceId: options.initiatorId, targetId: options.opponentId })

  for (const playerId of [options.initiatorId, options.opponentId]) {
    askPindianCard(host, playerId, options.timeoutMs ?? 30_000)
  }
}

function askPindianCard(host: PindianHost, playerId: PlayerId, timeoutMs: number): void {
  const pindian = host.state.pindian!
  const player = playerOf(host.state, playerId)!
  const request: ChooseCardsRequest = {
    id: `${pindian.id}:${playerId}`,
    kind: 'choose-cards',
    playerId,
    prompt: '请选择一张手牌用于拼点',
    timeoutMs,
    // 拼点必须选一张，不能跳过
    optional: false,
    purpose: 'pindian',
    cardIds: [...player.zones.hand],
    hiddenCardSlots: [],
    min: 1,
    max: 1,
  }
  host.state.pendingRequests.push(request)
  pindian.requestIds[playerId] = request.id
}

/** 这个请求是不是某次拼点的选牌。 */
export function isPindianRequest(state: SanguoshaState, requestId: string): boolean {
  const pindian = state.pindian
  if (!pindian) return false
  return Object.values(pindian.requestIds).includes(requestId)
}

/**
 * 收下一方的选牌。
 *
 * 牌立刻从手牌移进**自己的**私有区：对方的视图里连 cardId 都不会出现，
 * 也就谈不上看到牌名、花色或点数。两边都交完才揭示。
 */
export function resolvePindianResponse(host: PindianHost, requestId: string, response: GameResponse): void {
  const pindian = host.state.pindian
  if (!pindian || pindian.stage !== 'selecting') throw new Error('拼点已经结束')
  const playerId = response.playerId
  if (pindian.requestIds[playerId] !== requestId) throw new Error('这不是你的拼点请求')

  const [cardId] = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
  const player = playerOf(host.state, playerId)
  // 拼点牌只能来自手牌：装备区、判定区、专属牌堆、私有区一律不行。
  // 服务端自己验，不靠客户端老实
  if (!player?.alive || !cardId || !player.zones.hand.includes(cardId)) throw new Error('拼点牌必须是自己的手牌')

  const zoneId = zoneIdFor(pindian.id, playerId)
  openPrivateZone(host.state, zoneId, playerId, 'pindian')
  moveIntoPrivateZone(host.state, cardId, { kind: 'hand', playerId }, zoneId)
  if (playerId === pindian.initiatorId) pindian.initiatorCardId = cardId
  else pindian.opponentCardId = cardId

  // 交完就不能再改：请求撤掉，重复提交会因为找不到请求被拒
  host.state.pendingRequests = host.state.pendingRequests.filter((candidate) => candidate.id !== requestId)
  delete pindian.requestIds[playerId]
  host.state.decisions.push({
    index: host.state.decisions.length,
    requestId,
    playerId,
    kind: 'choose-cards',
    payload: { cardIds: [cardId] },
  })

  if (pindian.initiatorCardId && pindian.opponentCardId) revealPindian(host)
}

/**
 * 双方都交完了：一次性公开、比点、把牌送进弃牌堆，然后交给技能。
 *
 * 揭示走统一的 `CardMove(revealed)` 事件，界面不自己拼结果。
 */
function revealPindian(host: PindianHost): void {
  const pindian = host.state.pindian!
  pindian.stage = 'revealing'
  const initiatorCardId = pindian.initiatorCardId!
  const opponentCardId = pindian.opponentCardId!
  const initiatorRank = pindianRank(host.state.cards[initiatorCardId])
  const opponentRank = pindianRank(host.state.cards[opponentCardId])

  // 先一起挪到处理区亮出来，再一起进弃牌堆——不能一张留处理区一张进弃牌堆
  for (const [playerId, cardId] of [[pindian.initiatorId, initiatorCardId], [pindian.opponentId, opponentCardId]] as const) {
    moveOutOfPrivateZone(host.state, cardId, zoneIdFor(pindian.id, playerId), { kind: 'processingArea' })
    closePrivateZone(host.state, zoneIdFor(pindian.id, playerId))
  }
  host.dispatch('CardMove', {
    playerId: pindian.initiatorId, cardIds: [initiatorCardId, opponentCardId], reason: 'pindian', revealed: true,
    pindian: {
      initiatorId: pindian.initiatorId, opponentId: pindian.opponentId,
      initiatorCardId, opponentCardId, initiatorRank, opponentRank,
    },
  }, { sourceId: pindian.initiatorId, targetId: pindian.opponentId, cardIds: [initiatorCardId, opponentCardId] })

  const outcome: PindianResult['outcome'] = initiatorRank > opponentRank
    ? 'initiator-win'
    : initiatorRank < opponentRank ? 'opponent-win' : 'tie'

  const initiator = playerOf(host.state, pindian.initiatorId)!
  const opponent = playerOf(host.state, pindian.opponentId)!
  const outcomeText = outcome === 'tie' ? '点数相同，平局'
    : outcome === 'initiator-win' ? `${initiator.nickname}拼点获胜` : `${opponent.nickname}拼点获胜`
  host.dispatch('SkillActivated', {
    skillId: pindian.reason, playerId: pindian.initiatorId, targetIds: [pindian.opponentId],
    result: `pindian-${outcome}`,
    logText: `${initiator.nickname}拼 ${initiatorRank} 点，${opponent.nickname}拼 ${opponentRank} 点：${outcomeText}`,
  }, { sourceId: pindian.initiatorId, targetId: pindian.opponentId })

  /*
   * 公共的拼点胜负事件。**平局不派发**——平局不算赢，
   * 挂在这上面的技能（神张辽【止啼】）也就自然不会触发。
   */
  if (outcome !== 'tie') {
    const winnerId = outcome === 'initiator-win' ? pindian.initiatorId : pindian.opponentId
    const loserId = outcome === 'initiator-win' ? pindian.opponentId : pindian.initiatorId
    host.dispatch('PindianResult', { winnerId, loserId, reason: pindian.reason },
      { sourceId: winnerId, targetId: loserId })
  }

  const result: PindianResult = {
    initiatorId: pindian.initiatorId,
    opponentId: pindian.opponentId,
    initiatorCardId,
    opponentCardId,
    initiatorRank,
    opponentRank,
    outcome,
    data: { ...pindian.data },
  }
  const run = continuations.get(pindian.continuationTag)
  // 先清状态再回调：技能可能在续接里再发起别的东西
  host.state.pindian = null
  host.state.pindianSettlement = { id: pindian.id, cardIds: [initiatorCardId, opponentCardId] }
  const disposition = run?.(host, result)
  if (disposition !== 'defer-settlement') finishPindianSettlement(host)
}

/** 把仍在处理区的拼点牌送入弃牌堆，结束这次延后的牌去向结算。 */
export function finishPindianSettlement(host: PindianHost): void {
  const settlement = host.state.pindianSettlement
  if (!settlement) return
  for (const cardId of settlement.cardIds) {
    if (host.state.zones.processingArea.includes(cardId)) {
      moveCard(host.state, cardId, { kind: 'processingArea' }, { kind: 'discardPile' })
    }
  }
  host.state.pindianSettlement = null
}

/**
 * 认领本次拼点中仍留在处理区的实体牌，然后把无人认领的剩余牌正常弃置。
 * 返回真正获得的 Card ID；调用者据此记录技能日志。
 */
export function claimPindianCards(host: PindianHost, playerId: PlayerId, cardIds: readonly CardId[]): CardId[] {
  const settlement = host.state.pindianSettlement
  const player = playerOf(host.state, playerId)
  if (!settlement || !player?.alive) return []
  const allowed = new Set(settlement.cardIds)
  const claimed: CardId[] = []
  for (const cardId of cardIds) {
    if (!allowed.has(cardId) || !host.state.zones.processingArea.includes(cardId)) continue
    moveCard(host.state, cardId, { kind: 'processingArea' }, { kind: 'hand', playerId })
    claimed.push(cardId)
  }
  if (claimed.length > 0) {
    host.dispatch('GainCard', { playerId, cardIds: claimed, reason: 'pindian-claim' }, { targetId: playerId, cardIds: claimed })
  }
  finishPindianSettlement(host)
  return claimed
}

/**
 * 参与者中途死了或者牌局结束：安全中止。
 *
 * 已经交上来的牌进弃牌堆——不能留在一个没人能碰的私有区里，也不能凭空消失。
 */
export function abortPindian(host: PindianHost): void {
  const pindian = host.state.pindian
  if (!pindian) {
    finishPindianSettlement(host)
    return
  }
  for (const [playerId, cardId] of [[pindian.initiatorId, pindian.initiatorCardId], [pindian.opponentId, pindian.opponentCardId]] as const) {
    const zoneId = zoneIdFor(pindian.id, playerId)
    if (cardId && privateZoneCards(host.state, zoneId).includes(cardId)) {
      moveOutOfPrivateZone(host.state, cardId, zoneId, { kind: 'discardPile' })
    }
    closePrivateZone(host.state, zoneId)
  }
  host.state.pendingRequests = host.state.pendingRequests.filter(
    (candidate) => !Object.values(pindian.requestIds).includes(candidate.id),
  )
  host.state.pindian = null
  finishPindianSettlement(host)
}
