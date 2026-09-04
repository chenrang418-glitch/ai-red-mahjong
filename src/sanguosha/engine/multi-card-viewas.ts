import type { ChooseCardsRequest, GameRequest, GameResponse } from './requests'
import type { SkillHost } from './skills/runtime'
import { skillsOf } from './skills/runtime'
import { skillIdsOf } from '../data/characters/standard'
import type { CardId, DamageNature, PlayerId, SanguoshaState, Suit } from './types'
import { locateOwnedCard, moveCard, setCardAlias, setCardNature } from './zones'

/**
 * 「把恰好 N 张同花色的牌当作某张牌使用或打出」的公共机制。
 *
 * 神赵云【龙魂】要的就是这个：X 张花色相同的牌，X 等于当前体力且至少为 1，
 * 红桃当【桃】、方块当【火杀】、梅花当【闪】、黑桃当【无懈可击】。
 *
 * 为什么不能用现有的单牌 `viewAs`：
 *
 * - 单牌 `viewAs` 一次只报一张牌，凑不出「恰好 N 张同花色」这个约束。
 * - 把所有组合枚举成选项在手机上没法用：6 张手牌配 2 张一组就是 15 个按钮，
 *   再乘四种用途。引擎里丈八蛇矛、方天画戟早就因为同样的原因改成了两步交互。
 * - 玩家必须**在选牌之前**就知道「这次需要几张、要同花色」，
 *   而不是选完一张才被告知非法。
 *
 * 所以走和于吉【蛊惑】同一条路：在各个求牌请求里多挂一条声明动作，
 * 引擎集中认领，挂起原请求 → 问玩家选哪 N 张 → 落地后把原请求重放一次。
 * 求闪、求桃、无懈、锦囊效果这四条路径因此都不用各写一遍。
 *
 * **底牌区域**：手牌和装备区都算（经典龙魂的「牌」包含装备区）。
 * 判定区、专属牌堆、弃牌堆一律不算。
 */

export const MULTI_VIEWAS_ACTION = 'multi-viewas'

/** 技能向本机制报备自己能提供什么。由技能运行时实现 `multiCardViewAs` 钩子。 */
export interface MultiCardViewAsSpec {
  skillId: string
  /** 这次要凑几张。由技能按当前状态算（龙魂是 max(1, 当前体力)）。 */
  requiredCount: number
  /** 花色 → 转化成的牌名。没列出的花色不能用。 */
  suitToCardName: Partial<Record<Suit, string>>
  /** 转化后的伤害属性（龙魂的方块是火焰）。不给就沿用牌面自带的。 */
  natureOf?: Partial<Record<Suit, DamageNature>>
}

export interface MultiCardViewAsState {
  ownerId: PlayerId
  skillId: string
  requiredCount: number
  /** 要凑成的牌名，由响应场景决定（求闪就是【闪】）。 */
  asCardName: string
  /** 原请求原样存着，落地之后放回去重放一次。 */
  request: GameRequest
  /** 求桃时挂起的濒死流程，重放前恢复。 */
  suspendedDying: unknown | null
  /** 本次落地时被指定为载体的那张牌，只在重放期间有值。 */
  grantedCardId: CardId | null
}

/**
 * 这张牌在**当前这次重放**里被授予成了什么牌名。
 *
 * 和于吉【蛊惑】的 `guhuoGrantedAs` 同一个用途：各个响应路径的校验读的是
 * 实体牌名，不认转化，所以要有一个「这次特批」的入口。
 * 只在挂起流程存在且正是那张载体牌时才返回，不会放开任意牌。
 */
export function multiCardGrantedAs(
  state: SanguoshaState,
  playerId: PlayerId,
  cardId: CardId,
): string | null {
  const pending = state.multiCardViewAs
  if (!pending || pending.ownerId !== playerId || pending.grantedCardId !== cardId) return null
  return pending.asCardName
}

function playerOf(state: SanguoshaState, playerId: PlayerId) {
  return state.players.find((candidate) => candidate.id === playerId)
}

function specsOf(state: SanguoshaState, playerId: PlayerId): MultiCardViewAsSpec[] {
  return skillsOf(state, playerId, skillIdsOf)
    .map((runtime) => runtime.multiCardViewAs?.(state, playerId))
    .filter((spec): spec is MultiCardViewAsSpec => Boolean(spec))
}

/**
 * 这名角色现在能不能凑出指定牌名。
 *
 * 手牌 + 装备区里，某个能转化成该牌名的花色，张数够不够 `requiredCount`。
 */
export function canMultiCardViewAs(
  state: SanguoshaState,
  playerId: PlayerId,
  requiredCardName: string,
): boolean {
  return findMultiViewAsSpec(state, playerId, requiredCardName) !== null
}

