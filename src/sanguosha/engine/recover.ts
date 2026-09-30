import type { EventContext, GameEvent, GameEventName } from './events'
import { recoverAmountBonusOf } from './skills/runtime'
import { skillIdsOf } from '../data/characters/standard'
import type { CardId, PlayerId, SanguoshaState } from './types'
import { hasMilitaryOrderEffect } from './modes/military-order'
import { dispatchHealthColorChange } from './health-color'

export interface RecoverEngineHost {
  state: SanguoshaState
  dispatch(
    name: GameEventName,
    payload?: Record<string, unknown>,
    metadata?: Omit<GameEvent, 'id' | 'seq' | 'name' | 'payload'>,
  ): EventContext
}

export function recover(host: RecoverEngineHost, targetId: PlayerId, amount = 1, sourceId?: PlayerId, sourceCardId?: CardId): number {
  const target = host.state.players.find((player) => player.id === targetId)
  if (!target?.alive) throw new Error('不能回复不存在或死亡的角色')
  if (!Number.isInteger(amount) || amount <= 0) throw new Error('回复值必须是正整数')
  if (hasMilitaryOrderEffect(host.state, targetId, 'recovery')) return 0
  amount += recoverAmountBonusOf(host.state, targetId, sourceId ?? null, skillIdsOf, sourceCardId)
  const recovered = Math.min(amount, target.maxHp - target.hp)
  if (recovered <= 0) return 0
  const previousHp = target.hp
  const previousMaxHp = target.maxHp
  target.hp += recovered
  host.dispatch('Recover', { playerId: target.id, amount: recovered, hp: target.hp }, { sourceId, targetId: target.id, ...(sourceCardId ? { cardIds: [sourceCardId] } : {}) })
  dispatchHealthColorChange(host, target.id, previousHp, previousMaxHp, 'recover')
  return recovered
}

/** Resolve effects phrased as “recover until HP is N” without turning them into N separate recovery. */
export function recoverTo(host: RecoverEngineHost, targetId: PlayerId, hp: number, sourceId?: PlayerId, reason?: string): number {
  const target = host.state.players.find((player) => player.id === targetId)
  if (!target?.alive) throw new Error('不能回复不存在或死亡的角色')
  if (!Number.isInteger(hp) || hp < 0) throw new Error('目标体力值必须是非负整数')
  if (hasMilitaryOrderEffect(host.state, targetId, 'recovery')) return 0
  const recovered = Math.max(0, Math.min(hp, target.maxHp) - target.hp)
  if (recovered === 0) return 0
  const previousHp = target.hp
  const previousMaxHp = target.maxHp
  target.hp += recovered
  host.dispatch('Recover', { playerId: target.id, amount: recovered, hp: target.hp, ...(reason ? { reason } : {}) }, { sourceId, targetId: target.id })
  dispatchHealthColorChange(host, target.id, previousHp, previousMaxHp, reason ?? 'recover')
  return recovered
}
