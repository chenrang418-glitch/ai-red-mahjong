import { QIHAI_STATE, hasTargetState } from './target-state'
import { skillsOf } from './skills/runtime'
import { skillIdsOf } from '../data/characters/standard'
import type { CardId, PlayerId, SanguoshaState, Suit } from './types'

/**
 * 「不能使用或打出某种花色的牌」（神黄忠【裂穹·气海】禁红桃）。
 *
 * 三条边界，写错任何一条都会变成另一个技能：
 *
 * 1. **只禁「使用」和「打出」**，不禁弃置、交给、当作技能代价。
 *    气海不是「红桃牌不能动」——把弃牌也拦掉会让他连弃牌阶段都过不去。
 * 2. **看的是实体牌的花色**，所以转化技的**子牌**也被拦住：
 *    用一张♥牌当【杀】打出，动的仍然是那张♥牌。
 *    只看转化后那张虚拟牌的花色，等于没拦。
 * 3. **红桃不等于红色**：♦方块不受影响。
 *
 * 收口在这一个函数，各响应路径通过 `canUseCardAs` 统一走到它，
 * 使用路径在生成合法动作时查一次——两边都不各写一遍「这张牌能不能用」。
 */

/** 这名角色现在被禁用的花色。 */
function lockedSuitsOf(state: SanguoshaState, playerId: PlayerId): Suit[] {
  const fromQihai: Suit[] = hasTargetState(state, playerId, QIHAI_STATE) ? ['heart'] : []
  // 杨芷【婉嫕】：武将牌上还压着哪些花色的婉嫕牌，就不能使用/打出那些花色的牌
  const fromSkills = skillsOf(state, playerId, skillIdsOf).flatMap((runtime) => runtime.locksOwnSuits?.(state, playerId) ?? [])
  return [...new Set([...fromQihai, ...fromSkills])]
}

/**
 * 这张实体牌现在能不能被这名角色**使用或打出**。
 *
 * 虚拟牌（技能凭空生成的）没有真实花色，不受花色禁令影响——
 * 真正被禁的是那张实体子牌，而它会各自走一遍这个判断。
 */
export function cardPlayableBySuit(state: SanguoshaState, playerId: PlayerId, cardId: CardId): boolean {
  const card = state.cards[cardId]
  if (!card || card.virtual) return true
  const locked = lockedSuitsOf(state, playerId)
  if (locked.length === 0) return true
  return !locked.includes(card.suit)
}

/** 这名角色现在有没有花色禁令，用于界面提示。 */
export function hasSuitLock(state: SanguoshaState, playerId: PlayerId): boolean {
  return lockedSuitsOf(state, playerId).length > 0
}
