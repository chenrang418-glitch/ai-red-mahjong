import type { PlayerId, SanguoshaState } from './types'

/**
 * 「带归属的全局唯一 Token」。
 *
 * 神甘宁的「营」要的就是这个：全场同时最多一个，而且要记得**它是谁的**。
 *
 * 为什么不能只写 `player.marks.camp = 1`：
 *
 * - 「营」有 owner（哪个神甘宁）和 carrier（现在放在谁身上）两层。
 *   有营的其他角色回合结束后，**owner** 获得其手牌——marks 记不下这个归属。
 * - 娱乐局里可能同时有两个神甘宁，各自一个营。用匿名 mark 会互相抢，
 *   最后把手牌发给错的人。
 *
 * 所以做成一张带 owner 的表，key 是 token 名。同名 token 允许多份，
 * 但**每个 owner 最多一份**，普通局里也就只有一份。
 */

export interface GlobalToken {
  /** token 名，比如「营」。 */
  name: string
  /** 这枚 token 属于谁（神甘宁自己）。 */
  ownerId: PlayerId
  /** 现在放在谁的武将牌旁。 */
  carrierId: PlayerId
}

function tokensOf(state: SanguoshaState): GlobalToken[] {
  return state.globalTokens ?? []
}

/** 场上有没有这种 token（任何归属）。 */
export function tokenExists(state: SanguoshaState, name: string): boolean {
  return tokensOf(state).some((token) => token.name === name)
}

/** 这名角色身上有没有这种 token。 */
export function carriesToken(state: SanguoshaState, playerId: PlayerId, name: string): boolean {
  return tokensOf(state).some((token) => token.name === name && token.carrierId === playerId)
}

/** 这名角色身上这种 token 的完整信息（要拿 ownerId）。 */
export function tokenCarriedBy(state: SanguoshaState, playerId: PlayerId, name: string): GlobalToken | null {
  return tokensOf(state).find((token) => token.name === name && token.carrierId === playerId) ?? null
}

/** 某个 owner 的这种 token。 */
export function tokenOwnedBy(state: SanguoshaState, ownerId: PlayerId, name: string): GlobalToken | null {
  return tokensOf(state).find((token) => token.name === name && token.ownerId === ownerId) ?? null
}

/** 生成一枚 token，初始放在 owner 自己身上。同一个 owner 已有就不再生成。 */
export function createToken(state: SanguoshaState, name: string, ownerId: PlayerId): boolean {
  if (tokenOwnedBy(state, ownerId, name)) return false
  state.globalTokens ??= []
  state.globalTokens.push({ name, ownerId, carrierId: ownerId })
  return true
}

/** 把 token 挪到另一名角色身上。owner 不变。 */
export function moveToken(state: SanguoshaState, name: string, ownerId: PlayerId, carrierId: PlayerId): boolean {
  const token = tokenOwnedBy(state, ownerId, name)
  if (!token) return false
  token.carrierId = carrierId
  return true
}

/** 移去一枚 token。 */
export function removeToken(state: SanguoshaState, name: string, ownerId: PlayerId): boolean {
  const before = tokensOf(state).length
  state.globalTokens = tokensOf(state).filter((token) => !(token.name === name && token.ownerId === ownerId))
  return state.globalTokens.length !== before
}

/**
 * 角色死亡时的清理。
 *
 * **owner 死了整枚 token 就没了**——不能等 carrier 回合结束再把手牌发给死人。
 * **carrier 死了 token 也移去**——他的手牌已经走死亡清理了。
 */
export function clearTokensOf(state: SanguoshaState, playerId: PlayerId): void {
  state.globalTokens = tokensOf(state).filter((token) => (
    token.ownerId !== playerId && token.carrierId !== playerId
  ))
}
