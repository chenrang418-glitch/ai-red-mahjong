import { moveCard } from '../../engine/zones'
import { drawCards } from '../../engine/draw'
import { pickableCardsOf, resolvePickedCard, movePickedCard } from '../../engine/card-pick'
import { registerSkillRuntime } from '../../engine/skills/runtime'
import type { ChooseCardsRequest, ChooseOptionRequest, ChooseTargetsRequest } from '../../engine/requests'
import type { CardId, PlayerId, SanguoshaState } from '../../engine/types'
import type { CharacterDefinition } from './types'

/**
 * 曹节（三国杀 OL 经典身份 SP）。
 *
 * 【守玺】：曹节成为【杀】的目标后，可以声明一种非装备牌的牌名（每种牌名
 *          本局限声明1次）；使用者选择：弃置1张声明牌名的牌并获得曹节
 *          1张牌，或令这张杀对曹节无效（无法支付则只能选后者）。
 * 【惠民】：结束阶段，X为手牌数小于体力值的存活角色数，曹节可以摸X张牌
 *          并展示，选择一名角色为起点，按存活座次顺序依次每人获得1张
 *          展示的牌，直到展示牌分配完（可循环）。
 */

const SHOUXI = 'shouxi'
const HUIMIN = 'huimin'

function playerOf(state: SanguoshaState, playerId: PlayerId) {
  return state.players.find((candidate) => candidate.id === playerId)
}

function nonEquipmentCardNames(state: SanguoshaState): string[] {
  const names = new Set<string>()
  for (const card of Object.values(state.cards)) {
    if (card.category !== 'equipment') names.add(card.name)
  }
  return [...names]
}

registerSkillRuntime({
  id: SHOUXI,
  interceptTarget(host, ownerId, context) {
    if (context.cardName !== '杀' || context.sourceId === ownerId) return false
    const owner = playerOf(host.state, ownerId)
    const source = playerOf(host.state, context.sourceId)
    if (!owner?.alive || !source?.alive) return false
    const options = nonEquipmentCardNames(host.state).filter((name) => !(host.state.shouxiDeclared ?? []).includes(name))
    if (options.length === 0) return false
    host.askSkill({
      skillId: SHOUXI, ownerId, step: 'declare', data: { sourceId: context.sourceId },
      build: (requestId): ChooseOptionRequest => ({
        id: requestId, kind: 'choose-option', playerId: ownerId,
        prompt: '【守玺】：声明一种非装备牌的牌名', timeoutMs: 20_000, optional: true,
        options: options.map((name) => ({ id: name, label: name })),
      }),
    })
    return true
  },
  resume(host, ownerId, resolution, response) {
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) { host.resumeCardTarget(); return }

    if (resolution.step === 'declare') {
      const { sourceId } = resolution.data as { sourceId: PlayerId }
      const name = (response.payload as { optionId?: string }).optionId
      const source = playerOf(host.state, sourceId)
      if (!name || !source?.alive) { host.resumeCardTarget(); return }
      host.state.shouxiDeclared = [...(host.state.shouxiDeclared ?? []), name]
      const payable = source.zones.hand.some((cardId) => host.state.cards[cardId]?.name === name)
      const canGive = owner.zones.hand.length + Object.values(owner.zones.equipment).filter(Boolean).length > 0
      const options: Array<{ id: string; label: string }> = []
      if (payable && canGive) options.push({ id: 'pay', label: `弃置1张【${name}】，然后获得${owner.nickname}1张牌` })
      options.push({ id: 'ineffective', label: '令这张杀对其无效' })
      host.askSkill({
        skillId: SHOUXI, ownerId, step: 'choose', data: { sourceId, name },
        build: (requestId): ChooseOptionRequest => ({
          id: requestId, kind: 'choose-option', playerId: sourceId,
          prompt: `【守玺】：${owner.nickname}声明了【${name}】，请选择`, timeoutMs: 20_000, optional: false, options,
        }),
      })
      return
    }

    if (resolution.step === 'choose') {
      const { sourceId, name } = resolution.data as { sourceId: PlayerId; name: string }
      const source = playerOf(host.state, sourceId)
      const optionId = (response.payload as { optionId?: string }).optionId
      if (!source?.alive) { host.resumeCardTarget(); return }
      if (optionId === 'pay') {
        const cardId = source.zones.hand.find((id) => host.state.cards[id]?.name === name)
        if (cardId) {
          moveCard(host.state, cardId, { kind: 'hand', playerId: sourceId }, { kind: 'discardPile' })
          host.dispatch('LoseCard', { playerId: sourceId, cardIds: [cardId], reason: SHOUXI }, { sourceId, cardIds: [cardId] })
          host.dispatch('SkillActivated', { skillId: SHOUXI, skillName: '守玺', playerId: ownerId, targetId: sourceId, logText: `${source.nickname}弃置【${name}】` }, { sourceId: ownerId, targetId: sourceId })
          const pickable = pickableCardsOf(host.state, ownerId)
          if (pickable.cardIds.length + pickable.hiddenCardSlots.length > 0) {
            host.askSkill({
              skillId: SHOUXI, ownerId, step: 'gain', data: { sourceId },
              build: (requestId): ChooseCardsRequest => ({
                id: requestId, kind: 'choose-cards', playerId: sourceId,
                prompt: `【守玺】：获得${owner.nickname}1张牌`, timeoutMs: 20_000, optional: false,
                purpose: 'skill', cardIds: pickable.cardIds, hiddenCardSlots: pickable.hiddenCardSlots, min: 1, max: 1,
              }),
            })
            return
          }
        }
        host.resumeCardTarget()
        return
      }
      const current = host.state.cardResolution
      if (current?.kind === 'slash') current.targetCancelled = true
      host.dispatch('SkillActivated', { skillId: SHOUXI, skillName: '守玺', playerId: ownerId, targetId: sourceId, logText: `${owner.nickname}发动【守玺】令这张杀无效` }, { sourceId: ownerId, targetId: sourceId })
      host.resumeCardTarget()
      return
    }

    if (resolution.step === 'gain') {
      const { sourceId } = resolution.data as { sourceId: PlayerId }
      const [picked] = (response.payload as { cardIds?: string[] }).cardIds ?? []
      const cardId = picked ? resolvePickedCard(host.state, ownerId, picked) : null
      if (cardId) {
        movePickedCard(host as never, ownerId, cardId, { kind: 'hand', playerId: sourceId })
        host.dispatch('GainCard', { playerId: sourceId, cardIds: [cardId], reason: SHOUXI }, { sourceId: ownerId, targetId: sourceId, cardIds: [cardId] })
      }
      host.resumeCardTarget()
    }
  },
})

