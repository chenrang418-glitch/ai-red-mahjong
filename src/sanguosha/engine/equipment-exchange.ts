import { isCharacterEquipment } from './character-equipment'
import { handleEquipmentLost, type EquipmentHost } from './equipment'
import { equipmentSlotsOf } from './equipment-slots'
import { dispatchEquipmentZoneLoss } from './equipment-zone-loss'
import { moveCard } from './zones'
import type { CardId, EquipmentSlot, PlayerId } from './types'

/**
 * 两名角色**整个装备区的原子互换**（吴国太【甘露】）。
 *
 * 四条纪律：
 *
 * 1. **是整体互换，不是按栏位一一对应交换。** 甲的武器不一定换到乙的武器栏，
 *    而是「甲装备区里的所有牌」整批去乙那边，反之亦然。
 * 2. **必须原子完成。** 中途绝不能出现「甲空了、乙还没搬」这种半完成状态：
 *    那一瞬间任何读装备区的技能（攻击范围、距离、防具判断）都会读到错的东西。
 *    做法是先把两边的牌全部收进处理区，再一次性发下去。
 * 3. **事件仍然是真的。** 每张牌照常发 `LoseEquipment`（孙尚香【枭姬】按张数），
 *    每一侧再发一条 `EquipmentZoneLoss`（凌统【旋风】按次数——一次换三件
 *    只给一次机会）。白银狮子的离场回血也在统一入口里。
 * 4. **放不下的牌按规则弃置，不静默消失、不覆盖、不复制。**
 *
 * 跨时代兼容（项目裁定，写在规则文档里）：
 *
 * - **武将牌变的装备**（神典韦【挈挟】）是绑定在拥有者身上的实例，
 *   不参与交换，留在原主装备区。它没有花色点数，也进不了别人的装备区。
 * - **对方装备区放不下的牌**（栏位已废除、或超出该角色的栏位数量）弃置。
 */

export interface EquipmentExchangeResult {
  /** 真正换到对面装备区的牌。 */
  moved: CardId[]
  /** 对面放不下、因此被弃置的牌。 */
  discarded: CardId[]
}

interface HeldCard {
  cardId: CardId
  fromId: PlayerId
  toId: PlayerId
}

/** 这名角色装备区里**能被搬走**的牌（武将牌变的装备不算）。 */
export function movableEquipmentOf(host: EquipmentHost, playerId: PlayerId): Array<{ cardId: CardId; slot: EquipmentSlot }> {
  const player = host.state.players.find((candidate) => candidate.id === playerId)
  if (!player) return []
  const held: Array<{ cardId: CardId; slot: EquipmentSlot }> = []
  for (const [slot, cardId] of Object.entries(player.zones.equipment)) {
    if (!cardId) continue
    if (isCharacterEquipment(host.state, cardId)) continue
    held.push({ cardId, slot: slot as EquipmentSlot })
  }
  return held
}

/** 装备区里现在有几张牌。用于「牌数之差」这类条件判断。 */
export function equipmentCountOf(host: EquipmentHost, playerId: PlayerId): number {
  const player = host.state.players.find((candidate) => candidate.id === playerId)
  if (!player) return 0
  return Object.values(player.zones.equipment).filter(Boolean).length
}

/**
 * 这张牌现在能放进这名角色的哪一栏。放不下就返回 null。
 *
 * `occupied` 是本次交换里已经被占掉的栏位——同一次交换要按顺序占位，
 * 不能两张武器都判定成「武器栏空着」。
 */
