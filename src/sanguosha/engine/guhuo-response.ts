import { registerGroupDecision, playersWhoChose, startGroupDecision } from './group-decision'
import { drawCards } from './draw'
import { loseHp } from './hp'
import {
  closePrivateZone, moveIntoPrivateZone, moveOutOfPrivateZone, openPrivateZone, privateZoneCards,
} from './private-zone'
import type { ChooseCardsRequest, GameRequest, GameResponse } from './requests'
import type { SkillHost } from './skills/runtime'
import type { CardId, PlayerId, SanguoshaState } from './types'
/**
 * 技能 id。**故意写在引擎侧而不是从武将文件 import**：
 * `basic.ts` / `damage.ts` / `judgment.ts` 都要用这里的函数，
 * 而它们反过来被 `data/characters` 依赖——引擎去 import 武将模块会成环，
 * 症状是 ALL_CHARACTERS 初始化到一半就被读，整套测试全红。
 */
const GUHUO = 'guhuo'

/**
 * 于吉【蛊惑】的**打出**模式。
 *
 * 使用模式（出牌阶段）在 wind-yuji.ts。这里处理「需要打出一张牌」的场合：
 * 求闪、求桃、无懈窗口、决斗要杀……
 *
 * 关键设计：**只有一个拦截点**。所有求牌请求都是「给一串 actionId、挑一个」，
 * 所以只要在每个请求的 actionIds 里多加一条 `guhuo-respond`，
 * 再在 `game.respondInner` 里集中认领它就够了——不需要在五条求牌路径里
 * 各写一遍挂起和恢复。
 *
 * 质疑结束之后**把原请求原样放回去再重放一次回答**，于是后续结算走的仍然是
 * 原来那条路（求闪回到 SlashResolution、无懈回到无懈链、桃回到濒死流程），
 * 不新造任何一张牌，也不复制任何卡牌效果。
 */

/** 求牌请求里代表「我要用蛊惑打出这张牌」的动作 id。 */
export const GUHUO_RESPOND_ACTION = 'guhuo-respond'

const CHALLENGE_TAG = 'guhuo-respond-challenge'
const CHALLENGE = 'guhuo-challenge-yes'
const PASS = 'guhuo-challenge-no'
const CHALLENGE_TIMEOUT_MS = 8_000
const ZONE_ID = 'guhuo-respond'

function playerOf(state: SanguoshaState, playerId: PlayerId) {
  return state.players.find((candidate) => candidate.id === playerId)
}

function hasGuhuo(state: SanguoshaState, playerId: PlayerId, skillIdsOf: (characterId: string) => string[]): boolean {
  const player = playerOf(state, playerId)
  return Boolean(player?.alive && player.characterId && skillIdsOf(player.characterId).includes(GUHUO))
}

/**
 * 这个人现在能不能用蛊惑打出 `requiredCardName`。
 *
 * 只要有手牌就行——真假由质疑去揭穿，这正是蛊惑的玩法。
 * 但**同一时刻只能有一次蛊惑在飞**，嵌套会把恢复逻辑绕死。
 */
export function canGuhuoRespond(
  state: SanguoshaState,
  playerId: PlayerId,
  requiredCardName: string,
  skillIdsOf: (characterId: string) => string[],
): boolean {
  // granted/declined 只存在于同步重放原响应的最后一瞬间。无双可能在这次重放
  // 内立刻生成“第二张闪/杀”请求；新请求应当带上下一次蛊惑入口，但真正提交
  // 要等当前调用返回，此时旧状态已经清空，所以不会形成嵌套质疑。
  if (state.guhuoResponse && !['granted', 'declined'].includes(state.guhuoResponse.stage)) return false
  if (state.groupDecision) return false
  if (!hasGuhuo(state, playerId, skillIdsOf)) return false
  // 声明的必须是基本牌或非延时锦囊——求牌场合本来也只会要这几种
  if (!['闪', '杀', '桃', '酒', '无懈可击'].includes(requiredCardName)) return false
  return (playerOf(state, playerId)?.zones.hand.length ?? 0) > 0
}

