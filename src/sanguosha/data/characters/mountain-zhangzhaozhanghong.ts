import { drawCards } from '../../engine/draw'
import type { ChooseCardsRequest, ChooseOptionRequest, ChooseTargetsRequest } from '../../engine/requests'
import { registerSkillRuntime } from '../../engine/skills/runtime'
import type { CardId, DiscardPhaseRecord, PlayerId, SanguoshaState } from '../../engine/types'
import { moveCard } from '../../engine/zones'
import type { CharacterDefinition } from './types'

export const ZHIJIAN = 'zhijian'
export const GUZHENG = 'guzheng'
const ZHIJIAN_ACTION = 'zhijian-equip'

function playerOf(state: SanguoshaState, playerId: PlayerId) {
  return state.players.find((candidate) => candidate.id === playerId)
}

function legalCards(state: SanguoshaState, ownerId: PlayerId): CardId[] {
  const owner = playerOf(state, ownerId)
  if (!owner?.alive) return []
  return owner.zones.hand.filter((cardId) => {
    const slot = state.cards[cardId]?.equipmentSlot
    return Boolean(slot && state.players.some((target) => target.alive && target.id !== ownerId && !target.zones.equipment[slot]))
  })
}

function legalTargets(state: SanguoshaState, ownerId: PlayerId, cardId: CardId): PlayerId[] {
  const slot = state.cards[cardId]?.equipmentSlot
  if (!slot) return []
  return state.players.filter((target) => target.alive && target.id !== ownerId && !target.zones.equipment[slot]).map((target) => target.id)
}

registerSkillRuntime({
  id: ZHIJIAN,
  activeActions(state, ownerId) {
    if (state.currentPlayerId !== ownerId || state.phase !== 'play' || legalCards(state, ownerId).length === 0) return []
    return [{ id: ZHIJIAN_ACTION, label: '发动【直谏】：将手牌中的装备置入其他角色的空装备栏' }]
  },
  invokeActive(host, ownerId, actionId) {
    if (actionId !== ZHIJIAN_ACTION) return
    const cardIds = legalCards(host.state, ownerId)
    if (!cardIds.length) return
    host.askSkill({ skillId: ZHIJIAN, ownerId, step: 'card', build: (requestId): ChooseCardsRequest => ({
      id: requestId, kind: 'choose-cards', playerId: ownerId, prompt: '【直谏】：选择一张手牌中的装备牌',
      timeoutMs: 20_000, optional: true, purpose: 'skill', cardIds, hiddenCardSlots: [], min: 0, max: 1,
    }) })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'card') {
      const [cardId] = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
      if (!cardId || !legalCards(host.state, ownerId).includes(cardId)) return
      const candidateIds = legalTargets(host.state, ownerId, cardId)
      if (!candidateIds.length) return
      host.askSkill({ skillId: ZHIJIAN, ownerId, step: 'target', data: { cardId }, build: (requestId): ChooseTargetsRequest => ({
        id: requestId, kind: 'choose-targets', playerId: ownerId, prompt: '【直谏】：选择装备栏对应位置为空的其他角色',
        timeoutMs: 20_000, optional: true, candidateIds, min: 0, max: 1,
      }) })
      return
    }
    if (resolution.step !== 'target') return
    const cardId = resolution.data.cardId as CardId
    const [targetId] = (response.payload as { targetIds?: PlayerId[] }).targetIds ?? []
    const owner = playerOf(host.state, ownerId)
    const slot = host.state.cards[cardId]?.equipmentSlot
    const target = targetId ? playerOf(host.state, targetId) : undefined
    if (!owner?.zones.hand.includes(cardId) || !slot || !target?.alive || target.id === ownerId || target.zones.equipment[slot]) return
    moveCard(host.state, cardId, { kind: 'hand', playerId: ownerId }, { kind: 'equipment', playerId: targetId, slot })
    host.dispatch('LoseCard', { playerId: ownerId, cardIds: [cardId], reason: ZHIJIAN }, { sourceId: ownerId, cardIds: [cardId] })
    host.dispatch('GainCard', { playerId: targetId, cardIds: [cardId], reason: ZHIJIAN }, { sourceId: ownerId, targetId, cardIds: [cardId] })
    drawCards(host.state, host.rng, ownerId, 1, (name, payload) => { host.dispatch(name, payload) })
  },
})

function stillDiscarded(state: SanguoshaState, records: DiscardPhaseRecord[]): DiscardPhaseRecord[] {
  return records.filter((record) => state.zones.discardPile.includes(record.cardId))
}

