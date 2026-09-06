import type { CardId, PlayerId, SanguoshaState } from './types'

/**
 * 一张牌**从谁那里**到了现在的手上。
 *
 * 法正【恩怨】的前半段要的是「你获得了**其他角色的**两张或更多的牌」，
 * 这句话里有三个不能省的限定：
 *
 * 1. **必须来自某名角色的区域**。摸牌、从弃牌堆捡回来、从处理区拿走
 *    都不算——那些牌不属于任何人，也就谈不上「其他角色的牌」。
 * 2. **必须是同一名角色的**。同一次效果里从甲、乙各拿一张是「各一张」，
 *    不构成任何一个人的两张。所以要按来源分组数，不能只数总数。
 * 3. **必须是同一次获得**。这一次拿一张、下一次再拿一张不能凑成两张。
 *
 * 所以「来自谁」只能在**牌移动的那一刻**记下来。`GainCard` 事件发出来的时候
 * 牌已经躺在新主人手上了，那时再回头找来源只能靠猜。
 *
 * 记录随牌局状态走（可序列化、能重连），牌一离开手牌就清掉，不会越积越多。
 */

export interface GainEntry {
  /** 这张牌是从谁的区域来的。牌堆、弃牌堆、处理区来的是 null。 */
  fromId: PlayerId | null
  /** 进入手牌时的事件序号。 */
  seq: number
}

export function recordGainEntry(
  state: SanguoshaState,
  cardId: CardId,
  fromOwnerId: PlayerId | null,
  toOwnerId: PlayerId,
): void {
  state.gainProvenance ??= {}
  /*
   * 自己区域内部的挪动（装备装上、手牌回到手上）不算「从别人那里获得」，
   * 记成 null 而不是自己——否则「获得其他角色的牌」会把自己也算进去。
   */
  const fromId = fromOwnerId && fromOwnerId !== toOwnerId ? fromOwnerId : null
  state.gainProvenance[cardId] = { fromId, seq: state.seq }
}

/** 牌离开手牌时清掉记录，免得下次再摸到它时顶着上一次的来源。 */
export function clearGainEntry(state: SanguoshaState, cardId: CardId): void {
  if (state.gainProvenance) delete state.gainProvenance[cardId]
}

export function gainEntryOf(state: SanguoshaState, cardId: CardId): GainEntry | null {
  return state.gainProvenance?.[cardId] ?? null
}

/**
 * 这一批牌里，每名**其他角色**贡献了几张。
 *
 * 只统计仍然在 `ownerId` 手上的牌：发问和结算之间可能有别的效果
 * 把牌又拿走了，那张牌不该再算作「他获得的」。
 */
export function gainOriginCounts(
  state: SanguoshaState,
  ownerId: PlayerId,
  cardIds: readonly CardId[],
): Map<PlayerId, number> {
  const owner = state.players.find((candidate) => candidate.id === ownerId)
  const counts = new Map<PlayerId, number>()
  if (!owner) return counts
  const hand = new Set(owner.zones.hand)
  for (const cardId of cardIds) {
    if (!hand.has(cardId)) continue
    const fromId = state.gainProvenance?.[cardId]?.fromId
    if (!fromId || fromId === ownerId) continue
    counts.set(fromId, (counts.get(fromId) ?? 0) + 1)
  }
  return counts
}
