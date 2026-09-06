import type { PlayerId, SanguoshaState } from './types'

/**
 * 「手牌数掉到某条线以下」这类**状态触发**。
 *
 * 张春华【伤逝】要的是：手牌数小于已损失体力值时可以补到那条线。
 * 这不是某个时机上的事件——**任何**让手牌变少或者让已损失体力变多的事都算：
 * 用牌、打出、被顺、被拆、弃牌、失去体力、体力上限变化……
 *
 * 逐个时机去挂是挂不全的，挂全了也会重复：一次被拿走三张手牌会连问三次。
 * 所以这里给的是一个**统一的复查点**：牌局每次回到干净状态时复查一遍，
 * 条件成立就给一次机会。
 *
 * 「放弃过就不再问」是错的：放弃之后如果又发生新的状态变化（又被拿走一张），
 * 应该重新问。所以记的是**上次问的时候是什么状态**，状态变了就能再问一次。
 */

/** 已损失体力值。**不能写死成「3 - hp」**：体力上限是会变的。 */
export function lostHpOf(state: SanguoshaState, playerId: PlayerId): number {
  const player = state.players.find((candidate) => candidate.id === playerId)
  if (!player) return 0
  return Math.max(0, player.maxHp - player.hp)
}

/**
 * 这名角色现在的「手牌 / 已损失体力」状态指纹。
 *
 * 两个数中任何一个变了，就算是一次新的状态变化，值得重新问一次。
 */
export function handStateFingerprint(state: SanguoshaState, playerId: PlayerId): string {
  const player = state.players.find((candidate) => candidate.id === playerId)
  if (!player) return ''
  return `${player.zones.hand.length}/${lostHpOf(state, playerId)}`
}
