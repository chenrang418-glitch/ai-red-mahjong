import type { CardId, SanguoshaState } from './types'

/**
 * 「这一次使用的牌**造成过伤害吗**」——按牌记的账，活到这次使用结算结束为止。
 *
 * 程普【疠火】要的是这个：一张【杀】结算结束后，**若其造成过伤害**才失去体力。
 * 三件事靠它才做得对：
 *
 * 1. **根在「这次使用」上，不是「这一次伤害」上。** 火【杀】可以有两个目标，
 *    伤了谁都算成立；两个都伤了也只失去 **1 点**体力，
 *    因为账是一本、读一次。
 * 2. **时机在整张牌结算完之后**，不是打中的那一刻。中途还可能被无懈、
 *    被闪、被藤甲改属性；「造成过伤害」要等结算收束才有定论。
 * 3. **被闪掉、被防止、被换成失去体力的都不记账**——那几种情况下
 *    根本走不到伤害落地那一行。
 *
 * 账在 `finishPhysicalCard` 里随这次使用一起销毁，不会跨牌残留。
 * 记在牌局状态里所以可序列化：Durable Object 休眠、断线重连都接得上。
 */

/** 记一笔：这张牌这次使用造成了 `amount` 点伤害。 */
export function recordCardDamage(state: SanguoshaState, cardId: CardId | null, amount: number): void {
  if (!cardId || amount <= 0) return
  state.cardDamageLedger ??= {}
  state.cardDamageLedger[cardId] = (state.cardDamageLedger[cardId] ?? 0) + amount
}

/** 这张牌这次使用一共造成了多少伤害。没造成过就是 0。 */
export function cardDamageDealt(state: SanguoshaState, cardId: CardId): number {
  return state.cardDamageLedger?.[cardId] ?? 0
}

/** 这次使用结算收束，销毁这张牌的账。由 `finishPhysicalCard` 统一调。 */
export function clearCardDamage(state: SanguoshaState, cardId: CardId): void {
  if (!state.cardDamageLedger) return
  delete state.cardDamageLedger[cardId]
  if (Object.keys(state.cardDamageLedger).length === 0) delete state.cardDamageLedger
}
