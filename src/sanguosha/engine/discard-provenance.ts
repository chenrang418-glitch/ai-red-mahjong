import type { CardId, PlayerId, SanguoshaState } from './types'

/**
 * 一张牌**为什么**进了弃牌堆。
 *
 * 曹植【落英】只收「因弃置或判定进入弃牌堆」的梅花牌——用过的【杀】结算完
 * 同样躺在弃牌堆里，但那不算。所以不能扫弃牌堆找梅花，必须知道它是怎么进去的。
 *
 * 记录挂在牌局状态里（可序列化、能重连），牌一离开弃牌堆就自动清掉，
 * 不会越积越多。
 */

export type DiscardReason =
  /** 被弃置：弃牌阶段、技能代价、过河拆桥、阵亡收牌都算。 */
  | 'discard'
  /** 判定牌用完了。含被改判换下来的那一张。 */
  | 'judgment'
  /** 其他：用过的牌结算完、装备被替换、技能把牌搬进去等等。 */
  | 'other'

export interface DiscardEntry {
  reason: DiscardReason
  /** 进弃牌堆之前属于谁。牌堆顶翻出来的判定牌没有归属，是 null。 */
  ownerId: PlayerId | null
  /** 进去时的事件序号，用来判断「这条是不是我还没看过的」。 */
  seq: number
}

/**
 * 从来源区推断原因。
 *
 * 手牌 / 装备区 / 判定区 → 被弃置；处理区 → 说不准（可能是用完的牌，
 * 也可能是判定牌），所以默认 `other`，由调用方在知道的时候显式说明。
 * **宁可推断成 `other`**：漏判只是少一次触发机会，误判成 `discard`
 * 会让「用过的牌」也被当成弃置，那是规则错误。
 */
function inferReason(fromKind: string): DiscardReason {
  if (fromKind === 'hand' || fromKind === 'equipment' || fromKind === 'judgingArea') return 'discard'
  return 'other'
}

export function recordDiscardEntry(
  state: SanguoshaState,
  cardId: CardId,
  fromKind: string,
  fromOwnerId: PlayerId | null,
  reason?: DiscardReason,
): void {
  state.discardProvenance ??= {}
  state.discardProvenance[cardId] = {
    reason: reason ?? inferReason(fromKind),
    ownerId: fromOwnerId,
    seq: state.seq,
  }
}

/** 牌离开弃牌堆时把记录清掉，免得它越积越大、也免得旧记录被当成新的。 */
export function clearDiscardEntry(state: SanguoshaState, cardId: CardId): void {
  if (state.discardProvenance) delete state.discardProvenance[cardId]
}

export function discardEntryOf(state: SanguoshaState, cardId: CardId): DiscardEntry | null {
  return state.discardProvenance?.[cardId] ?? null
}

/**
 * 现在弃牌堆里，符合条件、而且序号在 `afterSeq` 之后的牌。
 *
 * 三个条件缺一不可：
 *
 * 1. **确实还在弃牌堆里**——别的效果（固政、游医）可能已经把它拿走了，
 *    这时候再「获得」一次就是凭空复制一张牌；
 * 2. 原因对得上；
 * 3. 序号比调用方上次看过的大，避免同一张牌被反复提供。
 */
export function newDiscardEntries(
  state: SanguoshaState,
  afterSeq: number,
  accept: (entry: DiscardEntry, cardId: CardId) => boolean,
): CardId[] {
  const provenance = state.discardProvenance ?? {}
  return state.zones.discardPile
    .filter((cardId) => {
      const entry = provenance[cardId]
      return !!entry && entry.seq > afterSeq && accept(entry, cardId)
    })
}
