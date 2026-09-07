import { handleEquipmentLost, type EquipmentHost } from './equipment'
import { dispatchEquipmentZoneLoss } from './equipment-zone-loss'
import { moveCard } from './zones'
import type { CardId, EquipmentSlot, PlayerId } from './types'

/**
 * 「弃置一名角色的所有牌」的公共入口。
 *
 * 马谡【挥泪】要弃光杀死他的人；身份局「主公杀死忠臣」的惩罚是同一件事。
 * 两处必须共用一个实现，否则「所有的牌」在项目里会有两个不同的含义。
 *
 * 三条纪律：
 *
 * 1. **必须是真的弃牌**，不是把区清空。
 *    `owner.zones.hand = []` 这种写法会让牌凭空消失，牌张守恒当场崩掉；
 *    就算把牌塞进弃牌堆，跳过统一入口也意味着枭姬、旋风、落英、白银狮子
 *    这一批「因弃置而触发」的效果全部被静默跳过。
 * 2. **范围是手牌 + 装备区，不含判定区**（规则文档里锁定的口径）。
 *    判定区里的延时锦囊不是「他的牌」，是挂在他身上的效果。
 * 3. **装备走统一的离场处理**：白银狮子的回血、枭姬的摸牌都在那里面。
 *    成批弃置时每张都发一条 `LoseEquipment`（枭姬按张数），
 *    但「失去装备区里的牌」这件事**整体只算一次**（旋风按次数）。
 *
 * 返回真正被弃掉的牌。一张都没有时不发事件——空的战报行只是噪音。
 */
export function discardAllCards(
  host: EquipmentHost,
  playerId: PlayerId,
  reason: string,
): CardId[] {
  const owner = host.state.players.find((candidate) => candidate.id === playerId)
  if (!owner) return []

  const discarded: CardId[] = []
  for (const cardId of [...owner.zones.hand]) {
    moveCard(host.state, cardId, { kind: 'hand', playerId }, { kind: 'discardPile' }, { discardReason: 'discard' })
    discarded.push(cardId)
  }

  const equipmentLost: CardId[] = []
  /*
   * 遍历装备区里**实际存在的牌**，不是写死的四个栏位：
   * 额外武器栏（神典韦【捐甲】）里的那张牌不能是隐形的。
   */
  for (const [slot, cardId] of Object.entries(owner.zones.equipment)) {
    if (!cardId) continue
    moveCard(host.state, cardId, { kind: 'equipment', playerId, slot: slot as EquipmentSlot }, { kind: 'discardPile' }, { discardReason: 'discard' })
    equipmentLost.push(cardId)
    discarded.push(cardId)
  }
  /*
   * 先把牌全部搬完，再逐张跑装备离场。
   *
   * 边搬边跑的话，离场处理里触发的技能会看到一个「弃了一半」的装备区，
   * 而且它可能又动了别的装备，循环读到的槽位就对不上了。
   */
  for (const cardId of equipmentLost) handleEquipmentLost(host, playerId, cardId, { batched: true })
  dispatchEquipmentZoneLoss(host, playerId, equipmentLost)

  if (discarded.length === 0) return []
  host.dispatch('LoseCard', { playerId, cardIds: discarded, reason }, { targetId: playerId, cardIds: discarded })
  return discarded
}
