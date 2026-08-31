import type { EventContext, GameEvent, GameEventName } from './events'
import type { PlayerId, SanguoshaState } from './types'

export interface RecoverEngineHost {
  state: SanguoshaState
  dispatch(
    name: GameEventName,
    payload?: Record<string, unknown>,
    metadata?: Omit<GameEvent, 'id' | 'seq' | 'name' | 'payload'>,
  ): EventContext
}

export function recover(host: RecoverEngineHost, targetId: PlayerId, amount = 1, sourceId?: PlayerId): number {
  const target = host.state.players.find((player) => player.id === targetId)
  if (!target?.alive) throw new Error('不能回复不存在或死亡的角色')
  if (!Number.isInteger(amount) || amount <= 0) throw new Error('回复值必须是正整数')
  const recovered = Math.min(amount, target.maxHp - target.hp)
  if (recovered <= 0) return 0
  target.hp += recovered
  host.dispatch('Recover', { playerId: target.id, amount: recovered, hp: target.hp }, { sourceId, targetId: target.id })
  return recovered
}
