/** 卡牌插画同样走集中 manifest；未登记时 SgsCard 使用类别纹理与大字 fallback。 */
export const CARD_ART: Readonly<Record<string, string>> = {}

export function cardArt(cardName: string): string | null {
  return CARD_ART[cardName] ?? null
}
