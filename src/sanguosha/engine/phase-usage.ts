import { phaseSlotOf } from './phase-replacement'
import type { PlayerId, SanguoshaState } from './types'

/**
 * 「出牌阶段限一次」的统一记账——**按阶段算，不是按回合算**。
 *
 * 这两者在现代武将同桌之后已经不等价了：神孙权【持纲】可以把判定位跑成
 * 出牌阶段，于是一个回合里会出现**两个**出牌阶段。按回合记账的话，
 * 「出牌阶段限一次」在那种回合里变成了「两个阶段合起来只有一次」。
 *
 * 记号搭在既有的 `turnUsedSkills` 上（本来就是个可序列化的字符串表、
 * 回合结束由 `turn.ts` 统一清空），键里带上**阶段位**：
 * 同一个回合里的两个出牌阶段占的是不同的阶段位，键自然不同。
 *
 * 既有武将仍然用 `turn-usage.ts` 的回合口径——那是一个更早的约定，
 * 这里不去偷偷改它们的行为；新写的技能按这个口径走。
 */

/** 当前阶段的唯一键：第几个回合 + 哪个阶段位 + 实际在跑的阶段。 */
function phaseKey(state: SanguoshaState): string {
  /*
   * 额外阶段（廖化【当先】）和随后的正常出牌阶段占的是**同一个阶段位**，
   * 只靠阶段位区分不开，「出牌阶段限一次」会被两个阶段合起来用掉一次。
   * 额外阶段有自己的实例号，拼进键里，两个阶段各有一次。
   */
  const extra = state.extraPhase ? `x${state.extraPhase.instanceId}` : ''
  return `${state.turnNumber}:${phaseSlotOf(state)}${extra}:${state.phase}`
}

function markFor(state: SanguoshaState, skillId: string): string {
  return `${skillId}@${phaseKey(state)}`
}

export function usedThisPhase(state: SanguoshaState, playerId: PlayerId, skillId: string): boolean {
  const player = state.players.find((candidate) => candidate.id === playerId)
  return player?.turnUsedSkills?.includes(markFor(state, skillId)) ?? false
}

export function markUsedThisPhase(state: SanguoshaState, playerId: PlayerId, skillId: string): void {
  const player = state.players.find((candidate) => candidate.id === playerId)
  if (!player) return
  // 旧快照里可能没有这个字段（Durable Object 恢复），补上再写
  if (!player.turnUsedSkills) player.turnUsedSkills = []
  const mark = markFor(state, skillId)
  if (!player.turnUsedSkills.includes(mark)) player.turnUsedSkills.push(mark)
}
