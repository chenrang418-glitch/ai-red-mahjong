import type { PlayerId, SanguoshaState } from './types'

/**
 * 「每种牌名限一次」的历史记账。
 *
 * 神荀彧【定汉】需要**两个互相独立**的集合，混成一个必然出错：
 *
 * - `recorded`：当前记录中的牌名。它会被玩家在回合开始时增删，
 *   同时也是【灵策】判断「这张锦囊算不算数」的依据之一。
 * - `used`：这一整局里**已经用掉过取消资格**的牌名。它只增不减。
 *
 * 为什么必须分开——一个具体的例子：
 *
 * 1. 神荀彧第一次被【决斗】指定：触发定汉，记录「决斗」，取消这个目标。
 *    此时 `recorded` 和 `used` 都有「决斗」。
 * 2. 他在自己回合开始时把「决斗」从记录里移除（换成更值得记的牌名）。
 *    `recorded` 没有「决斗」了，于是实体决斗不再因为定汉记录触发灵策——这是对的。
 * 3. 之后他又被【决斗】指定：**不能**再取消一次。「每种牌名限一次」说的是
 *    整局历史，不是「当前记录里还有没有」。靠 `recorded` 判断就会让玩家
 *    通过反复增删无限取消。
 *
 * 反过来也成立：手动往记录里加一个从没触发过的牌名，**不消耗**它的首次取消资格。
 */
export interface CardNameHistory {
  /** 当前记录中的牌名。玩家可增删。 */
  recorded: string[]
  /** 已经用掉过一次性资格的牌名。只增不减。 */
  used: string[]
}

function storeOf(state: SanguoshaState, ownerId: PlayerId, key: string): CardNameHistory {
  state.cardNameHistories ??= {}
  const id = `${ownerId}:${key}`
  return (state.cardNameHistories[id] ??= { recorded: [], used: [] })
}

export function recordedNames(state: SanguoshaState, ownerId: PlayerId, key: string): readonly string[] {
  return storeOf(state, ownerId, key).recorded
}

export function hasRecordedName(state: SanguoshaState, ownerId: PlayerId, key: string, name: string): boolean {
  return storeOf(state, ownerId, key).recorded.includes(name)
}

export function addRecordedName(state: SanguoshaState, ownerId: PlayerId, key: string, name: string): void {
  const store = storeOf(state, ownerId, key)
  if (!store.recorded.includes(name)) store.recorded.push(name)
}

export function removeRecordedName(state: SanguoshaState, ownerId: PlayerId, key: string, name: string): void {
  const store = storeOf(state, ownerId, key)
  store.recorded = store.recorded.filter((candidate) => candidate !== name)
}

/** 这个牌名的一次性资格还在不在。 */
export function canUseOnce(state: SanguoshaState, ownerId: PlayerId, key: string, name: string): boolean {
  return !storeOf(state, ownerId, key).used.includes(name)
}

/**
 * 用掉一个牌名的一次性资格。
 *
 * **只有真正触发时才调用**，手动增删记录不走这里。
 */
export function consumeOnce(state: SanguoshaState, ownerId: PlayerId, key: string, name: string): void {
  const store = storeOf(state, ownerId, key)
  if (!store.used.includes(name)) store.used.push(name)
}
