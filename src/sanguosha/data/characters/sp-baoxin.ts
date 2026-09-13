import { moveCard } from '../../engine/zones'
import { drawCards } from '../../engine/draw'
import { resolveDamage } from '../../engine/damage'
import { getDistance } from '../../engine/distance'
import { registerSkillRuntime } from '../../engine/skills/runtime'
import type { SkillHost } from '../../engine/skills/runtime'
import type { ChooseCardsRequest, ChooseOptionRequest, ChooseTargetsRequest } from '../../engine/requests'
import type { CardId, PlayerId, SanguoshaState } from '../../engine/types'
import type { CharacterDefinition } from './types'

/**
 * 鲍信（三国杀 OL 经典身份 SP）。
 *
 * 【募讨】：出牌阶段限一次，选择一名角色A，将A手牌中所有【杀】置入
 *          鲍信的专属牌堆（`characterPiles`），然后从A的下家开始按
 *          存活座次顺序，逐个随机将这些杀分配给一名角色（确定性随机源，
 *          每人最多拿1张，轮空即止）；最后一名实际收到杀的角色L，鲍信
 *          对其造成 X=min(2, L手牌中杀的数量) 点伤害。
 * 【毅谋】：与鲍信距离不超过1的角色受到伤害后，鲍信可以选择：A随机获得
 *          牌堆中1张杀；或A交给另一名角色1张手牌然后A摸1张。
 */

const MUTAO = 'mutao'
const YIMOU = 'yimou'
const MUTAO_PILE = 'mutao'

function playerOf(state: SanguoshaState, playerId: PlayerId) {
  return state.players.find((candidate) => candidate.id === playerId)
}

function seatOrderAfter(state: SanguoshaState, fromId: PlayerId): PlayerId[] {
  const from = playerOf(state, fromId)
  if (!from) return []
  const result: PlayerId[] = []
  for (let offset = 1; offset <= state.players.length; offset += 1) {
    const candidate = state.players[(from.seat + offset) % state.players.length]
    if (candidate.alive) result.push(candidate.id)
  }
  return result
}

registerSkillRuntime({
  id: MUTAO,
  activeActions(state, ownerId) {
    if (state.phase !== 'play' || state.currentPlayerId !== ownerId) return []
    const owner = playerOf(state, ownerId)
    if (!owner?.alive || owner.turnUsedSkills.includes(MUTAO)) return []
    if (!state.players.some((candidate) => candidate.alive)) return []
    return [{ id: MUTAO, label: '募讨：选择一名角色分配其手中的杀' }]
  },

  invokeActive(host, ownerId, actionId) {
    if (actionId !== MUTAO) return
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive || owner.turnUsedSkills.includes(MUTAO)) return
    const candidateIds = host.state.players.filter((candidate) => candidate.alive).map((candidate) => candidate.id)
    host.askSkill({
      skillId: MUTAO, ownerId, step: 'target',
      build: (requestId): ChooseTargetsRequest => ({
        id: requestId, kind: 'choose-targets', playerId: ownerId,
        prompt: '【募讨】：选择一名角色', timeoutMs: 20_000, optional: false, candidateIds, min: 1, max: 1,
      }),
    })
  },

  resume(host, ownerId, resolution, response) {
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive || owner.turnUsedSkills.includes(MUTAO)) return

    if (resolution.step === 'target') {
      const [targetId] = (response.payload as { targetIds?: PlayerId[] }).targetIds ?? []
      const target = targetId ? playerOf(host.state, targetId) : undefined
      if (!target?.alive) return
      owner.turnUsedSkills.push(MUTAO)
      const slashes = target.zones.hand.filter((cardId) => host.state.cards[cardId]?.name === '杀')
      host.dispatch('SkillActivated', { skillId: MUTAO, skillName: '募讨', playerId: ownerId, targetId, logText: `${owner.nickname}发动【募讨】` }, { sourceId: ownerId, targetId })
      if (slashes.length === 0) return
      for (const cardId of slashes) moveCard(host.state, cardId, { kind: 'hand', playerId: target.id }, { kind: 'characterPile', playerId: target.id, pile: MUTAO_PILE })
      host.dispatch('LoseCard', { playerId: target.id, cardIds: slashes, reason: MUTAO }, { sourceId: target.id, cardIds: slashes })

      const order = seatOrderAfter(host.state, target.id)
      distributeNext(host, ownerId, target.id, order, [...slashes], null)
      return
    }
  },
})

