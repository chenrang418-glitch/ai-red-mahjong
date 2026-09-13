import { moveCard } from '../../engine/zones'
import { drawCards } from '../../engine/draw'
import { finalizeDamage, resumeDamageChain } from '../../engine/damage'
import { pickableCardsOf, resolvePickedCard, movePickedCard } from '../../engine/card-pick'
import { canTarget } from '../../engine/distance'
import { registerSkillRuntime, type SkillHost } from '../../engine/skills/runtime'
import type { ChooseCardsRequest, ChooseOptionRequest, ChooseTargetsRequest } from '../../engine/requests'
import type { CardId, DamageNature, PlayerId, SanguoshaState } from '../../engine/types'
import type { CharacterDefinition } from './types'

/**
 * 黄皓（三国杀 OL 经典身份 SP）。
 *
 * 【寝情】：结束阶段，可以选择任意名攻击范围包含主公的其他角色，依次弃置
 *          每人1张牌后其摸1张；结束后，其中手牌数大于主公的人数为X，
 *          你摸X张。
 * 【贿生】：你受到其他角色A造成的伤害时，可以展示至少1张手牌，A选择：
 *          获得其中1张并防止此伤害（此后本局你不能再对A发动贿生）；
 *          或弃置等量的牌，伤害正常继续。
 */

const QINQING = 'qinqing'
const HUISHENG = 'huisheng'

function playerOf(state: SanguoshaState, playerId: PlayerId) {
  return state.players.find((candidate) => candidate.id === playerId)
}

function qinqingStep(host: SkillHost, ownerId: PlayerId, ids: PlayerId[], index: number, promoted: number): void {
  const owner = playerOf(host.state, ownerId)
  if (!owner?.alive) return
  if (index >= ids.length) { finishQinqing(host, ownerId, ids, promoted); return }
  const targetId = ids[index]
  const target = playerOf(host.state, targetId)
  if (!target?.alive) { qinqingStep(host, ownerId, ids, index + 1, promoted); return }
  const pickable = pickableCardsOf(host.state, targetId)
  if (pickable.cardIds.length + pickable.hiddenCardSlots.length === 0) {
    drawCards(host.state, host.rng, targetId, 1, (name, payload) => { host.dispatch(name, payload) })
    qinqingStep(host, ownerId, ids, index + 1, promoted)
    return
  }
  host.askSkill({
    skillId: QINQING, ownerId, step: 'discard', data: { ids, index, promoted, targetId },
    build: (requestId): ChooseCardsRequest => ({
      id: requestId, kind: 'choose-cards', playerId: ownerId,
      prompt: `【寝情】：弃置${target.nickname}一张牌`, timeoutMs: 20_000, optional: false,
      purpose: 'skill', cardIds: pickable.cardIds, hiddenCardSlots: pickable.hiddenCardSlots, min: 1, max: 1,
    }),
  })
}

function finishQinqing(host: SkillHost, ownerId: PlayerId, ids: PlayerId[], promoted: number): void {
  const owner = playerOf(host.state, ownerId)
  if (!owner?.alive) return
  const lord = host.state.players.find((candidate) => candidate.alive && candidate.identity === 'lord')
  const lordHand = lord?.zones.hand.length ?? 0
  const x = ids.filter((id) => (playerOf(host.state, id)?.zones.hand.length ?? 0) > lordHand).length
  void promoted
  if (x > 0) drawCards(host.state, host.rng, ownerId, x, (name, payload) => { host.dispatch(name, payload) })
}