function slotFor(
  host: EquipmentHost,
  playerId: PlayerId,
  cardId: CardId,
  occupied: Set<EquipmentSlot>,
): EquipmentSlot | null {
  const card = host.state.cards[cardId]
  const wanted = card?.equipmentSlot
  if (!wanted) return null
  const legal = equipmentSlotsOf(host.state, playerId)
  const candidates: EquipmentSlot[] = wanted === 'weapon'
    // 有额外武器栏的人（神典韦【捐甲】）能收下第二把武器
    ? legal.filter((slot) => slot === 'weapon' || slot === 'weapon2')
    : legal.filter((slot) => slot === wanted)
  const player = host.state.players.find((candidate) => candidate.id === playerId)
  for (const slot of candidates) {
    if (occupied.has(slot)) continue
    if (player?.zones.equipment[slot]) continue
    return slot
  }
  return null
}

export function exchangeEquipmentZones(
  host: EquipmentHost,
  leftId: PlayerId,
  rightId: PlayerId,
): EquipmentExchangeResult {
  if (leftId === rightId) return { moved: [], discarded: [] }
  const left = host.state.players.find((candidate) => candidate.id === leftId)
  const right = host.state.players.find((candidate) => candidate.id === rightId)
  if (!left || !right) return { moved: [], discarded: [] }

  const leftCards = movableEquipmentOf(host, leftId)
  const rightCards = movableEquipmentOf(host, rightId)
  if (leftCards.length === 0 && rightCards.length === 0) return { moved: [], discarded: [] }

  /*
   * 第一步：两边的牌**全部**收进处理区。
   *
   * 收完之后两个装备区都是空的，这是这次交换唯一的中间状态，
   * 而且它是自洽的——没有「一张牌同时属于两个人」的瞬间。
   */
  const held: HeldCard[] = []
  for (const { cardId, slot } of leftCards) {
    moveCard(host.state, cardId, { kind: 'equipment', playerId: leftId, slot }, { kind: 'processingArea' })
    held.push({ cardId, fromId: leftId, toId: rightId })
  }
  for (const { cardId, slot } of rightCards) {
    moveCard(host.state, cardId, { kind: 'equipment', playerId: rightId, slot }, { kind: 'processingArea' })
    held.push({ cardId, fromId: rightId, toId: leftId })
  }

  // 第二步：按目标角色逐一放下去，放不下的弃置
  const moved: CardId[] = []
  const discarded: CardId[] = []
  const occupied = new Map<PlayerId, Set<EquipmentSlot>>([[leftId, new Set()], [rightId, new Set()]])
  for (const entry of held) {
    const slot = slotFor(host, entry.toId, entry.cardId, occupied.get(entry.toId)!)
    if (slot) {
      occupied.get(entry.toId)!.add(slot)
      moveCard(host.state, entry.cardId, { kind: 'processingArea' }, { kind: 'equipment', playerId: entry.toId, slot })
      moved.push(entry.cardId)
      continue
    }
    /*
     * 放不下（栏位被废除、或超出栏位数量）：按统一规则弃置。
     * **不能留在处理区**——那是结算中的暂存区，留在那里的牌没有归属。
     */
    moveCard(host.state, entry.cardId, { kind: 'processingArea' }, { kind: 'discardPile' }, { discardReason: 'other' })
    discarded.push(entry.cardId)
  }

  /*
   * 第三步：补事件。
   *
   * 放在**牌全部落位之后**：装备离场会触发技能（枭姬摸牌、旋风弃牌、
   * 白银狮子回血），那些技能读到的必须是交换**完成后**的场面，
   * 而不是搬到一半的样子。
   */
  host.dispatch('CardMove', {
    cardIds: held.map((entry) => entry.cardId),
    reason: 'equipment-exchange',
    revealed: true,
  }, { cardIds: held.map((entry) => entry.cardId) })
  for (const [playerId, cards] of [[leftId, leftCards], [rightId, rightCards]] as const) {
    const cardIds = cards.map((entry) => entry.cardId)
    if (cardIds.length === 0) continue
    for (const cardId of cardIds) handleEquipmentLost(host, playerId, cardId, { batched: true })
    dispatchEquipmentZoneLoss(host, playerId, cardIds)
  }
  return { moved, discarded }
}