/**
 * 一张牌现在能不能被当作某个牌名**打出**。
 *
 * 只有质疑通过之后的那一瞬间会返回 true。求闪、求桃这些路径本来就用
 * `viewAs` 判断「这张牌能不能当那张牌」，所以蛊惑成立时临时把那张牌
 * 报进去，就能沿用它们全部的校验，不必改五处。
 */
export function guhuoGrantedAs(state: SanguoshaState, playerId: PlayerId, cardId: CardId): string | null {
  const pending = state.guhuoResponse
  if (!pending || pending.stage !== 'granted') return null
  if (pending.ownerId !== playerId || pending.cardId !== cardId) return null
  return pending.requiredCardName
}

/**
 * 开始一次「打出」模式的蛊惑。
 *
 * 调用方（game.respondInner）已经确认这条动作合法，这里负责：
 * 收走原请求并**原样记下来**，然后问于吉要扣哪张牌。
 */
export function beginGuhuoRespond(host: SkillHost, request: GameRequest): void {
  const ownerId = request.playerId
  const requiredCardName = 'requiredCardName' in request ? String(request.requiredCardName) : '桃'
  const owner = playerOf(host.state, ownerId)
  if (!owner?.alive || owner.zones.hand.length === 0) throw new Error('现在不能用蛊惑打出牌')

  host.state.pendingRequests = host.state.pendingRequests.filter((candidate) => candidate.id !== request.id)
  host.state.guhuoResponse = {
    ownerId,
    requiredCardName,
    cardId: null,
    stage: 'declaring',
    penaltyPlayerIds: [],
    grantedAfterPenalties: false,
    suspendedDying: request.kind === 'rescue' && host.state.dying
      ? structuredClone(host.state.dying)
      : null,
    // 原请求原样存着：质疑结束之后要把它放回去再重放一次回答
    request: structuredClone(request),
  }
  // 求桃本身就是一条濒死流程。质疑期间若有人因失去体力进入濒死，
  // 必须让新的流程暂时占用 state.dying，原流程跟随蛊惑上下文序列化挂起。
  if (request.kind === 'rescue' && host.state.dying) host.state.dying = null
  host.askSkill({
    skillId: GUHUO,
    ownerId,
    step: 'respond-card',
    build: (requestId): ChooseCardsRequest => ({
      id: requestId,
      kind: 'choose-cards',
      playerId: ownerId,
      prompt: `【蛊惑】：选择一张手牌，正面朝下当作【${requiredCardName}】打出`,
      timeoutMs: 20_000,
      optional: false,
      purpose: 'skill',
      cardIds: [...owner.zones.hand],
      hiddenCardSlots: [],
      min: 1,
      max: 1,
    }),
  })
}

/** 于吉选好了要扣的牌，扣置并向其他人发起质疑。 */
export function continueGuhuoRespond(host: SkillHost, ownerId: PlayerId, cardId: CardId): void {
  const pending = host.state.guhuoResponse
  const owner = playerOf(host.state, ownerId)
  if (!pending || pending.stage !== 'declaring' || !owner?.alive || !owner.zones.hand.includes(cardId)) {
    finishGuhuoRespond(host, false)
    return
  }
  pending.cardId = cardId
  openPrivateZone(host.state, ZONE_ID, ownerId, GUHUO)
  moveIntoPrivateZone(host.state, cardId, { kind: 'hand', playerId: ownerId }, ZONE_ID)
  host.dispatch('SkillActivated', {
    skillId: GUHUO, skillName: '蛊惑', playerId: ownerId,
    declaredName: pending.requiredCardName, faceDown: true, mode: 'respond',
  }, { sourceId: ownerId })

  startGroupDecision(host, {
    id: `guhuo-respond-${host.state.seq}`,
    tag: CHALLENGE_TAG,
    playerIds: challengeOrder(host.state, ownerId),
    prompt: `${owner.nickname}发动【蛊惑】，声明打出【${pending.requiredCardName}】，是否质疑？`,
    options: [{ id: CHALLENGE, label: '质疑' }, { id: PASS, label: '不质疑' }],
    defaultOptionId: PASS,
    timeoutMs: CHALLENGE_TIMEOUT_MS,
    data: { ownerId },
  })
}

