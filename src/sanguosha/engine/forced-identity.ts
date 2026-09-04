import type { CardId, DamageNature, PlayerId, SanguoshaState } from './types'

/**
 * 「本回合你的某类手牌**只能**当作某张牌使用或打出」的公共机制。
 *
 * 神刘备【龙怒】要的就是这个：
 * 阳——红色手牌均视为火【杀】；阴——锦囊牌均视为雷【杀】。
 *
 * **和普通 `viewAs` 是两回事。** 武圣、龙胆那种转化是「多给一个用途」，
 * 原来的用途仍然保留：一张红桃【桃】既能当【杀】用，也还能当【桃】吃。
 * 龙怒的「均视为」是**强制改写身份并禁止原用途**：
 * 阳状态下手里那张【桃】不能再吃，那张【八卦阵】不能再装，
 * 那张黑桃以外的【闪】也不能再当闪打出——它们此刻只能是火【杀】。
 *
 * 所以不能套 `viewAs`，需要一条独立的「身份改写 + 原用途禁止」通道。
 * 之后的现代神将还会复用。
 *
 * **只作用于手牌**：装备区、判定区、专属牌堆里的牌不受影响。
 */

/** 哪一类手牌被改写。谓词写死成有限的几种，状态才能序列化。 */
export type ForcedIdentityScope = 'red' | 'trick'

export interface ForcedCardIdentity {
  ownerId: PlayerId
  scope: ForcedIdentityScope
  /** 改写成哪张牌。 */
  asCardName: string
  /** 改写后的伤害属性（龙怒阳是火、阴是雷）。 */
  nature: DamageNature
  /** 这些改写出来的【杀】是否无距离限制。 */
  ignoreDistance: boolean
  /** 这些改写出来的【杀】是否不受出杀次数限制。 */
  unlimitedUses: boolean
  skillId: string
  /** 目前只有「本回合结束时失效」一种。 */
  expiry: 'turn-end'
}

function playerOf(state: SanguoshaState, playerId: PlayerId) {
  return state.players.find((candidate) => candidate.id === playerId)
}

function matchesScope(state: SanguoshaState, cardId: CardId, scope: ForcedIdentityScope): boolean {
  const card = state.cards[cardId]
  if (!card) return false
  if (scope === 'red') return card.color === 'red'
  if (scope === 'trick') return card.category === 'trick'
  return false
}

/**
 * 这张牌此刻是不是被强制改写了身份。不是就返回 null。
 *
 * **只认手牌**：牌在装备区、判定区里的时候不受影响，
 * 所以龙怒不会让神刘备装着的红色防具突然变成一张杀。
 */
export function forcedIdentityFor(
  state: SanguoshaState,
  playerId: PlayerId,
  cardId: CardId,
): ForcedCardIdentity | null {
  const owner = playerOf(state, playerId)
  if (!owner?.alive || !owner.zones.hand.includes(cardId)) return null
  for (const entry of state.forcedIdentities ?? []) {
    if (entry.ownerId !== playerId) continue
    if (matchesScope(state, cardId, entry.scope)) return entry
  }
  return null
}

/** 这名角色现在有没有任何强制改写生效。用于快速跳过。 */
export function hasForcedIdentity(state: SanguoshaState, playerId: PlayerId): boolean {
  return (state.forcedIdentities ?? []).some((entry) => entry.ownerId === playerId)
}

/**
 * 这张牌现在能不能按 `asCardName` 使用或打出。
 *
 * 没有被改写就照常（返回 true）；被改写了就**只有**改写成的那张牌名放行。
 * 各个响应路径（求闪、求桃、无懈、锦囊效果）用这一个入口过滤候选，
 * 不要各写一遍「红牌能不能当闪」。
 */
export function canUseCardAs(
  state: SanguoshaState,
  playerId: PlayerId,
  cardId: CardId,
  asCardName: string,
): boolean {
  const forced = forcedIdentityFor(state, playerId, cardId)
  return !forced || forced.asCardName === asCardName
}

export function applyForcedIdentity(state: SanguoshaState, entry: ForcedCardIdentity): void {
  state.forcedIdentities ??= []
  // 同一个技能同一个人不叠加，重复施加就是刷新
  state.forcedIdentities = state.forcedIdentities.filter((candidate) => (
    !(candidate.ownerId === entry.ownerId && candidate.skillId === entry.skillId)
  ))
  state.forcedIdentities.push(entry)
}

/**
 * 回合结束时统一清理。由 `turn.ts` 调一次，**技能不各自注册清理**。
 *
 * 漏清的话下一个回合神刘备的红牌还是只能当杀用，而且他自己都不知道为什么。
 */
export function clearForcedIdentities(state: SanguoshaState): void {
  state.forcedIdentities = (state.forcedIdentities ?? []).filter((entry) => entry.expiry !== 'turn-end')
}

/** 角色死亡时清掉他身上的改写。 */
export function clearForcedIdentitiesOf(state: SanguoshaState, playerId: PlayerId): void {
  state.forcedIdentities = (state.forcedIdentities ?? []).filter((entry) => entry.ownerId !== playerId)
}
