import type { PlayerId, SanguoshaState } from './types'

/** 胡昭【弥笃】废除的判定区。判定区规则统一从这里读取。 */
export function isJudgmentAreaAbolished(state: SanguoshaState, playerId: PlayerId): boolean {
  return state.abolishedJudgmentAreas?.includes(playerId) ?? false
}

export function abolishJudgmentArea(state: SanguoshaState, playerId: PlayerId): boolean {
  if (isJudgmentAreaAbolished(state, playerId)) return false
  state.abolishedJudgmentAreas ??= []
  state.abolishedJudgmentAreas.push(playerId)
  return true
}

export function restoreJudgmentArea(state: SanguoshaState, playerId: PlayerId): boolean {
  if (!isJudgmentAreaAbolished(state, playerId)) return false
  state.abolishedJudgmentAreas = state.abolishedJudgmentAreas?.filter((id) => id !== playerId)
  return true
}