/** 除于吉之外的存活角色，从当前回合角色起按座次。 */
function challengeOrder(state: SanguoshaState, ownerId: PlayerId): PlayerId[] {
  const current = playerOf(state, state.currentPlayerId)
  const start = current?.seat ?? 0
  const order: PlayerId[] = []
  for (let offset = 0; offset < state.players.length; offset += 1) {
    const candidate = state.players[(start + offset) % state.players.length]
    if (candidate.alive && candidate.id !== ownerId) order.push(candidate.id)
  }
  return order
}

registerGroupDecision(CHALLENGE_TAG, (host, decision) => {
  const skillHost = host as unknown as SkillHost
  const pending = host.state.guhuoResponse
  if (!pending || !pending.cardId) {
    closePrivateZone(host.state, ZONE_ID)
    host.state.guhuoResponse = null
    return
  }
  const ownerId = pending.ownerId
  const [cardId] = privateZoneCards(host.state, ZONE_ID)
  const owner = playerOf(host.state, ownerId)
  if (!cardId || !owner?.alive) {
    closePrivateZone(host.state, ZONE_ID)
    finishGuhuoRespond(skillHost, false)
    return
  }

  const realCard = host.state.cards[cardId]
  const truthful = realCard.name === pending.requiredCardName
  const challengers = playersWhoChose(decision, CHALLENGE)

  if (challengers.length === 0) {
    // 无人质疑：按所述之牌打出，不揭示
    finishGuhuoRespond(skillHost, true)
    return
  }

  skillHost.dispatch('CardMove', {
    playerId: ownerId, cardIds: [cardId], reason: GUHUO, revealed: true,
    declaredName: pending.requiredCardName, truthful, challengerIds: [...challengers],
  }, { sourceId: ownerId, cardIds: [cardId] })

  pending.stage = 'penalizing'
  pending.penaltyPlayerIds = [...challengers]
  pending.grantedAfterPenalties = truthful && realCard.suit === 'heart'
  continueGuhuoResponseAfterDying(skillHost, truthful)
})

/**
 * 依次结算质疑者。若某人因失去体力进入濒死，就把剩余名单留在状态中；
 * 该濒死流程结束后由 Game 重新调用这里，能够跨 DO 休眠与断线恢复。
 */
export function continueGuhuoResponseAfterDying(host: SkillHost, truthfulOverride?: boolean): boolean {
  const pending = host.state.guhuoResponse
  if (!pending || pending.stage !== 'penalizing') return false
  const cardId = pending.cardId
  const realCard = cardId ? host.state.cards[cardId] : null
  const truthful = truthfulOverride ?? Boolean(realCard && realCard.name === pending.requiredCardName)
  const remaining = pending.penaltyPlayerIds ?? []

  while (!host.state.dying && remaining.length > 0 && host.state.status === 'playing') {
    const challengerId = remaining.shift()!
    const challenger = playerOf(host.state, challengerId)
    if (!challenger?.alive) continue
    if (truthful) {
      // 失去体力，不是伤害；若进入濒死，循环会停在这里等待完整救援。
      loseHp(host, challengerId, 1, GUHUO)
    } else {
      drawCards(host.state, host.rng, challengerId, 1, (name, payload) => {
        host.dispatch(name, { ...payload, reason: GUHUO })
      })
    }
  }

  if (host.state.dying) return true
  if (host.state.status !== 'playing') {
    abortGuhuoRespond(host)
    return true
  }
  finishGuhuoRespond(host, Boolean(pending.grantedAfterPenalties))
  return true
}

/**
 * 质疑惩罚可能直接令牌局结束。此时原请求已经没有继续结算的意义，不能再把它
 * 放回队列，否则结束后的状态里会残留一条永远无法回答的请求。
 */
