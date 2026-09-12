import { moveCard } from '../../engine/zones'
import { drawCards } from '../../engine/draw'
import { handleEquipmentLost } from '../../engine/equipment'
import { fieldCards } from '../../engine/field-move'
import { registerSkillRuntime } from '../../engine/skills/runtime'
import type { ChooseCardsRequest, ChooseOptionRequest, ChooseTargetsRequest } from '../../engine/requests'
import type { CardId, EquipmentSlot, PlayerId, SanguoshaState } from '../../engine/types'
import type { CharacterDefinition } from './types'

/**
 * 樊稠（三国杀 OL 经典身份 SP）。
 *
 * 【兴乱】：出牌阶段限一次，樊稠使用一张牌后，可以选择：
 *   1. 获得场上（装备区/判定区）一张点数为6的牌；
 *   2. 从牌堆里搜寻至多2张点数为6的牌，获得其中1张（没有则摸1张）；
 *   3. 选择一名其他角色，其弃置一张点数为6的牌，否则交给樊稠1张牌。
 */

const XINGLUAN = 'xingluan'

function playerOf(state: SanguoshaState, playerId: PlayerId) {
  return state.players.find((candidate) => candidate.id === playerId)
}

function isSix(state: SanguoshaState, cardId: CardId): boolean {
  return state.cards[cardId]?.rank === 6
}

