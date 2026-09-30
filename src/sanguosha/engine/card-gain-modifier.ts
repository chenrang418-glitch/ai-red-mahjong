import type { PlayerId, SanguoshaState } from './types'

/** 建立一次性的下一次获得牌数量修正。倍率至少为 1。 */
export function armNextGainCardMultiplier(state: SanguoshaState, playerId: PlayerId, multiplier: number): void {
  if (!Number.isFinite(multiplier) || multiplier <= 1) return
  state.nextGainCardMultiplier ??= {}
  state.nextGainCardMultiplier[playerId] = Math.max(1, Math.trunc(multiplier))
}

/** 读取并消费一次性修正；没有修正时返回原数量。 */
export function consumeGainCardCount(state: SanguoshaState, playerId: PlayerId, count: number): number {
  const multiplier = state.nextGainCardMultiplier?.[playerId] ?? 1
  if (state.nextGainCardMultiplier?.[playerId] !== undefined) delete state.nextGainCardMultiplier[playerId]
  return Math.max(0, Math.trunc(count * multiplier))
}