function distributeNext(
  host: SkillHost,
  ownerId: PlayerId,
  poolOwnerId: PlayerId,
  order: PlayerId[],
  remaining: CardId[],
  lastRecipient: PlayerId | null,
): void {
  if (remaining.length === 0 || order.length === 0) {
    finishMutao(host, ownerId, lastRecipient)
    return
  }
  const [recipientId, ...restOrder] = order
  const recipient = playerOf(host.state, recipientId)
  if (!recipient?.alive) {
    distributeNext(host, ownerId, poolOwnerId, restOrder, remaining, lastRecipient)
    return
  }
  const picked = remaining[host.rng.nextInt(remaining.length)]
  moveCard(host.state, picked, { kind: 'characterPile', playerId: poolOwnerId, pile: MUTAO_PILE }, { kind: 'hand', playerId: recipientId })
  host.dispatch('GainCard', { playerId: recipientId, cardIds: [picked], reason: MUTAO }, { targetId: recipientId, cardIds: [picked] })
  const nextRemaining = remaining.filter((cardId) => cardId !== picked)
  distributeNext(host, ownerId, poolOwnerId, restOrder, nextRemaining, recipientId)
}

function finishMutao(
  host: SkillHost,
  ownerId: PlayerId,
  lastRecipient: PlayerId | null,
): void {
  if (!lastRecipient) return
  const target = playerOf(host.state, lastRecipient)
  if (!target?.alive) return
  const slashCount = target.zones.hand.filter((cardId) => host.state.cards[cardId]?.name === '杀').length
  const amount = Math.min(2, slashCount)
  if (amount <= 0) return
  resolveDamage(host as never, { sourceId: ownerId, targetId: lastRecipient, amount, nature: 'normal', cardName: null })
}