registerSkillRuntime({
  id: HUIMIN,
  triggers: [{
    event: 'PhaseStart',
    handle(host, ownerId, context) {
      const payload = context.event.payload as { phase?: string; playerId?: PlayerId }
      if (payload.phase !== 'finish' || payload.playerId !== ownerId) return
      const owner = playerOf(host.state, ownerId)
      if (!owner?.alive) return
      const x = host.state.players.filter((candidate) => candidate.alive && candidate.zones.hand.length < candidate.hp).length
      if (x <= 0) return
      const candidateIds = host.state.players.filter((candidate) => candidate.alive).map((candidate) => candidate.id)
      host.queueSkill({ skillId: HUIMIN, ownerId, step: 'ask', data: { x, candidateIds } })
    },
  }],
  startQueued(host, ownerId, prompt) {
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    if (prompt.step === 'ask') {
      host.askSkill({
        skillId: HUIMIN, ownerId, step: 'ask', data: prompt.data,
        build: (requestId): ChooseOptionRequest => ({
          id: requestId, kind: 'choose-option', playerId: ownerId,
          prompt: '【惠民】：是否发动？', timeoutMs: 20_000, optional: true,
          options: [{ id: 'yes', label: '发动' }, { id: 'no', label: '不发动' }],
        }),
      })
      return
    }
    if (prompt.step === 'draft') {
      const { pool, order, index } = prompt.data as { pool: CardId[]; order: PlayerId[]; index: number }
      const recipientId = order[index % order.length]
      const recipient = playerOf(host.state, recipientId)
      if (!recipient?.alive || pool.length === 0) return
      host.askSkill({
        skillId: HUIMIN, ownerId, step: 'draft', data: prompt.data,
        build: (requestId): ChooseCardsRequest => ({
          id: requestId, kind: 'choose-cards', playerId: recipientId,
          prompt: '【惠民】：从展示的牌中获得1张', timeoutMs: 20_000, optional: false,
          purpose: 'skill', cardIds: pool, hiddenCardSlots: [], min: 1, max: 1,
        }),
      })
    }
  },
  resume(host, ownerId, resolution, response) {
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    if (resolution.step === 'ask') {
      const { x, candidateIds } = resolution.data as { x: number; candidateIds: PlayerId[] }
      if ((response.payload as { optionId?: string }).optionId !== 'yes') return
      drawCards(host.state, host.rng, ownerId, x, (n, p) => { host.dispatch(n, p) })
      const revealed = owner.zones.hand.slice(Math.max(0, owner.zones.hand.length - x))
      if (revealed.length === 0) return
      host.dispatch('CardMove', { cardIds: revealed, reason: HUIMIN, revealed: true }, { sourceId: ownerId })
      host.dispatch('SkillActivated', { skillId: HUIMIN, skillName: '惠民', playerId: ownerId, logText: `${owner.nickname}发动【惠民】` }, { sourceId: ownerId })
      host.askSkill({
        skillId: HUIMIN, ownerId, step: 'pick-start', data: { pool: revealed, candidateIds },
        build: (requestId): ChooseTargetsRequest => ({
          id: requestId, kind: 'choose-targets', playerId: ownerId,
          prompt: '【惠民】：选择一名角色作为分配起点', timeoutMs: 20_000, optional: false,
          candidateIds, min: 1, max: 1,
        }),
      })
      return
    }
    if (resolution.step === 'pick-start') {
      const { pool, candidateIds } = resolution.data as { pool: CardId[]; candidateIds: PlayerId[] }
      const [startId] = (response.payload as { targetIds?: PlayerId[] }).targetIds ?? []
      const seatOrder = [...candidateIds].sort((a, b) => (playerOf(host.state, a)?.seat ?? 0) - (playerOf(host.state, b)?.seat ?? 0))
      const startIndex = seatOrder.findIndex((id) => id === startId)
      if (startIndex < 0 || pool.length === 0) return
      const order = [...seatOrder.slice(startIndex), ...seatOrder.slice(0, startIndex)]
      host.queueSkill({ skillId: HUIMIN, ownerId, step: 'draft', data: { pool, order, index: 0 } })
      return
    }
    if (resolution.step === 'draft') {
      const { pool, order, index } = resolution.data as { pool: CardId[]; order: PlayerId[]; index: number }
      const recipientId = order[index % order.length]
      const [cardId] = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
      const recipient = playerOf(host.state, recipientId)
      const remaining = pool.filter((id) => id !== cardId)
      if (cardId && recipient?.alive && owner.zones.hand.includes(cardId)) {
        moveCard(host.state, cardId, { kind: 'hand', playerId: ownerId }, { kind: 'hand', playerId: recipientId })
        host.dispatch('LoseCard', { playerId: ownerId, cardIds: [cardId], reason: HUIMIN }, { sourceId: ownerId, cardIds: [cardId] })
        host.dispatch('GainCard', { playerId: recipientId, cardIds: [cardId], reason: HUIMIN }, { sourceId: ownerId, targetId: recipientId, cardIds: [cardId] })
      }
      if (remaining.length === 0) return
      host.queueSkill({ skillId: HUIMIN, ownerId, step: 'draft', data: { pool: remaining, order, index: index + 1 } })
    }
  },
})

export const CAOJIE: CharacterDefinition = {
  id: 'caojie',
  name: '曹节',
  kingdom: 'wei',
  gender: 'female',
  maxHp: 3,
  pack: 'sp',
  skills: [
    { id: SHOUXI, name: '守玺', description: '你成为【杀】的目标后，可以声明一种非装备牌的牌名（每种牌名本局限声明1次），使用者需弃置1张该牌名的牌并获得你1张牌，否则这张杀对你无效。' },
    { id: HUIMIN, name: '惠民', description: '结束阶段，X为手牌数小于体力值的存活角色数，你可以摸X张牌并展示，选择一名角色为起点，按存活座次顺序每人依次获得1张展示的牌，直到分配完毕。' },
  ],
}
