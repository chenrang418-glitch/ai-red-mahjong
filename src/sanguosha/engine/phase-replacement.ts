import { skillsOf } from './skills/runtime'
import { skillIdsOf } from '../data/characters/standard'
import type { PlayerId, SanguoshaState, TurnPhase } from './types'

/**
 * 阶段替换：某个阶段**改为**另一个阶段（神孙权【持纲】把判定阶段改成摸牌或出牌阶段）。
 *
 * 关键在于「改为」不是「额外来一个」，也不是「在判定阶段里偷偷摸两张牌」：
 *
 * - 被替换掉的那个阶段**不执行**。判定阶段被改掉，判定区里的延时锦囊
 *   这一轮就不结算——这正是这个效果的分量所在。
 * - 换上来的那个阶段是**真阶段**：`PhaseStart` / `PhaseEnd` 报的是新阶段，
 *   摸牌阶段的数量修正、出牌阶段的合法动作全都照常。
 *   写成「多摸两张牌」或者「多开一次动作面板」都不算数。
 * - 回合的**位置**不因此错乱：一个回合仍然是准备 → 判定位 → 摸牌 → 出牌 →
 *   弃牌 → 结束六个位置，被替换的只是「判定位上跑的是什么阶段」。
 *   所以位置（`phaseSlot`）和内容（`phase`）是两个字段——只改 `phase` 的话，
 *   「判定改成摸牌」会把真正的摸牌阶段顶掉，他这回合反而少摸一次。
 */

/**
 * 这名角色的这个阶段位现在要跑成哪个阶段。
 *
 * 返回 null 表示照原样跑。多个技能都想替换时取第一个——同一个人身上
 * 同时有两个替换同一阶段的技能是规则层面的冲突，不在这里悄悄合并。
 */
export function replacementPhaseFor(
  state: SanguoshaState,
  playerId: PlayerId,
  slot: TurnPhase,
): TurnPhase | null {
  for (const runtime of skillsOf(state, playerId, skillIdsOf)) {
    const replacement = runtime.replacesPhase?.(state, playerId, slot)
    if (replacement && replacement !== slot) return replacement
  }
  return null
}

/** 当前跑的这个阶段占的是哪个阶段位。没有替换时就是阶段本身。 */
export function phaseSlotOf(state: SanguoshaState): TurnPhase {
  return state.phaseReplacedFrom ?? state.phase
}

/** 当前阶段是被替换来的吗。 */
export function phaseIsReplaced(state: SanguoshaState): boolean {
  return state.phaseReplacedFrom !== undefined
}
