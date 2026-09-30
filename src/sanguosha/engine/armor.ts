import type { EventContext, GameEvent, GameEventName } from './events'
import type { PlayerId, SanguoshaState } from './types'

export interface ArmorEngineHost {
  state: SanguoshaState
  dispatch(name: GameEventName, payload?: Record<string, unknown>, metadata?: Omit<GameEvent, 'id' | 'seq' | 'name' | 'payload'>): EventContext
}

/** 移动版“护甲”独立于装备区防具；上限为5，伤害结算中自动优先消耗。 */
export function gainArmor(host: ArmorEngineHost, playerId: PlayerId, amount = 1, reason: string): number {
  const player = host.state.players.find((entry) => entry.id === playerId)
  if (!player?.alive) return 0
  if (!Number.isInteger(amount) || amount < 0) throw new Error('增加护甲值必须是非负整数')
  const before = player.armorPoints ?? 0
  const gained = Math.min(amount, 5 - before)
  if (gained <= 0) return 0
  player.armorPoints = before + gained
  host.dispatch('ArmorChanged', { playerId, amount: gained, armorPoints: player.armorPoints, reason }, { targetId: playerId })
  return gained
}

/** 由技能主动消耗护甲；不视为受到伤害，也不触发伤害时机。 */
export function loseArmor(host: ArmorEngineHost, playerId: PlayerId, amount = 1, reason: string): number {
  const player = host.state.players.find((entry) => entry.id === playerId)
  if (!player?.alive) return 0
  if (!Number.isInteger(amount) || amount < 0) throw new Error('失去护甲值必须是非负整数')
  const before = player.armorPoints ?? 0
  const lost = Math.min(amount, before)
  if (lost <= 0) return 0
  player.armorPoints = before - lost
  host.dispatch('ArmorChanged', { playerId, amount: -lost, armorPoints: player.armorPoints, reason }, { targetId: playerId })
  return lost
}
