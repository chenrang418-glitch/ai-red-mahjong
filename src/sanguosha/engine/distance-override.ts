import type { PlayerId, SanguoshaState } from './types'

/**
 * 「视为距离 N」的定向覆盖（伏皇后【惴恐】没赢：该角色与伏皇后的距离视为 1）。
 *
 * 和 `attack-range-override.ts` 的「视为在攻击范围内」是同一类做法，但这里
 * 要覆盖的是**距离数值本身**——伏皇后这条要连带影响顺手牵羊、兵粮寸断这些
 * 直接读距离的效果，不能只做一个「攻击范围内」的布尔豁免。
 *
 * 方向是 `fromId → toId`：只改「谁看谁」这一侧的距离，不是双向对称的。
 * 期限统一到当前回合结束，和攻击范围覆盖同一套清理时机。
 */

export interface DistanceOverride {
  fromId: PlayerId
  toId: PlayerId
  distance: number
  sourceSkillId: string
}

export function forceDistance(state: SanguoshaState, entry: DistanceOverride): void {
  state.distanceOverrides ??= []
  state.distanceOverrides = state.distanceOverrides.filter((candidate) => (
    !(candidate.fromId === entry.fromId && candidate.toId === entry.toId)
  ))
  state.distanceOverrides.push({ ...entry })
}

export function distanceOverrideFor(state: SanguoshaState, fromId: PlayerId, toId: PlayerId): number | null {
  const entry = (state.distanceOverrides ?? []).find((candidate) => candidate.fromId === fromId && candidate.toId === toId)
  return entry ? entry.distance : null
}

/** 回合结束时统一清空。额外回合结束同样要清。 */
export function clearDistanceOverrides(state: SanguoshaState): void {
  if (state.distanceOverrides?.length) state.distanceOverrides = []
}
