import type { ChooseOptionRequest, GameResponse } from './requests'
import { validateResponse } from './requests'
import type { GroupDecisionState, PlayerId, SanguoshaState } from './types'

/**
 * 多人同时决定（MultiPlayerDecision）。
 *
 * 现有的 Request 是「问一个人 → 等回答 → 问下一个」。质疑不能这么问：
 * 后面的人会先看到前面的人已经质疑了再做决定。
 *
 * 这里的做法是**同时挂 N 个请求**，每人一个。引擎本来就支持多个 pendingRequest
 * （开局的选将就是每人一个），而 `buildPlayerView` 只把「发给我的那一个」
 * 下发给观察者——所以隐私是天然成立的：**别人的请求根本不在我的视图里**。
 *
 * 已经交上来的答案存在 `responses` 里，而 `responses` 不进 PlayerView，
 * 所以在全部收齐之前谁也看不到别人选了什么。
 *
 * 「同时」是逻辑上的同时，不要求网络包同一毫秒到达：只要保证
 * A 做决定时拿不到 B 的选择、AI 也读不到已提交的答案就够了。
 *
 * 收齐之后由 `tag` 指向的续接统一处理——和判定改判一样用字符串而不是闭包，
 * 因为 Durable Object 在等回答的时候会休眠，闭包活不过去。
 */

type GroupDecisionContinuation = (host: GroupDecisionHost, decision: GroupDecisionState) => void

export interface GroupDecisionHost {
  state: SanguoshaState
}

const continuations = new Map<string, GroupDecisionContinuation>()

export function registerGroupDecision(tag: string, run: GroupDecisionContinuation): void {
  if (continuations.has(tag)) throw new Error(`多人决定续接重复注册：${tag}`)
  continuations.set(tag, run)
}

export interface GroupDecisionOptions {
  id: string
  tag: string
  /** 参与者。死人和不该参与的人由调用方过滤掉。 */
  playerIds: readonly PlayerId[]
  prompt: string
  options: ReadonlyArray<{ id: string; label: string }>
  /** 超时或掉线时替玩家填的默认选项，必须在 `options` 里。 */
  defaultOptionId: string
  timeoutMs: number
  /** 续接需要的上下文，必须可序列化。 */
  data?: Record<string, unknown>
}

/**
 * 发起一次多人决定。
 *
 * 一个参与者都没有时**直接跑续接**，不留下空决定——调用方不需要自己判空。
 */
export function startGroupDecision(host: GroupDecisionHost, options: GroupDecisionOptions): void {
  if (!continuations.has(options.tag)) throw new Error(`多人决定续接未注册：${options.tag}`)
  if (host.state.groupDecision) throw new Error('上一次多人决定还没结束')
  if (!options.options.some((option) => option.id === options.defaultOptionId)) {
    throw new Error('默认选项必须在候选里')
  }

  const participants = options.playerIds.filter((playerId) => {
    const player = host.state.players.find((candidate) => candidate.id === playerId)
    return Boolean(player?.alive)
  })

  const decision: GroupDecisionState = {
    id: options.id,
    tag: options.tag,
    playerIds: [...participants],
    responses: {},
    defaultOptionId: options.defaultOptionId,
    requestIds: {},
    data: options.data ?? {},
  }

  if (participants.length === 0) {
    runContinuation(host, decision)
    return
  }

  host.state.groupDecision = decision
  participants.forEach((playerId, index) => {
    const request: ChooseOptionRequest = {
      id: `${options.id}:${playerId}:${index}`,
      kind: 'choose-option',
      playerId,
      prompt: options.prompt,
      timeoutMs: options.timeoutMs,
      optional: false,
      options: [...options.options],
    }
    host.state.pendingRequests.push(request)
    decision.requestIds[playerId] = request.id
  })
}

