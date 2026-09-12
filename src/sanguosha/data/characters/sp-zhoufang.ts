import { moveCard } from '../../engine/zones'
import { drawCards } from '../../engine/draw'
import { hiddenHandSlot } from '../../engine/cards/host'
import { registerSkillRuntime } from '../../engine/skills/runtime'
import type { ChooseCardsRequest, ChooseTargetsRequest } from '../../engine/requests'
import type { CardId, PlayerId, SanguoshaState } from '../../engine/types'
import type { CharacterDefinition } from './types'

/**
 * 周鲂（三国杀 OL 经典身份 SP）。
 *
 * 【诱敌】：结束阶段，可以选择一名其他角色A，令其弃置周鲂一张手牌
 *          （隐藏选择）；若弃的不是【杀】，周鲂获得A区域内一张合法牌；
 *          若弃的是黑色牌，周鲂摸1张牌——两个后续条件可同时成立。
 * 【断发】：出牌阶段，可以弃置任意张黑色牌，然后摸等量的牌；本阶段累计
 *          通过断发弃置的牌数不超过周鲂体力上限。
 */

const YOUDI = 'youdi'
const DUANFA = 'duanfa'

function playerOf(state: SanguoshaState, playerId: PlayerId) {
  return state.players.find((candidate) => candidate.id === playerId)
}

function phaseKeyOf(state: SanguoshaState): string {
  return `${state.turnNumber}:${state.phase}:${state.extraPhase?.instanceId ?? 0}`
}

registerSkillRuntime({
  id: YOUDI,
  triggers: [{
    event: 'PhaseStart',
    handle(host, ownerId, context) {
      const payload = context.event.payload as { playerId?: PlayerId; phase?: string }
      if (payload.phase !== 'finish' || payload.playerId !== ownerId) return
      const owner = playerOf(host.state, ownerId)
      if (!owner?.alive || owner.zones.hand.length === 0) return
      const candidateIds = host.state.players.filter((candidate) => candidate.alive && candidate.id !== ownerId).map((candidate) => candidate.id)
      if (candidateIds.length === 0) return
      host.queueSkill({ skillId: YOUDI, ownerId, step: 'target', data: { candidateIds } })
    },
  }],

  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'target') return
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive || owner.zones.hand.length === 0) return
    const { candidateIds } = prompt.data as { candidateIds: PlayerId[] }
    host.askSkill({
      skillId: YOUDI, ownerId, step: 'target', data: {},
      build: (requestId): ChooseTargetsRequest => ({
        id: requestId, kind: 'choose-targets', playerId: ownerId,
        prompt: '【诱敌】：可以选择一名其他角色', timeoutMs: 20_000, optional: true, candidateIds, min: 0, max: 1,
      }),
    })
  },

  resume(host, ownerId, resolution, response) {
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return

    if (resolution.step === 'target') {
      const [actorId] = (response.payload as { targetIds?: PlayerId[] }).targetIds ?? []
      if (!actorId || !playerOf(host.state, actorId)?.alive || owner.zones.hand.length === 0) return
      const hidden = owner.zones.hand.map((_, index) => hiddenHandSlot(ownerId, index))
      host.dispatch('SkillActivated', { skillId: YOUDI, skillName: '诱敌', playerId: ownerId, targetId: actorId, logText: `${owner.nickname}发动【诱敌】` }, { sourceId: ownerId, targetId: actorId })
      host.askSkill({
        skillId: YOUDI, ownerId, step: 'discard', data: { actorId },
        build: (requestId): ChooseCardsRequest => ({
          id: requestId, kind: 'choose-cards', playerId: actorId,
          prompt: `【诱敌】：弃置${owner.nickname}的一张手牌`, timeoutMs: 20_000, optional: false,
          purpose: 'skill', cardIds: [], hiddenCardSlots: hidden, min: 1, max: 1,
        }),
      })
      return
    }

    if (resolution.step === 'discard') {
      const { actorId } = resolution.data as { actorId: PlayerId }
      const [picked] = (response.payload as { cardIds?: string[] }).cardIds ?? []
      const hiddenIndex = owner.zones.hand.findIndex((_, index) => hiddenHandSlot(ownerId, index) === picked)
      if (hiddenIndex < 0) return
      const cardId = owner.zones.hand[hiddenIndex]
      const cardName = host.state.cards[cardId]?.name
      const color = host.state.cards[cardId]?.color
      moveCard(host.state, cardId, { kind: 'hand', playerId: ownerId }, { kind: 'discardPile' })
      host.dispatch('LoseCard', { playerId: ownerId, cardIds: [cardId], reason: YOUDI }, { sourceId: ownerId, cardIds: [cardId] })
      if (color === 'black') drawCards(host.state, host.rng, ownerId, 1, (name, payload) => { host.dispatch(name, payload) })
      if (cardName !== '杀') {
        const actor = playerOf(host.state, actorId)
        if (!actor?.alive) return
        const hidden = actor.zones.hand.map((_, index) => hiddenHandSlot(actorId, index))
        const visible = [
          ...Object.values(actor.zones.equipment).filter((id): id is CardId => !!id),
          ...actor.zones.judgingArea,
        ]
        if (hidden.length + visible.length === 0) return
        host.askSkill({
          skillId: YOUDI, ownerId, step: 'gain', data: { actorId },
          build: (requestId): ChooseCardsRequest => ({
            id: requestId, kind: 'choose-cards', playerId: ownerId,
            prompt: `【诱敌】：获得${actor.nickname}区域里的一张牌`, timeoutMs: 20_000, optional: false,
            purpose: 'skill', cardIds: visible, hiddenCardSlots: hidden, min: 1, max: 1,
          }),
        })
      }
      return
    }

    if (resolution.step === 'gain') {
      const { actorId } = resolution.data as { actorId: PlayerId }
      const actor = playerOf(host.state, actorId)
      const [picked] = (response.payload as { cardIds?: string[] }).cardIds ?? []
      if (!actor?.alive || !picked) return
      let cardId: CardId
      let from: { kind: 'hand'; playerId: PlayerId } | { kind: 'equipment'; playerId: PlayerId; slot: keyof typeof actor.zones.equipment } | { kind: 'judgingArea'; playerId: PlayerId }
      const hiddenIndex = actor.zones.hand.findIndex((_, index) => hiddenHandSlot(actorId, index) === picked)
      if (hiddenIndex >= 0) {
        cardId = actor.zones.hand[hiddenIndex]
        from = { kind: 'hand', playerId: actorId }
      } else if (actor.zones.judgingArea.includes(picked as CardId)) {
        cardId = picked as CardId
        from = { kind: 'judgingArea', playerId: actorId }
      } else {
        const slot = (Object.keys(actor.zones.equipment) as Array<keyof typeof actor.zones.equipment>).find((key) => actor.zones.equipment[key] === picked)
        if (!slot) return
        cardId = picked as CardId
        from = { kind: 'equipment', playerId: actorId, slot }
      }
      moveCard(host.state, cardId, from, { kind: 'hand', playerId: ownerId })
      host.dispatch('GainCard', { playerId: ownerId, cardIds: [cardId], reason: YOUDI }, { targetId: ownerId, cardIds: [cardId] })
    }
  },
})