registerSkillRuntime({
  id: GUZHENG,
  triggers: [{ event: 'PhaseEnd', handle(host, ownerId, context) {
    const payload = context.event.payload as { playerId?: PlayerId; phase?: string }
    const ledger = host.state.discardPhaseLedger
    if (payload.phase !== 'discard' || !payload.playerId || payload.playerId === ownerId || !ledger) return
    if (!ledger.records.some((record) => record.sourcePlayerId === payload.playerId && record.originalZone === 'hand')) return
    host.queueSkill({ skillId: GUZHENG, ownerId, step: 'return', data: {
      phaseInstanceId: ledger.phaseInstanceId, phaseOwnerId: payload.playerId, records: structuredClone(ledger.records),
    } })
  } }],
  startQueued(host, ownerId, prompt) {
    const phaseOwnerId = prompt.data.phaseOwnerId as PlayerId
    const records = prompt.data.records as DiscardPhaseRecord[]
    const cardIds = stillDiscarded(host.state, records)
      .filter((record) => record.sourcePlayerId === phaseOwnerId && record.originalZone === 'hand').map((record) => record.cardId)
    if (!playerOf(host.state, ownerId)?.alive || !playerOf(host.state, phaseOwnerId)?.alive || !cardIds.length) return
    host.askSkill({ skillId: GUZHENG, ownerId, step: 'return', data: { phaseOwnerId, records }, build: (requestId): ChooseCardsRequest => ({
      id: requestId, kind: 'choose-cards', playerId: ownerId, prompt: '发动【固政】？选择一张此阶段弃置的手牌返还给该角色',
      timeoutMs: 20_000, optional: true, purpose: 'skill', cardIds, hiddenCardSlots: [], min: 0, max: 1,
    }) })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'return') {
      const phaseOwnerId = resolution.data.phaseOwnerId as PlayerId
      const records = resolution.data.records as DiscardPhaseRecord[]
      const [cardId] = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
      if (!cardId || !records.some((r) => r.cardId === cardId && r.sourcePlayerId === phaseOwnerId && r.originalZone === 'hand')) return
      if (!host.state.zones.discardPile.includes(cardId) || !playerOf(host.state, phaseOwnerId)?.alive) return
      moveCard(host.state, cardId, { kind: 'discardPile' }, { kind: 'hand', playerId: phaseOwnerId })
      host.dispatch('GainCard', { playerId: phaseOwnerId, cardIds: [cardId], reason: GUZHENG }, { sourceId: ownerId, targetId: phaseOwnerId, cardIds: [cardId] })
      const remaining = stillDiscarded(host.state, records).map((record) => record.cardId)
      if (!remaining.length) return
      host.askSkill({ skillId: GUZHENG, ownerId, step: 'gain', data: { records }, build: (requestId): ChooseOptionRequest => ({
        id: requestId, kind: 'choose-option', playerId: ownerId, prompt: `【固政】：是否获得其余 ${remaining.length} 张牌？`,
        timeoutMs: 20_000, optional: true, options: [{ id: 'yes', label: '获得其余牌' }, { id: 'no', label: '放弃' }],
      }) })
      return
    }
    if (resolution.step !== 'gain' || (response.payload as { optionId?: string }).optionId !== 'yes') return
    const remaining = stillDiscarded(host.state, resolution.data.records as DiscardPhaseRecord[]).map((record) => record.cardId)
    for (const cardId of remaining) moveCard(host.state, cardId, { kind: 'discardPile' }, { kind: 'hand', playerId: ownerId })
    if (remaining.length) host.dispatch('GainCard', { playerId: ownerId, cardIds: remaining, reason: GUZHENG }, { targetId: ownerId, cardIds: remaining })
  },
})

export const ZHANGZHAOZHANGHONG: CharacterDefinition = {
  id: 'zhangzhaozhanghong', name: '张昭张纮', kingdom: 'wu', gender: 'male', maxHp: 3, pack: 'mountain',
  skills: [
    { id: ZHIJIAN, name: '直谏', description: '出牌阶段，你可以将手牌中的一张装备牌置于一名其他角色装备区里的对应位置，然后摸一张牌。' },
    { id: GUZHENG, name: '固政', description: '其他角色的弃牌阶段结束时，你可以将其于此阶段弃置的一张手牌交还给其，然后你可以获得此阶段其余仍在弃牌堆中的牌。' },
  ],
}
