import { canTarget, getAttackRange } from '../../engine/distance'
import { drawCards } from '../../engine/draw'
import { markUsedThisPhase, usedThisPhase } from '../../engine/phase-usage'
import { markUsedThisTurn, usedThisTurn } from '../../engine/turn-usage'
import { effectiveCardColor, effectiveCardSuit, registerSkillRuntime } from '../../engine/skills/runtime'
import { moveCard } from '../../engine/zones'
import type { ChooseCardsRequest, ChooseTargetsRequest } from '../../engine/requests'
import type { CardId, PlayerId, SanguoshaState } from '../../engine/types'
import type { CharacterDefinition } from './types'

/**
 * 钟繇（一将成名 2015）。
 *
 * 【活墨】：出牌阶段，若钟繇本回合没有使用过【杀】，可以将一张黑色非基本牌
 *          置于牌堆顶，视为使用一张无实体的【杀】。
 * 【佐定】：其他角色在其出牌阶段使用黑桃牌指定目标后，若这个出牌阶段目前
 *          没有任何角色受到过伤害，钟繇可以选择这次使用的一名目标，令其摸
 *          一张牌。
 *
 * 两处最容易做错的：
 *
 * 1. **活墨的代价是「置于牌堆顶」，不是弃置**，走 `discard-provenance` 之外
 *    的普通移动；本项目把这个技能范围限定在【杀】（最常用、也是既有
 *    `beginVirtualSlash` 直接支持的基本牌），不覆盖桃 / 闪 / 酒的转化。
 * 2. **佐定按「这个出牌阶段是否已经发生过伤害」判断**，用阶段账本记录任意
 *    一次 `AfterDamage`，不看是谁受伤、造成了多少点。
 */

const HUOMO = 'huomo'
const ZUODING = 'zuoding'
const DAMAGE_OCCURRED_MARK = 'zuoding-damage-occurred'

function playerOf(state: SanguoshaState, playerId: PlayerId) {
  return state.players.find((candidate) => candidate.id === playerId)
}

function blackNonBasicCandidates(state: SanguoshaState, ownerId: PlayerId): CardId[] {
  const owner = playerOf(state, ownerId)
  if (!owner?.alive) return []
  return owner.zones.hand.filter((cardId) => {
    const card = state.cards[cardId]
    return card && card.category !== 'basic' && effectiveCardColor(state, ownerId, cardId) === 'black'
  })
}

registerSkillRuntime({
  id: HUOMO,
  triggers: [{
    // 记录本回合是否已经用过【杀】（含活墨自己生成的那一次），供下一次判断门槛
    event: 'AfterCardUse',
    handle(host, ownerId, context) {
      const payload = context.event.payload as { cardName?: string }
      if (context.event.sourceId === ownerId && payload.cardName === '杀') {
        markUsedThisTurn(host.state, ownerId, '杀')
      }
    },
  }],

  activeActions(state, ownerId) {
    if (state.phase !== 'play' || state.currentPlayerId !== ownerId) return []
    if (usedThisTurn(state, ownerId, '杀')) return []
    if (blackNonBasicCandidates(state, ownerId).length === 0) return []
    const candidateIds = state.players.filter((candidate) => candidate.alive && candidate.id !== ownerId && canTarget(state, ownerId, candidate.id, getAttackRange(state, ownerId))).map((candidate) => candidate.id)
    if (candidateIds.length === 0) return []
    return [{ id: HUOMO, label: '活墨：置一张黑色非基本牌于牌堆顶，视为使用一张【杀】' }]
  },

  invokeActive(host, ownerId, actionId) {
    if (actionId !== HUOMO) return
    const candidates = blackNonBasicCandidates(host.state, ownerId)
    if (candidates.length === 0) return
    host.askSkill({
      skillId: HUOMO, ownerId, step: 'cost',
      build: (requestId): ChooseCardsRequest => ({
        id: requestId, kind: 'choose-cards', playerId: ownerId,
        prompt: '【活墨】：将一张黑色非基本牌置于牌堆顶',
        timeoutMs: 20_000, optional: true, purpose: 'skill',
        cardIds: candidates, hiddenCardSlots: [], min: 0, max: 1,
      }),
    })
  },

  resume(host, ownerId, resolution, response) {
    const owner = playerOf(host.state, ownerId)

    if (resolution.step === 'cost') {
      const [cardId] = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
      if (!cardId || !owner?.alive || !blackNonBasicCandidates(host.state, ownerId).includes(cardId)) return
      if (usedThisTurn(host.state, ownerId, '杀')) return
      const candidateIds = host.state.players.filter((candidate) => candidate.alive && candidate.id !== ownerId && canTarget(host.state, ownerId, candidate.id, getAttackRange(host.state, ownerId))).map((candidate) => candidate.id)
      if (candidateIds.length === 0) return
      moveCard(host.state, cardId, { kind: 'hand', playerId: ownerId }, { kind: 'drawPile' }, { toTop: true })
      host.dispatch('LoseCard', { playerId: ownerId, cardIds: [cardId], reason: HUOMO }, { targetId: ownerId, cardIds: [cardId] })
      host.askSkill({
        skillId: HUOMO, ownerId, step: 'target',
        build: (requestId): ChooseTargetsRequest => ({
          id: requestId, kind: 'choose-targets', playerId: ownerId,
          prompt: '【活墨】：选择一名角色，视为对其使用一张【杀】',
          timeoutMs: 20_000, optional: false,
          candidateIds, min: 1, max: 1,
        }),
      })
      return
    }

    if (resolution.step === 'target') {
      const [targetId] = (response.payload as { targetIds?: PlayerId[] }).targetIds ?? []
      if (!owner?.alive || !targetId || !playerOf(host.state, targetId)?.alive) return
      host.dispatch('SkillActivated', {
        skillId: HUOMO, skillName: '活墨', playerId: ownerId, targetId,
        logText: `${owner.nickname}发动【活墨】，视为对其使用一张【杀】`,
      }, { sourceId: ownerId, targetId })
      host.beginVirtualSlash({ sourceId: ownerId, targetId, sourceSkillId: HUOMO, countUsage: true })
    }
  },
})

