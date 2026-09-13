import { getSeatDistance } from './distance'
import { moveCard } from './zones'
import { registerSkillRuntime, type SkillHost } from './skills/runtime'
import type { ChooseTargetsRequest, GameRequest, GameResponse } from './requests'
import type { CardId, PlayerId, SanguoshaState } from './types'

/**
 * 郭图【诿解】。
 *
 * 需要 Use/Respond 一张基本牌时，弃置一名距离为 1 的角色的 1 张手牌（暗弃，
 * 不能看到完整 hand）；若牌名相同，视为用它满足了这次请求。
 *
 * 走的是和于吉【蛊惑】、龙魂多牌转化完全一样的「集中认领」路子：所有求牌
 * 请求本来就是「一串 actionId 里挑一个」，这里只在同样几条路径上追加一个
 * `weijie-respond`，再在 `game.respondInner` 里统一认领，不必在求闪/求桃/
 * 锦囊效果里各自实现一遍。
 *
 * 和蛊惑的区别：蛊惑是"自己声明、可能被戳穿"；诿解是"真的弃邻居一张牌，
 * 牌名对不对当场就知道"，不需要质疑阶段。命中的那张牌先移入郭图手里，
 * 再原样重放一次原请求——真正走的仍是原有的求闪/求桃/锦囊响应管线，
 * 那张牌自然按管线本身的规则进弃牌堆，效果上就是"弃置"。没命中就直接弃置。
 */

const WEIJIE = 'weijie'
export const WEIJIE_ACTION = 'weijie-respond'
const TURN_MARK = 'weijie-used-turn'

function playerOf(state: SanguoshaState, playerId: PlayerId) {
  return state.players.find((candidate) => candidate.id === playerId)
}

function hasWeijie(state: SanguoshaState, playerId: PlayerId, skillIdsOf: (characterId: string) => string[]): boolean {
  const player = playerOf(state, playerId)
  return Boolean(player?.alive && player.characterId && skillIdsOf(player.characterId).includes(WEIJIE))
}

function distance1Candidates(state: SanguoshaState, ownerId: PlayerId): PlayerId[] {
  return state.players
    .filter((candidate) => candidate.alive && candidate.id !== ownerId && candidate.zones.hand.length > 0 && getSeatDistance(state, ownerId, candidate.id) === 1)
    .map((candidate) => candidate.id)
}

export function canWeijieRespond(
  state: SanguoshaState,
  playerId: PlayerId,
  requiredCardName: string,
  skillIdsOf: (characterId: string) => string[],
): boolean {
  if (state.weijieResponse) return false
  if (!hasWeijie(state, playerId, skillIdsOf)) return false
  if (!['杀', '闪', '桃', '酒'].includes(requiredCardName)) return false
  const player = playerOf(state, playerId)
  if (!player || player.marks[TURN_MARK] === state.turnNumber) return false
  return distance1Candidates(state, playerId).length > 0
}

export function beginWeijieRespond(host: SkillHost, request: GameRequest): void {
  const ownerId = request.playerId
  const requiredCardName = 'requiredCardName' in request ? String(request.requiredCardName) : '桃'
  const owner = playerOf(host.state, ownerId)
  if (!owner?.alive) return
  owner.marks[TURN_MARK] = host.state.turnNumber
  host.state.pendingRequests = host.state.pendingRequests.filter((candidate) => candidate.id !== request.id)
  host.state.weijieResponse = { ownerId, requiredCardName, request: structuredClone(request) }
  host.dispatch('SkillActivated', { skillId: WEIJIE, skillName: '诿解', playerId: ownerId, logText: `${owner.nickname}发动【诿解】` }, { sourceId: ownerId })
  const candidateIds = distance1Candidates(host.state, ownerId)
  if (candidateIds.length === 1) {
    resolveWeijieTarget(host, candidateIds[0])
    return
  }
  host.askSkill({
    skillId: WEIJIE, ownerId, step: 'pick-target', data: {},
    build: (requestId): ChooseTargetsRequest => ({
      id: requestId, kind: 'choose-targets', playerId: ownerId,
      prompt: '【诿解】：选择一名距离1的角色，弃置其1张手牌', timeoutMs: 20_000, optional: false,
      candidateIds, min: 1, max: 1,
    }),
  })
}

registerSkillRuntime({
  id: WEIJIE,
  resume(host, _ownerId, resolution, response) {
    if (resolution.step !== 'pick-target') return
    const [targetId] = (response.payload as { targetIds?: PlayerId[] }).targetIds ?? []
    if (!targetId) { finishWeijie(host, false); return }
    resolveWeijieTarget(host, targetId)
  },
})

function resolveWeijieTarget(host: SkillHost, targetId: PlayerId): void {
  const pending = host.state.weijieResponse
  if (!pending) return
  const target = playerOf(host.state, targetId)
  if (!target?.alive || target.zones.hand.length === 0) { finishWeijie(host, false); return }
  const cardId = target.zones.hand[host.rng.nextInt(target.zones.hand.length)]
  const realName = host.state.cards[cardId]?.name
  const granted = realName === pending.requiredCardName
  if (granted) {
    // 命中：先移入郭图手里，让原请求把它当真正的响应牌重放消耗掉
    moveCard(host.state, cardId, { kind: 'hand', playerId: targetId }, { kind: 'hand', playerId: pending.ownerId })
    host.dispatch('GainCard', { playerId: pending.ownerId, cardIds: [cardId], reason: WEIJIE }, { sourceId: targetId, targetId: pending.ownerId, cardIds: [cardId] })
  } else {
    moveCard(host.state, cardId, { kind: 'hand', playerId: targetId }, { kind: 'discardPile' })
    host.dispatch('LoseCard', { playerId: targetId, cardIds: [cardId], reason: WEIJIE }, { sourceId: pending.ownerId, targetId, cardIds: [cardId] })
  }
  finishWeijie(host, granted, granted ? cardId : undefined)
}

function grantedActionId(host: SkillHost, request: GameRequest, cardId: CardId): string {
  if (request.kind === 'rescue') return `rescue-card:${cardId}`
  const resolution = host.state.cardResolution
  if (resolution?.kind === 'trick' && resolution.stage === 'awaiting-effect') return `respond-trick:${cardId}`
  return `respond-dodge:${cardId}`
}

function declineActionId(request: GameRequest): string {
  return request.kind === 'rescue' ? 'rescue-pass' : 'respond-pass'
}

function finishWeijie(host: SkillHost, granted: boolean, cardId?: CardId): void {
  const pending = host.state.weijieResponse
  if (!pending) return
  const request = pending.request as GameRequest
  const actionId = granted && cardId ? grantedActionId(host, request, cardId) : declineActionId(request)
  const replayRequest = structuredClone(request) as GameRequest & { actionIds?: string[] }
  if (Array.isArray(replayRequest.actionIds) && !replayRequest.actionIds.includes(actionId)) {
    replayRequest.actionIds = [...replayRequest.actionIds, actionId]
  }
  host.state.pendingRequests.push(replayRequest)
  const response: GameResponse = { requestId: request.id, playerId: pending.ownerId, payload: { actionId } }
  const replay = host as unknown as { respondInner(response: GameResponse): void }
  host.state.weijieResponse = null
  replay.respondInner(response)
}
