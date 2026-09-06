import type { CardId, PlayerId, SanguoshaState } from './types'

/**
 * 「这张牌当初指定了哪些目标」。
 *
 * 有一类技能的条件是**这张牌只指定了一个目标**（神华佗的虎灵就是），
 * 而结算到伤害那一刻已经查不到这件事了：
 *
 * - 锦囊的 `cardResolution.targetIds` 确实是完整目标表，但牌收掉之后就没了；
 * - 【杀】的结算状态里只有「当前目标」和「还没轮到的目标」。多目标杀结算到
 *   最后一个目标时，剩余表已经空了，看起来和单目标杀一模一样。
 *
 * 所以在使用时机把目标表记下来，用完再弹掉。
 *
 * **必须是栈，不能只存一条。** 使用牌会嵌套：【借刀杀人】会让目标使用一张
 * 【杀】，那张【杀】结算完之后，外层的【借刀杀人】还没结束。只存一条的话
 * 内层结束就把外层的记录抹掉了。
 */

export interface CardUseTargets {
  cardId: CardId
  sourceId: PlayerId
  targetIds: PlayerId[]
}

function stack(state: SanguoshaState): CardUseTargets[] {
  return (state.cardUseTargets ??= [])
}

export function pushCardUseTargets(state: SanguoshaState, entry: CardUseTargets): void {
  stack(state).push({ ...entry, targetIds: [...entry.targetIds] })
}

/**
 * 弹掉一次使用记录。
 *
 * 按 cardId 从**栈顶往下**找而不是无脑 pop：牌局出异常回滚时栈可能没配平，
 * 无脑 pop 会把外层的记录误弹掉。找不到就什么都不做。
 */
export function popCardUseTargets(state: SanguoshaState, cardId: CardId): void {
  const entries = stack(state)
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    if (entries[index].cardId !== cardId) continue
    entries.splice(index, 1)
    return
  }
}

/** 这张牌当前这次使用的目标表。不在结算中就返回 null。 */
export function cardUseTargetsOf(state: SanguoshaState, cardId: CardId | null | undefined): CardUseTargets | null {
  if (!cardId) return null
  const entries = stack(state)
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    if (entries[index].cardId === cardId) return entries[index]
  }
  return null
}

/** 这张牌这次使用是不是只指定了一个目标，而且正好是这个人。 */
export function isSoleTargetOf(
  state: SanguoshaState,
  cardId: CardId | null | undefined,
  targetId: PlayerId,
): boolean {
  const entry = cardUseTargetsOf(state, cardId)
  return !!entry && entry.targetIds.length === 1 && entry.targetIds[0] === targetId
}