/** 找出能凑成这个牌名的那条声明，顺便带上可用的花色。 */
export function findMultiViewAsSpec(
  state: SanguoshaState,
  playerId: PlayerId,
  requiredCardName: string,
): { spec: MultiCardViewAsSpec; suits: Suit[] } | null {
  const owner = playerOf(state, playerId)
  if (!owner?.alive) return null
  for (const spec of specsOf(state, playerId)) {
    const suits = (Object.entries(spec.suitToCardName) as Array<[Suit, string]>)
      .filter(([, cardName]) => cardName === requiredCardName)
      .map(([suit]) => suit)
      .filter((suit) => baseCardsOf(state, playerId, suit).length >= spec.requiredCount)
    if (suits.length > 0) return { spec, suits }
  }
  return null
}

/**
 * 可以当底牌的牌：手牌 + 装备区，按花色筛。
 *
 * 判定区不算——那些牌不归你使用；专属牌堆、弃牌堆同理。
 */
export function baseCardsOf(state: SanguoshaState, playerId: PlayerId, suit: Suit): CardId[] {
  const owner = playerOf(state, playerId)
  if (!owner) return []
  const equipment = Object.values(owner.zones.equipment).filter((cardId): cardId is CardId => Boolean(cardId))
  return [...owner.zones.hand, ...equipment].filter((cardId) => state.cards[cardId]?.suit === suit)
}

/** 所有可用花色的底牌合起来，用于发问时的候选池。 */
function candidatePool(state: SanguoshaState, playerId: PlayerId, suits: Suit[]): CardId[] {
  return suits.flatMap((suit) => baseCardsOf(state, playerId, suit))
}

/**
 * 玩家选择了「用多牌转化响应」。挂起原请求，问他选哪几张。
 */
export function beginMultiCardViewAs(host: SkillHost, request: GameRequest, requiredCardName: string): void {
  const ownerId = request.playerId
  const found = findMultiViewAsSpec(host.state, ownerId, requiredCardName)
  if (!found) throw new Error('现在不能用多牌转化响应')
  const { spec, suits } = found

  host.state.pendingRequests = host.state.pendingRequests.filter((candidate) => candidate.id !== request.id)
  host.state.multiCardViewAs = {
    ownerId,
    skillId: spec.skillId,
    requiredCount: spec.requiredCount,
    asCardName: requiredCardName,
    request: structuredClone(request),
    suspendedDying: request.kind === 'rescue' && host.state.dying ? structuredClone(host.state.dying) : null,
    grantedCardId: null,
  }
  // 求桃本身就是一条濒死流程，挂起期间让出 state.dying
  if (request.kind === 'rescue' && host.state.dying) host.state.dying = null

  const pool = candidatePool(host.state, ownerId, suits)
  host.askSkill({
    skillId: spec.skillId,
    ownerId,
    step: 'multi-viewas',
    build: (requestId): ChooseCardsRequest => ({
      id: requestId,
      kind: 'choose-cards',
      playerId: ownerId,
      // 张数和「必须同花色」写在提示里：不能让玩家选完才被告知非法
      prompt: `【${skillNameOf(spec.skillId)}】：选择 ${spec.requiredCount} 张花色相同的牌，`
        + `当作【${requiredCardName}】使用或打出`,
      timeoutMs: 30_000,
      optional: false,
      purpose: 'skill',
      cardIds: pool,
      hiddenCardSlots: [],
      min: spec.requiredCount,
      max: spec.requiredCount,
    }),
  })
}

function skillNameOf(skillId: string): string {
  return skillId === 'longhun' ? '龙魂' : skillId
}

/**
 * 玩家选好了 N 张牌，落地。
 *
 * 其中一张当**载体**：别名成目标牌名、必要时改写伤害属性，然后原样重放原请求，
 * 后续的求闪 / 濒死 / 无懈链完全走既有路径。其余 N-1 张作为代价直接进弃牌堆。
 * 净效果和「N 张一起作为子牌」相同，而且不用把整条响应链改成支持复合牌。
 */
