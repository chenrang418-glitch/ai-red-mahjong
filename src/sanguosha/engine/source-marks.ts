import type { PlayerId, SanguoshaState } from './types'

/**
 * 「来源绑定」的可叠加标记。
 *
 * 神孙策【平定】是第一个用它的技能：标记贴在别人身上，但**是谁贴的**决定了
 * 后面一连串结果——谁对他使用牌不受距离限制、谁使用的牌他不能响应、
 * 他死的时候谁加体力上限摸牌。
 *
 * 为什么不能用 `player.marks.pingding` 这种普通标记：
 *
 * 1. 娱乐模式允许同名武将重复出场，一桌可能坐着两个神孙策。共用一个计数
 *    会让 A 贴的标记给 B 送去死亡回收，覆海也会误封 B 使用的牌。
 * 2. 同一个来源可以**叠加**（多个回合各贴一枚，冯河防伤也会追加），
 *    所以每个来源存的是数量而不是布尔。
 *
 * 存储形状是 `state.sourceMarks[targetId][key][sourceId] = count`。
 * 全部是纯数据，跟着快照走，重连之后不需要任何重建。
 */

export type SourceMarkCounts = Record<PlayerId, number>

function bucket(state: SanguoshaState, targetId: PlayerId, key: string): SourceMarkCounts {
  state.sourceMarks ??= {}
  const byKey = (state.sourceMarks[targetId] ??= {})
  return (byKey[key] ??= {})
}

/** 给 `targetId` 贴上 `count` 枚来源为 `sourceId` 的标记。 */
export function addSourceMark(
  state: SanguoshaState,
  targetId: PlayerId,
  key: string,
  sourceId: PlayerId,
  count = 1,
): void {
  if (count <= 0) return
  const counts = bucket(state, targetId, key)
  counts[sourceId] = (counts[sourceId] ?? 0) + count
}

/** `targetId` 身上来源为 `sourceId` 的标记数。 */
export function sourceMarkCount(
  state: SanguoshaState,
  targetId: PlayerId,
  key: string,
  sourceId: PlayerId,
): number {
  return state.sourceMarks?.[targetId]?.[key]?.[sourceId] ?? 0
}

/** `targetId` 身上这种标记的总数，不分来源。展示用。 */
export function totalSourceMarks(state: SanguoshaState, targetId: PlayerId, key: string): number {
  const counts = state.sourceMarks?.[targetId]?.[key]
  if (!counts) return 0
  return Object.values(counts).reduce((sum, count) => sum + count, 0)
}

/** 给 `targetId` 贴过这种标记的所有来源。 */
export function sourceMarkOwners(state: SanguoshaState, targetId: PlayerId, key: string): PlayerId[] {
  const counts = state.sourceMarks?.[targetId]?.[key]
  if (!counts) return []
  return Object.entries(counts).filter(([, count]) => count > 0).map(([sourceId]) => sourceId)
}

/**
 * 清空 `targetId` 身上这种标记。
 *
 * 死亡回收之后要调用：标记的宿主已经不在场上了，留着只会让展示层
 * 和后续的「谁有平定」查询读到幽灵数据。
 */
export function clearSourceMarks(state: SanguoshaState, targetId: PlayerId, key: string): void {
  const byKey = state.sourceMarks?.[targetId]
  if (!byKey) return
  delete byKey[key]
}
