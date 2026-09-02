import type { PlayerId, SanguoshaState } from './types'

/**
 * 「每回合限一次」的统一记账。
 *
 * 技能只管问和标记，**不要各自注册回合结束的重置**——
 * `turn.ts` 在回合结束时统一清空 `turnUsedSkills`。
 * 原来是每个技能自己清自己的，散在 5 个文件里，漏了一个就变成永久失效
 * （华佗【青囊】就是这么坏的）。
 *
 * 一局一次的限定技用 `usedLimitedSkills`，那个永不重置，别混。
 */
export function usedThisTurn(state: SanguoshaState, playerId: PlayerId, skillId: string): boolean {
  const player = state.players.find((candidate) => candidate.id === playerId)
  return player?.turnUsedSkills?.includes(skillId) ?? false
}

export function markUsedThisTurn(state: SanguoshaState, playerId: PlayerId, skillId: string): void {
  const player = state.players.find((candidate) => candidate.id === playerId)
  if (!player) return
  // 旧快照里可能没有这个字段（Durable Object 恢复），补上再写
  if (!player.turnUsedSkills) player.turnUsedSkills = []
  if (!player.turnUsedSkills.includes(skillId)) player.turnUsedSkills.push(skillId)
}
