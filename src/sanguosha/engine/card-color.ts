import type { CardId, SanguoshaState } from './types'

/**
 * 多张子牌合成一张牌时，这张牌**算什么颜色**。
 *
 * 荀攸【奇策】把所有手牌当一张锦囊用：子牌全红就是红牌，全黑就是黑牌，
 * 红黑混着就**没有颜色**。这三种结果都要能表达——写成「取第一张子牌的颜色」
 * 是错的，那会让一把混色手牌变成一张有颜色的牌，
 * 而颜色是有规则挂靠的（于禁【毅重】按黑色判、判定按红黑分）。
 *
 * 虚拟牌本身没有花色，所以颜色只能**单独记**。记在牌局状态里
 * （可序列化、能重连），牌销毁时一起清掉。
 */

export type CardColorValue = 'red' | 'black' | null

/**
 * 一组牌合起来算什么颜色。
 *
 * 空数组返回 null——「没有牌」谈不上颜色，
 * 调用方不该把它当成黑色（那是把「无」当成了一种颜色）。
 */
export function aggregateCardColor(state: SanguoshaState, cardIds: readonly CardId[]): CardColorValue {
  let seen: CardColorValue = null
  for (const cardId of cardIds) {
    const card = state.cards[cardId]
    if (!card) continue
    // 虚拟牌、武将牌变的装备没有真实颜色，混进来一样让整体变成无色
    if (card.virtual || card.characterId) return null
    const color = card.color
    if (seen === null) seen = color
    else if (seen !== color) return null
  }
  return seen
}

/** 给一张（通常是虚拟的）牌记下它的有效颜色。`null` 表示无色。 */
export function setCardColorOverride(state: SanguoshaState, cardId: CardId, color: CardColorValue): void {
  state.cardColorOverrides ??= {}
  state.cardColorOverrides[cardId] = color
}

/** 读这张牌的颜色改写。没有记录时返回 `undefined`，调用方照牌面算。 */
export function cardColorOverrideOf(state: SanguoshaState, cardId: CardId): CardColorValue | undefined {
  const overrides = state.cardColorOverrides
  if (!overrides || !(cardId in overrides)) return undefined
  return overrides[cardId]
}

/** 牌销毁或离场时清掉记录，免得下一张同 id 的牌顶着旧颜色。 */
export function clearCardColorOverride(state: SanguoshaState, cardId: CardId): void {
  if (state.cardColorOverrides) delete state.cardColorOverrides[cardId]
}