registerSkillRuntime({
  id: QINQING,
  triggers: [{
    event: 'PhaseStart',
    handle(host, ownerId, context) {
      const payload = context.event.payload as { phase?: string; playerId?: PlayerId }
      if (payload.phase !== 'finish' || payload.playerId !== ownerId) return
      const owner = playerOf(host.state, ownerId)
      if (!owner?.alive) return
      const lord = host.state.players.find((candidate) => candidate.alive && candidate.identity === 'lord')
      if (!lord) return
      const candidateIds = host.state.players.filter((candidate) => candidate.alive && candidate.id !== ownerId && canTarget(host.state, candidate.id, lord.id)).map((candidate) => candidate.id)
      if (candidateIds.length === 0) return
      host.queueSkill({ skillId: QINQING, ownerId, step: 'pick-targets', data: { candidateIds } })
    },
  }],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'pick-targets') return
    const { candidateIds } = prompt.data as { candidateIds: PlayerId[] }
    host.askSkill({
      skillId: QINQING, ownerId, step: 'pick-targets', data: {},
      build: (requestId): ChooseTargetsRequest => ({
        id: requestId, kind: 'choose-targets', playerId: ownerId,
        prompt: '【寝情】：选择任意名攻击范围包含主公的角色', timeoutMs: 20_000, optional: true,
        candidateIds, min: 0, max: candidateIds.length,
      }),
    })
  },
  resume(host, ownerId, resolution, response) {
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    if (resolution.step === 'pick-targets') {
      const ids = (response.payload as { targetIds?: PlayerId[] }).targetIds ?? []
      if (ids.length === 0) return
      host.dispatch('SkillActivated', { skillId: QINQING, skillName: '寝情', playerId: ownerId, logText: `${owner.nickname}发动【寝情】` }, { sourceId: ownerId })
      qinqingStep(host, ownerId, ids, 0, 0)
      return
    }
    if (resolution.step === 'discard') {
      const { ids, index, promoted, targetId } = resolution.data as { ids: PlayerId[]; index: number; promoted: number; targetId: PlayerId }
      const [picked] = (response.payload as { cardIds?: string[] }).cardIds ?? []
      const cardId = picked ? resolvePickedCard(host.state, targetId, picked) : null
      if (cardId) {
        movePickedCard(host as never, targetId, cardId, { kind: 'discardPile' })
        host.dispatch('LoseCard', { playerId: targetId, cardIds: [cardId], reason: QINQING }, { sourceId: ownerId, targetId, cardIds: [cardId] })
      }
      if (playerOf(host.state, targetId)?.alive) drawCards(host.state, host.rng, targetId, 1, (name, payload) => { host.dispatch(name, payload) })
      qinqingStep(host, ownerId, ids, index + 1, promoted)
    }
  },
})

