import type { CardId, SanguoshaState } from './types'

/**
 * 这次「使用牌」是不是用了一张**实体原生牌**。
 *
 * 神荀彧【灵策】和神太史慈【神著】都要求「非虚拟、非转化」，判断口径必须一致，
 * 所以收在一个地方。三个条件缺一不可：
 *
 * 1. 牌还在（虚拟牌结算完就从牌表里销毁了）；
 * 2. `virtual` 不为真——佐幸印出来的锦囊、丈八蛇矛拼出来的【杀】都是虚拟牌；
 * 3. 印刷名和生效名一致——武圣的红牌、龙胆的杀闪互换、蛊惑声明的牌名，
 *    生效名对得上但印的不是这个，一律不算。
 *
 * 注意**火【杀】、雷【杀】是实体原生的【杀】**：它们印的就是杀，
 * 只是伤害属性不同，不能被这条挡在外面。
 */
export function isPhysicalCardUse(
  state: SanguoshaState,
  cardId: CardId | null | undefined,
  effectiveName: string,
): boolean {
  if (!cardId) return false
  const card = state.cards[cardId]
  if (!card) return false
  if (card.virtual) return false
  return card.name === effectiveName
}