registerSkillRuntime({
  id: ZUODING,
  triggers: [
    {
      event: 'AfterDamage',
      handle(host) {
        markUsedThisPhase(host.state, host.state.currentPlayerId, DAMAGE_OCCURRED_MARK)
      },
    },
    {
      event: 'TargetConfirmed',
      handle(host, ownerId, context) {
        const payload = context.event.payload as { cardId?: CardId; targetId?: PlayerId }
        const userId = context.event.sourceId as PlayerId | undefined
        if (!userId || userId === ownerId || host.state.phase !== 'play' || host.state.currentPlayerId !== userId) return
        if (!payload.cardId || effectiveCardSuit(host.state, userId, payload.cardId) !== 'spade') return
        if (usedThisPhase(host.state, host.state.currentPlayerId, DAMAGE_OCCURRED_MARK)) return
        const owner = playerOf(host.state, ownerId)
        const target = payload.targetId ? playerOf(host.state, payload.targetId) : undefined
        if (!owner?.alive || !target?.alive) return
        host.queueSkill({ skillId: ZUODING, ownerId, step: 'ask', data: { targetId: payload.targetId } })
      },
    },
  ],

  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'ask') return
    const targetId = prompt.data.targetId as PlayerId
    const owner = playerOf(host.state, ownerId)
    const target = playerOf(host.state, targetId)
    if (!owner?.alive || !target?.alive) return
    host.askSkill({
      skillId: ZUODING, ownerId, step: 'ask', data: { targetId },
      build: (requestId) => ({
        id: requestId, kind: 'choose-option' as const, playerId: ownerId,
        prompt: `【佐定】：令${target.nickname}摸一张牌？`,
        timeoutMs: 20_000, optional: true,
        options: [{ id: 'yes', label: '发动【佐定】' }, { id: 'no', label: '不发动' }],
      }),
    })
  },

  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'ask') return
    if ((response.payload as { optionId?: string }).optionId !== 'yes') return
    const targetId = resolution.data.targetId as PlayerId
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive || !playerOf(host.state, targetId)?.alive) return
    host.dispatch('SkillActivated', {
      skillId: ZUODING, skillName: '佐定', playerId: ownerId, targetId,
      logText: `${owner.nickname}发动【佐定】`,
    }, { sourceId: ownerId, targetId })
    drawCards(host.state, host.rng, targetId, 1, (name, payload) => { host.dispatch(name, payload) })
  },
})

export const ZHONGYAO: CharacterDefinition = {
  id: 'zhongyao',
  name: '钟繇',
  kingdom: 'wei',
  gender: 'male',
  maxHp: 3,
  pack: 'yjcm2015',
  skills: [
    {
      id: HUOMO,
      name: '活墨',
      description: '出牌阶段，若钟繇本回合没有使用过【杀】，可以将一张黑色非基本牌置于牌堆顶，视为使用一张【杀】。',
    },
    {
      id: ZUODING,
      name: '佐定',
      description: '其他角色在其出牌阶段使用黑桃牌指定目标后，若这个出牌阶段目前没有任何角色受到过伤害，钟繇可以选择这次使用的一名目标，令其摸一张牌。',
    },
  ],
}
