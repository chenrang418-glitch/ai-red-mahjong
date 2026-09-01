
import type { EventContext, GameEvent, GameEventName } from '../events'
import type { CardId, PlayerId, SanguoshaState } from '../types'

/**
 * 技能运行时。
 *
 * 三条约束，都是被参考项目和任务书点过名的：
 *
 * 1. **技能处理器是运行时代码，不能序列化。**
 *    Durable Object 醒来之后必须重新调用 `registerAllSkills`，
 *    绝不能指望把函数存进 GameState。
 * 2. **技能不自己算距离、不自己判合法性。**
 *    距离改动走 `distanceModifier`，出杀次数走 `unlimitedSlash`，
 *    统一入口只有一个，技能只负责报告修正值。
 * 3. **转化技必须产出真正的 LegalAction。**
 *    「关羽的红牌可以当杀用」不能靠前端自己猜，
 *    引擎要把「用这张红牌当杀打某人」作为一条独立动作发出去，
 *    玩家才点得到，AI 才选得到，回放才对得上。
 */

export interface SkillHost {
  state: SanguoshaState
  dispatch(
    name: GameEventName,
    payload?: Record<string, unknown>,
    metadata?: Omit<GameEvent, 'id' | 'seq' | 'name' | 'payload'>,
  ): EventContext
}

export interface SkillTrigger {
  event: GameEventName
  /** 数字越大越先执行，和 GameEventBus 的排序一致。 */
  priority?: number
  handle(host: SkillHost, ownerId: PlayerId, context: EventContext): void
}

/** 一张手牌可以被转化成什么牌来用。 */
export interface ViewAsOption {
  /** 转化后当作哪张牌 */
  asCardName: string
  /** 需要打出的原牌 */
  cardId: CardId
  /** 展示给玩家的说明，多用途牌靠它区分用途 */
  label: string
}

export interface SkillRuntime {
  id: string
  /** 挂到事件总线上的触发技。 */
  triggers?: SkillTrigger[]
  /** 锁定技：出牌阶段【杀】不限次。 */
  unlimitedSlash?: boolean
  /** 锁定技：使用锦囊时无视距离限制（奇才）。 */
  ignoresTrickDistance?: boolean
  /** 距离修正：正数表示「与其他角色距离 +n」，负数表示 -n。 */
  distanceModifier?: { toOthers?: number; fromOthers?: number }
  /**
   * 主动技：出牌阶段能发动的技能，直接产出 LegalAction。
   * 和转化技一样，不能让前端自己猜「现在能不能发动」。
   */
  activeActions?(state: SanguoshaState, ownerId: PlayerId): Array<{ id: string; label: string }>
  /** 主动技的执行。id 是 activeActions 给出的那一个。 */
  invokeActive?(host: SkillHost, ownerId: PlayerId, actionId: string): void
  /**
   * 转化技：把手牌当成别的牌用。
   * 返回这名玩家当前能做的所有转化，引擎据此生成 LegalAction。
   */
  viewAs?(state: SanguoshaState, ownerId: PlayerId): ViewAsOption[]
}

const registry = new Map<string, SkillRuntime>()

export function registerSkillRuntime(runtime: SkillRuntime): void {
  if (registry.has(runtime.id)) throw new Error(`技能重复注册：${runtime.id}`)
  registry.set(runtime.id, runtime)
}

export function getSkillRuntime(skillId: string): SkillRuntime | undefined {
  return registry.get(skillId)
}

/** 仅供测试使用：清空注册表。 */
export function resetSkillRegistry(): void {
  registry.clear()
}

/** 某名玩家当前拥有的技能运行时。武将没选定时返回空。 */
export function skillsOf(state: SanguoshaState, playerId: PlayerId, skillIdsOf: (characterId: string) => string[]): SkillRuntime[] {
  const player = state.players.find((candidate) => candidate.id === playerId)
  if (!player?.characterId) return []
  return skillIdsOf(player.characterId)
    .map((skillId) => registry.get(skillId))
    .filter((runtime): runtime is SkillRuntime => !!runtime)
}

/**
 * 把所有技能的触发器挂到事件总线上。
 *
 * **Durable Object 醒来之后必须重新调用这个函数。**
 * 处理器是运行时代码，序列化不了，GameState 里只有可序列化的数据。
 */
export function registerSkillTriggers(
  host: SkillHost,
  on: (event: GameEventName, handler: (context: EventContext) => void, priority?: number) => void,
  skillIdsOf: (characterId: string) => string[],
): void {
  for (const runtime of registry.values()) {
    for (const trigger of runtime.triggers ?? []) {
      on(trigger.event, (context) => {
        // 只有真正拥有这个技能的人才会被触发
        for (const player of host.state.players) {
          if (!player.alive || !player.characterId) continue
          if (!skillIdsOf(player.characterId).includes(runtime.id)) continue
          trigger.handle(host, player.id, context)
        }
      }, trigger.priority ?? 0)
    }
  }
}
