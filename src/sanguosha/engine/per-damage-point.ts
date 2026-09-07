import type { SkillHost } from './skills/runtime'
import type { PlayerId } from './types'

/**
 * 「每当你（或来源）受到 **1 点**伤害后……」的逐点结算。
 *
 * 法正【恩怨·怨】和钟会【权计】都是这一类：一次 3 点伤害要给**三次**独立机会，
 * 不是一次。两处曾经各写一遍，其中一处踩过同一个坑，所以收在这里。
 *
 * 三条纪律：
 *
 * 1. **排队问，不当场问。** 伤害结算里还有一串「受到伤害后」的时机没跑完，
 *    而且相关角色可能在同一批里被打死。排队的东西要等牌桌干净才放出来。
 * 2. **一次只放一点。** 每一点结清之后再排下一点——不能一口气把三次问句
 *    全推进队列：中间任何一点都可能改变后面几点还该不该问
 *    （人死了、条件没了）。
 * 3. **剩余点数必须走队列，不能在同一条同步链上递归。**
 *    这一点的结果可能把某人打进濒死，濒死没结清就扣下一点，
 *    引擎会直接抛「已有濒死流程正在进行」（压测 seed=yjcm11-8-53 抓到过）。
 */

export interface DamagePointPrompt {
  skillId: string
  ownerId: PlayerId
  step: string
  /** 还欠几点。放进队列的那一条自己带着这个数。 */
  remaining: number
  /** 技能自己的上下文，原样带回来。 */
  data?: Record<string, unknown>
}

/** 排下一点。`remaining` 到 0 就结束。 */
export function queueDamagePoint(host: SkillHost, prompt: DamagePointPrompt): void {
  if (prompt.remaining <= 0) return
  host.queueSkill({
    skillId: prompt.skillId,
    ownerId: prompt.ownerId,
    step: prompt.step,
    data: { ...(prompt.data ?? {}), remaining: prompt.remaining },
  })
}

/** 从技能挂起状态里读出「还欠几点」。 */
export function remainingDamagePoints(data: Record<string, unknown> | undefined): number {
  const value = Number(data?.remaining ?? 0)
  return Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0
}

/** 这一点结清了，把剩下的排上。 */
export function queueNextDamagePoint(host: SkillHost, prompt: DamagePointPrompt): void {
  queueDamagePoint(host, { ...prompt, remaining: prompt.remaining - 1 })
}

/** 一次伤害有几点。非正数一律当作 0——0 点伤害不给机会。 */
export function damagePointsOf(amount: unknown): number {
  const value = Math.trunc(Number(amount ?? 0))
  return Number.isFinite(value) ? Math.max(0, value) : 0
}
