import { isForcedInAttackRange } from './attack-range-override'
import { distanceOverrideFor } from './distance-override'
import { weaponCardsOf } from './equipment-slots'
import { skillsOf } from './skills/runtime'
import { skillIdsOf } from '../data/characters/standard'
import type { CardId, PlayerId, SanguoshaState } from './types'

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
    // 定向修正（田豫【追讨】：只对这一个 target 生效，不是对所有人都 -1）
    total += Math.trunc(runtime.directedDistanceTo?.(state, sourceId, targetId) ?? 0)
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
  if (sourceId === targetId) return 0
  /*
   * 定向的「视为距离 N」（伏皇后【惴恐】没赢）优先于正常计算——
   * 这条要连带影响顺手牵羊、兵粮寸断这些直接读距离的效果，
   * 不能只做一个「攻击范围内」的布尔豁免，所以覆盖的是距离本身。
   */
  const overridden = distanceOverrideFor(state, sourceId, targetId)
  if (overridden !== null) return overridden
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
  /*
   * 武器栏被废除时武器不存在（神张辽【夺锐】）；有第二武器栏时可能同时装着两把
   * （神典韦【捐甲】）。**两把武器的攻击范围取较大的那个，不是相加**——
   * 攻击范围是「你能打多远」，多带一把兵器不会让手变长两倍。
   */
  const ranges = weaponCardsOf(state, playerId)
    .map((cardId) => state.cards[cardId]?.attackRange ?? 1)
  return Math.max(1, ...ranges) + source.attackRangeBonus
}

/**
 * 使用者对这个目标是不是完全不受距离限制（神孙策【英霸】）。
 *
 * 注意问的是**使用者**的技能，而且带上了具体目标——「对有我标记的人无距离」
 * 不能写成「我对所有人无距离」。
 */
export function ignoresDistanceTo(state: SanguoshaState, sourceId: PlayerId, targetId: PlayerId, cardId?: CardId): boolean {
  return skillsOf(state, sourceId, skillIdsOf).some((runtime) => runtime.ignoresDistanceTo?.(state, sourceId, targetId, cardId))
}

/** 场上有没有第三方技能让 `attackerId` 对 `targetId` 无视距离（孙休【诏缚】）。 */
export function globalIgnoresDistanceTo(state: SanguoshaState, attackerId: PlayerId, targetId: PlayerId): boolean {
  for (const owner of state.players) {
    if (!owner.alive || !owner.characterId) continue
    for (const runtime of skillsOf(state, owner.id, skillIdsOf)) {
      if (runtime.globalIgnoresDistanceTo?.(state, owner.id, attackerId, targetId)) return true
    }
  }
  return false
}

export function canTarget(state: SanguoshaState, sourceId: PlayerId, targetId: PlayerId, range = getAttackRange(state, sourceId), cardId?: CardId): boolean {
  const target = player(state, targetId)
  if (sourceId === targetId || !target.alive) return false
  if (ignoresDistanceTo(state, sourceId, targetId, cardId)) return true
  // 定向的「视为在攻击范围内」（神太史慈【破围】）：只对这一对角色成立
  if (isForcedInAttackRange(state, sourceId, targetId)) return true
  if (globalIgnoresDistanceTo(state, sourceId, targetId)) return true
  return getDistance(state, sourceId, targetId) <= range
}
