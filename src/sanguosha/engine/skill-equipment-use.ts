import { handleEquipmentLost } from './equipment'
import { beginPhysicalCard, finishPhysicalCard, type CardEngineHost } from './cards/host'
import { isCardUseProhibited } from './skills/runtime'
import { equipmentSlotsOf } from './equipment-slots'
import type { CardId, EquipmentSlot, PlayerId, SanguoshaState } from './types'
import { effectiveEquipmentName, locateOwnedCard, moveCard } from './zones'

/** Skill-given equipment uses follow the same card-use lifecycle while ignoring the normal Play Phase gate. */
export function equipmentSlotsForSkillUse(state: SanguoshaState, playerId: PlayerId, cardId: CardId): EquipmentSlot[] {
  const card = state.cards[cardId]
  const owner = state.players.find((entry) => entry.id === playerId)
  if (!owner?.alive || card?.category !== 'equipment' || !card.equipmentSlot || !owner.zones.hand.includes(cardId)) return []
  const compatible = equipmentSlotsOf(state, playerId).filter((slot) => card.equipmentSlot === 'weapon'
    ? slot === 'weapon' || slot === 'weapon2'
    : slot === card.equipmentSlot)
  const empty = compatible.filter((slot) => !owner.zones.equipment[slot])
  return empty.length ? [empty[0]] : compatible
}

/** Use a skill-given equipment card immediately, including replacement and card-use triggers. */
export function useEquipmentFromSkill(host: CardEngineHost, playerId: PlayerId, cardId: CardId, slot: EquipmentSlot): boolean {
  const current = equipmentSlotsForSkillUse(host.state, playerId, cardId)
  const card = host.state.cards[cardId]
  const from = locateOwnedCard(host.state, playerId, cardId)
  if (!current.includes(slot) || from?.kind !== 'hand' || !card?.equipmentSlot) return false
  if (isCardUseProhibited(host.state, playerId, effectiveEquipmentName(host.state, cardId), { dyingPlayerId: host.state.dying?.playerId ?? null })) return false
  if (!beginPhysicalCard(host, playerId, cardId, [playerId], effectiveEquipmentName(host.state, cardId), from)) return false
  const replaced = host.state.players.find((entry) => entry.id === playerId)?.zones.equipment[slot]
  moveCard(host.state, cardId, { kind: 'processingArea' }, { kind: 'equipment', playerId, slot })
  if (replaced) handleEquipmentLost(host, playerId, replaced)
  finishPhysicalCard(host, playerId, cardId, [playerId], false, effectiveEquipmentName(host.state, cardId))
  return true
}
