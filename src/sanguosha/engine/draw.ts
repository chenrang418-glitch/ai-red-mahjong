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

/**
 * 从牌堆顶亮出若干张真牌，放进处理区并公开展示。
 *
 * 「亮出」不是「看一眼」：这些是真实 CardId，必须真的离开牌堆、进入处理区，
 * 否则牌张守恒立刻不成立，前端也看不到它们。调用方拿到列表后**必须**把每一张
 * 都送去一个确定的归宿（手牌或弃牌堆），不能留在处理区。
 *
 * 牌堆不足时和 `drawCards` 走同一条重洗规则；两边都空就只亮出实际拿得到的张数，
 * 绝不越界。
 */
export function revealTopCards(
  state: SanguoshaState,
  rng: GameRng,
  count: number,
  reason: string,
  emit?: EmitDrawEvent,
): string[] {
  if (!Number.isInteger(count) || count < 0) throw new Error('亮牌数量必须是非负整数')
  const revealed: string[] = []
  for (let index = 0; index < count; index += 1) {
    if (state.zones.drawPile.length === 0) {
      if (state.zones.discardPile.length === 0) break
      state.zones.drawPile.push(...rng.shuffle(state.zones.discardPile))
      state.zones.discardPile.length = 0
    }
    const cardId = state.zones.drawPile[0]
    moveCard(state, cardId, { kind: 'drawPile' }, { kind: 'processingArea' })
    revealed.push(cardId)
  }
  // 一次性发一条批量事件，战报不刷 N 行「展示牌」
  if (revealed.length > 0) emit?.('CardMove', { cardIds: revealed, reason, revealed: true })
  return revealed
}
