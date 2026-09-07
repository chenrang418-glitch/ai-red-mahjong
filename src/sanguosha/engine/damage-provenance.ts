import { DELAYED_TRICKS, INSTANT_TRICKS } from './cards/tricks'
import { effectiveCardName } from './zones'
import type { CardCategory, CardId, PlayerId, SanguoshaState } from './types'

/**
 * 这次伤害**是哪一类牌造成的**。
 *
 * 徐庶【无言】防止的是「锦囊牌造成的伤害」，不是「某个人造成的伤害」：
 * 同一个人打出的【杀】照常打进来，他用的【决斗】却一点都造不成。
 * 所以判断必须落在**这次伤害挂在哪张牌上**，不能看伤害来源角色。
 *
 * 三条判断顺序，缺一不可：
 *
 * 1. **有实体牌就按实体牌的有效牌名算。** 转化技把一张【闪】当【决斗】用时，
 *    造成伤害的是【决斗】——只看印刷牌名会把它当成基本牌放过去。
 * 2. **没有实体牌就按牌名算。** 技能凭空生成的虚拟锦囊、判定区的【闪电】
 *    在结算时都只带着一个牌名。
 * 3. **两样都没有就不属于任何牌。** 技能直接造成的伤害不归属于任何一张牌，
 *    既不是基本牌也不是锦囊牌——**不能默认成锦囊**，否则一切技能伤害
 *    都会被无言吃掉，那是完全不同的一个技能。
 */

/** 牌名 → 类别。牌名不认识时返回 null，调用方按「不属于任何类别」处理。 */
export function cardCategoryOfName(name: string | null | undefined): CardCategory | null {
  if (!name) return null
  if (INSTANT_TRICKS.has(name) || DELAYED_TRICKS.has(name)) return 'trick'
  if (BASIC_NAMES.has(name)) return 'basic'
  return null
}

/**
 * 基本牌的牌名。
 *
 * 写成清单而不是「不是锦囊就是基本牌」：装备牌、以及以后新增的牌类
 * 都不该被算成基本牌。徐庶【举荐】要弃一张**非基本牌**，
 * 判错一次就等于允许他拿【桃】当代价。
 */
const BASIC_NAMES = new Set(['杀', '闪', '桃', '酒'])

export interface DamageCardContext {
  cardId?: CardId | null
  cardName?: string | null
}

/**
 * 这次伤害归属于哪一类牌。不属于任何牌时返回 null。
 *
 * `state` 用来读实体牌的**有效牌名**（转化之后的），所以转化出来的锦囊
 * 按锦囊算，这和求闪、无懈、毅重读的是同一个口径。
 */
export function damageCardCategory(state: SanguoshaState, context: DamageCardContext): CardCategory | null {
  const cardId = context.cardId ?? null
  if (cardId && state.cards[cardId]) {
    const name = effectiveCardName(state, cardId)
    const byName = cardCategoryOfName(name)
    // 牌名认不出来时退回牌本身印的类别（自定义牌、扩展牌）
    return byName ?? state.cards[cardId].category ?? null
  }
  return cardCategoryOfName(context.cardName)
}

/** 这次伤害是锦囊牌造成的吗。 */
export function damageIsFromTrick(state: SanguoshaState, context: DamageCardContext): boolean {
  return damageCardCategory(state, context) === 'trick'
}

/** 这张牌是不是基本牌。用于「弃置一张非基本牌」这类代价判断。 */
export function isBasicCard(state: SanguoshaState, cardId: CardId): boolean {
  const card = state.cards[cardId]
  if (!card) return false
  const byName = cardCategoryOfName(effectiveCardName(state, cardId))
  return (byName ?? card.category) === 'basic'
}

/** 这名角色区域里可以当作「非基本牌」代价的牌：手牌 + 装备区。 */
export function nonBasicCardsOf(state: SanguoshaState, playerId: PlayerId): CardId[] {
  const player = state.players.find((candidate) => candidate.id === playerId)
  if (!player) return []
  const equipped = Object.values(player.zones.equipment).filter((cardId): cardId is CardId => !!cardId)
  /*
   * **判定区不算**：那些牌不是「他的牌」，是挂在他身上的效果，
   * 不能作为主动技能的代价（规则文档里锁定的口径）。
   */
  return [...player.zones.hand, ...equipped].filter((cardId) => !isBasicCard(state, cardId))
}
