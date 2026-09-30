import { getSkillRuntime, ownedSkillIds } from './skills/runtime'
import type { SkillHost } from './skills/runtime'
import type { CardId, DamageNature, PlayerId, SanguoshaState } from './types'

/**
 * 技能对伤害「属性 / 数值 / 是否发生」的统一修正入口。
 *
 * 神马超【驭雳】既要改属性又要防伤害，这两件事都**不能各自在技能文件里硬来**：
 *
 * - 改属性必须发生在**藤甲、狂风、大雾之前**。晚一步的话，一发火焰伤害会先被
 *   藤甲 +1、被狂风再 +1，然后才变成雷电——加成按的是已经不存在的属性；
 *   大雾也会按「非雷伤」把它防掉，而它此刻明明是雷伤。
 * - 防伤害必须发生在**扣血和「受到伤害后」那批时机之前**，而且是真的没发生：
 *   不能先扣了再补回来，那样狂暴、忍戒、濒死全都会被错误地触发一遍。
 *
 * 所以这里排在伤害管线的最前面，紧跟在「伤害来源改写」之后：
 * 先定属性和数值，再交给装备、角色状态和各个伤害时机。
 */

export interface OutgoingDamageContext {
  targetId: PlayerId
  amount: number
  nature: DamageNature
  cardId: CardId | null
  cardName: string | null
  chainTransfer: boolean
}

export interface IncomingDamageContext {
  sourceId: PlayerId | null
  amount: number
  nature: DamageNature
  cardId: CardId | null
  cardName: string | null
  chainTransfer: boolean
}

/** 牌在多目标结算过程中，第三方技能对指定目标的统一防止入口。 */
export interface CardDamageTargetContext extends IncomingDamageContext {
  targetId: PlayerId
  sourceId: PlayerId | null
}

export interface DamageAdjustment {
  amount: number
  nature: DamageNature
  /** 改写了属性或数值的那些技能，用于战报。 */
  appliedSkillIds: string[]
}

function runtimesOf(state: SanguoshaState, playerId: PlayerId | null) {
  if (!playerId) return []
  return ownedSkillIds(state, playerId)
    .map((skillId) => getSkillRuntime(skillId))
    .filter((runtime): runtime is NonNullable<typeof runtime> => !!runtime)
}

/**
 * 伤害来源的技能对这次伤害的属性 / 数值修正。
 *
 * 按技能返回值依次叠加，**不是取最后一个**：以后有第二个改属性的技能时，
 * 顺序仍然由 `ownedSkillIds` 的稳定顺序决定，同一个种子走出同一个结果。
 */
export function adjustOutgoingDamage(
  state: SanguoshaState,
  sourceId: PlayerId | null,
  context: OutgoingDamageContext,
): DamageAdjustment {
  let amount = context.amount
  let nature = context.nature
  const appliedSkillIds: string[] = []
  for (const runtime of runtimesOf(state, sourceId)) {
    if (!runtime.outgoingDamage || !sourceId) continue
    const change = runtime.outgoingDamage(state, sourceId, { ...context, amount, nature })
    if (!change) continue
    if (change.nature && change.nature !== nature) nature = change.nature
    if (typeof change.amount === 'number') amount = change.amount
    appliedSkillIds.push(runtime.id)
  }
  /*
   * 第三方技能对「这次由 sourceId 造成的伤害」的加成（成公英【匡襄】：
   * A 使用因匡襄获得的黑牌造成伤害时+1，拥有者是成公英，不是 A 自己，
   * `outgoingDamage` 只查伤害来源自己的技能，接不住这种情况）。
   */
  if (sourceId) {
    for (const owner of state.players) {
      if (!owner.alive || !owner.characterId) continue
      for (const skillId of ownedSkillIds(state, owner.id)) {
        const runtime = getSkillRuntime(skillId)
        const change = runtime?.globalOutgoingDamage?.(state, owner.id, sourceId, { ...context, amount, nature })
        if (!change) continue
        if (change.nature && change.nature !== nature) nature = change.nature
        if (typeof change.amount === 'number') amount = change.amount
        appliedSkillIds.push(skillId)
      }
    }
  }
  // 数值被改到 0 或负数就等于没有伤害；管线上游按「不发生」处理
  return { amount: Math.max(0, Math.trunc(amount)), nature, appliedSkillIds }
}

/**
 * 受伤者的技能对这次伤害的数值 / 属性修正（潘濬【公清】按来源攻击范围
 * 改伤害值）。和 `adjustOutgoingDamage` 是同一种形状，只是换到受伤方，
 * 排在源头修正**之后**——源头的加成（裸衣、驭雳）先算完，受伤方的修正
 * 再在这个基础上继续调整，藤甲/狂风/大雾仍然按最终属性判断。
 */
