import type { PlayerId, SanguoshaState } from './types'

/**
 * 「这个回合里谁杀死了谁」的公共账本。
 *
 * 神司马懿【连破】要的就是这个：一名角色的回合结束后，若神司马懿在该回合内
 * 杀死过至少一名角色，他可以获得一个额外回合。
 *
 * 三条纪律：
 *
 * 1. **按回合实例记账，不是一个全局布尔**。写成 `killedThisTurn = true`
 *    就分不清「哪个回合里杀的」，回合外死亡、跨回合残留都会误触发。
 *    `turnNumber` 每个回合（含额外回合）都会加一，正好当回合实例 id。
 * 2. **同一回合杀多人只算一次机会**。查的是「这个回合有没有杀过人」，
 *    不是杀了几个——杀三个人不该换来三个额外回合。
 * 3. **回合外的死亡不记账**。不属于任何角色回合的后处理阶段里有人死亡时，
 *    不应该凭空关联到已经结束的上一个回合。
 */

export interface TurnKillRecord {
  /** 回合实例 id，用 `state.turnNumber`。 */
  turnNumber: number
  /** 这个回合归谁。 */
  turnPlayerId: PlayerId
  killerId: PlayerId
  killedPlayerIds: PlayerId[]
}

/** 记一次击杀。来源为空（闪电、崩坏、自杀）时不记。 */
export function recordTurnKill(
  state: SanguoshaState,
  killerId: PlayerId | null | undefined,
  killedPlayerId: PlayerId,
): void {
  if (!killerId || killerId === killedPlayerId) return
  // 不在任何回合内（牌局还没开始、或回合之间的后处理）就不记账
  if (state.status !== 'playing' || !state.currentPlayerId) return
  state.turnKills ??= []
  const existing = state.turnKills.find((entry) => (
    entry.turnNumber === state.turnNumber && entry.killerId === killerId
  ))
  if (existing) {
    if (!existing.killedPlayerIds.includes(killedPlayerId)) existing.killedPlayerIds.push(killedPlayerId)
    return
  }
  state.turnKills.push({
    turnNumber: state.turnNumber,
    turnPlayerId: state.currentPlayerId,
    killerId,
    killedPlayerIds: [killedPlayerId],
  })
}

/**
 * 这个回合里此人杀过人吗。
 *
 * **不看是不是他自己的回合**：神司马懿在貂蝉的回合里用决斗杀了人，
 * 那个回合结束后同样可以连破。
 */
export function killedInTurn(state: SanguoshaState, killerId: PlayerId, turnNumber: number): boolean {
  return (state.turnKills ?? []).some((entry) => (
    entry.turnNumber === turnNumber && entry.killerId === killerId && entry.killedPlayerIds.length > 0
  ))
}

/**
 * 回合结束后清掉这个回合的账。
 *
 * 由 `turn.ts` 在 `TurnEnd` 之后统一调——**必须在 TurnEnd 的技能都结算完之后**，
 * 否则连破还没来得及问就把账本删了。
 */
export function clearTurnKills(state: SanguoshaState, turnNumber: number): void {
  state.turnKills = (state.turnKills ?? []).filter((entry) => entry.turnNumber !== turnNumber)
}