function abortGuhuoRespond(host: SkillHost): void {
  const pending = host.state.guhuoResponse
  if (!pending) return
  if (pending.cardId && privateZoneCards(host.state, ZONE_ID).includes(pending.cardId)) {
    moveOutOfPrivateZone(host.state, pending.cardId, ZONE_ID, { kind: 'discardPile' })
  }
  closePrivateZone(host.state, ZONE_ID)
  host.state.guhuoResponse = null
}

/**
 * 收尾：把原请求放回去，再替于吉重放一次回答。
 *
 * `granted` 为 true 时那张牌被当作声明的牌打出，为 false 时等同于放弃。
 * **走的仍然是原来那条结算路径**——求闪回到 SlashResolution、
 * 无懈回到无懈链、桃回到濒死流程，一张新牌都不造。
 */
function finishGuhuoRespond(host: SkillHost, granted: boolean): void {
  const pending = host.state.guhuoResponse
  if (!pending) return
  const { ownerId, cardId, requiredCardName } = pending
  const request = pending.request as GameRequest
  const owner = playerOf(host.state, ownerId)

  if (granted && cardId && owner?.alive) {
    // 牌回到手上，然后临时报成声明的那张牌，让原来的校验放行
    moveOutOfPrivateZone(host.state, cardId, ZONE_ID, { kind: 'hand', playerId: ownerId })
    closePrivateZone(host.state, ZONE_ID)
    pending.stage = 'granted'
  } else {
    if (cardId) moveOutOfPrivateZone(host.state, cardId, ZONE_ID, { kind: 'discardPile' })
    closePrivateZone(host.state, ZONE_ID)
    pending.stage = 'declined'
  }

  const actionId = granted && cardId
    ? grantedActionId(host, request, cardId, requiredCardName)
    : declineActionId(request)
  /*
   * 原请求放回去时要把成立后的那条动作补进 actionIds。
   *
   * 请求是在「这张牌还不是【闪】」的时候构造的，里面自然没有它；
   * 不补的话重放会被 validateResponse 以「actionId 非法」打回来。
   * 补的是**这一次**重放用的那一条，不是放开任意牌。
   */
  const replayRequest = structuredClone(request) as GameRequest & { actionIds?: string[] }
  if (Array.isArray(replayRequest.actionIds) && !replayRequest.actionIds.includes(actionId)) {
    replayRequest.actionIds = [...replayRequest.actionIds, actionId]
  }
  // 若原请求是求桃，先恢复它所属的那条濒死流程，再把原请求原样放回去。
  if (pending.suspendedDying) host.state.dying = structuredClone(pending.suspendedDying)
  host.state.pendingRequests.push(replayRequest)
  const response: GameResponse = { requestId: request.id, playerId: ownerId, payload: { actionId } }
  const replay = host as unknown as { respondInner(response: GameResponse): void }
  try {
    replay.respondInner(response)
  } finally {
    host.state.guhuoResponse = null
  }
}

/** 成立时该用哪条动作 id 回答原请求。 */
function grantedActionId(host: SkillHost, request: GameRequest, cardId: CardId, requiredCardName: string): string {
  if (request.kind === 'rescue') return `rescue-card:${cardId}`
  if (requiredCardName === '无懈可击') return `respond-nullification:${cardId}`
  /*
   * 锦囊效果里的「打出杀/闪」（决斗、南蛮、万箭）走 respond-trick，
   * 普通求闪走 respond-dodge。**按当前结算状态判断，不看 actionIds**——
   * 原来是「actionIds 里有没有 respond-trick:」，可于吉正是因为手上没有那张牌
   * 才发的蛊惑，那时候一条 respond-trick: 都不会有，于是走进求闪那条分支，
   * 被「响应 action 类型不匹配」打回来。
   */
  const resolution = host.state.cardResolution
  if (resolution?.kind === 'trick' && resolution.stage === 'awaiting-effect') return `respond-trick:${cardId}`
  return `respond-dodge:${cardId}`
}

/** 不成立时等同于放弃。 */
function declineActionId(request: GameRequest): string {
  return request.kind === 'rescue' ? 'rescue-pass' : 'respond-pass'
}