export function adjustIncomingDamage(
  state: SanguoshaState,
  targetId: PlayerId,
  context: OutgoingDamageContext & { sourceId: PlayerId | null },
): DamageAdjustment {
  let amount = context.amount
  let nature = context.nature
  const appliedSkillIds: string[] = []
  for (const runtime of runtimesOf(state, targetId)) {
    if (!runtime.incomingDamage) continue
    const change = runtime.incomingDamage(state, targetId, { ...context, amount, nature })
    if (!change) continue
    if (change.nature && change.nature !== nature) nature = change.nature
    if (typeof change.amount === 'number') amount = change.amount
    appliedSkillIds.push(runtime.id)
  }
  return { amount: Math.max(0, Math.trunc(amount)), nature, appliedSkillIds }
}

/** Apply third-party effects that adjust a particular player's incoming damage. */
export function adjustGlobalIncomingDamage(
  state: SanguoshaState,
  targetId: PlayerId,
  context: OutgoingDamageContext & { sourceId: PlayerId | null },
): DamageAdjustment & { appliedOwners: Array<{ ownerId: PlayerId; skillId: string }> } {
  let amount = context.amount
  let nature = context.nature
  const appliedOwners: Array<{ ownerId: PlayerId; skillId: string }> = []
  for (const owner of state.players) {
    if (!owner.alive || !owner.characterId) continue
    for (const skillId of ownedSkillIds(state, owner.id)) {
      const change = getSkillRuntime(skillId)?.globalIncomingDamage?.(state, owner.id, targetId, { ...context, amount, nature })
      if (!change) continue
      if (change.nature && change.nature !== nature) nature = change.nature
      if (typeof change.amount === 'number') amount = change.amount
      appliedOwners.push({ ownerId: owner.id, skillId })
    }
  }
  return { amount: Math.max(0, Math.trunc(amount)), nature, appliedSkillIds: appliedOwners.map(({ skillId }) => skillId), appliedOwners }
}

/**
 * 伤害来源的技能有没有把这次伤害**整个换成失去体力**（张春华【绝情】）。
 *
 * 返回换掉它的那个技能 id；没换就返回 null。
 */
export function damageReplacedWithHpLoss(
  state: SanguoshaState,
  sourceId: PlayerId | null,
  context: { targetId: PlayerId; amount: number; nature: DamageNature; cardName: string | null },
): string | null {
  if (!sourceId) return null
  for (const runtime of runtimesOf(state, sourceId)) {
    if (runtime.replacesDamageWithHpLoss?.(state, sourceId, context)) return runtime.id
  }
  return null
}

/**
 * 受伤者的技能有没有把这次伤害挡下来。
 *
 * 返回挡下它的技能 id；没挡下就返回 null。允许技能在挡下的同时做事
 * （【驭雳】挡住雷伤之后要摸等量的牌），所以这里拿的是 host 而不是 state。
 */
export function interceptIncomingDamage(
  host: SkillHost,
  targetId: PlayerId,
  context: IncomingDamageContext,
): string | null {
  for (const runtime of runtimesOf(host.state, targetId)) {
    if (!runtime.interceptIncomingDamage) continue
    if (runtime.interceptIncomingDamage(host, targetId, context)) return runtime.id
  }
  return null
}

/** Run third-party damage-prevention decisions in stable seat / skill order. */
export function interceptGlobalIncomingDamage(
  host: SkillHost,
  targetId: PlayerId,
  context: IncomingDamageContext,
  skipSkillIds: readonly string[] = [],
): string | null {
  const skipped = new Set(skipSkillIds)
  for (const owner of host.state.players) {
    if (!owner.alive) continue
    for (const runtime of runtimesOf(host.state, owner.id)) {
      if (skipped.has(runtime.id) || !runtime.interceptGlobalIncomingDamage) continue
      if (runtime.interceptGlobalIncomingDamage(host, owner.id, targetId, context)) return runtime.id
    }
  }
  return null
}

export function interceptCardDamageTarget(host: SkillHost, context: CardDamageTargetContext): { skillId: string; ownerId: PlayerId } | null {
  for (const owner of host.state.players) {
    for (const runtime of runtimesOf(host.state, owner.id)) {
      if (!runtime.interceptCardDamageTarget) continue
      if (runtime.interceptCardDamageTarget(host, owner.id, context)) return { skillId: runtime.id, ownerId: owner.id }
    }
  }
  return null
}
