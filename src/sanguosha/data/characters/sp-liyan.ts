import { hiddenHandSlot } from '../../engine/cards/host'
import { resolvePickedCard, movePickedCard } from '../../engine/card-pick'
import { moveCard } from '../../engine/zones'
import { registerSkillRuntime } from '../../engine/skills/runtime'
import type { ChooseCardsRequest, ChooseOptionRequest, ChooseTargetsRequest } from '../../engine/requests'
import type { CardId, PlayerId, SanguoshaState } from '../../engine/types'
import type { CharacterDefinition } from './types'

/**
 * 李严（三国杀 OL 经典身份 SP）。
 *
 * 【督粮】：出牌阶段限一次，获得一名其他角色A的1张手牌（暗置挑选，不看
 *          完整手牌），然后二选一：令A观看牌堆顶2张牌并获得其中的基本
 *          牌（只A可见）；或令A的下个摸牌阶段多摸1张。
 * 【腹鳞】：锁定技，弃牌阶段，你本回合内获得的牌不计入手牌上限。
 */

const DULIANG = 'duliang'
const DULIANG_INVOKE = 'duliang-invoke'
const FULIN = 'fulin'

function playerOf(state: SanguoshaState, playerId: PlayerId) {
  return state.players.find((candidate) => candidate.id === playerId)
}

registerSkillRuntime({
  id: DULIANG,
  activeActions(state, ownerId) {
    if (state.phase !== 'play' || state.currentPlayerId !== ownerId) return []
    const owner = playerOf(state, ownerId)
    if (!owner?.alive || owner.turnUsedSkills.includes(DULIANG)) return []
    if (!state.players.some((candidate) => candidate.alive && candidate.id !== ownerId && candidate.zones.hand.length > 0)) return []
    return [{ id: DULIANG_INVOKE, label: '督粮：获得一名其他角色的一张手牌，然后二选一' }]
  },
  invokeActive(host, ownerId, actionId) {
    if (actionId !== DULIANG_INVOKE) return
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive || owner.turnUsedSkills.includes(DULIANG)) return
    const candidateIds = host.state.players.filter((candidate) => candidate.alive && candidate.id !== ownerId && candidate.zones.hand.length > 0).map((candidate) => candidate.id)
    if (candidateIds.length === 0) return
    host.askSkill({
      skillId: DULIANG, ownerId, step: 'pick-a', data: {},
      build: (requestId): ChooseTargetsRequest => ({
        id: requestId, kind: 'choose-targets', playerId: ownerId,
        prompt: '【督粮】：选择一名其他角色', timeoutMs: 20_000, optional: false,
        candidateIds, min: 1, max: 1,
      }),
    })
  },
  triggers: [{
    event: 'DrawPhase',
    handle(host, _ownerId, context) {
      const payload = context.event.payload as { playerId?: PlayerId; count?: number }
      const targetId = payload.playerId
      if (!targetId || !host.state.liyanNextDrawBonus?.[targetId]) return
      delete host.state.liyanNextDrawBonus[targetId]
      context.event.payload = { ...payload, count: Math.max(0, Math.trunc(Number(payload.count ?? 2))) + 1 }
    },
  }],
  resume(host, ownerId, resolution, response) {
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return

    if (resolution.step === 'pick-a') {
      const [aId] = (response.payload as { targetIds?: PlayerId[] }).targetIds ?? []
      const a = playerOf(host.state, aId)
      if (!a?.alive || a.zones.hand.length === 0) return
      owner.turnUsedSkills.push(DULIANG)
      host.askSkill({
        skillId: DULIANG, ownerId, step: 'gain', data: { aId },
        build: (requestId): ChooseCardsRequest => ({
          id: requestId, kind: 'choose-cards', playerId: ownerId,
          prompt: `【督粮】：获得${a.nickname}的一张手牌`, timeoutMs: 20_000, optional: false,
          purpose: 'skill', cardIds: [], hiddenCardSlots: a.zones.hand.map((_, index) => hiddenHandSlot(aId, index)), min: 1, max: 1,
        }),
      })
      return
    }

    if (resolution.step === 'gain') {
      const { aId } = resolution.data as { aId: PlayerId }
      const a = playerOf(host.state, aId)
      if (!a?.alive) return
      const [picked] = (response.payload as { cardIds?: string[] }).cardIds ?? []
      const realId = picked ? resolvePickedCard(host.state, aId, picked) : null
      if (!realId) return
      movePickedCard(host as never, aId, realId, { kind: 'hand', playerId: ownerId })
      host.dispatch('GainCard', { playerId: ownerId, cardIds: [realId], reason: DULIANG }, { sourceId: ownerId, targetId: aId, cardIds: [realId] })
      host.dispatch('SkillActivated', { skillId: DULIANG, skillName: '督粮', playerId: ownerId, targetId: aId, logText: `${owner.nickname}发动【督粮】` }, { sourceId: ownerId, targetId: aId })
      host.askSkill({
        skillId: DULIANG, ownerId, step: 'choose-branch', data: { aId },
        build: (requestId): ChooseOptionRequest => ({
          id: requestId, kind: 'choose-option', playerId: ownerId,
          prompt: '【督粮】：请选择', timeoutMs: 20_000, optional: false,
          options: [
            { id: 'top2', label: `令${a.nickname}观看牌堆顶2张牌并获得其中的基本牌` },
            { id: 'draw', label: `令${a.nickname}下个摸牌阶段多摸1张牌` },
          ],
        }),
      })
      return
    }

    if (resolution.step === 'choose-branch') {
      const { aId } = resolution.data as { aId: PlayerId }
      const a = playerOf(host.state, aId)
      if (!a?.alive) return
      const optionId = (response.payload as { optionId?: string }).optionId
      if (optionId === 'draw') {
        host.state.liyanNextDrawBonus ??= {}
        host.state.liyanNextDrawBonus[aId] = true
        host.dispatch('SkillActivated', { skillId: DULIANG, skillName: '督粮', playerId: ownerId, targetId: aId, logText: `${a.nickname}下个摸牌阶段将多摸1张牌` }, { sourceId: ownerId, targetId: aId })
        return
      }
      const top = host.state.zones.drawPile.slice(0, 2)
      if (top.length === 0) return
      const basicIds = top.filter((cardId) => host.state.cards[cardId]?.category === 'basic')
      host.askSkill({
        skillId: DULIANG, ownerId, step: 'top2-pick', data: { top },
        build: (requestId): ChooseCardsRequest => ({
          id: requestId, kind: 'choose-cards', playerId: aId,
          prompt: '【督粮】：观看牌堆顶2张牌，获得其中的基本牌', timeoutMs: 20_000, optional: true,
          purpose: 'skill', cardIds: basicIds, viewOnlyCardIds: top.filter((cardId) => !basicIds.includes(cardId)),
          hiddenCardSlots: [], min: 0, max: basicIds.length,
        }),
      })
      return
    }

    if (resolution.step === 'top2-pick') {
      const { top } = resolution.data as { top: CardId[] }
      const gained = ((response.payload as { cardIds?: CardId[] }).cardIds ?? [])
        .filter((cardId) => top.includes(cardId) && host.state.cards[cardId]?.category === 'basic' && host.state.zones.drawPile.includes(cardId))
      if (gained.length === 0) return
      const aId = response.playerId
      for (const cardId of gained) moveCard(host.state, cardId, { kind: 'drawPile' }, { kind: 'hand', playerId: aId })
      host.dispatch('GainCard', { playerId: aId, cardIds: gained, reason: DULIANG }, { targetId: aId, cardIds: gained })
    }
  },
})

