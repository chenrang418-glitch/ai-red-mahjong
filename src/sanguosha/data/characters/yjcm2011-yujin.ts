import { registerSkillRuntime } from '../../engine/skills/runtime'
import type { PlayerId, SanguoshaState } from '../../engine/types'
import type { CharacterDefinition } from './types'

/**
 * 于禁（一将成名 2011 原版）。
 *
 * 【毅重】：锁定技，若你的装备区里没有防具牌，则黑色的【杀】对你无效。
 *
 * 三处最容易做错的：
 *
 * 1. **条件是「防具栏里没有防具」，不是「装备区是空的」。** 带着武器和马、
 *    只是没穿防具，毅重照样生效。
 * 2. **是「对你无效」，不是「不能选你为目标」。** 黑色【杀】仍然可以指定他，
 *    使用照常成立，只是对他不产生效果——所以也不该再问他要【闪】。
 *    在选目标阶段把他删掉是另一条规则，会让【杀】的目标数、连环、
 *    伤害归属全部错位。
 * 3. **颜色按有效颜色算。** 转化技把一张黑牌当【杀】用时，那张【杀】是黑色的；
 *    只看印刷牌名或者只取多张子牌里的第一张，都会判错。
 *    这一条由引擎统一提供，这里只做判断。
 */

const YIZHONG = 'yizhong'

/**
 * 装备区里有没有防具牌。
 *
 * 看的是**实际有没有那张牌**，不是「防具栏还在不在」：防具栏被废除时
 * 栏里当然也没有防具，条件同样成立。
 */
function hasArmorCard(state: SanguoshaState, ownerId: PlayerId): boolean {
  const owner = state.players.find((candidate) => candidate.id === ownerId)
  return !!owner?.zones.equipment.armor
}

registerSkillRuntime({
  id: YIZHONG,
  cardEffectInvalid(state, ownerId, _sourceId, cardName, cardColor) {
    if (cardName !== '杀') return false
    /*
     * 颜色由引擎按有效颜色算好传进来。虚拟牌没有颜色（null），
     * 那种【杀】不是黑色的，毅重不管它。
     */
    if (cardColor !== 'black') return false
    /*
     * 判断发生在**效果开始结算的那一刻**。
     *
     * 指定目标之后、结算之前防具被拆掉的话，这里读到的就是「没有防具」，
     * 毅重成立——快照在指定目标时的状态是错的。
     */
    return !hasArmorCard(state, ownerId)
  },
})

export const YUJIN: CharacterDefinition = {
  id: 'yujin',
  name: '于禁',
  kingdom: 'wei',
  gender: 'male',
  maxHp: 4,
  pack: 'yjcm2011',
  skills: [
    {
      id: YIZHONG,
      name: '毅重',
      description: '锁定技，若你的装备区里没有防具牌，则黑色的【杀】对你无效。',
    },
  ],
}
