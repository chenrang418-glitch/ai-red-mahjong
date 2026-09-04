import { isSlotAbolished } from './equipment-slots'
import { skillsOf } from './skills/runtime'
import { skillIdsOf } from '../data/characters/standard'
import type { PlayerId, SanguoshaState } from './types'

/**
 * 技能带来的距离修正：来源的「与他人距离」和目标的「他人与我距离」都算进来。
 *
 * 修正量允许是函数：邓艾【屯田】的减距离等于「田」的张数，每次现算。
 */
function resolveModifier(
  value: number | ((state: SanguoshaState, ownerId: PlayerId) => number) | undefined,
  state: SanguoshaState,
  ownerId: PlayerId,
): number {
  if (value === undefined) return 0
  return Math.trunc(typeof value === 'function' ? value(state, ownerId) : value)
}

function skillDistanceModifier(state: SanguoshaState, sourceId: PlayerId, targetId: PlayerId): number {
  let total = 0
  for (const runtime of skillsOf(state, sourceId, skillIdsOf)) {
    total += resolveModifier(runtime.distanceModifier?.toOthers, state, sourceId)
  }
  for (const runtime of skillsOf(state, targetId, skillIdsOf)) {
    total += resolveModifier(runtime.distanceModifier?.fromOthers, state, targetId)
  }
  return total
}

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
  // 技能的距离修正（马术等）和坐骑走同一条公式，技能自己不重算距离
  const skill = skillDistanceModifier(state, sourceId, targetId)
  return Math.max(1, getSeatDistance(state, sourceId, targetId) - sourceHorse + targetHorse
    + source.distanceToOthers + target.distanceFromOthers + skill)
}

export function getAttackRange(state: SanguoshaState, playerId: PlayerId): number {
  const source = player(state, playerId)
  // 武器栏被废除时武器不存在，攻击范围随之变化（神张辽【夺锐】）
  const weaponId = isSlotAbolished(state, playerId, 'weapon') ? null : source.zones.equipment.weapon
  const weapon = weaponId ? state.cards[weaponId] : null
  return Math.max(1, weapon?.attackRange ?? 1) + source.attackRangeBonus
}

export function canTarget(state: SanguoshaState, sourceId: PlayerId, targetId: PlayerId, range = getAttackRange(state, sourceId)): boolean {
  const target = player(state, targetId)
  return sourceId !== targetId && target.alive && getDistance(state, sourceId, targetId) <= range
}
