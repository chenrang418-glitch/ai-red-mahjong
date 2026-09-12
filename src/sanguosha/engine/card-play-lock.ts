import { cardPlayableBySuit } from './card-suit-lock'
import { effectiveCardColor } from './skills/runtime'
import type { CardColorValue } from './card-color'
import type { CardCategory, CardId, PlayerId, SanguoshaState } from './types'

/**
 * 「不能使用或打出某类牌」的统一入口。
 *
 * 现在有两种来源，判据不同但边界完全一样，所以收在同一个函数里：
 *
 * - **花色禁令**（神黄忠【裂穹·气海】禁红桃），见 `card-suit-lock.ts`；
 * - **颜色禁令**（马岱【潜袭】禁与弃置牌同色的**手牌**），在本模块里。
 *
 * 四条边界，写错任何一条都会变成另一个技能：
 *
 * 1. **只禁「使用」和「打出」**，不禁弃置、交给别人、被顺被拆、
 *    当作技能代价。潜袭不是「同色牌不能动」。
 * 2. **看的是实体牌**，所以转化技的**子牌**同样被拦住：拿一张被禁颜色的
 *    手牌去当【杀】用（武圣、丈八、父魂、奇策……）一样不行。
 *    只看转化出来那张虚拟牌的颜色，等于没拦。
 * 3. **潜袭只禁手牌**。装备区、判定区、专属牌堆里的牌不受影响——
 *    技能文本说的就是「手牌」。
 * 4. **无色的牌不被任何颜色禁令拦住**。虚拟牌、武将牌变的装备没有颜色，
 *    「与它同色」这件事无从谈起。
 *
 * 各条响应路径（求闪、求桃、无懈、锦囊求牌）通过 `canUseCardAs` 统一走到这里，
 * 出牌阶段的合法动作在生成时查一次——两边都不各写一遍「这张牌能不能用」。
 */

/**
 * 一条颜色禁令。**绑定回合序号**：额外回合各自独立，
 * 不按轮次推算，也不按「施加者的下一个回合」推算。
 */
export interface CardColorLockEntry {
  targetId: PlayerId
  color: Exclude<CardColorValue, null>
  sourceId: PlayerId
  skillId: string
  /** 施加时所在的回合；这个回合结束时统一清掉。 */
  turnNumber: number
}

/**
 * 施加一条颜色禁令，持续到**当前回合结束**。
 *
 * 同一个技能对同一个人不叠加：重复施加就是刷新（换成新的颜色）。
 * `color` 为 null 时什么都不做——无色的牌产生不了颜色限制。
 */
export function lockCardColor(
  state: SanguoshaState,
  entry: { targetId: PlayerId; color: CardColorValue; sourceId: PlayerId; skillId: string },
): boolean {
  if (entry.color === null) return false
  state.cardColorLocks ??= []
  state.cardColorLocks = state.cardColorLocks.filter((candidate) => (
    !(candidate.targetId === entry.targetId && candidate.skillId === entry.skillId && candidate.sourceId === entry.sourceId)
  ))
  state.cardColorLocks.push({
    targetId: entry.targetId,
    color: entry.color,
    sourceId: entry.sourceId,
    skillId: entry.skillId,
    turnNumber: state.turnNumber,
  })
  return true
}

/** 这名角色现在被禁用的颜色。 */
export function lockedColorsOf(state: SanguoshaState, playerId: PlayerId): Array<Exclude<CardColorValue, null>> {
  return (state.cardColorLocks ?? [])
    .filter((entry) => entry.targetId === playerId)
    .map((entry) => entry.color)
}

/**
 * 回合结束时统一清理。由 `turn.ts` 调一次，**技能不各自注册清理**。
 *
 * 散着写迟早漏一个，然后某个玩家身上挂着一个永远不消失的颜色禁令，
 * 而且他自己都不知道为什么出不了牌。
 */
export function clearTurnCardColorLocks(state: SanguoshaState, turnNumber: number): void {
  if (!state.cardColorLocks) return
  state.cardColorLocks = state.cardColorLocks.filter((entry) => entry.turnNumber !== turnNumber)
  if (state.cardColorLocks.length === 0) delete state.cardColorLocks
}

/** 角色阵亡时把挂在他身上、以及由他施加的禁令一起收走。 */
export function clearCardColorLocksOf(state: SanguoshaState, playerId: PlayerId): void {
  if (!state.cardColorLocks) return
  state.cardColorLocks = state.cardColorLocks.filter((entry) => entry.targetId !== playerId && entry.sourceId !== playerId)
  if (state.cardColorLocks.length === 0) delete state.cardColorLocks
}

/** 这张牌现在在不在这名角色手上。颜色禁令只管手牌。 */
function isInHand(state: SanguoshaState, playerId: PlayerId, cardId: CardId): boolean {
  return state.players.find((candidate) => candidate.id === playerId)?.zones.hand.includes(cardId) ?? false
}

/** 颜色禁令这一条：这张实体牌能不能被这名角色使用或打出。 */
export function cardPlayableByColor(state: SanguoshaState, playerId: PlayerId, cardId: CardId): boolean {
  const locked = lockedColorsOf(state, playerId)
  if (locked.length === 0) return true
  if (!isInHand(state, playerId, cardId)) return true
  // 有效颜色而不是牌面颜色：颜色改写（奇策、父魂合成的牌）同样算数
  const color = effectiveCardColor(state, playerId, cardId)
  if (color === null) return true
  return !locked.includes(color)
}

