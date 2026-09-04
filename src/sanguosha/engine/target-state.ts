import type { DamageNature, PlayerId, SanguoshaState, TargetState } from './types'

/**
 * 临时角色状态（狂风、大雾这一类「附加在某人身上、到某个时机自动消失」的效果）。
 *
 * 和 `player.marks` 的区别：marks 是**计数**（梦魇几枚、裸衣有没有），
 * 这里是**带失效时机的具名状态**，而且要参与伤害结算。
 * 两者都在权威 state 里，都能序列化、能重连、能下发到 PlayerView。
 *
 * 三条纪律：
 *
 * 1. **状态自己带失效条件，不靠技能各自注册清理。** 散着写迟早漏一个，
 *    然后某个玩家身上挂着一个永远不消失的大雾。
 * 2. **伤害修正统一走 `applyTargetStateDamage`**，不在牌效果里逐张特判
 *    「如果是杀且目标有大雾」。杀、决斗、南蛮、万箭、连环火伤、业炎
 *    走的都是同一条伤害管线，挂在这里就自然全都覆盖到。
 * 3. **不写武将 id 特判**：状态名是数据，谁加的、加给谁由技能决定，
 *    这个文件只认状态本身。
 */

/** 状态名常量。技能和引擎共用同一份，避免两边写错字符串对不上。 */
export const KUANGFENG_STATE = 'kuangfeng'
export const DAWU_STATE = 'dawu'

/** 某人身上现在有没有这个状态。 */
export function hasTargetState(state: SanguoshaState, playerId: PlayerId, name: string): boolean {
  return (state.targetStates ?? []).some((entry) => entry.ownerId === playerId && entry.name === name)
}

export function targetStatesOf(state: SanguoshaState, playerId: PlayerId): TargetState[] {
  return (state.targetStates ?? []).filter((entry) => entry.ownerId === playerId)
}

/**
 * 给某人加一个状态，持续到**施加者的下一个回合开始前**。
 *
 * 同名同源不叠加——重复施加只刷新时间，不会在同一个人身上挂两份狂风。
 */
export function applyTargetState(
  state: SanguoshaState,
  playerId: PlayerId,
  name: string,
  sourceId: PlayerId,
  skillId?: string,
): void {
  state.targetStates ??= []
  const existing = state.targetStates.find((entry) => (
    entry.ownerId === playerId && entry.name === name && entry.sourceId === sourceId
  ))
  if (existing) {
    existing.appliedTurn = state.turnNumber
    return
  }
  state.targetStates.push({
    name,
    ownerId: playerId,
    expiry: 'source-next-turn-start',
    appliedTurn: state.turnNumber,
    sourceId,
    ...(skillId ? { skillId } : {}),
  })
}

/** 移除一个状态。返回是否真的移除了。 */
export function clearTargetState(state: SanguoshaState, playerId: PlayerId, name: string): boolean {
  const before = (state.targetStates ?? []).length
  state.targetStates = (state.targetStates ?? []).filter((entry) => !(entry.ownerId === playerId && entry.name === name))
  return state.targetStates.length !== before
}

/**
 * 回合**开始**时统一清理到期状态。
 *
 * 由 `turn.ts` 在每个回合开始时调一次，**技能不各自注册清理**。
 *
 * `source-next-turn-start` 的判据是「正要开始回合的人就是施加者，
 * 而且这不是施加它的那个回合」——狂风/大雾是在神诸葛亮的结束阶段发出去的，
 * 必须活过他这一回合剩下的部分、活过其他人的回合，
 * 直到他自己的下一个回合开始前才消失。
 */
export function expireTargetStates(state: SanguoshaState, startingPlayerId: PlayerId): void {
  state.targetStates = (state.targetStates ?? []).filter((entry) => {
    if (entry.expiry !== 'source-next-turn-start') return true
    if (entry.sourceId !== startingPlayerId) return true
    return entry.appliedTurn === state.turnNumber
  })
}

/**
 * 角色死亡时的清理。
 *
 * 既要收掉挂在他身上的状态，也要收掉**由他施加**的状态——
 * 施加者死了就再也不会有「他的下一个回合」，留着就是永久生效。
 */
export function clearTargetStatesOf(state: SanguoshaState, playerId: PlayerId): void {
  state.targetStates = (state.targetStates ?? []).filter((entry) => (
    entry.ownerId !== playerId && entry.sourceId !== playerId
  ))
}

export interface TargetStateDamageResult {
  amount: number
  /** 被防止时给出是哪个状态挡的，用于战报。 */
  preventedBy?: string
  amplifiedBy?: string
}

/**
 * 状态对一次伤害的修正。
 *
 * **状态不会因为触发而消失**——狂风是「每次受到火焰伤害时 +1」，
 * 大雾是「防止（期间所有）非雷电伤害」，都持续到施加者下回合开始前。
 * 写成一次性消耗是常见的做法，但那是另一个版本的技能。
 *
 * `amount` 为 0 表示这次伤害被防止；调用方据此提前返回，
 * 后续的伤害时机、濒死、连环传导都不再发生。
 */
export function applyTargetStateDamage(
  state: SanguoshaState,
  targetId: PlayerId,
  amount: number,
  nature: DamageNature,
): TargetStateDamageResult {
  // 大雾：防止非雷电伤害。雷电照常打进来；失去体力不是伤害，本来就走不到这里。
  // 防止优先于加成：被防住之后就没有「这次伤害」可言了。
  if (nature !== 'thunder' && hasTargetState(state, targetId, DAWU_STATE)) {
    return { amount: 0, preventedBy: DAWU_STATE }
  }
  // 狂风：受到的火焰伤害 +1。只认火，普通和雷都不加。
  if (nature === 'fire' && hasTargetState(state, targetId, KUANGFENG_STATE)) {
    return { amount: amount + 1, amplifiedBy: KUANGFENG_STATE }
  }
  return { amount }
}