registerSkillRuntime({
  id: YIMOU,
  triggers: [{
    event: 'Damaged',
    handle(host, ownerId, context) {
      const targetId = context.event.targetId
      if (!targetId || targetId === ownerId) return
      const owner = playerOf(host.state, ownerId)
      const target = playerOf(host.state, targetId)
      if (!owner?.alive || !target?.alive) return
      if (getDistance(host.state, ownerId, targetId) > 1) return
      host.queueSkill({ skillId: YIMOU, ownerId, step: 'ask', data: { targetId } })
    },
  }],

  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'ask') return
    const owner = playerOf(host.state, ownerId)
    const { targetId } = prompt.data as { targetId: PlayerId }
    const target = playerOf(host.state, targetId)
    if (!owner?.alive || !target?.alive) return
    const hasSlashInDeck = host.state.zones.drawPile.some((cardId) => host.state.cards[cardId]?.name === '杀')
    const hasOtherToGive = target.zones.hand.length > 0 && host.state.players.some((candidate) => candidate.alive && candidate.id !== targetId)
    const options = [
      ...(hasSlashInDeck ? [{ id: 'draw-slash', label: `${target.nickname}随机获得牌堆中1张杀` }] : []),
      ...(hasOtherToGive ? [{ id: 'give', label: `${target.nickname}交给另一名角色1张牌，然后摸1张` }] : []),
    ]
    if (options.length === 0) return
    host.askSkill({
      skillId: YIMOU, ownerId, step: 'choose', data: { targetId },
      build: (requestId): ChooseOptionRequest => ({
        id: requestId, kind: 'choose-option', playerId: ownerId,
        prompt: '【毅谋】：请选择', timeoutMs: 20_000, optional: true, options,
      }),
    })
  },

  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'choose') {
      const { targetId } = resolution.data as { targetId: PlayerId }
      const owner = playerOf(host.state, ownerId)
      const target = playerOf(host.state, targetId)
      if (!owner?.alive || !target?.alive) return
      const optionId = (response.payload as { optionId?: string }).optionId
      if (!optionId) return
      host.dispatch('SkillActivated', { skillId: YIMOU, skillName: '毅谋', playerId: ownerId, targetId, logText: `${owner.nickname}发动【毅谋】` }, { sourceId: ownerId, targetId })

      if (optionId === 'draw-slash') {
        const slashes = host.state.zones.drawPile.filter((cardId) => host.state.cards[cardId]?.name === '杀')
        if (slashes.length === 0) return
        const picked = slashes[host.rng.nextInt(slashes.length)]
        moveCard(host.state, picked, { kind: 'drawPile' }, { kind: 'hand', playerId: targetId })
        host.dispatch('GainCard', { playerId: targetId, cardIds: [picked], reason: YIMOU }, { targetId, cardIds: [picked] })
        return
      }

      const others = host.state.players.filter((candidate) => candidate.alive && candidate.id !== targetId).map((candidate) => candidate.id)
      if (target.zones.hand.length === 0 || others.length === 0) return
      host.askSkill({
        skillId: YIMOU, ownerId, step: 'give-target', data: { targetId },
        build: (requestId): ChooseTargetsRequest => ({
          id: requestId, kind: 'choose-targets', playerId: targetId,
          prompt: '【毅谋】：选择一名角色交给1张牌', timeoutMs: 20_000, optional: false, candidateIds: others, min: 1, max: 1,
        }),
      })
      return
    }

    if (resolution.step === 'give-target') {
      const { targetId } = resolution.data as { targetId: PlayerId }
      const target = playerOf(host.state, targetId)
      if (!target?.alive) return
      const [recipientId] = (response.payload as { targetIds?: PlayerId[] }).targetIds ?? []
      const recipient = recipientId ? playerOf(host.state, recipientId) : undefined
      if (!recipient?.alive) return
      host.askSkill({
        skillId: YIMOU, ownerId, step: 'give-card', data: { targetId, recipientId },
        build: (requestId): ChooseCardsRequest => ({
          id: requestId, kind: 'choose-cards', playerId: targetId,
          prompt: `【毅谋】：交给${recipient.nickname}1张牌`, timeoutMs: 20_000, optional: false,
          purpose: 'skill', cardIds: [...target.zones.hand], hiddenCardSlots: [], min: 1, max: 1,
        }),
      })
      return
    }

    if (resolution.step === 'give-card') {
      const { targetId, recipientId } = resolution.data as { targetId: PlayerId; recipientId: PlayerId }
      const target = playerOf(host.state, targetId)
      const recipient = playerOf(host.state, recipientId)
      const [cardId] = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
      if (!target?.alive || !recipient?.alive || !cardId || !target.zones.hand.includes(cardId)) return
      moveCard(host.state, cardId, { kind: 'hand', playerId: targetId }, { kind: 'hand', playerId: recipientId })
      host.dispatch('LoseCard', { playerId: targetId, cardIds: [cardId], reason: YIMOU }, { sourceId: targetId, cardIds: [cardId] })
      host.dispatch('GainCard', { playerId: recipientId, cardIds: [cardId], reason: YIMOU }, { targetId: recipientId, cardIds: [cardId] })
      drawCards(host.state, host.rng, targetId, 1, (name, payload) => { host.dispatch(name, payload) })
    }
  },
})

export const BAOXIN: CharacterDefinition = {
  id: 'baoxin',
  name: '鲍信',
  kingdom: 'wei',
  gender: 'male',
  maxHp: 4,
  pack: 'sp',
  skills: [
    { id: MUTAO, name: '募讨', description: '出牌阶段限一次，选择一名角色，将其手牌中所有杀置入专属牌堆，然后从其下家开始按存活座次顺序随机分配这些杀，每人最多拿1张；最后一名收到杀的角色，鲍信对其造成X=min(2,其手牌杀数量)点伤害。' },
    { id: YIMOU, name: '毅谋', description: '与鲍信距离不超过1的角色受到伤害后，鲍信可以选择：其随机获得牌堆中1张杀，或其交给另一名角色1张手牌然后摸1张。' },
  ],
}
