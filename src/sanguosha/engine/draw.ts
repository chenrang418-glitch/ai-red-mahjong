import { GameRng } from './rng'
import type { GameEventName } from './events'
import type { PlayerId, SanguoshaState } from './types'
import { moveCard } from './zones'
import { reshuffleDrawPile } from './deck'
import { drawsFromBottomFor } from './skills/runtime'
import { consumeGainCardCount } from './card-gain-modifier'

export type EmitDrawEvent = (name: GameEventName, payload: Record<string, unknown>) => unknown
const drawEventEmitters = new WeakMap<SanguoshaState, EmitDrawEvent>()
const drawRngs = new WeakMap<SanguoshaState, GameRng>()

/** Legacy signatures must advance the same RNG that the game serializes. */
export function bindDrawRng(state: SanguoshaState, rng: GameRng): void {
  drawRngs.set(state, rng)
}

/** Bind the game event bus once so legacy draw callers that omit `emit` still share draw timing. */
export function bindDrawEventEmitter(state: SanguoshaState, emit: EmitDrawEvent): void {
  drawEventEmitters.set(state, emit)
}

/** A draw replacement interrupted the synchronous caller before any card moved. */
export class DrawAttemptInterrupted extends Error {
  constructor(readonly playerId: PlayerId, readonly count: number, readonly attemptIndex: number) {
    super(`摸牌流程已中断，等待 ${playerId} 对 ${count} 张牌的替代效果作出选择`)
    this.name = 'DrawAttemptInterrupted'
  }
}

/** 统一摸牌入口；牌堆耗尽时使用同一局 RNG 重洗弃牌堆。 */
export function drawCards(state: SanguoshaState, rng: GameRng, playerId: PlayerId, count: number, emit?: EmitDrawEvent): string[]
/** 兼容早期批次的旧调用顺序：drawCards(state, playerId, count, emit)。 */
export function drawCards(state: SanguoshaState, playerId: PlayerId, count: number, emit?: EmitDrawEvent): string[]
export function drawCards(
  state: SanguoshaState,
  rngOrPlayerId: GameRng | PlayerId,
  playerIdOrCount: PlayerId | number,
  countOrEmit?: number | EmitDrawEvent,
  emitMaybe?: EmitDrawEvent,
): string[] {
  const legacy = !(rngOrPlayerId instanceof GameRng)
  const rng = legacy ? drawRngs.get(state) ?? new GameRng(state.seed, state.rngState) : rngOrPlayerId
  const playerId = (legacy ? rngOrPlayerId : playerIdOrCount) as PlayerId
  let count = (legacy ? playerIdOrCount : countOrEmit) as number
  const emit = (legacy ? countOrEmit : emitMaybe) as EmitDrawEvent | undefined
  const notify = emit ?? drawEventEmitters.get(state)
  const target = state.players.find((player) => player.id === playerId)
  if (!target) throw new Error(`玩家不存在：${playerId}`)
  if (!Number.isInteger(count) || count < 0) throw new Error('摸牌数量必须是非负整数')
  count = consumeGainCardCount(state, playerId, count)

  // 这是「摸牌时」的公共、尚未移动牌张的窗口。回调可同步取消，
  // 让外层可续接操作负责挂起/恢复；不得在已摸进手牌后再尝试撤销。
  const attemptIndex = count > 0 && state.drawOperationReplay ? state.drawAttemptIndex ?? 0 : -1
  if (count > 0 && state.drawOperationReplay) state.drawAttemptIndex = attemptIndex + 1
  const attempt = count > 0 ? notify?.('DrawAttempt', { playerId, count, isDraw: true, attemptIndex }) : undefined
  const interrupt = state.drawAttemptInterrupt?.attemptIndex === attemptIndex ? state.drawAttemptInterrupt : undefined
  if (interrupt) delete state.drawAttemptInterrupt
  if (interrupt || (attempt && typeof attempt === 'object' && 'cancelled' in attempt && attempt.cancelled)) {
    if (interrupt?.replacementCardIds) return interrupt.replacementCardIds
    const payload = attempt && typeof attempt === 'object' && 'event' in attempt && attempt.event && typeof attempt.event === 'object'
      ? (attempt.event as { payload?: Record<string, unknown> }).payload
      : undefined
    const replacementCardIds = payload?.replacementCardIds
    if (Array.isArray(replacementCardIds) && replacementCardIds.every((id) => typeof id === 'string'))
      return replacementCardIds
    throw new DrawAttemptInterrupted(playerId, count, attemptIndex)
  }

  const fromBottom = drawsFromBottomFor(state, playerId)
  const drawn: string[] = []
  for (let index = 0; index < count; index += 1) {
    // 牌堆空了走公共重洗：它会留下「这个回合洗过牌」的痕迹
    if (state.zones.drawPile.length === 0 && reshuffleDrawPile(state, rng, notify) === 0) break
    const cardId = fromBottom ? state.zones.drawPile[state.zones.drawPile.length - 1] : state.zones.drawPile[0]
    moveCard(state, cardId, { kind: 'drawPile' }, { kind: 'hand', playerId })
    drawn.push(cardId)
  }
  if (drawn.length > 0) notify?.('GainCard', { playerId, cardIds: drawn, reason: 'draw', isDraw: true })
  if (legacy) state.rngState = rng.snapshot()
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
    if (state.zones.drawPile.length === 0 && reshuffleDrawPile(state, rng, emit ?? drawEventEmitters.get(state)) === 0) break
    const cardId = state.zones.drawPile[0]
    moveCard(state, cardId, { kind: 'drawPile' }, { kind: 'processingArea' })
    revealed.push(cardId)
  }
  // 一次性发一条批量事件，战报不刷 N 行「展示牌」
  if (revealed.length > 0) emit?.('CardMove', { cardIds: revealed, reason, revealed: true })
  return revealed
}
