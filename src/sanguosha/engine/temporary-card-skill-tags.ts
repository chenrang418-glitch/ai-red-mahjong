import type { CardId, SanguoshaState } from './types'

/** Attach skill-scoped metadata to a card for one resolution without mutating its printed definition. */
export function setTemporaryCardSkillTag(state: SanguoshaState, cardId: CardId, skillId: string): void {
  state.temporaryCardSkillTags ??= {}
  state.temporaryCardSkillTags[cardId] = skillId
}

export function hasTemporaryCardSkillTag(state: SanguoshaState, cardId: CardId, skillId: string): boolean {
  return state.temporaryCardSkillTags?.[cardId] === skillId
}

export function clearTemporaryCardSkillTag(state: SanguoshaState, cardId: CardId): void {
  if (!state.temporaryCardSkillTags) return
  delete state.temporaryCardSkillTags[cardId]
  if (Object.keys(state.temporaryCardSkillTags).length === 0) delete state.temporaryCardSkillTags
}
