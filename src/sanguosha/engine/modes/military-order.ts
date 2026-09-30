import { isLockedSkill } from '../locked-skills'
import type { CardId, MilitaryOrderEffectKind, PlayerId, SanguoshaState } from '../types'

export const MILITARY_ORDER_IDS = [
  'silence', 'lose-hp', 'draw-give', 'deal-damage', 'turn-over', 'keep-one-each',
] as const
export type MilitaryOrderId = typeof MILITARY_ORDER_IDS[number]

export function addMilitaryOrderEffect(
  state: SanguoshaState,
  effect: { targetId: PlayerId; sourceId: PlayerId; kind: MilitaryOrderEffectKind },
): void {
  const target = state.players.find((player) => player.id === effect.targetId)
  if (!target?.alive) return
  const effects = state.militaryOrderEffects ??= []
  if (effects.some((entry) => entry.targetId === effect.targetId && entry.turnNumber === state.turnNumber && entry.kind === effect.kind)) return
  effects.push({ ...effect, turnNumber: state.turnNumber })
  if (effect.kind === 'non-locked-skills-and-hand-cards') target.marks['军令封技'] = 1
  if (effect.kind === 'recovery') target.marks['军令禁回'] = 1
}

export function hasMilitaryOrderEffect(state: SanguoshaState, targetId: PlayerId, kind: MilitaryOrderEffectKind): boolean {
  return (state.militaryOrderEffects ?? []).some((effect) => effect.targetId === targetId
    && effect.kind === kind && effect.turnNumber === state.turnNumber)
}

export function blocksMilitaryOrderHandCard(state: SanguoshaState, playerId: PlayerId, cardId: CardId): boolean {
  const player = state.players.find((candidate) => candidate.id === playerId)
  return hasMilitaryOrderEffect(state, playerId, 'non-locked-skills-and-hand-cards')
    && Boolean(player?.zones.hand.includes(cardId))
}

export function suppressesMilitaryOrderSkills(state: SanguoshaState, playerId: PlayerId): boolean {
  return hasMilitaryOrderEffect(state, playerId, 'non-locked-skills-and-hand-cards')
}

export function expireMilitaryOrderEffects(state: SanguoshaState): void {
  const previous = state.militaryOrderEffects ?? []
  state.militaryOrderEffects = previous.filter((effect) => effect.turnNumber >= state.turnNumber)
  for (const player of state.players) {
    if (!state.militaryOrderEffects.some((effect) => effect.targetId === player.id && effect.kind === 'non-locked-skills-and-hand-cards'))
      delete player.marks['军令封技']
    if (!state.militaryOrderEffects.some((effect) => effect.targetId === player.id && effect.kind === 'recovery'))
      delete player.marks['军令禁回']
  }
  if (!state.militaryOrderEffects.length) delete state.militaryOrderEffects
}

/** 执行军令①后，技能即刻按锁定/非锁定属性重新求值。 */
export function retainOnlyLockedSkills(skillIds: readonly string[], state?: SanguoshaState, playerId?: PlayerId): string[] {
  return skillIds.filter((skillId) => isLockedSkill(skillId, state, playerId))
}
