import { finishMultiCardViewAs, type MultiCardViewAsSpec } from '../../engine/multi-card-viewas'
import { drawCards } from '../../engine/draw'
import { movePickedCard, pickableCardsOf, resolvePickedCard } from '../../engine/card-pick'
import { registerSkillRuntime } from '../../engine/skills/runtime'
import { clearTemporaryCardSkillTag, hasTemporaryCardSkillTag, setTemporaryCardSkillTag } from '../../engine/temporary-card-skill-tags'
import type { ChooseCardsRequest } from '../../engine/requests'
import type { CardId, PlayerId, SanguoshaState } from '../../engine/types'
import type { CharacterDefinition } from './types'

/**
 * 神赵云。按武将册当前采用版本，2 体力。
 *
 * 【绝境】：锁定技，手牌上限 +2；进入或脱离濒死时摸一张牌。
 * 【龙魂】：至多两张同花色牌转化；两张红牌使回复或伤害 +1，两张黑牌弃当前回合角色一张牌。
 *
 * 主动用牌、响应、两牌奖励分别走共享牌流程与龙魂自身回调；龙魂仍需补足多响应嵌套和死亡等边界验证。
 */

const JUEJING = 'juejing'
const LONGHUN = 'longhun'
const LONGHUN_TWO_RED = `${LONGHUN}:two-red`
const LONGHUN_TWO_BLACK = `${LONGHUN}:two-black`

function playerOf(state: SanguoshaState, playerId: PlayerId) {
  return state.players.find((candidate) => candidate.id === playerId)
}

registerSkillRuntime({
  id: JUEJING,

  triggers: (['EnterDying', 'QuitDying'] as const).map((event) => ({
    event,
    handle(host, ownerId, context) {
      const payload = context.event.payload as { playerId?: PlayerId }
      if (payload.playerId !== ownerId) return
      const owner = playerOf(host.state, ownerId)
      if (!owner?.alive) return
      drawCards(host.state, host.rng, ownerId, 1, (name, drawPayload) => host.dispatch(name, drawPayload, { sourceId: ownerId }))
      host.dispatch('SkillActivated', {
        skillId: JUEJING, skillName: '绝境', playerId: ownerId,
        logText: `【绝境】${owner.nickname}摸一张牌`,
      }, { sourceId: ownerId })
    },
  })),

  /** 手牌上限 +2。 */
  maxCardsBonus() {
    return 2
  },
})

