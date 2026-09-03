import type { PlayerId, SanguoshaState } from './types'

/**
 * 无亮【忍耐】的公共判断。
 *
 * **单独一个叶子模块（只依赖 types）**：求闪、锦囊效果求牌、无懈轮询三条路径
 * 都要问「这个人现在能不能改成忍」，而 `cards/basic.ts`、`cards/tricks.ts`
 * 反过来被 `data/characters` 依赖——引擎去 import 武将模块会成环。
 * `engine/nullification.ts` 和 `engine/guhuo-response.ts` 是同样的原因。
 */

/** 求牌请求里代表「放弃这次响应，改为忍」的动作 id。 */
export const RENNAI_ACTION = 'rennai'

export const RENNAI_SKILL = 'rennai'
/** 「忍」的数量，也是座位卡上显示的标记。 */
export const RENNAI_MARK = 'rennai'
/** 上限 4 枚，再忍也不会涨。 */
export const RENNAI_MAX = 4
/**
 * 已经放弃响应、正在等这张牌结算完看有没有吃到亏。
 *
 * 存的是当次卡牌的 seq，而不是布尔量：`marks` 只能存数字，而且带上 seq 之后
 * 上一张牌留下的残留标记不会被下一张牌误认。
 */
const RENNAI_ARMED_MARK = 'rennai-armed'
/** 这次放弃响应之后确实吃到了负面结果。 */
const RENNAI_HURT_MARK = 'rennai-hurt'

function playerOf(state: SanguoshaState, playerId: PlayerId) {
  return state.players.find((candidate) => candidate.id === playerId)
}

function hasRennai(state: SanguoshaState, playerId: PlayerId, skillIdsOf: (characterId: string) => string[]): boolean {
  const player = playerOf(state, playerId)
  return Boolean(player?.alive && player.characterId && skillIdsOf(player.characterId).includes(RENNAI_SKILL))
}

export function rennaiCount(state: SanguoshaState, playerId: PlayerId): number {
  return playerOf(state, playerId)?.marks[RENNAI_MARK] ?? 0
}

export function setRennaiCount(state: SanguoshaState, playerId: PlayerId, value: number): void {
  const player = playerOf(state, playerId)
  if (!player) return
  const next = Math.max(0, Math.min(RENNAI_MAX, Math.trunc(value)))
  if (next > 0) player.marks[RENNAI_MARK] = next
  else delete player.marks[RENNAI_MARK]
}

/**
 * 现在能不能把这次响应改成「忍」。
 *
 * `hasRealResponse` 由调用方给：**规则要求「若你可以响应」**，也就是这张牌本来
 * 就存在合法的响应手段。手上根本没有【闪】时不能靠「不响应」白拿收益，
 * 被技能禁止响应时同理——那两种情况调用方给出的 actionIds 里本来就没有真响应。
 */
export function canRennai(
  state: SanguoshaState,
  responderId: PlayerId,
  sourceId: PlayerId | null,
  hasRealResponse: boolean,
  usedThisTurn: boolean,
  skillIdsOf: (characterId: string) => string[],
): boolean {
  if (!hasRealResponse || usedThisTurn) return false
  // 必须是**其他角色**使用的牌
  if (!sourceId || sourceId === responderId) return false
  return hasRennai(state, responderId, skillIdsOf)
}

/** 已经声明忍、正在等这张牌结算完。 */
export function isRennaiArmed(state: SanguoshaState, playerId: PlayerId): boolean {
  return (playerOf(state, playerId)?.marks[RENNAI_ARMED_MARK] ?? 0) > 0
}

/** 声明忍：记下这一次，等牌结算完再看有没有吃亏。 */
export function armRennai(state: SanguoshaState, playerId: PlayerId): void {
  const player = playerOf(state, playerId)
  if (!player) return
  player.marks[RENNAI_ARMED_MARK] = Math.max(1, state.seq)
  delete player.marks[RENNAI_HURT_MARK]
}

/** 记一笔「这次真的吃亏了」。只有 armed 期间才算数。 */
export function noteRennaiHarm(state: SanguoshaState, playerId: PlayerId): void {
  const player = playerOf(state, playerId)
  if (!player || !isRennaiArmed(state, playerId)) return
  player.marks[RENNAI_HURT_MARK] = 1
}

/**
 * 结算这一次忍：返回是否真的吃到了负面结果，并把两个临时标记清掉。
 *
 * 清标记和判定放在一起，调用方没法只清一半。
 */
export function consumeRennai(state: SanguoshaState, playerId: PlayerId): boolean {
  const player = playerOf(state, playerId)
  if (!player) return false
  const hurt = (player.marks[RENNAI_HURT_MARK] ?? 0) > 0
  delete player.marks[RENNAI_ARMED_MARK]
  delete player.marks[RENNAI_HURT_MARK]
  return hurt
}
