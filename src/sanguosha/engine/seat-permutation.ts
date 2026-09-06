import type { PlayerId, SanguoshaState } from './types'

/**
 * 重排座次。
 *
 * 神鲁肃【榻谟】是第一个用它的技能：游戏开始时重新安排除主公外所有角色的座次。
 *
 * **为什么必须同时重排 `state.players` 数组。**
 *
 * 引擎里有五处是这么找下家的：
 *
 *     state.players[(某人.seat + offset) % state.players.length]
 *
 * 也就是说「数组下标」和「座位号」是同一个东西，`players[i].seat === i`
 * 是一条硬不变式（`assertGameInvariants` 也在查）。只改 `seat` 字段不动数组，
 * 下家、距离、判定顺序、求桃顺序会立刻全部错位，而且错得很安静。
 *
 * 其余一切都是按 playerId 记的——手牌、标记、围、营、额外回合队列、
 * 技能压制——所以它们跟着人走，不需要在这里做任何搬迁。
 */

/**
 * 按给定顺序重排座次。`orderedPlayerIds[i]` 会坐到 i 号位。
 *
 * 必须是**双射**：每名角色恰好出现一次，不能重复也不能遗漏。
 * 传进来的顺序有问题时直接抛——这种错误静默吞掉的话，牌局会以一个
 * 少了一个人的座位表继续跑下去。
 */
export function applySeatPermutation(state: SanguoshaState, orderedPlayerIds: readonly PlayerId[]): void {
  if (orderedPlayerIds.length !== state.players.length) {
    throw new Error('座次重排必须包含每一名角色')
  }
  if (new Set(orderedPlayerIds).size !== orderedPlayerIds.length) {
    throw new Error('座次重排里有重复的角色')
  }
  const byId = new Map(state.players.map((player) => [player.id, player]))
  const reordered = orderedPlayerIds.map((playerId) => {
    const player = byId.get(playerId)
    if (!player) throw new Error(`座次重排里有不存在的角色：${playerId}`)
    return player
  })
  state.players = reordered
  state.players.forEach((player, index) => { player.seat = index })
}

/**
 * 把「主公不动、其余角色按给定顺序填空位」翻译成完整的座次表。
 *
 * 主公的位置是锁死的，所以不能直接把非主公的排列当成整张座位表用——
 * 那样主公会被挤走。这里按座位号从小到大扫，遇到主公就原样留下，
 * 其余空位依次填入给定顺序。
 */
export function seatOrderWithFixedLord(
  state: SanguoshaState,
  lordId: PlayerId,
  otherOrder: readonly PlayerId[],
): PlayerId[] {
  const lordSeat = state.players.find((player) => player.id === lordId)?.seat
  if (lordSeat === undefined) throw new Error('主公不在座位表里')
  const others = [...otherOrder]
  const result: PlayerId[] = []
  for (let seat = 0; seat < state.players.length; seat += 1) {
    if (seat === lordSeat) { result.push(lordId); continue }
    const next = others.shift()
    if (next === undefined) throw new Error('非主公角色的排列长度不足')
    result.push(next)
  }
  if (others.length > 0) throw new Error('非主公角色的排列长度过长')
  return result
}
