import { INSTANT_TRICKS, instantTrickActions } from './cards/tricks'
import type { CardId, PlayerId, SanguoshaState } from './types'

/**
 * 「视为使用一张普通锦囊牌」。
 *
 * 神郭嘉【佐幸】要印一张任意普通锦囊。不能写成一长串
 * `if 选了决斗 … else if 选了火攻 …`——那是把整套锦囊逻辑在武将文件里再抄一遍，
 * 而且每加一张新锦囊都要回来改。
 *
 * 做法是复用引擎里**已经存在**的虚拟牌生命周期（`cards/basic.ts` 的虚拟【杀】
 * 走的就是这一套）：合成一张 `virtual: true` 的牌 → 放进使用者手牌 →
 * 走正常的使用管线 → `finishPhysicalCard` 结算后把它 `delete` 掉。
 *
 * 三个直接后果，都是规则要求的：
 *
 * 1. **不产生实体牌**，结算完就销毁，不会凭空多一张【决斗】进弃牌堆，
 *    牌张守恒不受影响；
 * 2. **目标合法性、距离、帷幕、无懈全部照常**，因为走的是同一条锦囊管线；
 * 3. **神荀彧【灵策】不会被它触发**——灵策要求「非虚拟非转化」，
 *    这张牌 `virtual` 为真，自然被挡在外面。
 */

/**
 * 现在能印哪些普通锦囊。
 *
 * 从锦囊注册表动态生成，不写死名单；并且**逐个试算合法目标**，
 * 印出来却没有合法目标的牌不进候选（选了也用不出去，只会让玩家卡住）。
 */
export function virtualTrickChoices(state: SanguoshaState, sourceId: PlayerId): string[] {
  const probeId = `virtual-probe:${sourceId}`
  const choices: string[] = []
  for (const name of INSTANT_TRICKS) {
    // 用一张临时探针牌问引擎「这张牌现在有合法动作吗」，问完立刻撤掉
    state.cards[probeId] = {
      id: probeId,
      ruleset: state.rulesetVersion,
      expansion: 'standard',
      name,
      suit: 'spade',
      rank: 1,
      color: 'black',
      category: 'trick',
      virtual: true,
    }
    let usable = false
    try {
      usable = instantTrickActions(state, sourceId, probeId, name).length > 0
    } finally {
      delete state.cards[probeId]
    }
    if (usable) choices.push(name)
  }
  return choices
}

/**
 * 合成一张虚拟普通锦囊并放进使用者手牌，返回它的 id。
 *
 * 调用方拿到 id 之后自己走使用流程（选目标、`beginInstantTrick`）。
 * 牌的销毁由 `finishPhysicalCard` 统一负责，调用方不要自己删。
 */
export function createVirtualTrick(
  state: SanguoshaState,
  sourceId: PlayerId,
  name: string,
  sourceSkillId: string,
): CardId {
  if (!INSTANT_TRICKS.has(name)) throw new Error(`不是普通锦囊：${name}`)
  const source = state.players.find((candidate) => candidate.id === sourceId)
  if (!source) throw new Error(`玩家不存在：${sourceId}`)
  const cardId = `virtual:${sourceSkillId}:${state.seq + 1}:${state.decisions.length}`
  state.cards[cardId] = {
    id: cardId,
    ruleset: state.rulesetVersion,
    expansion: 'standard',
    name,
    // 虚拟牌没有真实花色；字段只为满足统一牌对象结构，规则判断必须查 virtual
    suit: 'spade',
    rank: 1,
    color: 'black',
    category: 'trick',
    virtual: true,
    sourceSkillId,
  }
  source.zones.hand.push(cardId)
  return cardId
}
