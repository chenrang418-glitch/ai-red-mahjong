import { drawCards } from '../../engine/draw'
import { movePickedCard, pickableCardsOf, resolvePickedCard } from '../../engine/card-pick'
import { registerSkillRuntime } from '../../engine/skills/runtime'
import { moveCard } from '../../engine/zones'
import type { ChooseOptionRequest, ChooseTargetsRequest } from '../../engine/requests'
import type { PlayerId, SanguoshaState } from '../../engine/types'
import type { CharacterDefinition } from './types'

/**
 * 王基（三国杀 OL 经典身份 SP）。
 *
 * 【奇制】：王基于自己的回合内使用非装备牌指定目标后，可以选择另一名角色，
 *          弃置其一张牌，然后其摸一张牌。
 * 【进趋】：结束阶段，王基可以摸 2 张牌，然后将手牌调整至 X 张（X 为本回合
 *          内王基发动【奇制】的次数）。
 *
 * 最容易做错的：**进趋是「调整至 X 张」，不是「弃 X 张」**——当前手牌数
 * 已经 ≤ X 时不弃；X 记在回合范围内的计数（本回合结束时读，之后随
 * `TurnEnd` 统一清空 `turnUsedSkills` 一起归零，改用独立标记避免和
 * 「限一次」语义混在一起）。
 */

const QIZHI = 'qizhi'
const JINQU = 'jinqu'
const QIZHI_TURN_MARK = 'qizhi-turn'
const QIZHI_COUNT_MARK = 'qizhi-count'

function playerOf(state: SanguoshaState, playerId: PlayerId) {
  return state.players.find((candidate) => candidate.id === playerId)
}

function qizhiCount(state: SanguoshaState, ownerId: PlayerId): number {
  const owner = playerOf(state, ownerId)
  if (!owner || owner.marks[QIZHI_TURN_MARK] !== state.turnNumber) return 0
  return owner.marks[QIZHI_COUNT_MARK] ?? 0
}

registerSkillRuntime({
  id: QIZHI,
  triggers: [{
    event: 'TargetConfirmed',
    handle(host, ownerId, context) {
      if (context.event.sourceId !== ownerId || host.state.currentPlayerId !== ownerId) return
      const payload = context.event.payload as { cardId?: string; targetId?: PlayerId }
      const card = payload.cardId ? host.state.cards[payload.cardId] : undefined
      if (!card || card.category === 'equipment') return
      const targetId = payload.targetId ?? context.event.targetId
      if (!targetId) return
      host.queueSkill({ skillId: QIZHI, ownerId, step: 'ask', data: { originalTargetId: targetId } })
    },
  }],

  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'ask') return
    if (!playerOf(host.state, ownerId)?.alive) return
    host.askSkill({
      skillId: QIZHI, ownerId, step: 'ask', data: prompt.data,
      build: (requestId): ChooseOptionRequest => ({
        id: requestId, kind: 'choose-option', playerId: ownerId,
        prompt: '【奇制】：选择另一名角色，弃置其一张牌，其摸一张牌？',
        timeoutMs: 20_000, optional: true,
        options: [{ id: 'yes', label: '发动【奇制】' }, { id: 'no', label: '不发动' }],
      }),
    })
  },

  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'ask') {
      if ((response.payload as { optionId?: string }).optionId !== 'yes') return
      const originalTargetId = resolution.data.originalTargetId as PlayerId
      const candidateIds = host.state.players.filter((candidate) => candidate.alive && candidate.id !== originalTargetId).map((candidate) => candidate.id)
      if (candidateIds.length === 0) return
      host.askSkill({
        skillId: QIZHI, ownerId, step: 'target',
        build: (requestId): ChooseTargetsRequest => ({
          id: requestId, kind: 'choose-targets', playerId: ownerId,
          prompt: '【奇制】：选择另一名角色', timeoutMs: 20_000, optional: false, candidateIds, min: 1, max: 1,
        }),
      })
      return
    }

    if (resolution.step === 'target') {
      const [targetId] = (response.payload as { targetIds?: PlayerId[] }).targetIds ?? []
      const owner = playerOf(host.state, ownerId)
      const target = targetId ? playerOf(host.state, targetId) : undefined
      if (!owner?.alive || !target?.alive) return
      const pickable = pickableCardsOf(host.state, targetId!)
      if (pickable.cardIds.length + pickable.hiddenCardSlots.length === 0) return
      if (owner.marks[QIZHI_TURN_MARK] !== host.state.turnNumber) {
        owner.marks[QIZHI_TURN_MARK] = host.state.turnNumber
        owner.marks[QIZHI_COUNT_MARK] = 0
      }
      owner.marks[QIZHI_COUNT_MARK] = (owner.marks[QIZHI_COUNT_MARK] ?? 0) + 1
      host.dispatch('SkillActivated', {
        skillId: QIZHI, skillName: '奇制', playerId: ownerId, targetId,
        logText: `${owner.nickname}发动【奇制】，弃置${target.nickname}一张牌，其摸一张牌`,
      }, { sourceId: ownerId, targetId })
      const slot = pickable.hiddenCardSlots.length > 0
        ? pickable.hiddenCardSlots[host.rng.nextInt(pickable.hiddenCardSlots.length)]
        : pickable.cardIds[host.rng.nextInt(pickable.cardIds.length)]
      const cardId = resolvePickedCard(host.state, targetId!, slot)
      if (cardId) {
        movePickedCard(host as never, targetId!, cardId, { kind: 'discardPile' })
        host.dispatch('LoseCard', { playerId: targetId!, cardIds: [cardId], reason: QIZHI }, { targetId, cardIds: [cardId] })
      }
      drawCards(host.state, host.rng, targetId!, 1, (name, payload) => { host.dispatch(name, payload) })
    }
  },
})

