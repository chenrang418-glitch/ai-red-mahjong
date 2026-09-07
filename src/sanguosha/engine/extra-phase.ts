import { skillsOf } from './skills/runtime'
import { skillIdsOf } from '../data/characters/standard'
import type { ExtraPhaseState, PlayerId, SanguoshaState, TurnPhase } from './types'

/**
 * 「回合开始时执行一个额外的阶段」——廖化【当先】。
 *
 * 四条纪律：
 *
 * 1. **是阶段，不是回合。** 不新建回合实例、不推进轮次、不进额外回合队列。
 *    回合级的东西（本回合限一次、直到回合结束、酒的一回合一次）
 *    两个阶段共享同一份。
 * 2. **是真阶段。** `PhaseStart` / `PhaseEnd` 照发，挂在出牌阶段上的技能
 *    照常触发，「出牌阶段限一次」在它里面各有一次机会——靠 `instanceId`
 *    和随后的正常出牌阶段区分开（两者占的阶段位是同一个）。
 * 3. **插在准备阶段之前。** 走完额外阶段之后回到正常的第一个阶段位，
 *    整个回合的其余部分不受影响。
 * 4. **谁提供的就属于谁。** 由技能运行时声明，引擎不认武将 id——
 *    技能被临时获得时，额外阶段属于此刻真正拥有它的那个人。
 *
 * 这个模块只处理**锁定技**式的额外阶段：在回合开始时一次算清，不发问。
 * 需要询问的额外阶段以后要另走一个可挂起的窗口，不要把发问塞进这里——
 * `beginTurn` 是同步的，在里面发问会让准备阶段抢在回答之前开始。
 */

/** 这名角色在回合开始时要执行哪些额外阶段，按技能登记顺序。 */
export function extraPhasesAtTurnStart(
  state: SanguoshaState,
  playerId: PlayerId,
): Array<{ phase: TurnPhase; skillId: string }> {
  const result: Array<{ phase: TurnPhase; skillId: string }> = []
  for (const runtime of skillsOf(state, playerId, skillIdsOf)) {
    const phase = runtime.extraPhaseAtTurnStart?.(state, playerId)
    if (phase) result.push({ phase, skillId: runtime.id })
  }
  return result
}

/** 现在跑的是不是一个额外阶段。 */
export function inExtraPhase(state: SanguoshaState): boolean {
  return state.extraPhase !== undefined
}

/**
 * 回合开始时安排额外阶段。安排上了返回**第一个要跑的阶段**，
 * 调用方据此设置 `state.phase`；没有额外阶段时返回 null。
 */
export function scheduleTurnStartExtraPhases(
  state: SanguoshaState,
  playerId: PlayerId,
  resumeSlot: TurnPhase,
): TurnPhase | null {
  const extras = extraPhasesAtTurnStart(state, playerId)
  if (extras.length === 0) return null
  const entries: ExtraPhaseState[] = extras.map((entry, index) => ({
    phase: entry.phase,
    resumeSlot,
    playerId,
    skillId: entry.skillId,
    // seq 在一局里单调递增，够用来区分同一回合里的多个额外阶段
    instanceId: state.seq + index,
    preSkipped: state.skippedPhases.includes(entry.phase),
  }))
  const [first, ...rest] = entries
  state.extraPhase = first
  if (rest.length > 0) state.pendingExtraPhases = rest
  else delete state.pendingExtraPhases
  return first.phase
}

/**
 * 一个额外阶段结束了。
 *
 * 还有排队的额外阶段就接着跑（`state.extraPhase` 换成下一个）；
 * 没有了就清空额外阶段状态并返回要回到的正常阶段位。
 * 返回 null 表示调用时根本不在额外阶段里。
 */
export function advanceExtraPhase(state: SanguoshaState): TurnPhase | null {
  const current = state.extraPhase
  if (!current) return null
  /*
   * 这个额外阶段是被「跳过」消化掉的（巧变）：标记随它一起收走。
   * 留着的话，这个回合里正常的同名阶段位会被同一个标记连带跳掉，
   * 一次巧变变成跳两个阶段。
   */
  if (!current.preSkipped) {
    const marked = state.skippedPhases.indexOf(current.phase)
    if (marked >= 0) state.skippedPhases.splice(marked, 1)
  }
  const queue = state.pendingExtraPhases ?? []
  const next = queue.shift()
  if (next) {
    state.extraPhase = next
    if (queue.length > 0) state.pendingExtraPhases = queue
    else delete state.pendingExtraPhases
    return next.phase
  }
  clearExtraPhases(state)
  return current.resumeSlot
}

/** 回合结束时清掉额外阶段状态，不让它漏到下一个回合。 */
export function clearExtraPhases(state: SanguoshaState): void {
  delete state.extraPhase
  delete state.pendingExtraPhases
}
