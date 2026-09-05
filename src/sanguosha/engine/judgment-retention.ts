import { moveCard } from './zones'
import type { CardId, PlayerId, SanguoshaState, Suit } from './types'

/**
 * 判定牌暂存。
 *
 * 普通判定结束时判定牌直接进弃牌堆。但有的技能要在连续判定**全部结束之后**
 * 再统一处置这些牌（神郭嘉【慧识】把所有生效的判定牌交给一名角色），
 * 那就不能让它们一张张漏进弃牌堆。
 *
 * 三条纪律：
 *
 * 1. **只收最终生效的那一张。** 改判换下来的旧牌在改判当场就进了弃牌堆
 *    （见 `resolveRetrialResponse`），走不到这里，所以「原判定 A 被改成 B」
 *    只会收 B，不会把 A 也算成生效判定牌。
 * 2. **暂存期间牌留在处理区。** 处理区是完全公开的，而判定牌本来就是明置的，
 *    语义对得上；牌张守恒也照常成立，不需要新开一个游离区域。
 * 3. **按续接 tag 认领。** 谁发起的判定谁收，不能把别的技能顺手插进来的判定
 *    也收进自己的暂存堆。
 */
export interface JudgmentRetentionState {
  /** 发起暂存的角色。 */
  ownerId: PlayerId
  /** 只收这个续接 tag 发起的判定。 */
  tag: string
  /** 已经暂存下来的、生效的判定牌，按判定顺序。 */
  cardIds: CardId[]
  /**
   * 每次判定的**最终**花色，按判定顺序，和 `cardIds` 一一对应。
   *
   * 必须当场记下来：最终花色可能被改判或【铁骑】改过，事后从牌面反推会读到印刷值。
   */
  suits: Suit[]
}

export function beginJudgmentRetention(state: SanguoshaState, ownerId: PlayerId, tag: string): void {
  if (state.judgmentRetention) throw new Error('上一次判定暂存还没有结束')
  state.judgmentRetention = { ownerId, tag, cardIds: [], suits: [] }
}

/** 这次判定要不要暂存。`finishJudgment` 用它决定是进弃牌堆还是留在处理区。 */
export function shouldRetainJudgment(state: SanguoshaState, tag: string): boolean {
  return state.judgmentRetention?.tag === tag
}

export function retainJudgmentCard(state: SanguoshaState, cardId: CardId, suit: Suit): void {
  const retention = state.judgmentRetention
  if (!retention) throw new Error('没有正在进行的判定暂存')
  if (!state.zones.processingArea.includes(cardId)) throw new Error('要暂存的判定牌不在处理区')
  retention.cardIds.push(cardId)
  retention.suits.push(suit)
}

/** 已经出现过的最终花色，按判定顺序。 */
export function retainedJudgmentSuits(state: SanguoshaState): readonly Suit[] {
  return state.judgmentRetention?.suits ?? []
}

export function retainedJudgmentCards(state: SanguoshaState): readonly CardId[] {
  return state.judgmentRetention?.cardIds ?? []
}

/**
 * 结束暂存并把牌交出去。
 *
 * `recipientId` 为空表示没人要（技能文本允许放弃），这些牌按普通判定牌的
 * 归宿进弃牌堆——绝不能留在处理区，那会变成永远清不掉的残留。
 */
export function endJudgmentRetention(state: SanguoshaState, recipientId: PlayerId | null): CardId[] {
  const retention = state.judgmentRetention
  if (!retention) return []
  const cardIds = [...retention.cardIds]
  state.judgmentRetention = null
  for (const cardId of cardIds) {
    const destination = recipientId
      ? ({ kind: 'hand', playerId: recipientId } as const)
      : ({ kind: 'discardPile' } as const)
    moveCard(state, cardId, { kind: 'processingArea' }, destination)
  }
  return cardIds
}
