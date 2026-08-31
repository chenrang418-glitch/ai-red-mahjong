import type { PlayerId, SanguoshaState } from './types'

function player(state: SanguoshaState, playerId: PlayerId) {
  const found = state.players.find((candidate) => candidate.id === playerId)
  if (!found) throw new Error(`玩家不存在：${playerId}`)
  return found
}

export function getSeatDistance(state: SanguoshaState, sourceId: PlayerId, targetId: PlayerId): number {
  if (sourceId === targetId) return 0
  const alive = state.players.filter((candidate) => candidate.alive).sort((left, right) => left.seat - right.seat)
  const sourceIndex = alive.findIndex((candidate) => candidate.id === sourceId)
  const targetIndex = alive.findIndex((candidate) => candidate.id === targetId)
  if (sourceIndex < 0 || targetIndex < 0) throw new Error('死亡角色不参与座次距离计算')
  const clockwise = (targetIndex - sourceIndex + alive.length) % alive.length
  const counterClockwise = (sourceIndex - targetIndex + alive.length) % alive.length
  return Math.min(clockwise, counterClockwise)
}

export function getDistance(state: SanguoshaState, sourceId: PlayerId, targetId: PlayerId): number {
  const source = player(state, sourceId)
  const target = player(state, targetId)
  const sourceHorse = source.zones.equipment.offensiveHorse ? 1 : 0
  const targetHorse = target.zones.equipment.defensiveHorse ? 1 : 0
  return Math.max(1, getSeatDistance(state, sourceId, targetId) - sourceHorse + targetHorse + source.distanceToOthers + target.distanceFromOthers)
}

export function getAttackRange(state: SanguoshaState, playerId: PlayerId): number {
  const source = player(state, playerId)
  const weapon = source.zones.equipment.weapon ? state.cards[source.zones.equipment.weapon] : null
  return Math.max(1, weapon?.attackRange ?? 1) + source.attackRangeBonus
}

export function canTarget(state: SanguoshaState, sourceId: PlayerId, targetId: PlayerId, range = getAttackRange(state, sourceId)): boolean {
  const target = player(state, targetId)
  return sourceId !== targetId && target.alive && getDistance(state, sourceId, targetId) <= range
}