registerSkillRuntime({
  id: HUISHENG,
  triggers: [{
    event: 'BeforeDamage',
    handle(host, ownerId, context) {
      if (context.event.targetId !== ownerId) return
      const sourceId = context.event.sourceId
      if (!sourceId || sourceId === ownerId) return
      const owner = playerOf(host.state, ownerId)
      if (!owner?.alive || owner.zones.hand.length === 0) return
      if ((host.state.huanghaoBlocked ?? []).some((entry) => entry.ownerId === ownerId && entry.sourceId === sourceId)) return
      if (host.state.damageChain) return
      if (host.state.cardResolution?.kind === 'trick') return
      if (host.state.cardResolution?.kind === 'slash' && host.state.cardResolution.remainingTargetIds.length > 0) return
      if (host.state.skillResolution) return
      const payload = context.event.payload as { amount?: number; cardId?: CardId; cardName?: string; redirectedBy?: string }
      const amount = typeof payload.amount === 'number' ? payload.amount : 0
      if (amount <= 0) return
      context.cancel()
      host.askSkill({
        skillId: HUISHENG, ownerId, step: 'show', data: {
          sourceId, amount, nature: (context.event.damageNature ?? 'normal') as DamageNature,
          cardId: payload.cardId ?? null, cardName: payload.cardName ?? null, redirectedBy: payload.redirectedBy ?? null,
        },
        build: (requestId): ChooseCardsRequest => ({
          id: requestId, kind: 'choose-cards', playerId: ownerId,
          prompt: '【贿生】：展示至少1张手牌', timeoutMs: 20_000, optional: true,
          purpose: 'skill', cardIds: [...owner.zones.hand], hiddenCardSlots: [], min: 0, max: owner.zones.hand.length,
        }),
      })
    },
  }],
  resume(host, ownerId, resolution, response) {
    const owner = playerOf(host.state, ownerId)
    const { sourceId, amount, nature, cardId, cardName, redirectedBy } = resolution.data as {
      sourceId: PlayerId; amount: number; nature: DamageNature; cardId: CardId | null; cardName: string | null; redirectedBy: string | null
    }
    const reapply = (): void => {
      const target = playerOf(host.state, ownerId)
      if (!target?.alive) return
      finalizeDamage(host as never, target, sourceId, amount, nature, cardId, cardName, redirectedBy, false)
      if (!host.state.dying) resumeDamageChain(host as never)
    }

    if (resolution.step === 'show') {
      const shown = ((response.payload as { cardIds?: CardId[] }).cardIds ?? []).filter((id) => owner?.zones.hand.includes(id))
      if (!owner?.alive || shown.length === 0) return reapply()
      host.dispatch('CardMove', { cardIds: shown, reason: HUISHENG, revealed: true }, { sourceId: ownerId })
      const source = playerOf(host.state, sourceId)
      if (!source?.alive) return reapply()
      host.dispatch('SkillActivated', { skillId: HUISHENG, skillName: '贿生', playerId: ownerId, targetId: sourceId, logText: `${owner.nickname}发动【贿生】，展示${shown.length}张牌` }, { sourceId: ownerId, targetId: sourceId })
      const options = [{ id: 'take', label: '获得其中1张，防止此伤害' }]
      if (source.zones.hand.length >= shown.length) options.push({ id: 'discard', label: `弃置${shown.length}张牌` })
      host.askSkill({
        skillId: HUISHENG, ownerId, step: 'source-choose', data: { sourceId, amount, nature, cardId, cardName, redirectedBy, shown },
        build: (requestId): ChooseOptionRequest => ({
          id: requestId, kind: 'choose-option', playerId: sourceId,
          prompt: '【贿生】：选择一项', timeoutMs: 20_000, optional: false, options,
        }),
      })
      return
    }
    if (resolution.step === 'source-choose') {
      const { shown } = resolution.data as { sourceId: PlayerId; shown: CardId[] }
      const choice = (response.payload as { optionId?: string }).optionId
      if (choice === 'discard') {
        const source = playerOf(host.state, sourceId)
        if (source?.alive) {
          host.askSkill({
            skillId: HUISHENG, ownerId, step: 'source-discard', data: { sourceId, amount, nature, cardId, cardName, redirectedBy, count: shown.length },
            build: (requestId): ChooseCardsRequest => ({
              id: requestId, kind: 'choose-cards', playerId: sourceId,
              prompt: `【贿生】：弃置${shown.length}张牌`, timeoutMs: 20_000, optional: false,
              purpose: 'skill', cardIds: [...source.zones.hand], hiddenCardSlots: [], min: shown.length, max: shown.length,
            }),
          })
          return
        }
        return reapply()
      }
      host.askSkill({
        skillId: HUISHENG, ownerId, step: 'source-take', data: { sourceId, shown },
        build: (requestId): ChooseCardsRequest => ({
          id: requestId, kind: 'choose-cards', playerId: sourceId,
          prompt: '【贿生】：获得其中1张', timeoutMs: 20_000, optional: false,
          purpose: 'skill', cardIds: shown, hiddenCardSlots: [], min: 1, max: 1,
        }),
      })
      return
    }
    if (resolution.step === 'source-discard') {
      const { count } = resolution.data as { sourceId: PlayerId; count: number }
      const source = playerOf(host.state, sourceId)
      const picked = ((response.payload as { cardIds?: CardId[] }).cardIds ?? []).filter((id) => source?.zones.hand.includes(id))
      if (!source?.alive || picked.length !== count) return reapply()
      for (const id of picked) moveCard(host.state, id, { kind: 'hand', playerId: sourceId }, { kind: 'discardPile' })
      host.dispatch('LoseCard', { playerId: sourceId, cardIds: picked, reason: HUISHENG }, { sourceId: ownerId, targetId: sourceId, cardIds: picked })
      return reapply()
    }
    if (resolution.step === 'source-take') {
      const { shown } = resolution.data as { sourceId: PlayerId; shown: CardId[] }
      const source = playerOf(host.state, sourceId)
      const [pickedId] = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
      if (!source?.alive || !pickedId || !shown.includes(pickedId) || !owner?.zones.hand.includes(pickedId)) return reapply()
      moveCard(host.state, pickedId, { kind: 'hand', playerId: ownerId }, { kind: 'hand', playerId: sourceId })
      host.dispatch('GainCard', { playerId: sourceId, cardIds: [pickedId], reason: HUISHENG }, { sourceId: ownerId, targetId: sourceId, cardIds: [pickedId] })
      host.state.huanghaoBlocked = [...(host.state.huanghaoBlocked ?? []), { ownerId, sourceId }]
    }
  },
})

export const HUANGHAO: CharacterDefinition = {
  id: 'huanghao',
  name: '黄皓',
  kingdom: 'shu',
  gender: 'male',
  maxHp: 3,
  pack: 'sp',
  skills: [
    { id: QINQING, name: '寝情', description: '结束阶段，可以选择任意名攻击范围包含主公的其他角色，依次弃置每人1张牌后其摸1张；结束后，其中手牌数大于主公的人数为X，你摸X张。' },
    { id: HUISHENG, name: '贿生', description: '你受到其他角色造成的伤害时，可以展示至少1张手牌，其选择获得其中1张并防止此伤害（此后本局你不能再对其发动贿生），或弃置等量的牌，伤害正常继续。' },
  ],
}
