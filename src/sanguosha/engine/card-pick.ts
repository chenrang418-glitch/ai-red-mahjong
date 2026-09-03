import { hiddenHandSlot } from './cards/host'
import { handleEquipmentLost, type EquipmentHost } from './equipment'
import type { CardId, PlayerId, SanguoshaState } from './types'
import { locateOwnedCard, moveCard, type ZoneRef } from './zones'

/**
 * 「从另一名角色的区域里挑一张牌」的公共入口。
 *
 * 顺手牵羊、过河拆桥、庞德【猛进】、祝融【烈刃】做的都是同一件事：
 * 装备区是公开的可以直接列出来，**手牌是暗的，只能给占位槽**——
 * 挑的人不许先看见点数花色再决定拿哪张。这条隐私纪律必须只有一份实现，
 * 各技能自己拼一遍迟早会漏掉某一处。
 *
 * 判定区的牌不在候选里：现有的「获得/弃置一张牌」类技能都不涉及判定区，
 * 需要时应当在这里显式加一个开关，而不是让某个技能自己去读 judgingArea。
 */

export interface PickableCards {
  /** 公开可选的牌（装备区）。 */
  cardIds: CardId[]
  /** 手牌的占位槽，数量等于手牌数，不泄露具体是哪几张。 */
  hiddenCardSlots: string[]
}

/** 某名角色现在有哪些牌可以被别人挑走。 */
export function pickableCardsOf(state: SanguoshaState, targetId: PlayerId): PickableCards {
  const target = state.players.find((candidate) => candidate.id === targetId)
  if (!target?.alive) return { cardIds: [], hiddenCardSlots: [] }
  return {
    cardIds: Object.values(target.zones.equipment).filter((cardId): cardId is CardId => Boolean(cardId)),
    hiddenCardSlots: target.zones.hand.map((_, index) => hiddenHandSlot(targetId, index)),
  }
}

/** 现在还有没有牌可挑。没有就不该发出一个空请求。 */
export function hasPickableCards(state: SanguoshaState, targetId: PlayerId): boolean {
  const pickable = pickableCardsOf(state, targetId)
  return pickable.cardIds.length + pickable.hiddenCardSlots.length > 0
}

/**
 * 把玩家选中的那一项还原成真实 CardId。
 *
 * 选的是占位槽就按**当前**手牌顺序取——发问期间对方的手牌可能已经变了，
 * 所以这里必须现算，不能用发问时快照下来的列表。
 */
export function resolvePickedCard(state: SanguoshaState, targetId: PlayerId, picked: string): CardId | null {
  const target = state.players.find((candidate) => candidate.id === targetId)
  if (!target?.alive) return null
  const hiddenIndex = target.zones.hand.findIndex((_, index) => hiddenHandSlot(targetId, index) === picked)
  const cardId = hiddenIndex >= 0 ? target.zones.hand[hiddenIndex] : picked
  return locateOwnedCard(state, targetId, cardId) ? cardId : null
}

/**
 * 把挑中的牌搬到目的地，并补上「失去装备」的收尾。
 *
 * 装备离场必须走 `handleEquipmentLost`，**不能只发一条 `LoseEquipment` 事件**：
 * 枭姬确实挂在那个事件上，但白银狮子的「失去时回复一点体力」写在
 * `handleEquipmentLost` 里面，只发事件会把它静默跳过。
 * 庞德【猛进】原来就是只发事件，拆掉别人的白银狮子时对方不回血——
 * 抽出这个公共入口的时候一并修掉了。
 */
export function movePickedCard(
  host: EquipmentHost,
  targetId: PlayerId,
  cardId: CardId,
  to: ZoneRef,
): boolean {
  const from = locateOwnedCard(host.state, targetId, cardId)
  if (!from) return false
  moveCard(host.state, cardId, from, to)
  if (from.kind === 'equipment') handleEquipmentLost(host, targetId, cardId)
  return true
}