/**
 * 类别禁令（杨修【鸡肋】：受到伤害后声明一个牌类别，直到回合结束，来源不能
 * 使用/打出其手牌中该类别的牌）。结构和存续规则与颜色禁令完全一样，
 * 只是判据换成 `CardCategory`，所以照抄一份而不是把两种判据拼进一个函数——
 * 拼在一起以后任何一条改判据都要多算一层「到底是哪种」。
 */
export function lockCardCategory(
  state: SanguoshaState,
  entry: { targetId: PlayerId; category: CardCategory; sourceId: PlayerId; skillId: string },
): void {
  state.cardCategoryLocks ??= []
  state.cardCategoryLocks = state.cardCategoryLocks.filter((candidate) => (
    !(candidate.targetId === entry.targetId && candidate.skillId === entry.skillId && candidate.sourceId === entry.sourceId)
  ))
  state.cardCategoryLocks.push({ ...entry, turnNumber: state.turnNumber })
}

/** 这名角色现在被禁用的牌类别。 */
export function lockedCategoriesOf(state: SanguoshaState, playerId: PlayerId): CardCategory[] {
  return (state.cardCategoryLocks ?? [])
    .filter((entry) => entry.targetId === playerId)
    .map((entry) => entry.category)
}

/** 类别禁令这一条：这张实体牌能不能被这名角色使用或打出。 */
export function cardPlayableByCategory(state: SanguoshaState, playerId: PlayerId, cardId: CardId): boolean {
  const locked = lockedCategoriesOf(state, playerId)
  if (locked.length === 0) return true
  if (!isInHand(state, playerId, cardId)) return true
  const category = state.cards[cardId]?.category
  if (!category) return true
  return !locked.includes(category)
}

/** 回合结束时统一清理，和颜色禁令走同一次调用点。 */
export function clearTurnCardCategoryLocks(state: SanguoshaState, turnNumber: number): void {
  if (!state.cardCategoryLocks) return
  state.cardCategoryLocks = state.cardCategoryLocks.filter((entry) => entry.turnNumber !== turnNumber)
  if (state.cardCategoryLocks.length === 0) delete state.cardCategoryLocks
}

/** 角色阵亡时把挂在他身上、以及由他施加的类别禁令一起收走。 */
export function clearCardCategoryLocksOf(state: SanguoshaState, playerId: PlayerId): void {
  if (!state.cardCategoryLocks) return
  state.cardCategoryLocks = state.cardCategoryLocks.filter((entry) => entry.targetId !== playerId && entry.sourceId !== playerId)
  if (state.cardCategoryLocks.length === 0) delete state.cardCategoryLocks
}

/**
 * 第四类禁令：按具体 Card ID 禁用（董白【黠慧】：A 获得的董白黑牌被锁定，
 * 直到 A 体力值下降才解锁）。和颜色/类别禁令的区别是**不按回合过期**，
 * 技能自己在正确的时机调用 `clearCardIdLocksOf` 解锁。
 */
export interface CardIdLockEntry {
  targetId: PlayerId
  cardId: CardId
  sourceId: PlayerId
  skillId: string
}

/** 锁定一张具体的牌；同一张牌重复锁定不产生第二条记录。 */
export function lockCardId(state: SanguoshaState, entry: CardIdLockEntry): void {
  state.cardIdLocks ??= []
  if (state.cardIdLocks.some((candidate) => candidate.targetId === entry.targetId && candidate.cardId === entry.cardId)) return
  state.cardIdLocks.push({ ...entry })
}

/** 这张具体的牌，对这名角色来说现在是不是被锁定。 */
export function isCardIdLocked(state: SanguoshaState, playerId: PlayerId, cardId: CardId): boolean {
  return (state.cardIdLocks ?? []).some((entry) => entry.targetId === playerId && entry.cardId === cardId)
}

/** 解除这名角色身上**全部**的按 Card ID 锁定（体力值下降后统一解锁）。 */
export function clearCardIdLocksOf(state: SanguoshaState, playerId: PlayerId): void {
  if (!state.cardIdLocks) return
  state.cardIdLocks = state.cardIdLocks.filter((entry) => entry.targetId !== playerId)
  if (state.cardIdLocks.length === 0) delete state.cardIdLocks
}

/**
 * 这张实体牌现在能不能被这名角色**使用或打出**。花色、颜色、类别、
 * 具体 Card ID 四类禁令都查。
 *
 * 这是唯一出口：新增第五类禁令时加在这里，不要在各条路径上再写一遍。
 */
export function cardPlayable(state: SanguoshaState, playerId: PlayerId, cardId: CardId): boolean {
  return cardPlayableBySuit(state, playerId, cardId)
    && cardPlayableByColor(state, playerId, cardId)
    && cardPlayableByCategory(state, playerId, cardId)
    && !isCardIdLocked(state, playerId, cardId)
}

/** 这名角色现在有没有任何用牌禁令，用于界面提示。 */
export function hasPlayLock(state: SanguoshaState, playerId: PlayerId): boolean {
  return lockedColorsOf(state, playerId).length > 0 || lockedCategoriesOf(state, playerId).length > 0
}
