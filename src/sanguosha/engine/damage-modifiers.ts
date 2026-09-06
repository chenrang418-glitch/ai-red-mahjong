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
  // 数值被改到 0 或负数就等于没有伤害；管线上游按「不发生」处理
  return { amount: Math.max(0, Math.trunc(amount)), nature, appliedSkillIds }
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
