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

/** 技能明确令一次阶段限次技视为未发动时，撤销当前阶段唯一键。 */
export function clearUsedThisPhase(state: SanguoshaState, playerId: PlayerId, skillId: string): void {
  const player = state.players.find((candidate) => candidate.id === playerId)
  if (!player?.turnUsedSkills) return
  const mark = markFor(state, skillId)
  player.turnUsedSkills = player.turnUsedSkills.filter((entry) => entry !== mark)
}

/**
 * 「这个出牌阶段里已经问过、而且被放弃了」。
 *
 * **活锁护栏**，不是规则的一部分。
 *
 * 可取消、而且取消之后什么都不改变的主动技（父魂、疠火、弓骑）有一个共同的
 * 危险形状：AI 点开 → 交空答案 → 场面没变 → 同一条动作又出现在合法动作里 →
 * 再点开。压测里这会直接跑成无限循环（一局 20000 步还没结束）。
 *
 * 所以放弃**也要留一个记号**：这一次出牌阶段实例里不再把这条动作报出来。
 * 记号和「出牌阶段限一次」共用同一套阶段实例键，所以：
 *
 * - 下一个出牌阶段（含廖化【当先】给的额外阶段）各自重新开始；
 * - 回合结束由 `turn.ts` 统一清，技能不各自注册清理。
 *
 * 代价是「这个阶段里改主意」要等到下个阶段——用一次可以撤销的确认换掉
 * 一个会把牌局跑死的循环，这笔交易是划算的，而且它只影响放弃过的那一次。
 */
export function declinedThisPhase(state: SanguoshaState, playerId: PlayerId, skillId: string): boolean {
  return usedThisPhase(state, playerId, `${skillId}:declined`)
}

export function markDeclinedThisPhase(state: SanguoshaState, playerId: PlayerId, skillId: string): void {
  markUsedThisPhase(state, playerId, `${skillId}:declined`)
}

/**
 * 撤掉放弃记号。
 *
 * 给「提交即上锁、成功落地再解锁」这种用法：有的技能在玩家**确认之前**
 * 一分代价都不付（程普【疠火】选完牌还没落属性），失败分支因此零状态变化、
 * 会被反复点开。那类技能在提交的一刻就先上锁，真的落地之后再解开——
 * 于是失败路径必然停住，而成功路径不损失任何一次合法发动。
 */
export function clearDeclinedThisPhase(state: SanguoshaState, playerId: PlayerId, skillId: string): void {
  const player = state.players.find((candidate) => candidate.id === playerId)
  if (!player?.turnUsedSkills) return
  const mark = `${skillId}:declined@${phaseKey(state)}`
  player.turnUsedSkills = player.turnUsedSkills.filter((entry) => entry !== mark)
}
