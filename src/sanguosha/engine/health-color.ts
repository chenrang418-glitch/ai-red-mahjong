import type { EventContext, GameEvent, GameEventName } from './events'
import type { PlayerId, SanguoshaState } from './types'

export type HealthColor = 'green' | 'yellow' | 'red'

/**
 * Official OL health-gem color bands used by skills such as 魔张飞【灼魂】.
 * Boundary values are yellow: green is strictly above 2/3 max HP, red strictly
 * below 1/3 max HP, and all intervening values are yellow.
 */
export function healthColorOf(hp: number, maxHp: number): HealthColor {
  if (!Number.isFinite(hp) || !Number.isFinite(maxHp) || maxHp <= 0) return 'red'
  if (hp * 3 > maxHp * 2) return 'green'
  if (hp * 3 < maxHp) return 'red'
  return 'yellow'
}

export interface HealthColorEventHost {
  state: SanguoshaState
  dispatch(
    name: GameEventName,
    payload?: Record<string, unknown>,
    metadata?: Omit<GameEvent, 'id' | 'seq' | 'name' | 'payload'>,
  ): EventContext
}

/** Emit a transition only when the character's gem actually changes color. */
export function dispatchHealthColorChange(
  host: HealthColorEventHost,
  playerId: PlayerId,
  previousHp: number,
  previousMaxHp: number,
  reason: string,
): void {
  const player = host.state.players.find((candidate) => candidate.id === playerId)
  if (!player) return
  const from = healthColorOf(previousHp, previousMaxHp)
  const to = healthColorOf(player.hp, player.maxHp)
  if (from === to) return
  host.dispatch('HealthColorChanged', {
    playerId,
    from,
    to,
    previousHp,
    hp: player.hp,
    previousMaxHp,
    maxHp: player.maxHp,
    reason,
  }, { targetId: playerId })
}
