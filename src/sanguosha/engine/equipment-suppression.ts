import type { PlayerId, SanguoshaState } from './types'

/** Equipment remains in its zone but contributes no rules effects until the target's next turn ends. */
export function suppressEquipmentEffectsUntilTurnEnd(state: SanguoshaState, playerId: PlayerId, armedAtTurn: number, drawReduction = 0): void {
  state.equipmentEffectSuppressions ??= []
  state.equipmentEffectSuppressions.push({ playerId, armedAtTurn, ...(drawReduction > 0 ? { drawReductionPending: drawReduction } : {}) })
}

export function consumeEquipmentDrawReduction(state: SanguoshaState, playerId: PlayerId): number {
  let reduction = 0
  for (const entry of state.equipmentEffectSuppressions ?? []) {
    if (entry.playerId !== playerId || !entry.drawReductionPending) continue
    reduction += entry.drawReductionPending
    entry.drawReductionPending = 0
  }
  return reduction
}

export function equipmentEffectsSuppressed(state: SanguoshaState, playerId: PlayerId): boolean {
  return (state.equipmentEffectSuppressions ?? []).some((entry) => entry.playerId === playerId)
}

/** Called after TurnEnd triggers, so the protection still applies during that entire end window. */
export function expireEquipmentEffectSuppression(state: SanguoshaState, playerId: PlayerId, turnNumber: number): void {
  if (!state.equipmentEffectSuppressions) return
  state.equipmentEffectSuppressions = state.equipmentEffectSuppressions.filter((entry) =>
    entry.playerId !== playerId || turnNumber <= entry.armedAtTurn)
}
