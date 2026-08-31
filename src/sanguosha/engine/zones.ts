import type { CardId, EquipmentSlot, PlayerId, SanguoshaState } from './types'

export type ZoneRef =
  | { kind: 'drawPile' }
  | { kind: 'discardPile' }
  | { kind: 'processingArea' }
  | { kind: 'hand'; playerId: PlayerId }
  | { kind: 'judgingArea'; playerId: PlayerId }
  | { kind: 'equipment'; playerId: PlayerId; slot: EquipmentSlot }

function player(state: SanguoshaState, playerId: PlayerId) {
  const found = state.players.find((candidate) => candidate.id === playerId)
  if (!found) throw new Error(`玩家不存在：${playerId}`)
  return found
}

export function zoneCards(state: SanguoshaState, zone: ZoneRef): CardId[] {
  switch (zone.kind) {
    case 'drawPile': return state.zones.drawPile
    case 'discardPile': return state.zones.discardPile
    case 'processingArea': return state.zones.processingArea
    case 'hand': return player(state, zone.playerId).zones.hand
    case 'judgingArea': return player(state, zone.playerId).zones.judgingArea
    case 'equipment': {
      const id = player(state, zone.playerId).zones.equipment[zone.slot]
      return id ? [id] : []
    }
  }
}

function removeCard(state: SanguoshaState, zone: ZoneRef, cardId: CardId): void {
  if (zone.kind === 'equipment') {
    const equipment = player(state, zone.playerId).zones.equipment
    if (equipment[zone.slot] !== cardId) throw new Error('卡牌不在指定装备槽')
    equipment[zone.slot] = null
    return
  }
  const cards = zoneCards(state, zone)
  const index = cards.indexOf(cardId)
  if (index < 0) throw new Error('卡牌不在来源区域')
  cards.splice(index, 1)
}

function addCard(state: SanguoshaState, zone: ZoneRef, cardId: CardId, toTop: boolean): CardId | null {
  if (zone.kind === 'equipment') {
    const equipment = player(state, zone.playerId).zones.equipment
    const replaced = equipment[zone.slot]
    equipment[zone.slot] = cardId
    return replaced
  }
  const cards = zoneCards(state, zone)
  if (zone.kind === 'drawPile' && toTop) cards.unshift(cardId)
  else cards.push(cardId)
  return null
}

export interface MoveCardOptions {
  toTop?: boolean
  replaceEquipmentTo?: ZoneRef
}

/** 单一卡牌移动真相入口；装备替换默认把旧装备移入弃牌堆。 */
export function moveCard(state: SanguoshaState, cardId: CardId, from: ZoneRef, to: ZoneRef, options: MoveCardOptions = {}): void {
  if (!state.cards[cardId]) throw new Error(`未知卡牌：${cardId}`)
  removeCard(state, from, cardId)
  const replaced = addCard(state, to, cardId, options.toTop ?? false)
  if (replaced) addCard(state, options.replaceEquipmentTo ?? { kind: 'discardPile' }, replaced, false)
}

export function allLocatedCardIds(state: SanguoshaState): CardId[] {
  const ids = [...state.zones.drawPile, ...state.zones.discardPile, ...state.zones.processingArea]
  for (const candidate of state.players) {
    ids.push(...candidate.zones.hand, ...candidate.zones.judgingArea)
    ids.push(...Object.values(candidate.zones.equipment).filter((id): id is CardId => Boolean(id)))
  }
  return ids
}

export function assertCardConservation(state: SanguoshaState): void {
  const located = allLocatedCardIds(state)
  const unique = new Set(located)
  if (unique.size !== located.length) throw new Error('同一张牌同时出现在多个区域')
  const known = Object.keys(state.cards)
  if (unique.size !== known.length || known.some((id) => !unique.has(id))) throw new Error('牌张不守恒：存在丢失或未知位置的牌')
}
