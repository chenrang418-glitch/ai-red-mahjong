import type { PlayerId, SanguoshaState } from './types'

/**
 * 强制满足觉醒条件。
 *
 * 神郭嘉【辉逝】能令另一名角色的某个觉醒技「视为已满足觉醒条件」。
 *
 * **它不是立刻把觉醒效果执行一遍。** 觉醒技各自有自己的时机（经典觉醒技都在
 * 准备阶段），辉逝只是把条件这一关放行；真正的发动仍然走觉醒技原本的时机、
 * 原本的记账（`player.awakenedSkills`）、原本的效果。直接执行 invoke 会
 * 绕过时机、绕过记账，也会让「一局一次」失效。
 *
 * 覆盖记录在成功觉醒之后清除：留着没有意义，而且会让下一局同名技能误判。
 */
export interface ForcedAwakening {
  playerId: PlayerId
  skillId: string
  /** 谁放行的。同名武将重复出现时要分得清是谁的辉逝。 */
  sourceId: PlayerId
}

export function forcedAwakeningsOf(state: SanguoshaState): ForcedAwakening[] {
  return state.forcedAwakenings ?? (state.forcedAwakenings = [])
}

export function hasForcedAwakening(state: SanguoshaState, playerId: PlayerId, skillId: string): boolean {
  return forcedAwakeningsOf(state).some((entry) => entry.playerId === playerId && entry.skillId === skillId)
}

export function addForcedAwakening(state: SanguoshaState, entry: ForcedAwakening): void {
  if (hasForcedAwakening(state, entry.playerId, entry.skillId)) return
  forcedAwakeningsOf(state).push(entry)
}

/** 觉醒真正完成之后调用。 */
export function clearForcedAwakening(state: SanguoshaState, playerId: PlayerId, skillId: string): void {
  state.forcedAwakenings = forcedAwakeningsOf(state)
    .filter((entry) => !(entry.playerId === playerId && entry.skillId === skillId))
}

/**
 * 这个人身上还没觉醒的觉醒技。
 *
 * 辉逝只能指定**尚未触发**的觉醒技：已经觉醒过的再放行也没有意义，
 * 而且会让玩家以为能重复吃一次效果。
 */
export function pendingAwakeningSkills(
  state: SanguoshaState,
  playerId: PlayerId,
  awakeningSkillIdsOf: (state: SanguoshaState, playerId: PlayerId) => string[],
): string[] {
  const player = state.players.find((candidate) => candidate.id === playerId)
  if (!player?.alive) return []
  const awakened = player.awakenedSkills ?? []
  return awakeningSkillIdsOf(state, playerId).filter((skillId) => !awakened.includes(skillId))
}
