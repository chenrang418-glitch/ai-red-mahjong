import type { PlayerId, SanguoshaState } from './types'

/**
 * 有序循环状态。
 *
 * 神华佗【五灵】是第一个用它的技能：由施加者定下五种「灵」的**完整排列**，
 * 目标立刻进入第一种，之后在自己的准备阶段切换到下一种，走完一轮回到第一种。
 *
 * 为什么必须做成公共机制，而不是五个独立技能：
 *
 * 1. 五种灵不是五个技能，是**同一个状态的五个取值**。做成五个技能之后
 *    「当前是哪一种」就没有唯一事实来源了，切换要靠加一个删一个，
 *    中间任何一次异常都会留下两种灵同时生效。
 * 2. 排列顺序本身是这次发动的一部分，必须跟着快照走。做成技能的话
 *    顺序就只能藏在某个 mark 的字符串里，重连之后基本救不回来。
 * 3. **来源要记住。** 娱乐模式允许同名武将重复出场，一桌两个神华佗
 *    各给一个人上五灵，共用一份状态会串线。
 *
 * 状态本身只管「当前是哪一个取值」；取值带来的效果由技能自己实现——
 * 这个模块不认识虎鹤熊猿鹿，也不该认识。
 */

export interface CyclicStatus {
  /** 状态种类。同一个人身上可以同时有不同种类的循环状态。 */
  key: string
  /** 状态挂在谁身上。 */
  ownerId: PlayerId
  /** 谁施加的。死亡回收、来源绑定的判断都看它。 */
  sourceId: PlayerId
  /** 完整排列。长度和内容由施加的技能负责校验。 */
  order: string[]
  /** 当前处在排列的第几项。 */
  index: number
}

function all(state: SanguoshaState): CyclicStatus[] {
  return (state.cyclicStatuses ??= [])
}

/** 这个人身上这种循环状态。一个人对同一种 key 只会有一份。 */
export function cyclicStatusOf(state: SanguoshaState, key: string, ownerId: PlayerId): CyclicStatus | null {
  return all(state).find((status) => status.key === key && status.ownerId === ownerId) ?? null
}

/** 当前取值。没有这个状态时返回 null。 */
export function currentCyclicValue(state: SanguoshaState, key: string, ownerId: PlayerId): string | null {
  const status = cyclicStatusOf(state, key, ownerId)
  if (!status) return null
  return status.order[status.index] ?? null
}

/**
 * 施加一个循环状态，返回进入的第一个取值。
 *
 * 已经有同种状态的人不会被覆盖——「不能重复授予」是规则的一部分，
 * 这里返回 null 让调用方把这个人排除在候选之外。
 */
export function grantCyclicStatus(
  state: SanguoshaState,
  entry: Omit<CyclicStatus, 'index'>,
): string | null {
  if (cyclicStatusOf(state, entry.key, entry.ownerId)) return null
  if (entry.order.length === 0) return null
  if (new Set(entry.order).size !== entry.order.length) throw new Error('循环状态的排列不能有重复项')
  all(state).push({ ...entry, order: [...entry.order], index: 0 })
  return entry.order[0]
}

/**
 * 切换到排列里的下一个取值，返回新的取值。
 *
 * 走到最后一项之后回到第一项——**循环**这两个字就是这个意思，
 * 不是走完就结束。
 */
export function advanceCyclicStatus(state: SanguoshaState, key: string, ownerId: PlayerId): string | null {
  const status = cyclicStatusOf(state, key, ownerId)
  if (!status || status.order.length === 0) return null
  status.index = (status.index + 1) % status.order.length
  return status.order[status.index]
}

/** 场上这种状态的全部实例。展示和结算用。 */
export function cyclicStatusesOf(state: SanguoshaState, key: string): CyclicStatus[] {
  return all(state).filter((status) => status.key === key)
}

/** 移除某人身上的这种状态。 */
export function clearCyclicStatus(state: SanguoshaState, key: string, ownerId: PlayerId): void {
  state.cyclicStatuses = all(state).filter((status) => !(status.key === key && status.ownerId === ownerId))
}
