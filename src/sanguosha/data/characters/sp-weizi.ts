import { moveCard } from '../../engine/zones'
import { drawCards } from '../../engine/draw'
import { registerSkillRuntime } from '../../engine/skills/runtime'
import type { ChooseCardsRequest, ChooseOptionRequest } from '../../engine/requests'
import type { CardId, PlayerId, SanguoshaState } from '../../engine/types'
import type { CharacterDefinition } from './types'

/**
 * 卫兹（三国杀 OL 经典身份 SP）。
 *
 * 【援资】：每轮限一次，任意角色的准备阶段开始时，卫兹可以将自己所有手牌
 *          交给当前回合角色A；本回合内，A每次造成伤害后，若此时
 *          A.handCount>=卫兹.handCount，卫兹可以摸2张牌（不限次数）。
 * 【烈节】：卫兹受到伤害后，可以弃置至多3张牌，然后摸等量的牌；弃置的红色
 *          牌数量为R，然后可以弃置伤害来源至多R张牌。
 */

const YUANZI = 'yuanzi'
const LIEJIE = 'liejie'

function playerOf(state: SanguoshaState, playerId: PlayerId) {
  return state.players.find((candidate) => candidate.id === playerId)
}

registerSkillRuntime({
  id: YUANZI,
  triggers: [{
    event: 'PhaseStart',
    handle(host, ownerId, context) {
      const payload = context.event.payload as { phase?: string; playerId?: PlayerId }
      if (payload.phase !== 'prepare') return
      const owner = playerOf(host.state, ownerId)
      if (!owner?.alive || owner.zones.hand.length === 0) return
      if (owner.marks[YUANZI + '-round'] === host.state.roundNumber) return
      const targetId = payload.playerId ?? host.state.currentPlayerId
      const target = playerOf(host.state, targetId)
      if (!target?.alive || targetId === ownerId) return
      host.queueSkill({ skillId: YUANZI, ownerId, step: 'ask', data: { targetId } })
    },
  }, {
    event: 'Damaged',
    handle(host, ownerId, context) {
      const pending = host.state.weiziYuanziPending
      if (!pending || pending.turnNumber !== host.state.turnNumber || context.event.sourceId !== pending.targetId) return
      const owner = playerOf(host.state, ownerId)
      const target = playerOf(host.state, pending.targetId)
      if (!owner?.alive || !target?.alive || target.zones.hand.length < owner.zones.hand.length) return
      host.queueSkill({ skillId: YUANZI, ownerId, step: 'draw-ask', data: {} })
    },
  }],
  startQueued(host, ownerId, prompt) {
    if (prompt.step === 'ask') {
      const { targetId } = prompt.data as { targetId: PlayerId }
      host.askSkill({
        skillId: YUANZI, ownerId, step: 'ask', data: { targetId },
        build: (requestId): ChooseOptionRequest => ({
          id: requestId, kind: 'choose-option', playerId: ownerId,
          prompt: '【援资】：是否将所有手牌交给当前回合角色？', timeoutMs: 20_000, optional: true,
          options: [{ id: 'yes', label: '发动' }, { id: 'no', label: '不发动' }],
        }),
      })
      return
    }
    if (prompt.step === 'draw-ask') {
      host.askSkill({
        skillId: YUANZI, ownerId, step: 'draw-ask', data: {},
        build: (requestId): ChooseOptionRequest => ({
          id: requestId, kind: 'choose-option', playerId: ownerId,
          prompt: '【援资】：是否摸2张牌？', timeoutMs: 20_000, optional: true,
          options: [{ id: 'yes', label: '摸2张牌' }, { id: 'no', label: '不发动' }],
        }),
      })
    }
  },
  resume(host, ownerId, resolution, response) {
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    if (resolution.step === 'ask') {
      const { targetId } = resolution.data as { targetId: PlayerId }
      const optionId = (response.payload as { optionId?: string }).optionId
      const target = playerOf(host.state, targetId)
      if (optionId !== 'yes' || !target?.alive || owner.zones.hand.length === 0) return
      owner.marks[YUANZI + '-round'] = host.state.roundNumber
      const cardIds = [...owner.zones.hand]
      for (const cardId of cardIds) moveCard(host.state, cardId, { kind: 'hand', playerId: ownerId }, { kind: 'hand', playerId: targetId })
      host.dispatch('GainCard', { playerId: targetId, cardIds, reason: YUANZI }, { sourceId: ownerId, targetId, cardIds })
      host.dispatch('SkillActivated', { skillId: YUANZI, skillName: '援资', playerId: ownerId, logText: `${owner.nickname}发动【援资】，交给${target.nickname}所有手牌` }, { sourceId: ownerId, targetId })
      host.state.weiziYuanziPending = { targetId, turnNumber: host.state.turnNumber }
      return
    }
    if (resolution.step === 'draw-ask') {
      const optionId = (response.payload as { optionId?: string }).optionId
      if (optionId !== 'yes') return
      drawCards(host.state, host.rng, ownerId, 2, (name, payload) => { host.dispatch(name, payload) })
      host.dispatch('SkillActivated', { skillId: YUANZI, skillName: '援资', playerId: ownerId, logText: `${owner.nickname}发动【援资】，摸2张牌` }, { sourceId: ownerId })
    }
  },
})

