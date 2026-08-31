import type { GameRng } from './rng'
import type { GameEventName } from './events'
import type { PlayerId, SanguoshaState } from './types'
import { moveCard } from './zones'

export type EmitDrawEvent = (name: GameEventName, payload: Record<string, unknown>) => void

/** 统一摸牌入口；牌堆耗尽时使用同一局 RNG 重洗弃牌堆。 */
export function drawCards(
  state: SanguoshaState,
  rng: GameRng,
  playerId: PlayerId,
  count: number,
  emit?: EmitDrawEvent,
): string[] {
  const target = state.players.find((player) => player.id === playerId)
  if (!target) throw new Error(`玩家不存在：${playerId}`)
  if (!Number.isInteger(count) || count < 0) throw new Error('摸牌数量必须是非负整数')

  const drawn: string[] = []
  for (let index = 0; index < count; index += 1) {
    if (state.zones.drawPile.length === 0) {
      if (state.zones.discardPile.length === 0) break
      state.zones.drawPile.push(...rng.shuffle(state.zones.discardPile))
      state.zones.discardPile.length = 0
    }
    const cardId = state.zones.drawPile[0]
    moveCard(state, cardId, { kind: 'drawPile' }, { kind: 'hand', playerId })
    drawn.push(cardId)
  }
  if (drawn.length > 0) emit?.('GainCard', { playerId, cardIds: drawn, reason: 'draw' })
  return drawn
}
