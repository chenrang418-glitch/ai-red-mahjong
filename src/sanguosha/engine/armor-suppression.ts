import type { PlayerId, SanguoshaState } from './types'

/**
 * 「某名角色的防具技能对某个来源无效」的公共机制。
 *
 * 神吕布【无前】需要的就是这个：指定一名角色，直到本回合结束，
 * 该角色的防具技能对神吕布无效。
 *
 * 三条纪律：
 *
 * 1. **绑定来源**。防具不是被全场废掉，只对指定的那个来源无效；
 *    别人打同一个目标，八卦阵、藤甲、仁王盾照常生效。
 * 2. **牌还在装备区**。这不是拆装备：八卦阵的实体牌仍然装备着，
 *    回合结束后自动恢复效力，不需要重新装备。
 * 3. **不写武将 id 特判**。`equipment.ts` 只问「这个来源打这个目标时，
 *    目标的防具还算不算数」，谁施加的、为什么施加由技能决定。
 */

export interface ArmorSuppression {
  /** 防具对谁无效。 */
  sourceId: PlayerId
  /** 哪些角色的防具被压制。 */
  targetIds: PlayerId[]
  /** 目前只有「本回合结束时解除」一种。 */
  expiry: 'turn-end'
  /** 施加时的回合序号，用于回合结束时判断该不该清。 */
  appliedTurn: number
  /** 施加它的技能，用于战报和调试。 */
  skillId?: string
}

/** 目标的防具技能对这个来源是否已被压制。 */
export function isArmorSuppressed(
  state: SanguoshaState,
  targetId: PlayerId,
  sourceId: PlayerId | null | undefined,
): boolean {
  if (!sourceId) return false
  return (state.armorSuppressions ?? []).some((entry) => (
    entry.sourceId === sourceId && entry.targetIds.includes(targetId)
  ))
}

/**
 * 压制一名角色的防具技能。
 *
 * 同一个来源对同一个目标重复施加不叠加——【无前】可以在一个回合里对多名角色
 * 分别发动，但对同一个人发动两次并不会「更无效」。
 */
export function suppressArmor(
  state: SanguoshaState,
  sourceId: PlayerId,
  targetId: PlayerId,
  skillId?: string,
): void {
  state.armorSuppressions ??= []
  const existing = state.armorSuppressions.find((entry) => entry.sourceId === sourceId)
  if (existing) {
    if (!existing.targetIds.includes(targetId)) existing.targetIds.push(targetId)
    existing.appliedTurn = state.turnNumber
    return
  }
  state.armorSuppressions.push({
    sourceId,
    targetIds: [targetId],
    expiry: 'turn-end',
    appliedTurn: state.turnNumber,
    ...(skillId ? { skillId } : {}),
  })
}

/**
 * 回合结束时统一清理。由 `turn.ts` 调一次，**技能不各自注册清理**。
 *
 * 散着写迟早漏一个，然后某个人的八卦阵对某个来源永久失效。
 */
export function expireArmorSuppressions(state: SanguoshaState): void {
  state.armorSuppressions = (state.armorSuppressions ?? []).filter((entry) => entry.expiry !== 'turn-end')
}

/** 角色死亡时的清理：他施加的、和施加在他身上的都收掉。 */
export function clearArmorSuppressionsOf(state: SanguoshaState, playerId: PlayerId): void {
  state.armorSuppressions = (state.armorSuppressions ?? [])
    .filter((entry) => entry.sourceId !== playerId)
    .map((entry) => ({ ...entry, targetIds: entry.targetIds.filter((id) => id !== playerId) }))
    .filter((entry) => entry.targetIds.length > 0)
}