registerSkillRuntime({
  id: JINQU,
  triggers: [{
    event: 'PhaseStart',
    handle(host, ownerId, context) {
      const payload = context.event.payload as { playerId?: PlayerId; phase?: string }
      if (payload.phase !== 'finish' || payload.playerId !== ownerId) return
      const owner = playerOf(host.state, ownerId)
      if (!owner?.alive) return
      host.queueSkill({ skillId: JINQU, ownerId, step: 'ask', data: {} })
    },
  }],

  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'ask') return
    if (!playerOf(host.state, ownerId)?.alive) return
    const x = qizhiCount(host.state, ownerId)
    host.askSkill({
      skillId: JINQU, ownerId, step: 'ask', data: { x },
      build: (requestId): ChooseOptionRequest => ({
        id: requestId, kind: 'choose-option', playerId: ownerId,
        prompt: `【进趋】：摸 2 张牌，然后将手牌调整至 ${x} 张？`,
        timeoutMs: 20_000, optional: true,
        options: [{ id: 'yes', label: '发动【进趋】' }, { id: 'no', label: '不发动' }],
      }),
    })
  },

  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'ask') return
    if ((response.payload as { optionId?: string }).optionId !== 'yes') return
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    const x = resolution.data.x as number
    host.dispatch('SkillActivated', {
      skillId: JINQU, skillName: '进趋', playerId: ownerId,
      logText: `${owner.nickname}发动【进趋】，摸 2 张牌，手牌调整至 ${x} 张`,
    }, { sourceId: ownerId })
    drawCards(host.state, host.rng, ownerId, 2, (name, payload) => { host.dispatch(name, payload) })
    const overflow = owner.zones.hand.length - x
    if (overflow <= 0) return
    host.askSkill({
      skillId: `${JINQU}-discard`, ownerId, step: 'discard', data: {},
      build: (requestId) => ({
        id: requestId, kind: 'choose-cards' as const, playerId: ownerId,
        prompt: `【进趋】：将手牌弃至 ${x} 张`,
        timeoutMs: 20_000, optional: false, purpose: 'skill' as const,
        cardIds: [...owner.zones.hand], hiddenCardSlots: [], min: overflow, max: overflow,
      }),
    })
  },
})

registerSkillRuntime({
  id: `${JINQU}-discard`,
  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'discard') return
    const owner = playerOf(host.state, ownerId)
    const cardIds = [...new Set((response.payload as { cardIds?: string[] }).cardIds ?? [])]
      .filter((cardId) => owner?.zones.hand.includes(cardId))
    if (!owner?.alive || cardIds.length === 0) return
    for (const cardId of cardIds) moveCard(host.state, cardId, { kind: 'hand', playerId: ownerId }, { kind: 'discardPile' })
    host.dispatch('LoseCard', { playerId: ownerId, cardIds, reason: JINQU }, { targetId: ownerId, cardIds })
  },
})

export const WANGJI: CharacterDefinition = {
  id: 'wangji',
  name: '王基',
  kingdom: 'wei',
  gender: 'male',
  maxHp: 3,
  pack: 'sp',
  skills: [
    {
      id: QIZHI,
      name: '奇制',
      description: '王基于自己的回合内使用非装备牌指定目标后，可以选择另一名角色，弃置其一张牌，然后其摸一张牌。',
    },
    {
      id: JINQU,
      name: '进趋',
      description: '结束阶段，王基可以摸 2 张牌，然后将手牌调整至 X 张（X 为本回合内王基发动【奇制】的次数）。',
    },
  ],
}
