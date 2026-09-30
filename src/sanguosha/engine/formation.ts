import type { PlayerId, SanguoshaState } from './types'
import { revealedGeneralFactionOf } from './general-slots'

/** 按当前存活座次取得角色左右相邻位；死人不再占据围攻位置。 */
export function formationFlanks(state: SanguoshaState, targetId: PlayerId): [PlayerId, PlayerId] | null {
  const alive = [...state.players].filter(player => player.alive).sort((a, b) => a.seat - b.seat)
  const index = alive.findIndex(player => player.id === targetId)
  if (index < 0 || alive.length < 3) return null
  return [alive[(index - 1 + alive.length) % alive.length].id, alive[(index + 1) % alive.length].id]
}

/** 国战围攻按明置武将的势力判断，不使用身份场身份。 */
export function shareRevealedFaction(state: SanguoshaState, firstId: PlayerId, secondId: PlayerId): boolean {
  const first = state.players.find(player => player.id === firstId)
  const second = state.players.find(player => player.id === secondId)
  if (!first?.alive || !second?.alive || first.id === second.id) return false
  const firstFaction = revealedGeneralFactionOf(first)
  const secondFaction = revealedGeneralFactionOf(second)
  return !!firstFaction && firstFaction === secondFaction
}

/**
 * 国战围攻关系：目标两侧各有一名同势力角色，且目标势力明确并与之不同。
 * participant 是发动技能的围攻者，source 是使用牌的围攻者。
 */
export function isInFactionEncirclement(
  state: SanguoshaState,
  participantId: PlayerId,
  sourceId: PlayerId,
  targetId: PlayerId,
): boolean {
  const flanks = formationFlanks(state, targetId)
  if (!flanks || participantId === targetId || sourceId === targetId) return false
  const [left, right] = flanks
  if (![left, right].includes(participantId) || ![left, right].includes(sourceId)) return false
  const target = state.players.find(player => player.id === targetId)
  const flankFaction = revealedGeneralFactionOf(state.players.find(player => player.id === left)!)
  const targetFaction = target ? revealedGeneralFactionOf(target) : undefined
  if (!flankFaction || !targetFaction || flankFaction === targetFaction) return false
  const otherFlankId = participantId === left ? right : left
  return shareRevealedFaction(state, participantId, otherFlankId)
}
