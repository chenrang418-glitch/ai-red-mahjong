import type { PlayerId, SanguoshaState } from './types'

/**
 * 「视为在攻击范围内」的定向覆盖。
 *
 * 神太史慈【破围】发动之后，**有围的那名角色**视为可以打到神太史慈——
 * 方向是 `carrier → 神太史慈`，不是反过来。写反了就变成神太史慈单方面
 * 获得一个远程打击能力，和这个技能想表达的「把自己送到对方刀口上」完全相反。
 *
 * 为什么不改距离数字：距离是双向对称的量，改它会连带影响
 * 【顺手牵羊】【兵粮寸断】、别人对他的攻击范围判断，以及所有读距离的技能。
 * 这里要的只是一条「这一对角色之间，攻击范围检查直接通过」的单向豁免。
 *
 * 期限是**当前回合结束**，正常回合和额外回合一视同仁，
 * 所以清理挂在 `TurnEnd` 上而不是按回合序号推算。
 */

export interface AttackRangeOverride {
  /** 进攻方：他视为够得着 `targetId`。 */
  attackerId: PlayerId
  targetId: PlayerId
  /** 施加它的技能，战报和调试用。 */
  sourceSkillId: string
}

export function forceInAttackRange(state: SanguoshaState, entry: AttackRangeOverride): void {
  state.attackRangeOverrides ??= []
  const exists = state.attackRangeOverrides.some((candidate) => (
    candidate.attackerId === entry.attackerId && candidate.targetId === entry.targetId
  ))
  if (!exists) state.attackRangeOverrides.push({ ...entry })
}

export function isForcedInAttackRange(state: SanguoshaState, attackerId: PlayerId, targetId: PlayerId): boolean {
  return (state.attackRangeOverrides ?? []).some((entry) => (
    entry.attackerId === attackerId && entry.targetId === targetId
  ))
}

/** 回合结束时统一清空。额外回合结束同样要清。 */
export function clearAttackRangeOverrides(state: SanguoshaState): void {
  if (state.attackRangeOverrides?.length) state.attackRangeOverrides = []
}