registerSkillRuntime({
  id: LONGHUN,

  /** 向公共多牌转化机制声明龙魂自己的转化规则。 */
  multiCardViewAs(_state, _ownerId): MultiCardViewAsSpec {
    return {
      skillId: LONGHUN,
      skillName: '龙魂',
      requiredCount: 1,
      maxCount: 2,
      activePlaySuits: ['heart', 'diamond'],
      suitToCardName: {
        heart: '桃',
        diamond: '杀',
        club: '闪',
        spade: '无懈可击',
      },
      // 方块转出来的是**火焰**【杀】，不是普通杀
      natureOf: { diamond: 'fire' },
      onConvert(state, _ownerId, carrierId, cardIds, _asCardName) {
        if (cardIds.length !== 2) return
        const colors = cardIds.map((id) => state.cards[id]?.color)
        if (colors.every((color) => color === 'red')) setTemporaryCardSkillTag(state, carrierId, LONGHUN_TWO_RED)
        if (colors.every((color) => color === 'black')) setTemporaryCardSkillTag(state, carrierId, LONGHUN_TWO_BLACK)
      },
    }
  },

  triggers: [
    {
      event: 'CardUsed',
      handle(host, ownerId, context) {
        const payload = context.event.payload as { cardId?: CardId }
        if (!payload.cardId || !hasTemporaryCardSkillTag(host.state, payload.cardId, LONGHUN_TWO_BLACK)) return
        const targetId = host.state.currentPlayerId
        if (!targetId || !pickableCardsOf(host.state, targetId, { discarderId: ownerId }).cardIds.length
          && !pickableCardsOf(host.state, targetId, { discarderId: ownerId }).hiddenCardSlots.length) return
        host.queueSkill({ skillId: LONGHUN, ownerId, step: 'discard-current-turn', data: { targetId } })
      },
    },
    {
      event: 'CardResponded',
      handle(host, ownerId, context) {
        const payload = context.event.payload as { asking?: boolean; cardId?: CardId; playerId?: PlayerId }
        if (payload.asking || payload.playerId !== ownerId || !payload.cardId
          || !hasTemporaryCardSkillTag(host.state, payload.cardId, LONGHUN_TWO_BLACK)) return
        const targetId = host.state.currentPlayerId
        if (!targetId) return
        const pickable = pickableCardsOf(host.state, targetId, { discarderId: ownerId })
        if (!pickable.cardIds.length && !pickable.hiddenCardSlots.length) return
        host.queueSkill({ skillId: LONGHUN, ownerId, step: 'discard-current-turn', data: { targetId } })
      },
    },
    {
      event: 'AfterCardUse',
      handle(host, _ownerId, context) {
        const payload = context.event.payload as { cardId?: CardId }
        const cardId = payload.cardId
        if (cardId && (hasTemporaryCardSkillTag(host.state, cardId, LONGHUN_TWO_RED)
          || hasTemporaryCardSkillTag(host.state, cardId, LONGHUN_TWO_BLACK))) clearTemporaryCardSkillTag(host.state, cardId)
      },
    },
  ],

  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'discard-current-turn') return
    const targetId = prompt.data.targetId as PlayerId
    if (!playerOf(host.state, ownerId)?.alive || !playerOf(host.state, targetId)?.alive) return
    const pickable = pickableCardsOf(host.state, targetId, { discarderId: ownerId })
    if (!pickable.cardIds.length && !pickable.hiddenCardSlots.length) return
    host.askSkill({
      skillId: LONGHUN, ownerId, step: 'discard-current-turn', data: { targetId },
      build: (requestId): ChooseCardsRequest => ({
        id: requestId, kind: 'choose-cards', playerId: ownerId,
        prompt: `【龙魂】：弃置当前回合角色${playerOf(host.state, targetId)?.nickname ?? '的'}一张牌`,
        timeoutMs: 25_000, optional: false, purpose: 'skill',
        cardIds: pickable.cardIds, hiddenCardSlots: pickable.hiddenCardSlots, min: 1, max: 1,
      }),
    })
  },

  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'discard-current-turn') {
      const targetId = resolution.data.targetId as PlayerId
      const picked = ((response.payload as { cardIds?: string[] }).cardIds ?? [])[0]
      if (!picked) return
      const cardId = resolvePickedCard(host.state, targetId, picked)
      if (!cardId || !movePickedCard(host as never, targetId, cardId, { kind: 'discardPile' })) return
      host.dispatch('LoseCard', { playerId: targetId, cardIds: [cardId], reason: LONGHUN }, { sourceId: ownerId, targetId, cardIds: [cardId] })
      return
    }
    if (resolution.step !== 'multi-viewas') return
    const cardIds = ((response.payload as { cardIds?: CardId[] }).cardIds ?? [])
    finishMultiCardViewAs(host, cardIds)
  },

  outgoingDamage(state, _ownerId, context) {
    if (!context.chainTransfer && context.cardId && hasTemporaryCardSkillTag(state, context.cardId, LONGHUN_TWO_RED))
      return { amount: context.amount + 1 }
    return null
  },

  recoverAmountBonus(state, _targetId, _sourceId, sourceCardId) {
    return sourceCardId && hasTemporaryCardSkillTag(state, sourceCardId, LONGHUN_TWO_RED) ? 1 : 0
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
      description: '锁定技，你的手牌上限+2；当你进入或脱离濒死状态时，你摸一张牌。',
    },
    {
      id: LONGHUN,
      name: '龙魂',
      description: '你可以将至多两张花色相同的牌按以下规则使用或打出：红桃当【桃】；方块当火【杀】；梅花当【闪】；黑桃当【无懈可击】。若你以此法使用了两张红色牌，则此牌回复值或伤害值+1。若你以此法使用了两张黑色牌，则你弃置当前回合角色一张牌。',
    },
  ],
}
