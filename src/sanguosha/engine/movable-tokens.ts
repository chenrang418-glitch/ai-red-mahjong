import type { PlayerId, SanguoshaState } from './types'

/**
 * 会在角色之间移动、且记得来源的标记。
 *
 * 神太史慈【破围】的「围」是第一个：开局给所有其他角色各一枚，
 * 之后每个回合开始时整体往下家挪一格。
 *
 * 和 `source-marks` 的区别：那边是「贴在谁身上、几枚」的计数，
 * 这边每一枚都是**独立的一枚**，因为它要被单独搬来搬去。
 *
 * 两条纪律：
 *
 * 1. **必须记来源。** 一桌可能坐着两个神太史慈，各自的使命各算各的；
 *    共用一堆匿名的「围」会让 A 的使命被 B 的围拖住。
 * 2. **移动必须先快照。** 边扫描边移动的话，刚挪到某个人身上的那一枚
 *    会在同一次移动里被再挪一次——挪一格变成挪两格，甚至绕着桌子跑一圈。
 */

export interface MovableToken {
  /** 标记种类。 */
  key: string
  /** 谁的标记。使命、结算全部按它归属。 */
  ownerId: PlayerId
  /** 现在贴在谁身上。 */
  carrierId: PlayerId
}

function all(state: SanguoshaState): MovableToken[] {
  return (state.movableTokens ??= [])
}

/** 一次给多名角色各贴一枚。 */
export function grantMovableTokens(
  state: SanguoshaState,
  key: string,
  ownerId: PlayerId,
  carrierIds: readonly PlayerId[],
): void {
  const tokens = all(state)
  for (const carrierId of carrierIds) tokens.push({ key, ownerId, carrierId })
}

/** 这个来源现在还有哪些标记在场上。 */
export function tokensOf(state: SanguoshaState, key: string, ownerId: PlayerId): MovableToken[] {
  return all(state).filter((token) => token.key === key && token.ownerId === ownerId)
}

/** 这个人身上有没有来源为 `ownerId` 的标记。 */
export function hasMovableToken(
  state: SanguoshaState,
  key: string,
  ownerId: PlayerId,
  carrierId: PlayerId,
): boolean {
  return all(state).some((token) => token.key === key && token.ownerId === ownerId && token.carrierId === carrierId)
}

/** 这个人身上这种标记的全部来源。UI 上重复来源要能分辨是谁的。 */
export function tokenOwnersOn(state: SanguoshaState, key: string, carrierId: PlayerId): PlayerId[] {
  const owners = all(state)
    .filter((token) => token.key === key && token.carrierId === carrierId)
    .map((token) => token.ownerId)
  return [...new Set(owners)]
}

/** 拿掉某人身上、来源为 `ownerId` 的全部这种标记。返回拿掉了几枚。 */
export function removeMovableTokens(
  state: SanguoshaState,
  key: string,
  ownerId: PlayerId,
  carrierId: PlayerId,
): number {
  const before = all(state).length
  state.movableTokens = all(state).filter((token) => !(
    token.key === key && token.ownerId === ownerId && token.carrierId === carrierId
  ))
  return before - state.movableTokens.length
}

/** 清掉这个来源的全部这种标记（使命成功或失败时）。 */
export function clearMovableTokens(state: SanguoshaState, key: string, ownerId: PlayerId): void {
  state.movableTokens = all(state).filter((token) => !(token.key === key && token.ownerId === ownerId))
}

/**
 * 整体移动一个来源的全部标记。
 *
 * `destinationOf` 拿到当前持有者，返回下一个持有者；返回 null 表示这一枚
 * 没有合法去处，直接清掉（场上只剩标记来源一个人时会走到这里）。
 *
 * **先把去处全部算完，再一次性写回。** 这是这个函数存在的唯一理由：
 * 就地循环会让刚移动过来的标记在同一轮里被再移动一次。
 */
export function moveMovableTokens(
  state: SanguoshaState,
  key: string,
  ownerId: PlayerId,
  destinationOf: (carrierId: PlayerId) => PlayerId | null,
): void {
  const tokens = all(state)
  const snapshot = tokens
    .map((token, index) => ({ token, index }))
    .filter(({ token }) => token.key === key && token.ownerId === ownerId)
  const destinations = snapshot.map(({ token }) => destinationOf(token.carrierId))
  const dropped = new Set<number>()
  snapshot.forEach(({ token, index }, position) => {
    const destination = destinations[position]
    if (destination === null) dropped.add(index)
    else token.carrierId = destination
  })
  if (dropped.size > 0) state.movableTokens = tokens.filter((_, index) => !dropped.has(index))
}