registerSkillRuntime({
  id: XINGLUAN,
  triggers: [{
    event: 'AfterCardUse',
    handle(host, ownerId, context) {
      const payload = context.event.payload as { cancelled?: boolean }
      if (context.event.sourceId !== ownerId || payload.cancelled) return
      const owner = playerOf(host.state, ownerId)
      if (!owner?.alive || owner.turnUsedSkills.includes(XINGLUAN)) return
      host.queueSkill({ skillId: XINGLUAN, ownerId, step: 'ask', data: {} })
    },
  }],

  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'ask') return
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive || owner.turnUsedSkills.includes(XINGLUAN)) return
    const hasFieldSix = fieldCards(host.state).some((card) => card.slot && isSix(host.state, card.cardId))
    const hasOtherAlive = host.state.players.some((candidate) => candidate.alive && candidate.id !== ownerId)
    const options = [
      ...(hasFieldSix ? [{ id: 'field', label: '获得场上一张点数为6的牌' }] : []),
      { id: 'deck', label: '从牌堆搜寻点数为6的牌' },
      ...(hasOtherAlive ? [{ id: 'target', label: '选择一名其他角色' }] : []),
    ]
    host.askSkill({
      skillId: XINGLUAN, ownerId, step: 'choose',
      build: (requestId): ChooseOptionRequest => ({
        id: requestId, kind: 'choose-option', playerId: ownerId,
        prompt: '【兴乱】：选择一项', timeoutMs: 20_000, optional: true, options,
      }),
    })
  },

  resume(host, ownerId, resolution, response) {
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return

    if (resolution.step === 'choose') {
      const optionId = (response.payload as { optionId?: string }).optionId
      if (!optionId) return
      owner.turnUsedSkills.push(XINGLUAN)
      host.dispatch('SkillActivated', { skillId: XINGLUAN, skillName: '兴乱', playerId: ownerId, logText: `${owner.nickname}发动【兴乱】` }, { sourceId: ownerId })

      if (optionId === 'field') {
        const candidates = fieldCards(host.state).filter((card) => card.slot && isSix(host.state, card.cardId))
        if (candidates.length === 0) return
        host.askSkill({
          skillId: XINGLUAN, ownerId, step: 'field-pick',
          build: (requestId): ChooseCardsRequest => ({
            id: requestId, kind: 'choose-cards', playerId: ownerId,
            prompt: '【兴乱】：选择场上一张点数为6的牌', timeoutMs: 20_000, optional: false,
            purpose: 'skill', cardIds: candidates.map((card) => card.cardId), hiddenCardSlots: [], min: 1, max: 1,
          }),
        })
        return
      }

      if (optionId === 'deck') {
        const found: CardId[] = []
        for (const cardId of host.state.zones.drawPile) {
          if (found.length >= 2) break
          if (isSix(host.state, cardId)) found.push(cardId)
        }
        if (found.length === 0) {
          drawCards(host.state, host.rng, ownerId, 1, (name, drawPayload) => { host.dispatch(name, drawPayload) })
          return
        }
        for (const cardId of found) moveCard(host.state, cardId, { kind: 'drawPile' }, { kind: 'processingArea' })
        host.dispatch('CardMove', { cardIds: found, reason: XINGLUAN, revealed: true }, { sourceId: ownerId, cardIds: found })
        if (found.length === 1) {
          moveCard(host.state, found[0], { kind: 'processingArea' }, { kind: 'hand', playerId: ownerId })
          host.dispatch('GainCard', { playerId: ownerId, cardIds: found, reason: XINGLUAN, revealed: true }, { targetId: ownerId, cardIds: found })
          return
        }
        host.askSkill({
          skillId: XINGLUAN, ownerId, step: 'deck-pick', data: { pool: found },
          build: (requestId): ChooseCardsRequest => ({
            id: requestId, kind: 'choose-cards', playerId: ownerId,
            prompt: '【兴乱】：获得其中一张', timeoutMs: 20_000, optional: false,
            purpose: 'skill', cardIds: found, hiddenCardSlots: [], min: 1, max: 1,
          }),
        })
        return
      }

      if (optionId === 'target') {
        const candidateIds = host.state.players.filter((candidate) => candidate.alive && candidate.id !== ownerId).map((candidate) => candidate.id)
        if (candidateIds.length === 0) return
        host.askSkill({
          skillId: XINGLUAN, ownerId, step: 'target-pick',
          build: (requestId): ChooseTargetsRequest => ({
            id: requestId, kind: 'choose-targets', playerId: ownerId,
            prompt: '【兴乱】：选择一名其他角色', timeoutMs: 20_000, optional: false, candidateIds, min: 1, max: 1,
          }),
        })
      }
      return
    }

    if (resolution.step === 'field-pick') {
      const [cardId] = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
      if (!cardId) return
      const located = fieldCards(host.state).find((card) => card.cardId === cardId)
      if (!located) return
      const from = located.slot
        ? { kind: 'equipment' as const, playerId: located.ownerId, slot: located.slot as EquipmentSlot }
        : { kind: 'judgingArea' as const, playerId: located.ownerId }
      moveCard(host.state, cardId, from, { kind: 'hand', playerId: ownerId })
      if (located.slot) handleEquipmentLost(host as never, located.ownerId, cardId)
      host.dispatch('GainCard', { playerId: ownerId, cardIds: [cardId], reason: XINGLUAN }, { targetId: ownerId, cardIds: [cardId] })
      return
    }

    if (resolution.step === 'deck-pick') {
      const pool = (resolution.data as { pool: CardId[] }).pool
      const [cardId] = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
      const rest = pool.filter((candidate) => candidate !== cardId)
      for (const leftover of rest) {
        if (host.state.zones.processingArea.includes(leftover)) moveCard(host.state, leftover, { kind: 'processingArea' }, { kind: 'discardPile' })
      }
      if (!cardId || !host.state.zones.processingArea.includes(cardId)) return
      moveCard(host.state, cardId, { kind: 'processingArea' }, { kind: 'hand', playerId: ownerId })
      host.dispatch('GainCard', { playerId: ownerId, cardIds: [cardId], reason: XINGLUAN, revealed: true }, { targetId: ownerId, cardIds: [cardId] })
      return
    }

    if (resolution.step === 'target-pick') {
      const [targetId] = (response.payload as { targetIds?: PlayerId[] }).targetIds ?? []
      const target = targetId ? playerOf(host.state, targetId) : undefined
      if (!target?.alive) return
      const hasSix = target.zones.hand.some((cardId) => isSix(host.state, cardId))
      const hasAny = target.zones.hand.length > 0
      if (!hasSix && !hasAny) return
      const options = [
        ...(hasSix ? [{ id: 'discard', label: '弃置一张点数为6的牌' }] : []),
        ...(hasAny ? [{ id: 'give', label: `交给${owner.nickname}1张牌` }] : []),
      ]
      if (options.length === 1) {
        host.askSkill({
          skillId: XINGLUAN, ownerId, step: options[0].id === 'discard' ? 'target-discard' : 'target-give', data: { targetId },
          build: (requestId): ChooseCardsRequest => ({
            id: requestId, kind: 'choose-cards', playerId: targetId,
            prompt: options[0].id === 'discard' ? '【兴乱】：弃置一张点数为6的牌' : `【兴乱】：交给${owner.nickname}1张牌`,
            timeoutMs: 20_000, optional: false, purpose: 'skill',
            cardIds: options[0].id === 'discard' ? target.zones.hand.filter((cardId) => isSix(host.state, cardId)) : [...target.zones.hand],
            hiddenCardSlots: [], min: 1, max: 1,
          }),
        })
        return
      }
      host.askSkill({
        skillId: XINGLUAN, ownerId, step: 'target-decide', data: { targetId },
        build: (requestId): ChooseOptionRequest => ({
          id: requestId, kind: 'choose-option', playerId: targetId,
          prompt: '【兴乱】：请选择', timeoutMs: 20_000, optional: false, options,
        }),
      })
      return
    }

    if (resolution.step === 'target-decide') {
      const { targetId } = resolution.data as { targetId: PlayerId }
      const target = playerOf(host.state, targetId)
      if (!target?.alive) return
      const optionId = (response.payload as { optionId?: string }).optionId
      const isDiscard = optionId === 'discard'
      host.askSkill({
        skillId: XINGLUAN, ownerId, step: isDiscard ? 'target-discard' : 'target-give', data: { targetId },
        build: (requestId): ChooseCardsRequest => ({
          id: requestId, kind: 'choose-cards', playerId: targetId,
          prompt: isDiscard ? '【兴乱】：弃置一张点数为6的牌' : `【兴乱】：交给${owner.nickname}1张牌`,
          timeoutMs: 20_000, optional: false, purpose: 'skill',
          cardIds: isDiscard ? target.zones.hand.filter((cardId) => isSix(host.state, cardId)) : [...target.zones.hand],
          hiddenCardSlots: [], min: 1, max: 1,
        }),
      })
      return
    }

    if (resolution.step === 'target-discard') {
      const { targetId } = resolution.data as { targetId: PlayerId }
      const target = playerOf(host.state, targetId)
      const [cardId] = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
      if (!target?.alive || !cardId || !target.zones.hand.includes(cardId)) return
      moveCard(host.state, cardId, { kind: 'hand', playerId: targetId }, { kind: 'discardPile' })
      host.dispatch('LoseCard', { playerId: targetId, cardIds: [cardId], reason: XINGLUAN }, { sourceId: targetId, cardIds: [cardId] })
      return
    }

    if (resolution.step === 'target-give') {
      const { targetId } = resolution.data as { targetId: PlayerId }
      const target = playerOf(host.state, targetId)
      const [cardId] = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
      if (!target?.alive || !cardId || !target.zones.hand.includes(cardId)) return
      moveCard(host.state, cardId, { kind: 'hand', playerId: targetId }, { kind: 'hand', playerId: ownerId })
      host.dispatch('LoseCard', { playerId: targetId, cardIds: [cardId], reason: XINGLUAN }, { sourceId: targetId, cardIds: [cardId] })
      host.dispatch('GainCard', { playerId: ownerId, cardIds: [cardId], reason: XINGLUAN }, { targetId: ownerId, cardIds: [cardId] })
    }
  },
})

export const FANCHOU: CharacterDefinition = {
  id: 'fanchou',
  name: '樊稠',
  kingdom: 'qun',
  gender: 'male',
  maxHp: 4,
  pack: 'sp',
  skills: [
    {
      id: XINGLUAN, name: '兴乱',
      description: '出牌阶段限一次，樊稠使用一张牌后，可以选择：获得场上一张点数为6的牌；或从牌堆里搜寻至多2张点数为6的牌并获得其中1张（没有则摸1张）；或选择一名其他角色，其弃置一张点数为6的牌，否则交给樊稠1张牌。',
    },
  ],
}
