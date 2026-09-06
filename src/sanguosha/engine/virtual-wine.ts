import type { SkillHost } from './skills/runtime'
import type { PlayerId } from './types'

/**
 * 「视为使用一张【酒】」（曹植【酒诗】）。
 *
 * 不需要实体酒，但**必须和真酒走同一套账**：本回合的酒次数、下一张【杀】的
 * 伤害加成读的都是 `state.turnUsage` 上那两个字段。另起一套计数会立刻错位——
 * 比如真酒用过之后酒诗还能再用一次。
 *
 * 生成的那张牌是**临时的**：进处理区、发一条使用事件、然后当场销毁。
 * 不留在弃牌堆里——牌堆构成不该因为一个技能凭空多出一张酒。
 */
export function useVirtualWine(host: SkillHost, playerId: PlayerId, sourceSkillId: string): void {
  const cardId = `virtual:${sourceSkillId}:${host.state.seq + 1}:${host.state.decisions.length}`
  host.state.cards[cardId] = {
    id: cardId,
    ruleset: host.state.rulesetVersion,
    expansion: 'standard',
    name: '酒',
    // 虚拟牌没有真实花色点数；规则判断必须查 `virtual`，不要读这三个字段
    suit: 'spade',
    rank: 1,
    color: 'black',
    category: 'basic',
    virtual: true,
    sourceSkillId,
  }
  host.state.zones.processingArea.push(cardId)
  host.dispatch('CardUsed', { cardId, cardName: '酒', targetIds: [playerId] }, {
    sourceId: playerId, targetId: playerId, cardIds: [cardId],
  })
  host.dispatch('AfterCardUse', { cardId, cardName: '酒', targetIds: [playerId], cancelled: false, virtual: true }, {
    sourceId: playerId, targetId: playerId, cardIds: [cardId],
  })
  // 用完就销毁：留着它，牌张守恒会认为场上凭空多了一张酒
  host.state.zones.processingArea = host.state.zones.processingArea.filter((id) => id !== cardId)
  delete host.state.cards[cardId]
}

/**
 * 出牌阶段用酒的效果：记一次酒、给下一张【杀】加伤。
 *
 * 和实体酒共用同一段状态，所以「本回合限一次」对两者一起生效。
 */
export function applyWineEffect(host: SkillHost): void {
  host.state.turnUsage.wineUses += 1
  host.state.turnUsage.wineDamageBonus = 1
}

/** 这一回合还能不能再用酒（含实体酒与技能视为的酒）。 */
export function canUseWineThisTurn(host: SkillHost): boolean {
  return host.state.turnUsage.wineUses < 1
}
