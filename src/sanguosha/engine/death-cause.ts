import type { PlayerId, SanguoshaState } from './types'

/**
 * 「他是不是**因此**死的」——濒死与死亡的因果归属。
 *
 * 神黄忠【裂穹·天冲】令目标失去所有体力，**若其因此死亡**才 +1 体力上限。
 * 这条判断不能靠时间先后凑：
 *
 * - 目标被桃救回来了，之后又被别人打死——那不算「因此死亡」；
 * - 目标在同一次濒死里没人救，死了——那算；
 * - 中间隔了几个别的效果，只要还是同一次濒死流程，仍然算。
 *
 * 所以记的是**这一次濒死是谁造成的**：进入濒死时打上标记，
 * 濒死结束（被救回来）时抹掉，死亡时还在就说明是因它而死。
 *
 * 标记挂在被击倒的人身上、写进牌局状态，重连之后仍然算得清。
 */

function keyOf(reason: string, sourceId: PlayerId): string {
  return `dying-cause:${reason}:${sourceId}`
}

/** 记下「这次濒死是 sourceId 用 reason 造成的」。 */
export function markDyingCause(state: SanguoshaState, playerId: PlayerId, reason: string, sourceId: PlayerId): void {
  const player = state.players.find((candidate) => candidate.id === playerId)
  if (!player) return
  player.marks[keyOf(reason, sourceId)] = 1
}

/** 这次死亡是不是由那个原因造成的。 */
export function dyingCausedBy(state: SanguoshaState, playerId: PlayerId, reason: string, sourceId: PlayerId): boolean {
  const player = state.players.find((candidate) => candidate.id === playerId)
  return !!player?.marks[keyOf(reason, sourceId)]
}

/**
 * 抹掉因果标记。
 *
 * **被救回来时必须调**：救回来之后他再死，就和这个原因没关系了。
 */
export function clearDyingCause(state: SanguoshaState, playerId: PlayerId, reason: string, sourceId: PlayerId): void {
  const player = state.players.find((candidate) => candidate.id === playerId)
  if (player) delete player.marks[keyOf(reason, sourceId)]
}
