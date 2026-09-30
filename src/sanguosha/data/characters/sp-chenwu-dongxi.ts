import { setChained } from '../../engine/character-state'
import { pickableCardsOf, resolvePickedCard, movePickedCard } from '../../engine/card-pick'
import { registerSkillRuntime, type SkillHost } from '../../engine/skills/runtime'
import type { ChooseCardsRequest, ChooseTargetsRequest } from '../../engine/requests'
import type { CardId, PlayerId, SanguoshaState } from '../../engine/types'
import type { CharacterDefinition } from './types'

/**
 * 陈武董袭（三国杀 OL 经典身份 SP）。
 *
 * 【断绁】：出牌阶段限一次，选择一名未处于连环状态的其他角色A，令A进入
 *          连环状态；若如此做，你也进入连环状态。
 * 【奋命】：结束阶段，若你处于连环状态，可以弃置每名处于连环状态角色各1张牌。
 */

const DUANXIE = 'duanxie'
const FENMING = 'fenming'

function playerOf(state: SanguoshaState, playerId: PlayerId) {
  return state.players.find((candidate) => candidate.id === playerId)
}

registerSkillRuntime({
  id: DUANXIE,
  activeActions(state, ownerId) {
    if (state.phase !== 'play' || state.currentPlayerId !== ownerId) return []
    const owner = playerOf(state, ownerId)
    if (!owner?.alive || owner.turnUsedSkills.includes(DUANXIE)) return []
    const candidateIds = state.players.filter((candidate) => candidate.alive && candidate.id !== ownerId && !candidate.chained).map((candidate) => candidate.id)
    if (candidateIds.length === 0) return []
    return [{ id: DUANXIE, label: '断绁：令一名未连环的角色进入连环状态' }]
  },
  invokeActive(host, ownerId, actionId) {
    if (actionId !== DUANXIE) return
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive || owner.turnUsedSkills.includes(DUANXIE)) return
    const candidateIds = host.state.players.filter((candidate) => candidate.alive && candidate.id !== ownerId && !candidate.chained).map((candidate) => candidate.id)
    if (candidateIds.length === 0) return
    owner.turnUsedSkills.push(DUANXIE)
    host.askSkill({
      skillId: DUANXIE, ownerId, step: 'pick-target', data: {},
      build: (requestId): ChooseTargetsRequest => ({
        id: requestId, kind: 'choose-targets', playerId: ownerId,
        prompt: '【断绁】：选择一名未处于连环状态的其他角色', timeoutMs: 20_000, optional: false,
        candidateIds, min: 1, max: 1,
      }),
    })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'pick-target') return
    const [targetId] = (response.payload as { targetIds?: PlayerId[] }).targetIds ?? []
    const owner = playerOf(host.state, ownerId)
    const target = targetId ? playerOf(host.state, targetId) : undefined
    if (!owner?.alive || !target?.alive || target.chained) return
    host.dispatch('SkillActivated', { skillId: DUANXIE, skillName: '断绁', playerId: ownerId, targetId, logText: `${owner.nickname}发动【断绁】` }, { sourceId: ownerId, targetId })
    setChained(host as never, targetId, DUANXIE, true)
    if (playerOf(host.state, targetId)?.chained) setChained(host as never, ownerId, DUANXIE, true)
  },
})