registerSkillRuntime({
  id: FULIN,
  handLimitExempt(state, ownerId, cardId) {
    const entry = state.liyanGainedThisTurn?.[ownerId]
    return !!entry && entry.turnNumber === state.turnNumber && entry.cardIds.includes(cardId)
  },
  triggers: [{
    event: 'GainCard',
    handle(host, ownerId, context) {
      const payload = context.event.payload as { playerId?: PlayerId; cardIds?: CardId[] }
      if (payload.playerId !== ownerId || !payload.cardIds?.length) return
      host.state.liyanGainedThisTurn ??= {}
      const entry = host.state.liyanGainedThisTurn[ownerId]
      const cardIds = entry?.turnNumber === host.state.turnNumber ? [...entry.cardIds, ...payload.cardIds] : [...payload.cardIds]
      host.state.liyanGainedThisTurn[ownerId] = { turnNumber: host.state.turnNumber, cardIds }
    },
  }],
})

export const LIYAN: CharacterDefinition = {
  id: 'liyan',
  name: '李严',
  kingdom: 'shu',
  gender: 'male',
  maxHp: 3,
  pack: 'sp',
  skills: [
    { id: DULIANG, name: '督粮', description: '出牌阶段限一次，获得一名其他角色的1张手牌，然后选择：令其观看牌堆顶2张牌并获得其中的基本牌；或令其下个摸牌阶段多摸1张牌。' },
    { id: FULIN, name: '腹鳞', description: '锁定技，弃牌阶段，你本回合内获得的牌不计入手牌上限。' },
  ],
}
