import type { PlayerId, SanguoshaState } from './types'

/**
 * 授出去的技能记住是谁给的。
 *
 * 有些被授予的技能，发动条件依赖**授予它的那个人**still存活或状态达标
 * （神郭嘉【天翊】授出的【佐幸】要花神郭嘉的体力上限）。娱乐模式允许同名武将
 * 重复出现，只按「场上还有没有神郭嘉活着」判断的话，A 授出的佐幸能去花 B 的
 * 体力上限——这是错的。
 *
 * 所以授技时把来源一起记下来，按 (持有者, 技能) 唯一。
 */
export interface SkillGrantSource {
  playerId: PlayerId
  skillId: string
  sourceId: PlayerId
}

function all(state: SanguoshaState): SkillGrantSource[] {
  return state.skillGrantSources ?? (state.skillGrantSources = [])
}

export function recordSkillGrantSource(state: SanguoshaState, entry: SkillGrantSource): void {
  const list = all(state)
  const existing = list.findIndex((item) => item.playerId === entry.playerId && item.skillId === entry.skillId)
  if (existing >= 0) list[existing] = entry
  else list.push(entry)
}

export function skillGrantSourceOf(state: SanguoshaState, playerId: PlayerId, skillId: string): PlayerId | null {
  return all(state).find((item) => item.playerId === playerId && item.skillId === skillId)?.sourceId ?? null
}
