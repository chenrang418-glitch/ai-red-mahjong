import type { CardId, SanguoshaState } from './types'
import { notifyHandCardLeft } from './zones'

export function isSpecialEquipment(state: SanguoshaState, cardId: CardId): boolean {
  return Boolean(state.cards[cardId]?.specialEquipment)
}

/** 特殊装备不是牌堆牌，离开装备区后从所有区域和卡表一并移除。 */
export function destroySpecialEquipment(state: SanguoshaState, cardId: CardId): boolean {
  if (!isSpecialEquipment(state, cardId)) return false
  const name = state.cards[cardId]?.specialEquipment
  if (name) {
    state.specialEquipmentRemoval ??= {}
    state.specialEquipmentRemoval[cardId] = name
    const rank = state.cards[cardId]?.rank
    if (rank !== undefined) {
      state.specialEquipmentRemovalRank ??= {}
      state.specialEquipmentRemovalRank[cardId] = rank
    }
  }
  state.zones.drawPile = state.zones.drawPile.filter((id) => id !== cardId)
  state.zones.discardPile = state.zones.discardPile.filter((id) => id !== cardId)
  state.zones.processingArea = state.zones.processingArea.filter((id) => id !== cardId)
  for (const player of state.players) {
    if (player.zones.hand.includes(cardId)) notifyHandCardLeft(state, { cardId, playerId: player.id, destination: null })
    player.zones.hand = player.zones.hand.filter((id) => id !== cardId)
    for (const slot of Object.keys(player.zones.equipment) as Array<keyof typeof player.zones.equipment>) {
      if (player.zones.equipment[slot] === cardId) player.zones.equipment[slot] = null
    }
  }
  delete state.cards[cardId]
  return true
}
