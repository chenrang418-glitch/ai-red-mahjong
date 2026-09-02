import type { LegalAction } from '../engine/actions'

type UseCardAction = Extract<LegalAction, { kind: 'use-card' }>

/** 只有引擎明确标记为固定全体目标，且用途唯一时，界面才可直接使用。 */
export function fixedTargetAction(
  actions: readonly LegalAction[],
  cardId: string,
  asCardName?: string,
): UseCardAction | null {
  const matches = actions.filter((action): action is UseCardAction => action.kind === 'use-card'
    && action.cardIds.includes(cardId)
    && (!asCardName || action.asCardName === asCardName))
  if (!asCardName && new Set(matches.map((action) => action.asCardName)).size !== 1) return null
  return matches.length === 1 && matches[0].targetMode === 'fixed' ? matches[0] : null
}