registerSkillRuntime({
  id: LIEJIE,
  triggers: [{
    event: 'Damaged',
    handle(host, ownerId, context) {
      if (context.event.targetId !== ownerId) return
      const owner = playerOf(host.state, ownerId)
      if (!owner?.alive || owner.zones.hand.length === 0) return
      host.queueSkill({ skillId: LIEJIE, ownerId, step: 'discard', data: { sourceId: context.event.sourceId ?? null } })
    },
  }],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'discard') return
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive || owner.zones.hand.length === 0) return
    host.askSkill({
      skillId: LIEJIE, ownerId, step: 'discard', data: prompt.data,
      build: (requestId): ChooseCardsRequest => ({
        id: requestId, kind: 'choose-cards', playerId: ownerId,
        prompt: '【烈节】：弃置至多3张牌', timeoutMs: 20_000, optional: true,
        purpose: 'skill', cardIds: [...owner.zones.hand], hiddenCardSlots: [], min: 0, max: Math.min(3, owner.zones.hand.length),
      }),
    })
  },
  resume(host, ownerId, resolution, response) {
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    if (resolution.step === 'discard') {
      const { sourceId } = resolution.data as { sourceId: PlayerId | null }
      const cardIds = ((response.payload as { cardIds?: CardId[] }).cardIds ?? []).filter((id) => owner.zones.hand.includes(id))
      if (cardIds.length === 0) return
      const redCount = cardIds.filter((id) => host.state.cards[id]?.color === 'red').length
      for (const cardId of cardIds) moveCard(host.state, cardId, { kind: 'hand', playerId: ownerId }, { kind: 'discardPile' })
      host.dispatch('LoseCard', { playerId: ownerId, cardIds, reason: LIEJIE }, { sourceId: ownerId, cardIds })
      drawCards(host.state, host.rng, ownerId, cardIds.length, (name, payload) => { host.dispatch(name, payload) })
      host.dispatch('SkillActivated', { skillId: LIEJIE, skillName: '烈节', playerId: ownerId, logText: `${owner.nickname}发动【烈节】，弃${cardIds.length}张牌（${redCount}张红色）` }, { sourceId: ownerId })
      const source = sourceId ? playerOf(host.state, sourceId) : undefined
      if (redCount > 0 && source?.alive && source.zones.hand.length > 0) {
        host.askSkill({
          skillId: LIEJIE, ownerId, step: 'discard-source', data: { sourceId, r: redCount },
          build: (requestId): ChooseOptionRequest => ({
            id: requestId, kind: 'choose-option', playerId: ownerId,
            prompt: `【烈节】：弃置伤害来源至多${Math.min(redCount, source.zones.hand.length)}张牌，选择数量`, timeoutMs: 20_000, optional: true,
            options: [
              ...Array.from({ length: Math.min(redCount, source.zones.hand.length) }, (_, index) => ({ id: String(index + 1), label: `弃${index + 1}张` })),
              { id: '0', label: '不弃置' },
            ],
          }),
        })
      }
      return
    }
    if (resolution.step === 'discard-source') {
      const { sourceId } = resolution.data as { sourceId: PlayerId }
      const count = Number((response.payload as { optionId?: string }).optionId ?? '0')
      const source = playerOf(host.state, sourceId)
      if (count <= 0 || !source?.alive) return
      const pool = [...source.zones.hand]
      const picked: CardId[] = []
      for (let index = 0; index < count && pool.length > 0; index += 1) {
        const [cardId] = pool.splice(host.rng.nextInt(pool.length), 1)
        picked.push(cardId)
      }
      for (const cardId of picked) moveCard(host.state, cardId, { kind: 'hand', playerId: sourceId }, { kind: 'discardPile' })
      if (picked.length > 0) host.dispatch('LoseCard', { playerId: sourceId, cardIds: picked, reason: LIEJIE }, { sourceId: ownerId, targetId: sourceId, cardIds: picked })
    }
  },
})

export const WEIZI: CharacterDefinition = {
  id: 'weizi',
  name: '卫兹',
  kingdom: 'wei',
  gender: 'male',
  maxHp: 4,
  pack: 'sp',
  skills: [
    { id: YUANZI, name: '援资', description: '每轮限一次，任意角色的准备阶段开始时，可以将所有手牌交给当前回合角色；本回合内，其每次造成伤害后，若其手牌数不少于你的手牌数，你可以摸2张牌。' },
    { id: LIEJIE, name: '烈节', description: '受到伤害后，可以弃置至多3张牌，然后摸等量的牌；弃置的红色牌数量为R，可以弃置伤害来源至多R张牌。' },
  ],
}
