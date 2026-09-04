import { skillsOf } from './skills/runtime'
import { skillIdsOf } from '../data/characters/standard'
import type { EventContext, GameEvent, GameEventName } from './events'
import type { PlayerId, SanguoshaState } from './types'

/**
 * 武将牌的翻面状态。
 *
 * 翻面不是某个武将的私有开关，而是一条通用的角色状态：曹仁【据守】把自己翻面，
 * 以后神曹操、放逐、酒诗一类效果也都会用到它。所以入口只有这一个，
 * **不允许技能自己去写 `player.faceDown`**——那样翻面的事件、战报、
 * 回合跳过就会各写各的，很快就对不上。
 *
 * 规则：背面朝上的角色轮到自己的回合时，先把武将牌翻回正面，然后跳过整个回合。
 * 「翻回正面」和「跳过回合」发生在同一个回合开始，见 `turn.ts` 的 `beginTurn`。
 */

export interface CharacterStateHost {
  state: SanguoshaState
  dispatch(
    name: GameEventName,
    payload?: Record<string, unknown>,
    metadata?: Omit<GameEvent, 'id' | 'seq' | 'name' | 'payload'>,
  ): EventContext
}

/**
 * 翻面。不给 `faceDown` 就是「翻到另一面」。
 *
 * 已经处于目标状态时什么都不做，也不发事件——重复翻面在规则上是无效操作，
 * 发出去只会让战报出现一条「什么都没发生」的噪音。
 */
export function flipCharacter(
  host: CharacterStateHost,
  playerId: PlayerId,
  reason: string,
  faceDown?: boolean,
): void {
  const target = host.state.players.find((player) => player.id === playerId)
  if (!target?.alive) return
  const next = faceDown ?? !target.faceDown
  if (target.faceDown === next) return
  target.faceDown = next
  host.dispatch('CharacterFlip', { playerId, faceDown: next, reason }, { targetId: playerId })
}

/** 角色是否背面朝上。给回合流转和界面共用，避免各处直接读字段。 */
export function isFaceDown(state: SanguoshaState, playerId: PlayerId): boolean {
  return state.players.find((player) => player.id === playerId)?.faceDown ?? false
}

/**
 * 横置 / 重置是一条公共角色状态，不属于铁索连环或庞统私有。
 * 不给 `chained` 就切换；明确给值则用于死亡、涅槃等重置场景。
 */
/** 这名角色的连环状态是否被锁住（不能被解除）。 */
function isUnchainPrevented(state: SanguoshaState, playerId: PlayerId): boolean {
  return skillsOf(state, playerId, skillIdsOf).some((runtime) => runtime.preventsUnchain)
}

export function setChained(
  host: CharacterStateHost,
  playerId: PlayerId,
  reason: string,
  chained?: boolean,
): void {
  const target = host.state.players.find((player) => player.id === playerId)
  if (!target?.alive) return
  const next = chained ?? !target.chained
  /*
   * 连环锁（神刘备【结营】）：**解除**连环的效果对他无效。
   *
   * 属性伤害传导时引擎会把全场连环角色统一解除，那一步是规则本身的一部分，
   * 不受锁的影响（神刘备靠自己的技能在伤害结算后重新进入）。
   * 锁挡的是【铁索连环】这张牌和其他技能主动解除他连环的效果。
   */
  if (!next && reason !== 'elemental-damage' && isUnchainPrevented(host.state, playerId)) return
  if (target.chained === next) return
  target.chained = next
  host.dispatch('CharacterChained', { playerId, chained: next, reason }, { targetId: playerId })
}
