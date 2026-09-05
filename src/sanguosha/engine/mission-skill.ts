import type { PlayerId, SanguoshaState } from './types'

/**
 * 使命技的状态机。
 *
 * 使命技有三个**互斥且终局**的状态，神太史慈【破围】是第一个用它的技能：
 *
 * - `in-progress`：还在进行中，使命的各段效果照常运作；
 * - `success`：使命完成，拿到奖励，从此不再运作；
 * - `failure`：使命失败，执行惩罚，**之后再也不能成功**。
 *
 * 为什么要单独一个状态机，而不是拿两三个 mark 拼：`failure` 之后即使
 * 客观条件（场上没有围）满足了，也**不能**再判成功。用「有没有围」
 * 这类客观条件反推状态，必然会在失败之后又送出一次奖励。
 * 状态必须自己存着，而且只允许 in-progress → success / failure 这两条边。
 */

export type MissionStatus = 'in-progress' | 'success' | 'failure'

function keyOf(ownerId: PlayerId, skillId: string): string {
  return `${ownerId}:${skillId}`
}

export function missionStatus(state: SanguoshaState, ownerId: PlayerId, skillId: string): MissionStatus {
  return state.missionSkills?.[keyOf(ownerId, skillId)] ?? 'in-progress'
}

export function missionInProgress(state: SanguoshaState, ownerId: PlayerId, skillId: string): boolean {
  return missionStatus(state, ownerId, skillId) === 'in-progress'
}

/**
 * 结束一个使命。
 *
 * 只有从 `in-progress` 出发才会真正写入：已经结束的使命不能被改判，
 * 返回 false 表示这次调用被挡下了。
 */
export function finishMission(
  state: SanguoshaState,
  ownerId: PlayerId,
  skillId: string,
  outcome: 'success' | 'failure',
): boolean {
  if (!missionInProgress(state, ownerId, skillId)) return false
  state.missionSkills ??= {}
  state.missionSkills[keyOf(ownerId, skillId)] = outcome
  return true
}
