import type { ChooseCardsRequest, GameResponse } from './requests'
import { validateResponse } from './requests'
import type { CardId, GroupCardDecisionState, PlayerId, SanguoshaState } from './types'

/**
 * 多人同时秘密选牌（GroupCardDecision）。
 *
 * 和 `group-decision.ts` 的多人同时决定是同一个思路，只是那个只支持从固定
 * options 里选一项（issue-option），选不了「任意几张牌」——庞会【异勇】要的是
 * 双方各自秘密弃任意张手牌再同时公开，只能新起一个 `choose-cards` 版本，
 * 不能硬塞进只认 optionId 的旧结构里。
 *
 * 隐私原理不变：`buildPlayerView` 只把发给"我"的那个 Request 下发，
 * `responses` 不进 PlayerView，全部交齐之前谁也看不到别人选了什么。
 */

type GroupCardDecisionContinuation = (host: GroupCardDecisionHost, decision: GroupCardDecisionState) => void

export interface GroupCardDecisionHost {
  state: SanguoshaState
}

const continuations = new Map<string, GroupCardDecisionContinuation>()

export function registerGroupCardDecision(tag: string, run: GroupCardDecisionContinuation): void {
  if (continuations.has(tag)) throw new Error(`多人选牌续接重复注册：${tag}`)
  continuations.set(tag, run)
}

export interface GroupCardDecisionOptions {
  id: string
  tag: string
  skillId?: string
  playerIds: readonly PlayerId[]
  prompt: string
  /** 每个参与者能选的牌（各自的手牌），min 默认 0（可以交空）。 */
  cardIdsFor(playerId: PlayerId): readonly CardId[]
  min?: number
  max?: number
  timeoutMs: number
  data?: Record<string, unknown>
}

/** 发起一次多人同时秘密选牌。一个参与者都没有时直接跑续接。 */
export function startGroupCardDecision(host: GroupCardDecisionHost, options: GroupCardDecisionOptions): void {
  if (!continuations.has(options.tag)) throw new Error(`多人选牌续接未注册：${options.tag}`)
  if (host.state.groupCardDecision) throw new Error('上一次多人选牌还没结束')

  const participants = options.playerIds.filter((playerId) => {
    const player = host.state.players.find((candidate) => candidate.id === playerId)
    return Boolean(player?.alive)
  })

  const decision: GroupCardDecisionState = {
    id: options.id,
    tag: options.tag,
    playerIds: [...participants],
    responses: {},
    requestIds: {},
    data: options.data ?? {},
  }

  if (participants.length === 0) {
    runContinuation(host, decision)
    return
  }

  host.state.groupCardDecision = decision
  participants.forEach((playerId, index) => {
    const cardIds = [...options.cardIdsFor(playerId)]
    const request: ChooseCardsRequest = {
      id: `${options.id}:${playerId}:${index}`,
      kind: 'choose-cards',
      playerId,
      prompt: options.prompt,
      timeoutMs: options.timeoutMs,
      optional: true,
      cardIds,
      hiddenCardSlots: [],
      min: options.min ?? 0,
      max: options.max ?? cardIds.length,
      purpose: 'skill',
      ...(options.skillId ? { skillId: options.skillId, skillStep: options.tag } : {}),
    }
    host.state.pendingRequests.push(request)
    decision.requestIds[playerId] = request.id
  })
}

/** 这个请求是不是某次多人选牌的一环。 */
export function isGroupCardDecisionRequest(state: SanguoshaState, requestId: string): boolean {
  const decision = state.groupCardDecision
  return Boolean(decision && Object.values(decision.requestIds).includes(requestId))
}

/** 收下一个人的选择。重复提交、非参与者提交一律拒绝，且不破坏其余人的状态。 */
export function resolveGroupCardDecisionResponse(
  host: GroupCardDecisionHost,
  requestId: string,
  response: GameResponse,
): void {
  const decision = host.state.groupCardDecision
  if (!decision) throw new Error('当前没有进行中的多人选牌')
  const expected = decision.requestIds[response.playerId]
  if (!expected || expected !== requestId) throw new Error('这个请求不属于该玩家')
  if (decision.responses[response.playerId] !== undefined) throw new Error('已经提交过了')

  const request = host.state.pendingRequests.find((candidate) => candidate.id === requestId)
  if (!request) throw new Error('Request 不存在或已经处理')
  const validationError = validateResponse(request, response)
  if (validationError) throw new Error(validationError)

  const cardIds = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
  decision.responses[response.playerId] = cardIds
  host.state.pendingRequests = host.state.pendingRequests.filter((candidate) => candidate.id !== requestId)
  host.state.decisions.push({
    index: host.state.decisions.length,
    requestId,
    playerId: response.playerId,
    kind: request.kind,
    payload: structuredClone(response.payload),
  })

  finishIfComplete(host, decision)
}

/** 超时、掉线、参与者中途死亡时按空选补齐并结束。不另起定时器，何时算超时由驱动层决定。 */
export function forceCompleteGroupCardDecision(host: GroupCardDecisionHost): void {
  const decision = host.state.groupCardDecision
  if (!decision) return
  for (const playerId of decision.playerIds) {
    if (decision.responses[playerId] === undefined) decision.responses[playerId] = []
  }
  const ids = new Set(Object.values(decision.requestIds))
  host.state.pendingRequests = host.state.pendingRequests.filter((candidate) => !ids.has(candidate.id))
  finishIfComplete(host, decision)
}

/** 参与者中途死了就不再等他，按空选算。 */
export function dropDeadCardDecisionParticipants(host: GroupCardDecisionHost): void {
  const decision = host.state.groupCardDecision
  if (!decision) return
  let changed = false
  for (const playerId of decision.playerIds) {
    if (decision.responses[playerId] !== undefined) continue
    const player = host.state.players.find((candidate) => candidate.id === playerId)
    if (player?.alive) continue
    decision.responses[playerId] = []
    const requestId = decision.requestIds[playerId]
    host.state.pendingRequests = host.state.pendingRequests.filter((candidate) => candidate.id !== requestId)
    changed = true
  }
  if (changed) finishIfComplete(host, decision)
}

function finishIfComplete(host: GroupCardDecisionHost, decision: GroupCardDecisionState): void {
  const pending = decision.playerIds.filter((playerId) => decision.responses[playerId] === undefined)
  if (pending.length > 0) return
  host.state.groupCardDecision = null
  runContinuation(host, decision)
}

function runContinuation(host: GroupCardDecisionHost, decision: GroupCardDecisionState): void {
  const run = continuations.get(decision.tag)
  if (!run) throw new Error(`多人选牌续接未注册：${decision.tag}`)
  run(host, decision)
}

/** 仅供测试使用：清空续接注册表。 */
export function resetGroupCardDecisions(): void {
  continuations.clear()
}
