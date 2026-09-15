import { getSkillRuntime } from './skills/runtime'
import type { GameRng } from './rng'
import type { CharacterId, Kingdom } from './types'

/**
 * 「随机获得若干个某势力的技能」的公共入口（神孙权【驭衡】）。
 *
 * 为什么不手写一个技能名数组：那份数组第二天就会和武将表脱节——
 * 加了新吴将不会自动进池，改了技能 id 也不会有任何测试发现。
 * 池子从当前武将表现算，资格只看**结构化标志**。
 */

export interface PoolSkill {
  id: string
  name: string
  characterId: CharacterId
  characterName: string
  kingdom: Kingdom
  /** 该技能所属武将的体力上限。张裕【相谶】按目标势力+体力上限筛选要用到。 */
  maxHp: number
}

let catalog: readonly PoolSkill[] = []

export function provideRandomSkillPool(skills: readonly PoolSkill[]): void {
  catalog = skills
}

/**
 * 一个技能能不能被随机获得。
 *
 * 排除的四类都由运行时的结构化标志判断，**不看描述文字**：
 *
 * - **限定技**：一局一次的资源，随机塞给别人会让「一局一次」失去意义；
 * - **觉醒技**：条件满足即强制发动，随机获得等于随机触发一次觉醒；
 * - **主公技**：只有主公能用，给别人是无效牌面；
 * - **衍生技**：本来就要靠别的技能授予，不该直接进池。
 *
 * 还要求技能**有运行时实现**：规则上能获得、拿到手却什么都不做，
 * 比不给还糟——玩家会以为自己拿到了一个技能。
 */
export function skillIsRandomlyGrantable(skillId: string, granted?: boolean): boolean {
  if (granted) return false
  const runtime = getSkillRuntime(skillId)
  if (!runtime) return false
  return !runtime.limited && !runtime.awakening && !runtime.lord
}

/** 某个势力现在能提供哪些可随机获得的技能。 */
export function randomSkillPoolOf(kingdom: Kingdom): PoolSkill[] {
  return catalog.filter((skill) => skill.kingdom === kingdom)
}

/** 张裕【相谶】要的是「同势力 + 体力上限相同」这一层更窄的筛选，复用同一份 catalog。 */
export function skillPoolByKingdomAndMaxHp(kingdom: Kingdom, maxHp: number): PoolSkill[] {
  return catalog.filter((skill) => skill.kingdom === kingdom && skill.maxHp === maxHp)
}

/**
 * 随机抽 `count` 个技能，**互不重复**，也不会抽到已经拥有的。
 *
 * 池子不够就有多少给多少——不补、不重复。随机用牌局自己的种子。
 */
export function sampleSkills(
  rng: GameRng,
  kingdom: Kingdom,
  count: number,
  exclude: readonly string[] = [],
): PoolSkill[] {
  const excluded = new Set(exclude)
  const remaining = randomSkillPoolOf(kingdom)
    .filter((skill) => !excluded.has(skill.id))
    .filter((skill) => skillIsRandomlyGrantable(skill.id))
  const picked: PoolSkill[] = []
  const seen = new Set<string>()
  while (picked.length < count && remaining.length > 0) {
    const [skill] = remaining.splice(rng.nextInt(remaining.length), 1)
    // 同一个技能 id 可能挂在多名武将身上，按 id 去重
    if (seen.has(skill.id)) continue
    seen.add(skill.id)
    picked.push(skill)
  }
  return picked
}
