import type { GameRng } from './rng'
import type { CardId, PlayerId, SanguoshaState } from './types'

/**
 * 把两个人的手牌合起来洗匀，再平均分回去。
 *
 * 神鲁肃【智盟】是第一个用它的技能。
 *
 * 三点容易做错的：
 *
 * 1. **这是真的重新分牌，不是「只补数量差」。** 两人都是三张时，
 *    结果仍然是三比三，但**具体是哪三张必须重新随机**。做成「只交换差额」
 *    的话，牌数相同就等于什么都没发生，技能的一半意义就没了。
 * 2. **随机必须用牌局自己的 seeded RNG。** 用 `Math.random` 会让同一个种子
 *    跑出两条不同的牌局，压测不可复现，重放对不上，联机两端也会分叉。
 * 3. **总数为奇数时多的那一张归发起者。** 这是规则定死的偏向，
 *    不能按「谁手牌少给谁」之类的直觉去分。
 */

export interface HandRedistribution {
  initiatorCards: CardId[]
  targetCards: CardId[]
}

/**
 * 合并、洗匀、平均分。返回双方最终各拿到哪些牌。
 *
 * 只做计算和搬运，不派发任何事件——谁该看到什么由调用方决定。
 * 牌是直接在两个手牌区之间移动的，中途不经过弃牌堆或处理区，
 * 所以不会误触发「牌进入弃牌堆时」那一批时机。
 */
export function redistributeHands(
  state: SanguoshaState,
  rng: GameRng,
  initiatorId: PlayerId,
  targetId: PlayerId,
): HandRedistribution {
  const initiator = state.players.find((player) => player.id === initiatorId)
  const target = state.players.find((player) => player.id === targetId)
  if (!initiator || !target) throw new Error('重新分牌的双方必须都在场上')
  if (initiatorId === targetId) throw new Error('重新分牌需要两名不同的角色')

  const pool = rng.shuffle([...initiator.zones.hand, ...target.zones.hand])
  /*
   * 奇数时发起者多拿一张：`ceil` 给发起者，`floor` 给目标。
   * 五张就是三比二，不是二比三。
   */
  const initiatorCount = Math.ceil(pool.length / 2)
  const initiatorCards = pool.slice(0, initiatorCount)
  const targetCards = pool.slice(initiatorCount)
  initiator.zones.hand = [...initiatorCards]
  target.zones.hand = [...targetCards]
  return { initiatorCards, targetCards }
}
