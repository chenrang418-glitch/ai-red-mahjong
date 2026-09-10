import { effectiveKingdomOf } from './huashen'
import type { SanguoshaState } from './types'

/**
 * 「现存势力数」的**唯一**计算入口。
 *
 * 三个技能读它：廖化【伏枥】回复至 X 点、刘表【自守】额外摸 X 张、
 * 刘表【宗室】手牌上限 +X。各写一套的话，三个技能迟早对不上——
 * 而且【自守】和【宗室】在同一个人身上，两者算出不同的 X 是荒谬的。
 *
 * 四条口径：
 *
 * 1. **去重**。三个蜀国角色只算一个势力。
 * 2. **只数存活角色**。已经灭亡的势力不计——技能文本说的就是「现存」。
 * 3. **神势力单独算一种**，不并进任何一个国。
 * 4. **实时计算，不缓存**。有人阵亡就当场变；缓存一次的话，
 *    宗室的手牌上限会停在开局那个值。
 *
 * 走 `effectiveKingdomOf`，所以化身（神吕蒙【化身】）当下顶的那个势力算数，
 * 而不是他武将牌上印的势力。
 */
export function livingKingdomCount(state: SanguoshaState): number {
  return livingKingdoms(state).size
}

/** 现存的势力集合。需要知道「有哪些」而不只是「几个」时用它。 */
export function livingKingdoms(state: SanguoshaState): Set<string> {
  const kingdoms = new Set<string>()
  for (const player of state.players) {
    if (!player.alive) continue
    const kingdom = effectiveKingdomOf(state, player.id)
    if (kingdom) kingdoms.add(kingdom)
  }
  return kingdoms
}
