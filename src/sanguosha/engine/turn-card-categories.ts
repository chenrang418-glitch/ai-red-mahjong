import type { CardCategory, CardId, PlayerId, SanguoshaState } from './types'

export interface TurnCardCategoryHistory {
  turnNumber: number
  entries: Array<{ cardId: CardId | null; category: CardCategory; kind: 'used' | 'responded' | 'discarded' }>
}

export function turnCardCategoriesOf(state: SanguoshaState, playerId: PlayerId): readonly CardCategory[] {
  const history = state.turnCardCategories?.[playerId]
  return history?.turnNumber === state.turnNumber ? [...new Set(history.entries.map((entry) => entry.category))] : []
}

export function hasTurnCardCategory(state: SanguoshaState, playerId: PlayerId, category: CardCategory): boolean {
  return turnCardCategoriesOf(state, playerId).includes(category)
}

export function recordTurnCardCategory(state: SanguoshaState, playerId: PlayerId, category: CardCategory, kind: TurnCardCategoryHistory['entries'][number]['kind'], cardId: CardId | null): void {
  state.turnCardCategories ??= {}
  let history = state.turnCardCategories[playerId]
  if (!history || history.turnNumber !== state.turnNumber) {
    history = { turnNumber: state.turnNumber, entries: [] }
    state.turnCardCategories[playerId] = history
  }
  if (history.entries.some((entry) => entry.kind === kind && entry.cardId === cardId && entry.category === category)) return
  history.entries.push({ cardId, category, kind })
}

export function forgetTurnDiscardedCard(state: SanguoshaState, playerId: PlayerId, cardId: CardId): void {
  const history = state.turnCardCategories?.[playerId]
  if (history?.turnNumber === state.turnNumber) history.entries = history.entries.filter((entry) => !(entry.kind === 'discarded' && entry.cardId === cardId))
}