function fenmingStep(host: SkillHost, ownerId: PlayerId, ids: PlayerId[], index: number): void {
  const owner = playerOf(host.state, ownerId)
  if (!owner?.alive) return
  if (index >= ids.length) return
  const targetId = ids[index]
  const target = playerOf(host.state, targetId)
  if (!target?.alive || !target.chained) { fenmingStep(host, ownerId, ids, index + 1); return }

  if (targetId === ownerId) {
    if (owner.zones.hand.length === 0) { fenmingStep(host, ownerId, ids, index + 1); return }
    host.askSkill({
      skillId: FENMING, ownerId, step: 'self-discard', data: { ids, index },
      build: (requestId): ChooseCardsRequest => ({
        id: requestId, kind: 'choose-cards', playerId: ownerId,
        prompt: '【奋命】：弃置1张手牌', timeoutMs: 20_000, optional: false,
        purpose: 'skill', cardIds: [...owner.zones.hand], hiddenCardSlots: [], min: 1, max: 1,
      }),
    })
    return
  }
  const pickable = pickableCardsOf(host.state, targetId)
  if (pickable.cardIds.length + pickable.hiddenCardSlots.length === 0) { fenmingStep(host, ownerId, ids, index + 1); return }
  host.askSkill({
    skillId: FENMING, ownerId, step: 'pick', data: { ids, index, targetId },
    build: (requestId): ChooseCardsRequest => ({
      id: requestId, kind: 'choose-cards', playerId: ownerId,
      prompt: `【奋命】：弃置${target.nickname}一张牌`, timeoutMs: 20_000, optional: false,
      purpose: 'skill', cardIds: pickable.cardIds, hiddenCardSlots: pickable.hiddenCardSlots, min: 1, max: 1,
    }),
  })
}

registerSkillRuntime({
  id: FENMING,
  triggers: [{
    event: 'PhaseStart',
    handle(host, ownerId, context) {
      const payload = context.event.payload as { phase?: string; playerId?: PlayerId }
      if (payload.phase !== 'finish' || payload.playerId !== ownerId) return
      const owner = playerOf(host.state, ownerId)
      if (!owner?.alive || !owner.chained) return
      const ids = host.state.players.filter((candidate) => candidate.alive && candidate.chained).map((candidate) => candidate.id)
      if (ids.length === 0) return
      host.dispatch('SkillActivated', { skillId: FENMING, skillName: '奋命', playerId: ownerId, logText: `${owner.nickname}发动【奋命】` }, { sourceId: ownerId })
      host.queueSkill({ skillId: FENMING, ownerId, step: 'self-discard', data: { ids, index: 0 } })
    },
  }],
  startQueued(host, ownerId, prompt) {
    const { ids, index } = prompt.data as { ids: PlayerId[]; index: number }
    fenmingStep(host, ownerId, ids, index)
  },
  resume(host, ownerId, resolution, response) {
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    if (resolution.step === 'self-discard') {
      const { ids, index } = resolution.data as { ids: PlayerId[]; index: number }
      const [cardId] = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
      if (cardId && owner.zones.hand.includes(cardId)) {
        movePickedCard(host as never, ownerId, cardId, { kind: 'discardPile' })
        host.dispatch('LoseCard', { playerId: ownerId, cardIds: [cardId], reason: FENMING }, { sourceId: ownerId, cardIds: [cardId] })
      }
      fenmingStep(host, ownerId, ids, index + 1)
      return
    }
    if (resolution.step === 'pick') {
      const { ids, index, targetId } = resolution.data as { ids: PlayerId[]; index: number; targetId: PlayerId }
      const [picked] = (response.payload as { cardIds?: string[] }).cardIds ?? []
      const cardId = picked ? resolvePickedCard(host.state, targetId, picked) : null
      if (cardId) {
        movePickedCard(host as never, targetId, cardId, { kind: 'discardPile' })
        host.dispatch('LoseCard', { playerId: targetId, cardIds: [cardId], reason: FENMING }, { sourceId: ownerId, targetId, cardIds: [cardId] })
      }
      fenmingStep(host, ownerId, ids, index + 1)
    }
  },
})

export const CHENWU_DONGXI: CharacterDefinition = {
  id: 'chenwudongxi',
  name: '陈武董袭',
  kingdom: 'wu',
  gender: 'male',
  maxHp: 4,
  pack: 'sp',
  skills: [
    { id: DUANXIE, name: '断绁', description: '出牌阶段限一次，选择一名未处于连环状态的其他角色，令其进入连环状态；若如此做，你也进入连环状态。' },
    { id: FENMING, name: '奋命', description: '结束阶段，若你处于连环状态，可以弃置每名处于连环状态角色各1张牌。' },
  ],
}
