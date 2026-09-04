import { finishMultiCardViewAs, type MultiCardViewAsSpec } from '../../engine/multi-card-viewas'
import { registerSkillRuntime } from '../../engine/skills/runtime'
import type { CardId, PlayerId, SanguoshaState } from '../../engine/types'
import type { CharacterDefinition } from './types'

/**
 * 神赵云。经典《神话再临·山》**原版**，2 体力。
 *
 * 【绝境】：锁定技，你的摸牌阶段额外摸 X 张牌（X 为你已损失的体力值）；你的手牌上限 +2。
 * 【龙魂】：你可以将 X 张花色相同的牌（X 为你的当前体力值且至少为 1）当作
 *   【桃】（红桃）、火焰【杀】（方块）、【闪】（梅花）、【无懈可击】（黑桃）使用或打出。
 *
 * **不采用 2018 重做版。** 那一版有「进入或脱离濒死时摸一张」「龙魂至多两张牌」
 * 「两张红牌伤害/回复 +1」「两张黑牌弃当前回合角色一张牌」——本项目一条都不要。
 *
 * 两个和上一批容易混的地方：
 *
 * - 绝境的手牌上限 +2 **是经典文本确实存在的**，和神诸葛亮【七星】没有手牌上限加成不同。
 * - 龙魂的 X 是**当前体力**，不是已损失体力；濒死时体力 0 或负数，X 仍按至少 1 算，
 *   所以 1 张红桃就能龙魂成【桃】自救。
 */

const JUEJING = 'juejing'
const LONGHUN = 'longhun'

function playerOf(state: SanguoshaState, playerId: PlayerId) {
  return state.players.find((candidate) => candidate.id === playerId)
}

/** 龙魂这一刻需要几张同花色的牌。 */
export function longhunRequiredCount(state: SanguoshaState, playerId: PlayerId): number {
  const owner = playerOf(state, playerId)
  if (!owner) return 1
  // **至少为 1**：0 血和负血濒死时都只要一张
  return Math.max(1, owner.hp)
}

registerSkillRuntime({
  id: JUEJING,

  triggers: [{
    /**
     * 摸牌阶段额外摸「已损失体力值」张。
     *
     * 走公共的「改事件里的 count」约定，**不是**取消 DrawPhase 自己接管摸牌——
     * 绝境是增加正常摸牌数量，不是替换摸牌阶段。
     * 摸牌阶段整个被跳过（兵粮寸断、神速）时 `DrawPhase` 根本不会派发，
     * 于是绝境自然也不会凭空多摸，不需要额外判断。
     */
    event: 'DrawPhase',
    handle(host, ownerId, context) {
      const payload = context.event.payload as { playerId?: PlayerId; count?: number }
      if (payload.playerId !== ownerId) return
      const owner = playerOf(host.state, ownerId)
      if (!owner?.alive) return
      // 按**当前**最大体力算，不写死 2：将来最大体力变化时这里自动跟着变
      const lost = Math.max(0, owner.maxHp - owner.hp)
      if (lost <= 0) return
      payload.count = Math.max(0, Math.trunc(Number(payload.count ?? 2))) + lost
      host.dispatch('SkillActivated', {
        skillId: JUEJING, skillName: '绝境', playerId: ownerId,
        logText: `【绝境】${owner.nickname}额外摸 ${lost} 张牌`,
      }, { sourceId: ownerId })
    },
  }],

  /**
   * 手牌上限 +2。
   *
   * 这一条经典神赵云**确实有**——和神诸葛亮【七星】没有手牌上限加成不是一回事，
   * 不要因为上一批的教训就把它一起删掉。
   */
  maxCardsBonus() {
    return 2
  },
})

registerSkillRuntime({
  id: LONGHUN,

  /**
   * 向公共的多牌转化机制报备：需要几张、哪种花色转成什么。
   *
   * 引擎据此在求闪 / 求桃 / 无懈 / 锦囊效果里挂出声明动作，
   * 龙魂本身不碰那四条响应路径。
   */
  multiCardViewAs(state, ownerId): MultiCardViewAsSpec {
    return {
      skillId: LONGHUN,
      requiredCount: longhunRequiredCount(state, ownerId),
      suitToCardName: {
        heart: '桃',
        diamond: '杀',
        club: '闪',
        spade: '无懈可击',
      },
      // 方块转出来的是**火焰**【杀】，不是普通杀
      natureOf: { diamond: 'fire' },
    }
  },

  resume(host, _ownerId, resolution, response) {
    if (resolution.step !== 'multi-viewas') return
    const cardIds = ((response.payload as { cardIds?: CardId[] }).cardIds ?? [])
    finishMultiCardViewAs(host, cardIds)
  },
})

export const SHENZHAOYUN: CharacterDefinition = {
  id: 'shenzhaoyun',
  name: '神·赵云',
  kingdom: 'shen',
  gender: 'male',
  maxHp: 2,
  pack: 'god',
  skills: [
    {
      id: JUEJING,
      name: '绝境',
      description: '锁定技，你的摸牌阶段额外摸X张牌（X为你已损失的体力值）；你的手牌上限+2。',
    },
    {
      id: LONGHUN,
      name: '龙魂',
      description: '你可以将X张花色相同的牌（X为你的当前体力值且至少为1）当作【桃】（红桃）、火【杀】（方块）、【闪】（梅花）或【无懈可击】（黑桃）使用或打出。',
    },
  ],
}