registerSkillRuntime({
  id: DUANFA,
  announcesSelf: true,

  activeActions(state, ownerId) {
    if (state.phase !== 'play' || state.currentPlayerId !== ownerId) return []
    const owner = playerOf(state, ownerId)
    if (!owner?.alive) return []
    const used = state.duanfaPhaseTotal?.[ownerId]
    const cap = owner.maxHp - (used?.phaseKey === phaseKeyOf(state) ? used.total : 0)
    if (cap <= 0 || !owner.zones.hand.some((cardId) => state.cards[cardId]?.color === 'black')) return []
    return [{ id: DUANFA, label: '断发：弃置任意张黑色牌，然后摸等量的牌' }]
  },

  invokeActive(host, ownerId, actionId) {
    if (actionId !== DUANFA) return
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    const key = phaseKeyOf(host.state)
    const used = host.state.duanfaPhaseTotal?.[ownerId]
    const cap = owner.maxHp - (used?.phaseKey === key ? used.total : 0)
    const candidates = owner.zones.hand.filter((cardId) => host.state.cards[cardId]?.color === 'black')
    if (cap <= 0 || candidates.length === 0) return
    host.askSkill({
      skillId: DUANFA, ownerId, step: 'discard',
      build: (requestId): ChooseCardsRequest => ({
        id: requestId, kind: 'choose-cards', playerId: ownerId,
        prompt: `【断发】：弃置任意张黑色牌（本阶段还能弃${Math.min(cap, candidates.length)}张）`, timeoutMs: 20_000, optional: false,
        purpose: 'skill', cardIds: candidates, hiddenCardSlots: [], min: 1, max: Math.min(cap, candidates.length),
      }),
    })
  },

  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'discard') return
    const owner = playerOf(host.state, ownerId)
    const cardIds = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
    const valid = cardIds.filter((cardId) => owner?.zones.hand.includes(cardId) && host.state.cards[cardId]?.color === 'black')
    if (!owner?.alive || valid.length === 0) return
    const key = phaseKeyOf(host.state)
    const used = host.state.duanfaPhaseTotal?.[ownerId]
    const currentTotal = used?.phaseKey === key ? used.total : 0
    if (currentTotal + valid.length > owner.maxHp) return
    host.state.duanfaPhaseTotal ??= {}
    host.state.duanfaPhaseTotal[ownerId] = { phaseKey: key, total: currentTotal + valid.length }
    for (const cardId of valid) moveCard(host.state, cardId, { kind: 'hand', playerId: ownerId }, { kind: 'discardPile' })
    host.dispatch('LoseCard', { playerId: ownerId, cardIds: valid, reason: DUANFA }, { sourceId: ownerId, cardIds: valid })
    host.dispatch('SkillActivated', { skillId: DUANFA, skillName: '断发', playerId: ownerId, logText: `${owner.nickname}发动【断发】` }, { sourceId: ownerId })
    drawCards(host.state, host.rng, ownerId, valid.length, (name, payload) => { host.dispatch(name, payload) })
  },
})

export const ZHOUFANG: CharacterDefinition = {
  id: 'zhoufang',
  name: '周鲂',
  kingdom: 'wu',
  gender: 'male',
  maxHp: 3,
  pack: 'sp',
  skills: [
    { id: YOUDI, name: '诱敌', description: '结束阶段，可以选择一名其他角色，令其弃置周鲂一张手牌；若弃的不是【杀】，周鲂获得其区域里一张合法牌；若弃的是黑色牌，周鲂摸1张牌。' },
    { id: DUANFA, name: '断发', description: '出牌阶段，可以弃置任意张黑色牌，然后摸等量的牌；本阶段累计弃置的牌数不超过体力上限。' },
  ],
}
