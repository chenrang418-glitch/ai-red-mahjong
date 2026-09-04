import type { EventContext, GameEventName } from './events'
import { getSkillRuntime, type SkillHost } from './skills/runtime'
import type { PlayerId } from './types'

/**
 * 「借用另一个技能的运行时发动一次」的公共机制。
 *
 * 神司马懿【极略】要的就是这个：觉醒之后他并**不是永久获得**
 * 鬼才、放逐、集智、制衡、完杀这五个技能，而是在对应时机移去 1 枚「忍」
 * 发动其中一个**一次**。
 *
 * 关键是**真正复用已有的技能运行时**，不是把五套逻辑各抄一遍：
 * 抄一遍意味着以后改鬼才要记得改两处，迟早对不上。
 *
 * 这个模块只负责「找到那个运行时并调用它」，
 * 「什么时候能发动、代价怎么收」由借用方自己决定。
 */

/** 借用一个主动技的执行入口。返回是否真的调用到了。 */
export function delegateActiveSkill(
  host: SkillHost,
  ownerId: PlayerId,
  skillId: string,
  actionId: string,
): boolean {
  const runtime = getSkillRuntime(skillId)
  if (!runtime?.invokeActive) return false
  runtime.invokeActive(host, ownerId, actionId)
  return true
}

/** 借用方能不能拿到这个主动技此刻的动作列表（用来判断「现在可不可以发动」）。 */
export function delegatedActiveActions(
  host: SkillHost,
  ownerId: PlayerId,
  skillId: string,
): Array<{ id: string; label: string }> {
  const runtime = getSkillRuntime(skillId)
  return runtime?.activeActions?.(host.state, ownerId) ?? []
}

/**
 * 借用一个触发型技能：把当前事件上下文交给它自己的处理函数。
 *
 * 事件名要对得上——一个技能可能挂了好几个时机（回合结束清理之类），
 * 只调用与当前时机匹配的那一条。
 */
export function delegateTriggeredSkill(
  host: SkillHost,
  ownerId: PlayerId,
  skillId: string,
  event: GameEventName,
  context: EventContext,
): boolean {
  const runtime = getSkillRuntime(skillId)
  const trigger = runtime?.triggers?.find((candidate) => candidate.event === event)
  if (!trigger) return false
  trigger.handle(host, ownerId, context)
  return true
}
