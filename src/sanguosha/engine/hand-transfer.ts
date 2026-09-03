import type { EventContext, GameEvent, GameEventName } from './events'
import type { CardId, PlayerId, SanguoshaState } from './types'
import { moveCard } from './zones'

/**
 * 手牌在角色之间的转移。
 *
 * 「交给」和「弃置」是两件完全不同的事，**牌绝不能路过弃牌堆**：
 * 走一趟弃牌堆会触发一批本不该触发的弃牌时机（枭姬、连营……），
 * 牌的来源语义也丢了。所以这里只做 hand → hand 的直接移动。
 *
 * 抽出来之前刘备【仁德】里内联了一份，鲁肃【好施】要用同一套；
 * 【缔盟】的「交换手牌」更是必须原子完成，散着写迟早写错。
 */

export interface HandTransferHost {
  state: SanguoshaState
  dispatch(
    name: GameEventName,
    payload?: Record<string, unknown>,
    metadata?: Omit<GameEvent, 'id' | 'seq' | 'name' | 'payload'>,
  ): EventContext
}

function playerOf(state: SanguoshaState, playerId: PlayerId) {
  return state.players.find((candidate) => candidate.id === playerId)
}

/**
 * 把若干张手牌交给另一名角色。
 *
 * 服务端**逐张确认牌确实还在给出者手上**，不信客户端提交的列表：
 * 发问和结算之间牌可能已经被别的技能拿走了。重复的 cardId 只算一次，
 * 否则同一张牌会被移动两次，牌张守恒当场崩掉。
 *
 * 返回真正给出去的牌。一张都没给成时不发事件——空的 GainCard 会让战报多一行废话。
 */
export function giveCards(
  host: HandTransferHost,
  fromId: PlayerId,
  toId: PlayerId,
  cardIds: readonly CardId[],
  reason: string,
): CardId[] {
  const from = playerOf(host.state, fromId)
  const to = playerOf(host.state, toId)
  if (!from || !to?.alive || fromId === toId) return []

  const given: CardId[] = []
  const seen = new Set<CardId>()
  for (const cardId of cardIds) {
    if (seen.has(cardId)) continue
    seen.add(cardId)
    // 只认手牌：装备区和判定区的牌不能被「交给」别人
    if (!from.zones.hand.includes(cardId)) continue
    moveCard(host.state, cardId, { kind: 'hand', playerId: fromId }, { kind: 'hand', playerId: toId })
    given.push(cardId)
  }
  if (given.length === 0) return []

  host.dispatch('LoseCard', { playerId: fromId, cardIds: given, reason }, { sourceId: fromId, cardIds: given })
  host.dispatch('GainCard', { playerId: toId, cardIds: given, reason }, { targetId: toId, cardIds: given })
  return given
}

/**
 * 两名角色交换全部手牌。
 *
 * **必须先把两边都快照下来再搬**。天真的写法是
 * 「A 的手牌给 B，然后 B 的手牌给 A」——第一步之后 B 手上已经包含了 A 的牌，
 * 第二步就把两个人的牌一股脑全塞回 A，结果是 A 拿走所有牌、B 空手。
 *
 * 交换**不是弃牌也不是摸牌**：两边都不该触发弃牌/摸牌类时机，
 * 所以只发一条 `HandSwap`，不发 LoseCard / GainCard。
 * 需要知道「手牌数变了」的技能读的是 handCount，本来就看得到。
 */
export function swapHands(
  host: HandTransferHost,
  leftId: PlayerId,
  rightId: PlayerId,
  reason: string,
): void {
  const left = playerOf(host.state, leftId)
  const right = playerOf(host.state, rightId)
  if (!left || !right || leftId === rightId) return

  const leftCards = [...left.zones.hand]
  const rightCards = [...right.zones.hand]
  // 直接换数组：牌没有离开过「某个人的手牌区」，中间不存在任何一张牌无主的瞬间
  left.zones.hand = rightCards
  right.zones.hand = leftCards
  // moveCard 进手牌时会顺手清掉「当作什么用」，这里绕开了它，所以要自己补上——
  // 留着别名的话，这张牌到了新主人手上还顶着上一次的身份
  for (const cardId of [...leftCards, ...rightCards]) delete host.state.cardAliases[cardId]

  host.dispatch('HandSwap', {
    leftId, rightId, reason,
    leftCount: right.zones.hand.length,
    rightCount: left.zones.hand.length,
  }, { sourceId: leftId, targetId: rightId })
}
