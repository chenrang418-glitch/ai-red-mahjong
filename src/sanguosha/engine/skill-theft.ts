import { getSkillRuntime } from './skills/runtime'
import { suppressedSkillsOf } from './skill-suppression'
import type { PlayerId, SanguoshaState } from './types'

/**
 * 「哪些技能可以被临时夺走」的资格判定。
 *
 * 【夺锐】的表述把排除项写在括号里：
 * 「限定技、觉醒技、使命技、主公技、部分规则冲突技能除外」。
 *
 * 判定**只读运行时元数据**，不用武将 id 黑名单——那样每加一个武将都要维护一张表，
 * 而且漏一个就变成规则错误。和左慈【化身】的资格判定同一条原则：
 * **普通技能默认可夺，只有明确的规则冲突才排除**。
 *
 * 如果某个理论上合法的普通技能因为实现里写死了武将 id 而不能被夺，
 * 那是**引擎的 bug**，要去修那个技能的拥有者判断，不是在这里加例外。
 */

/** 不能被夺的技能 id 及原因。写在这里而不是散在各处，便于生成兼容性报告。 */
const STRUCTURAL_EXCLUSIONS: Record<string, string> = {
  // 化身体系整体绑定左慈自己的化身池，换个人持有没有任何意义
  huashen: '与左慈的化身池强绑定，换人持有无对应资源',
  xinsheng: '依附【化身】而存在，脱离化身池无意义',
  // 极略借用的是「神司马懿的忍」，换人持有没有资源来源
  jilue: '依附神司马懿的「忍」资源，换人持有无对应资源',
  // 夺锐本身：夺来一个夺锐会形成套娃，表述里也明确夺锐期间不能再发动
  duorui: '夺锐期间不能再发动夺锐，夺取它本身没有意义',
}

export interface SkillEligibility {
  skillId: string
  name: string
  eligible: boolean
  reason?: string
}

/**
 * 判断单个技能能不能被夺，并给出原因（原因用于兼容性报告）。
 *
 * `skills` 里带 `granted` 标记的是「觉醒后才获得」的条目，
 * 它们不出现在武将牌上，所以不是夺锐的候选；
 * 但**觉醒之后真正拥有的普通技能**（比如孙策觉醒拿到的技能）
 * 按技能自身类型判断，和「它是怎么来的」无关——和化身同理。
 */
export function evaluateSkillTheft(skill: { id: string; name: string; granted?: boolean }): SkillEligibility {
  const runtime = getSkillRuntime(skill.id)
  if (!runtime) return { skillId: skill.id, name: skill.name, eligible: false, reason: '没有注册运行时' }
  if (skill.granted) return { skillId: skill.id, name: skill.name, eligible: false, reason: '不在武将牌上（觉醒后才获得的条目）' }
  if (runtime.limited) return { skillId: skill.id, name: skill.name, eligible: false, reason: '限定技' }
  if (runtime.awakening) return { skillId: skill.id, name: skill.name, eligible: false, reason: '觉醒技' }
  if (runtime.lord) return { skillId: skill.id, name: skill.name, eligible: false, reason: '主公技' }
  if (runtime.stealable === false) return { skillId: skill.id, name: skill.name, eligible: false, reason: '技能自己声明不可夺' }
  const structural = STRUCTURAL_EXCLUSIONS[skill.id]
  if (structural) return { skillId: skill.id, name: skill.name, eligible: false, reason: structural }
  return { skillId: skill.id, name: skill.name, eligible: true }
}

/**
 * 目标此刻有哪些技能可以被夺。
 *
 * 读的是**目标当前实际拥有的技能**，所以：
 * - 被蔡文姬【断肠】清空技能的目标没有可夺技能，不能白废一个装备栏；
 * - 已经被别的夺锐压制着的技能也不再是候选。
 */
export function stealableSkillsOf(
  state: SanguoshaState,
  targetId: PlayerId,
  skillsOfCharacter: (characterId: string) => Array<{ id: string; name: string; granted?: boolean }>,
): SkillEligibility[] {
  const target = state.players.find((candidate) => candidate.id === targetId)
  if (!target?.alive || !target.characterId) return []
  // 断肠：技能全部失效，没有可夺的
  if (target.characterSkillsDisabled) return []
  const suppressed = new Set(suppressedSkillsOf(state, targetId))
  return skillsOfCharacter(target.characterId)
    .map((skill) => evaluateSkillTheft(skill))
    .filter((entry) => entry.eligible && !suppressed.has(entry.skillId))
}
