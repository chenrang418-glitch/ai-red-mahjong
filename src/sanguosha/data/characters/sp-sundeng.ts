import { moveCard } from '../../engine/zones'
import { drawCards } from '../../engine/draw'
import { registerSkillRuntime } from '../../engine/skills/runtime'
import type { ChooseCardsRequest, ChooseTargetsRequest } from '../../engine/requests'
import type { CardId, PlayerId, SanguoshaState } from '../../engine/types'
import type { CharacterDefinition } from './types'

/**
 * 孙登（三国杀 OL 经典身份 SP）。
 *
 * 【匡弼】：出牌阶段限一次，选择一名其他角色A，A将1~3张牌置于你的武将牌上
 *          （称为"匡弼牌"）；你下一个回合开始时获得所有匡弼牌，A摸等量的牌。
 */

const KUANGBI = 'kuangbi'
const PILE = 'kuangbi'

function playerOf(state: SanguoshaState, playerId: PlayerId) {
  return state.players.find((candidate) => candidate.id === playerId)
}

registerSkillRuntime({
  id: KUANGBI,
  activeActions(state, ownerId) {
    if (state.phase !== 'play' || state.currentPlayerId !== ownerId) return []
    const owner = playerOf(state, ownerId)
    if (!owner?.alive || owner.turnUsedSkills.includes(KUANGBI)) return []
    if (!state.players.some((candidate) => candidate.alive && candidate.id !== ownerId && candidate.zones.hand.length > 0)) return []
    return [{ id: KUANGBI, label: '匡弼：选择一名角色置1~3张牌于你的武将牌上' }]
  },
  invokeActive(host, ownerId, actionId) {
    if (actionId !== KUANGBI) return
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive || owner.turnUsedSkills.includes(KUANGBI)) return
    const candidateIds = host.state.players.filter((candidate) => candidate.alive && candidate.id !== ownerId && candidate.zones.hand.length > 0).map((candidate) => candidate.id)
    if (candidateIds.length === 0) return
    owner.turnUsedSkills.push(KUANGBI)
    host.askSkill({
      skillId: KUANGBI, ownerId, step: 'pick-target', data: {},
      build: (requestId): ChooseTargetsRequest => ({
        id: requestId, kind: 'choose-targets', playerId: ownerId,
        prompt: '【匡弼】：选择一名其他角色', timeoutMs: 20_000, optional: false,
        candidateIds, min: 1, max: 1,
      }),
    })
  },
  resume(host, ownerId, resolution, response) {
    const owner = playerOf(host.state, ownerId)
    if (resolution.step === 'pick-target') {
      const [targetId] = (response.payload as { targetIds?: PlayerId[] }).targetIds ?? []
      const target = targetId ? playerOf(host.state, targetId) : undefined
      if (!owner?.alive || !target?.alive || target.zones.hand.length === 0) return
      const max = Math.min(3, target.zones.hand.length)
      host.dispatch('SkillActivated', { skillId: KUANGBI, skillName: '匡弼', playerId: ownerId, targetId, logText: `${owner.nickname}发动【匡弼】` }, { sourceId: ownerId, targetId })
      host.askSkill({
        skillId: KUANGBI, ownerId, step: 'target-place', data: { targetId },
        build: (requestId): ChooseCardsRequest => ({
          id: requestId, kind: 'choose-cards', playerId: targetId,
          prompt: `【匡弼】：置1~${max}张牌于孙登的武将牌上`, timeoutMs: 20_000, optional: true,
          purpose: 'skill', cardIds: [...target.zones.hand], hiddenCardSlots: [], min: 0, max,
        }),
      })
      return
    }
    if (resolution.step === 'target-place') {
      const { targetId } = resolution.data as { targetId: PlayerId }
      const target = playerOf(host.state, targetId)
      const picked = ((response.payload as { cardIds?: CardId[] }).cardIds ?? []).filter((cardId) => target?.zones.hand.includes(cardId)).slice(0, 3)
      if (!owner?.alive || !target?.alive || picked.length === 0) return
      for (const cardId of picked) moveCard(host.state, cardId, { kind: 'hand', playerId: targetId }, { kind: 'characterPile', playerId: ownerId, pile: PILE })
      host.dispatch('LoseCard', { playerId: targetId, cardIds: picked, reason: KUANGBI }, { sourceId: targetId, cardIds: picked })
      host.state.sundengKuangbi = [...(host.state.sundengKuangbi ?? []), { providerId: targetId, cardIds: picked }]
    }
  },
  triggers: [{
    event: 'PhaseStart',
    handle(host, ownerId, context) {
      const payload = context.event.payload as { phase?: string; playerId?: PlayerId }
      if (payload.phase !== 'prepare' || payload.playerId !== ownerId) return
      const entries = host.state.sundengKuangbi ?? []
      host.state.sundengKuangbi = []
      if (entries.length === 0) return
      const owner = playerOf(host.state, ownerId)
      const inPile = new Set(owner?.characterPiles?.[PILE] ?? [])
      const grouped = entries.map((entry) => ({ providerId: entry.providerId, cardIds: entry.cardIds.filter((cardId) => inPile.has(cardId)) }))
      const allCardIds = grouped.flatMap((entry) => entry.cardIds)
      if (owner?.alive && allCardIds.length > 0) {
        for (const cardId of allCardIds) moveCard(host.state, cardId, { kind: 'characterPile', playerId: ownerId, pile: PILE }, { kind: 'hand', playerId: ownerId })
        host.dispatch('GainCard', { playerId: ownerId, cardIds: allCardIds, reason: KUANGBI }, { targetId: ownerId, cardIds: allCardIds })
        host.dispatch('SkillActivated', { skillId: KUANGBI, skillName: '匡弼', playerId: ownerId, logText: `${owner.nickname}的【匡弼】牌回到手中` }, { sourceId: ownerId })
      }
      for (const entry of grouped) {
        const provider = playerOf(host.state, entry.providerId)
        if (!provider?.alive || entry.cardIds.length === 0) continue
        drawCards(host.state, host.rng, entry.providerId, entry.cardIds.length, (name, payload2) => { host.dispatch(name, payload2) })
      }
    },
  }],
})

export const SUNDENG: CharacterDefinition = {
  id: 'sundeng',
  name: '孙登',
  kingdom: 'wu',
  gender: 'male',
  maxHp: 3,
  pack: 'sp',
  skills: [
    { id: KUANGBI, name: '匡弼', description: '出牌阶段限一次，选择一名其他角色，其将1~3张牌置于你的武将牌上；你下一个回合开始时获得所有这些牌，提供者摸等量的牌。' },
  ],
}
