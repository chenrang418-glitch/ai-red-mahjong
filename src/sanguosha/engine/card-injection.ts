import type { GameRng } from './rng'
import type { CardCategory, CardId, PhysicalCard, Rank, SanguoshaState, Suit } from './types'

/**
 * 开局往牌堆里加真实的实体牌。
 *
 * 神荀彧【天佐】要把 8 张【奇正相生】加进本局牌堆。这些**必须是真牌**，
 * 不是技能标记、也不是摸到时临时变出来的：它们要能被摸到、使用、弃置、
 * 洗回牌堆，全程参与牌张守恒。
 *
 * 三条纪律：
 *
 * 1. **只在有对应技能时才加。** 没有神荀彧的一局，牌堆仍然是项目原本那副，
 *    不能把这 8 张写进基础牌表。
 * 2. **洗进牌堆用的是牌局自己的 seeded RNG。** 直接 push 到牌堆末尾会让这
 *    8 张永远最后才摸到；用 `Math.random` 则会让压测不可复现。
 * 3. **id 必须唯一。** 娱乐模式允许同名武将重复出现，两个神荀彧各加 8 张，
 *    id 撞了会直接破坏牌张守恒。id 里带上注入者的座位就不会撞。
 */

export interface InjectedCardSpec {
  name: string
  suit: Suit
  rank: Rank
  category: CardCategory
  expansion?: PhysicalCard['expansion']
}

export interface CardInjectionHost {
  state: SanguoshaState
  rng: GameRng
}

/**
 * 把一批牌洗进牌堆，返回它们的 id。
 *
 * `tag` 用来区分不同的注入来源，会成为 id 的一部分。
 */
export function injectCardsIntoDeck(
  host: CardInjectionHost,
  specs: readonly InjectedCardSpec[],
  tag: string,
): CardId[] {
  const state = host.state
  const created: CardId[] = []
  for (const [index, spec] of specs.entries()) {
    const cardId = `injected:${tag}:${index}`
    if (state.cards[cardId]) throw new Error(`注入牌 id 重复：${cardId}`)
    state.cards[cardId] = {
      id: cardId,
      ruleset: state.rulesetVersion,
      expansion: spec.expansion ?? 'standard',
      name: spec.name,
      suit: spec.suit,
      rank: spec.rank,
      color: spec.suit === 'heart' || spec.suit === 'diamond' ? 'red' : 'black',
      category: spec.category,
    }
    created.push(cardId)
  }
  /*
   * 洗进去而不是堆在末尾。
   *
   * 摸牌是从 `drawPile` 头部取的，直接 push 到末尾意味着这几张要等整副牌
   * 摸完才可能出现——那和「加入牌堆」不是一回事。
   */
  state.zones.drawPile = host.rng.shuffle([...state.zones.drawPile, ...created])
  return created
}

/** 这张牌是不是开局注入进来的。诊断和测试用。 */
export function isInjectedCard(cardId: CardId): boolean {
  return cardId.startsWith('injected:')
}
