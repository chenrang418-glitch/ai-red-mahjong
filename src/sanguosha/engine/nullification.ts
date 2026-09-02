import type { CardId, PlayerId, SanguoshaState } from './types'

/**
 * 无懈可击询问的公共部分。
 *
 * 单独一个叶子模块（只依赖 types）：锦囊结算和判定阶段各有一套无懈轮询，
 * 两边都要用这些常量和判断。放在 `cards/tricks.ts` 里会让 `judgment.ts`
 * 反向依赖它，构成 import 环——踩过一次，症状是
 * 「Cannot access 'continuations' before initialization」。
 */

/**
 * 无懈可击的响应窗口。
 *
 * 30 秒对一个「有没有无懈」的判断来说太长了：多目标锦囊每个目标都要问一轮，
 * 一张五谷丰登能把牌局卡上好几分钟。收到 3 秒——真想用的人早就想好了，
 * 手上没有无懈的人根本不会被问到。
 */
export const NULLIFICATION_TIMEOUT_MS = 3_000

/** 「本轮均不使用」：这张牌剩下的目标都不再问我。 */
export const PASS_ROUND_ACTION = 'respond-pass-round'

/**
 * 某人现在能打出的无懈可击。空数组表示他插不上手，**不要问他**。
 *
 * 死人也返回空：延时锦囊那一轮原来连死人都问。
 */
export function nullificationCardIds(state: SanguoshaState, playerId: PlayerId): CardId[] {
  const responder = state.players.find((candidate) => candidate.id === playerId)
  if (!responder?.alive) return []
  return responder.zones.hand.filter((cardId) => state.cards[cardId]?.name === '无懈可击')
}