export function finishMultiCardViewAs(host: SkillHost, cardIds: CardId[]): void {
  const pending = host.state.multiCardViewAs
  if (!pending) return
  const { ownerId, asCardName, requiredCount } = pending
  const request = pending.request as GameRequest
  const owner = playerOf(host.state, ownerId)

  const valid = validateSelection(host.state, ownerId, cardIds, requiredCount)
  if (!owner?.alive || !valid) {
    // 选得不合法就当作放弃，不能把原请求丢掉
    replay(host, declineActionId(request))
    return
  }

  const suit = host.state.cards[valid[0]]!.suit
  const spec = specsOf(host.state, ownerId).find((candidate) => candidate.skillId === pending.skillId)
  const [carrierId, ...costIds] = valid

  // 代价牌先进弃牌堆。装备区的牌离场要走正常收尾，所以统一用 moveCard + 事件。
  for (const cardId of costIds) {
    const from = locateOwnedCard(host.state, ownerId, cardId)
    if (!from) continue
    moveCard(host.state, cardId, from, { kind: 'discardPile' })
    if (from.kind === 'equipment') {
      host.dispatch('LoseEquipment', { playerId: ownerId, cardId, reason: pending.skillId }, { targetId: ownerId, cardIds: [cardId] })
    }
  }
  if (costIds.length > 0) {
    host.dispatch('LoseCard', { playerId: ownerId, cardIds: costIds, reason: pending.skillId }, { sourceId: ownerId, cardIds: costIds })
  }

  // 载体牌如果在装备区，先回到手上，后面的响应路径才认它
  const carrierFrom = locateOwnedCard(host.state, ownerId, carrierId)
  if (carrierFrom?.kind === 'equipment') {
    moveCard(host.state, carrierId, carrierFrom, { kind: 'hand', playerId: ownerId })
    host.dispatch('LoseEquipment', { playerId: ownerId, cardId: carrierId, reason: pending.skillId }, { targetId: ownerId, cardIds: [carrierId] })
  }

  pending.grantedCardId = carrierId
  setCardAlias(host.state, carrierId, asCardName)
  const nature = spec?.natureOf?.[suit]
  if (nature) setCardNature(host.state, carrierId, nature)

  host.dispatch('SkillActivated', {
    skillId: pending.skillId, skillName: skillNameOf(pending.skillId), playerId: ownerId,
    logText: `${owner.nickname}发动【${skillNameOf(pending.skillId)}】，`
      + `将 ${requiredCount} 张${suitLabel(suit)}牌当作【${asCardName}】`,
  }, { sourceId: ownerId })

  replay(host, grantedActionId(host, request, carrierId, asCardName))
}

function suitLabel(suit: Suit): string {
  return { spade: '黑桃', heart: '红桃', club: '梅花', diamond: '方块' }[suit] ?? ''
}

/** 校验：数量对、都还在自己区域里、花色全部相同。 */
function validateSelection(
  state: SanguoshaState,
  ownerId: PlayerId,
  cardIds: CardId[],
  requiredCount: number,
): CardId[] | null {
  const unique = [...new Set(cardIds)]
  if (unique.length !== requiredCount) return null
  const suits = new Set<Suit>()
  for (const cardId of unique) {
    const from = locateOwnedCard(state, ownerId, cardId)
    // 判定区的牌不能当底牌
    if (!from || (from.kind !== 'hand' && from.kind !== 'equipment')) return null
    const suit = state.cards[cardId]?.suit
    if (!suit) return null
    suits.add(suit)
  }
  // **同花色**，不是同颜色：红桃配方块非法
  if (suits.size !== 1) return null
  return unique
}

function replay(host: SkillHost, actionId: string): void {
  const pending = host.state.multiCardViewAs
  if (!pending) return
  const request = pending.request as GameRequest
  const replayRequest = structuredClone(request) as GameRequest & { actionIds?: string[] }
  if (Array.isArray(replayRequest.actionIds) && !replayRequest.actionIds.includes(actionId)) {
    replayRequest.actionIds = [...replayRequest.actionIds, actionId]
  }
  if (pending.suspendedDying) host.state.dying = structuredClone(pending.suspendedDying) as never
  host.state.pendingRequests.push(replayRequest)
  const response: GameResponse = { requestId: request.id, playerId: pending.ownerId, payload: { actionId } }
  const replayHost = host as unknown as { respondInner(response: GameResponse): void }
  try {
    replayHost.respondInner(response)
  } finally {
    host.state.multiCardViewAs = null
  }
}

/** 和蛊惑同一套：按当前结算状态决定用哪条动作 id 回答原请求。 */
function grantedActionId(host: SkillHost, request: GameRequest, cardId: CardId, asCardName: string): string {
  if (request.kind === 'rescue') return `rescue-card:${cardId}`
  if (asCardName === '无懈可击') return `respond-nullification:${cardId}`
  const resolution = host.state.cardResolution
  if (resolution?.kind === 'trick' && resolution.stage === 'awaiting-effect') return `respond-trick:${cardId}`
  return `respond-dodge:${cardId}`
}

function declineActionId(request: GameRequest): string {
  return request.kind === 'rescue' ? 'rescue-pass' : 'respond-pass'
}
