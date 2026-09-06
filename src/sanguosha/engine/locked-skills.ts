/**
 * 「这是不是一个锁定技」的统一口径。
 *
 * 神马超【霆威】要令目标的**非锁定技**失效，而且期间新获得的非锁定技也一并失效——
 * 所以判定必须在「用到的那一刻」现算，不能开局快照一份技能 id 列表。
 *
 * 这里只留一个注入点，**不直接 import 武将数据**：`skill-suppression` 被
 * `skills/runtime` 依赖，而武将数据反过来依赖 runtime，直连会成环。
 * 和 `provideSkillIdsLookup` 是同一套做法，注入在 `data/characters/standard.ts`。
 */

let lookup: (skillId: string) => boolean = () => false

export function provideLockedSkillLookup(fn: (skillId: string) => boolean): void {
  lookup = fn
}

/** 未注册的技能一律按非锁定技处理：漏判会少压制一个技能，误判会凭空压制一个锁定技。 */
export function isLockedSkill(skillId: string): boolean {
  return lookup(skillId)
}
