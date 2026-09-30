import type { PlayerId, SanguoshaState, Suit } from './types'

/**
 * 延时锦囊的判定是否「命中」——也就是这张牌是否真的产生了效果。
 *
 * 结算（`judgment.ts`）和表现层（`presentation.ts`）都要这个判断：
 * 前者用来决定跳阶段还是造成伤害，后者用来决定要不要播这张牌的音效
 * （牌放进判定区时不播，只有判定真正生效才播）。
 *
 * 抽出来是因为两边各写一份必然会漂移：闪电的点数区间改了一处忘了另一处，
 * 就会出现「明明劈中了却没有音效」这种对不上的表现。
 */
export function delayedTrickHits(name: string, suit: Suit, rank: number): boolean {
  if (name === '乐不思蜀') return suit !== 'heart'
  if (name === '兵粮寸断') return suit !== 'club'
  if (name === '闪电') return suit === 'spade' && rank >= 2 && rank <= 9
  return false
}

/**
 * 某些技能会在本局为特定角色扩展延时锦囊的判定命中组合。
 * 这份角色限定修正规则同时供真实结算与公开结果提示调用。
 */
export function delayedTrickHitsForPlayer(state: SanguoshaState, playerId: PlayerId, name: string, suit: Suit, rank: number): boolean {
  if (delayedTrickHits(name, suit, rank)) return true
  const rules = state as SanguoshaState & {
    additionalDelayedTrickHitFaces?: Partial<Record<PlayerId, Partial<Record<string, Array<{ suit: Suit; rank: number }>>>>>
  }
  return rules.additionalDelayedTrickHitFaces?.[playerId]?.[name]
    ?.some((face) => face.suit === suit && face.rank === rank) ?? false
}
