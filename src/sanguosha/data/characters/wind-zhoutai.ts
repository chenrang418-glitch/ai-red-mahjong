import { registerSkillRuntime } from '../../engine/skills/runtime'
import type { CardId, PlayerId, SanguoshaState } from '../../engine/types'
import { moveCard } from '../../engine/zones'

/**
 * 周泰【不屈】。
 *
 * 采用**经典风包版**（锁定的规则文本见 docs/sanguosha-ruleset-v1.md）：
 * 锁定技，当你处于濒死状态时，你将牌堆顶的一张牌置于你的武将牌上，称为「创」；
 * 若此牌的点数与你武将牌上已有的「创」的点数均不同，则你不会死亡
 * ——**体力值保持不变，可以是 0 或更低**，这正是「0 血周泰」的来历。
 * 若点数与已有的「创」重复，不屈这次没撑住，照常进入求桃流程。
 *
 * 界不屈（「有任意两张点数相同则不屈失效」）和新版奋激都不混进来。
 *
 * 实现上两条硬约束：
 * 1. 「创」是**真实的牌**，从牌堆真移动到专属牌堆，不是复制出来的牌面。
 *    牌张守恒把专属牌堆算在内，一张牌不会同时出现在两个区域。
 * 2. 不改死亡流程本身。周泰通过 `dyingIntercept` 在濒死一开始就介入，
 *    通过 `survivesAtZeroHp` 告诉不变量「我现在撑得住」，
 *    **引擎里没有任何一处写 `characterId === 'zhoutai'`**。
 */

export const BUQU = 'buqu'

/** 周泰武将牌上的「创」。 */
function buquPile(state: SanguoshaState, ownerId: PlayerId): CardId[] {
  const owner = state.players.find((player) => player.id === ownerId)
  if (!owner) return []
  return owner.characterPiles[BUQU] ?? []
}

/** 「创」的点数是否互不相同。相同即不屈失效。 */
function ranksAllDistinct(state: SanguoshaState, ids: readonly CardId[]): boolean {
  const ranks = ids.map((id) => state.cards[id]?.rank)
  return new Set(ranks).size === ranks.length
}

registerSkillRuntime({
  id: BUQU,

  /**
   * 不变量的例外：只有当「创」确实撑得住时，周泰才可以在 0 体力以下活着。
   * 点数一旦出现重复，这个例外立刻失效——那时候他就该正常濒死或死亡。
   */
  survivesAtZeroHp(state, ownerId) {
    const pile = buquPile(state, ownerId)
    return pile.length > 0 && ranksAllDistinct(state, pile)
  },

  dyingIntercept(host, ownerId) {
    const owner = host.state.players.find((player) => player.id === ownerId)
    if (!owner?.alive) return false

    // 牌堆空了就把弃牌堆洗回去；一张牌都没有时不屈无从发动
    if (host.state.zones.drawPile.length === 0) {
      if (host.state.zones.discardPile.length === 0) return false
      host.state.zones.drawPile.push(...host.rng.shuffle(host.state.zones.discardPile))
      host.state.zones.discardPile.length = 0
    }
    const drawn = host.state.zones.drawPile[0]
    moveCard(host.state, drawn, { kind: 'drawPile' }, { kind: 'characterPile', playerId: ownerId, pile: BUQU })
    host.dispatch(
      'GainCard',
      { playerId: ownerId, cardIds: [drawn], reason: '不屈', pile: BUQU, revealed: true },
      { targetId: ownerId, cardIds: [drawn] },
    )

    const pile = buquPile(host.state, ownerId)
    const survived = ranksAllDistinct(host.state, pile)
    host.dispatch('SkillActivated', {
      skillId: BUQU,
      skillName: '不屈',
      playerId: ownerId,
      // 撑住与否是公开信息：「创」本来就是亮出来的
      survived,
      rank: host.state.cards[drawn].rank,
    }, { sourceId: ownerId, targetId: ownerId })
    return survived
  },
})