/** 这个请求是不是某次多人决定的一环。 */
export function isGroupDecisionRequest(state: SanguoshaState, requestId: string): boolean {
  const decision = state.groupDecision
  return Boolean(decision && Object.values(decision.requestIds).includes(requestId))
}

/**
 * 收下一个人的选择。
 *
 * 重复提交、非参与者提交、决定已经结束之后再提交，一律拒绝——
 * 而且**拒绝时不破坏状态**，其余人照样能继续回答。
 */
export function resolveGroupDecisionResponse(
  host: GroupDecisionHost,
  requestId: string,
  response: GameResponse,
): void {
  const decision = host.state.groupDecision
  if (!decision) throw new Error('当前没有进行中的多人决定')
  const expected = decision.requestIds[response.playerId]
  if (!expected || expected !== requestId) throw new Error('这个请求不属于该玩家')
  if (decision.responses[response.playerId] !== undefined) throw new Error('已经提交过了')

  const request = host.state.pendingRequests.find((candidate) => candidate.id === requestId)
  if (!request) throw new Error('Request 不存在或已经处理')
  const validationError = validateResponse(request, response)
  if (validationError) throw new Error(validationError)

  const optionId = (response.payload as { optionId: string }).optionId
  decision.responses[response.playerId] = optionId
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

/**
 * 把还没回答的人按默认值补齐并结束。
 *
 * 超时、掉线、参与者中途死亡都走这里。**不另起一套定时器**——
 * 什么时候算超时由驱动层（联机的 alarm / 单机的 AI 循环）决定。
 */
export function forceCompleteGroupDecision(host: GroupDecisionHost): void {
  const decision = host.state.groupDecision
  if (!decision) return
  for (const playerId of decision.playerIds) {
    if (decision.responses[playerId] === undefined) decision.responses[playerId] = decision.defaultOptionId
  }
  const ids = new Set(Object.values(decision.requestIds))
  host.state.pendingRequests = host.state.pendingRequests.filter((candidate) => !ids.has(candidate.id))
  finishIfComplete(host, decision)
}

/** 参与者中途死了就不再等他，按默认值算。 */
export function dropDeadParticipants(host: GroupDecisionHost): void {
  const decision = host.state.groupDecision
  if (!decision) return
  let changed = false
  for (const playerId of decision.playerIds) {
    if (decision.responses[playerId] !== undefined) continue
    const player = host.state.players.find((candidate) => candidate.id === playerId)
    if (player?.alive) continue
    decision.responses[playerId] = decision.defaultOptionId
    const requestId = decision.requestIds[playerId]
    host.state.pendingRequests = host.state.pendingRequests.filter((candidate) => candidate.id !== requestId)
    changed = true
  }
  if (changed) finishIfComplete(host, decision)
}

function finishIfComplete(host: GroupDecisionHost, decision: GroupDecisionState): void {
  const pending = decision.playerIds.filter((playerId) => decision.responses[playerId] === undefined)
  if (pending.length > 0) return
  // 先清空再跑续接：续接里可能立刻发起下一次决定
  host.state.groupDecision = null
  runContinuation(host, decision)
}

function runContinuation(host: GroupDecisionHost, decision: GroupDecisionState): void {
  const run = continuations.get(decision.tag)
  if (!run) throw new Error(`多人决定续接未注册：${decision.tag}`)
  run(host, decision)
}

/**
 * 按稳定顺序列出选了某个选项的人。
 *
 * **不要直接遍历 `responses` 的键**：那是提交顺序，取决于谁先点，
 * 多个质疑者失去体力的先后会变得不可复现。这里按参与者列表的顺序来，
 * 而参与者列表由调用方按座次生成。
 */
export function playersWhoChose(decision: GroupDecisionState, optionId: string): PlayerId[] {
  return decision.playerIds.filter((playerId) => decision.responses[playerId] === optionId)
}

/** 仅供测试使用：清空续接注册表。 */
export function resetGroupDecisions(): void {
  continuations.clear()
}
