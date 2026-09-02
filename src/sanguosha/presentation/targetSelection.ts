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

/**
 * 选中一张牌时应当**预先选中**哪些目标。
 *
 * 全体锦囊（南蛮入侵、万箭齐发、桃园结义、五谷丰登）的目标由引擎定死，选中就整套
 * 标红；其余牌返回空数组，由玩家自己在牌桌上点。
 *
 * 这里刻意**不**替玩家把牌用出去。以前 `fixedTargetAction` 一命中就直接发动作，
 * 点一下牌就飞出去，手一抖就是一张牌——用户报的误触正是这个。预选之后仍然要按
 * 「确定」，和普通手牌的操作节奏一致。
 */
export function initialTargetIds(
  actions: readonly LegalAction[],
  cardId: string,
  asCardName?: string,
): string[] {
  return [...(fixedTargetAction(actions, cardId, asCardName)?.targetIds ?? [])]
}
