import { hasPickableCards, pickableCardsOf, resolvePickedCard } from '../../engine/card-pick'
import { detainCards } from '../../engine/turn-bound-pile'
import { registerSkillRuntime } from '../../engine/skills/runtime'
import type { ChooseCardsRequest } from '../../engine/requests'
import type { CardId, PlayerId, SanguoshaState } from '../../engine/types'
import type { CharacterDefinition } from './types'

/**
 * 徐盛（一将成名 2011 经典）。
 *
 * 【破军】：你于出牌阶段内使用【杀】指定一个目标后，你可以将其至多 X 张牌
 *          扣置于其武将牌旁（X 为其体力值），当前回合结束后，其获得这些牌。
 *
 * 六处最容易做错的：
 *
 * 1. **只在他自己的出牌阶段。** 回合外被别的技能指使着使用【杀】
 *    （法正【眩惑】、陈宫【明策】）不触发；判断的是**现在是谁的出牌阶段**，
 *    不是「这张杀是不是他用的」。
 * 2. **按目标触发，不是按这张牌触发。** 一张多目标的【杀】对每个目标
 *    各给一次机会——文本说的是「指定**一个**目标后」。
 * 3. **X 是目标此刻的体力值**，不是体力上限、不是已损失体力、
 *    更不是徐盛自己的体力。X ≤ 0 时不给一个必然落空的机会。
 * 4. **暗手牌只给占位槽**：徐盛不能先看清对方手牌再挑。
 * 5. **扣置是一次原子移动**，装备是真的离开装备区（枭姬、旋风、
 *    白银狮子照常触发）；一次扣走多件装备，旋风只算一次。
 * 6. **归还、死亡清理都不归这个技能管**：那是公共牌区的事
 *    （`engine/turn-bound-pile.ts`），技能只负责「扣哪几张」。
 */

const POJUN = 'pojun'

function playerOf(state: SanguoshaState, playerId: PlayerId) {
  return state.players.find((candidate) => candidate.id === playerId)
}

/** 现在这个目标最多能被扣几张。0 表示不该给机会。 */
function pojunLimit(state: SanguoshaState, targetId: PlayerId): number {
  const target = playerOf(state, targetId)
  if (!target?.alive) return 0
  // X 是**此刻的体力值**；同时不能超过他实际拥有的可扣牌数
  const pickable = pickableCardsOf(state, targetId)
  const available = pickable.cardIds.length + pickable.hiddenCardSlots.length
  return Math.max(0, Math.min(target.hp, available))
}

registerSkillRuntime({
  id: POJUN,
  announcesSelf: true,

  interceptSourceTarget(host, ownerId, context) {
    if (context.cardName !== '杀') return false
    /*
     * **必须是他自己的出牌阶段。**
     *
     * 回合外被别的技能指使着使用【杀】时，虽然使用者是徐盛，
     * 但那不是「你于出牌阶段内使用【杀】」。判断读的是牌局的回合与阶段，
     * 不是这张牌的使用者。
     */
    if (host.state.phase !== 'play' || host.state.currentPlayerId !== ownerId) return false
    const owner = playerOf(host.state, ownerId)
    const target = playerOf(host.state, context.targetId)
    if (!owner?.alive || !target?.alive || target.id === ownerId) return false
    const limit = pojunLimit(host.state, context.targetId)
    if (limit <= 0) return false
    if (!hasPickableCards(host.state, context.targetId)) return false

    const pickable = pickableCardsOf(host.state, context.targetId)
    host.askSkill({
      skillId: POJUN, ownerId, step: 'detain', data: { targetId: context.targetId },
      build: (requestId): ChooseCardsRequest => ({
        id: requestId, kind: 'choose-cards', playerId: ownerId,
        prompt: `【破军】：将${target.nickname}的至多 ${limit} 张牌扣置于其武将牌旁（其体力值为 ${target.hp}）`,
        timeoutMs: 25_000,
        // 「至多」：一张都不扣就是不发动
        optional: true, purpose: 'skill',
        // 手牌只给占位槽，徐盛看不到牌面；装备是明置的
        cardIds: pickable.cardIds, hiddenCardSlots: pickable.hiddenCardSlots,
        min: 0, max: limit,
      }),
    })
    return true
  },

  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'detain') {
      host.resumeCardTarget()
      return
    }
    const targetId = resolution.data.targetId as PlayerId
    const picks = (response.payload as { cardIds?: string[] }).cardIds ?? []
    const owner = playerOf(host.state, ownerId)
    const target = playerOf(host.state, targetId)
    if (!owner?.alive || !target?.alive || picks.length === 0) {
      // 无论发不发动，**都必须把控制权交回去**，否则这张杀停在指定目标那一步
      host.resumeCardTarget()
      return
    }
    /*
     * 落地前重新验一次：发问期间目标的牌可能已经被别的效果动过，
     * 体力值也可能变了（所以上限要现算）。
     */
    const limit = pojunLimit(host.state, targetId)
    const cardIds: CardId[] = []
    for (const picked of picks.slice(0, limit)) {
      const cardId = resolvePickedCard(host.state, targetId, picked)
      if (cardId && !cardIds.includes(cardId)) cardIds.push(cardId)
    }
    const detained = detainCards(host as never, { ownerId: targetId, sourceId: ownerId, skillId: POJUN, cardIds })
    if (detained.length > 0) {
      host.dispatch('SkillActivated', {
        skillId: POJUN, skillName: '破军', playerId: ownerId, targetId,
        logText: `${owner.nickname}发动【破军】，将${target.nickname}的 ${detained.length} 张牌扣置于其武将牌旁`,
      }, { sourceId: ownerId, targetId })
    }
    host.resumeCardTarget()
  },
})

export const XUSHENG: CharacterDefinition = {
  id: 'xusheng',
  name: '徐盛',
  kingdom: 'wu',
  gender: 'male',
  maxHp: 4,
  pack: 'yjcm2011',
  skills: [
    {
      id: POJUN,
      name: '破军',
      description: '你于出牌阶段内使用【杀】指定一个目标后，你可以将其至多 X 张牌'
        + '扣置于其武将牌旁（X 为其体力值），当前回合结束后，其获得这些牌。',
    },
  ],
}
