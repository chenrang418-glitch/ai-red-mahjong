import { moveCard } from '../../engine/zones'
import { drawCards } from '../../engine/draw'
import { killPlayer } from '../../engine/damage'
import { startPindian, registerPindianContinuation, finishPindianSettlement } from '../../engine/pindian'
import { registerSkillRuntime, type SkillHost } from '../../engine/skills/runtime'
import type { ChooseCardsRequest, ChooseOptionRequest, ChooseTargetsRequest } from '../../engine/requests'
import type { CardId, PlayerId, SanguoshaState } from '../../engine/types'
import type { CharacterDefinition } from './types'

/**
 * 王朗（三国杀 OL 经典身份 SP）。
 *
 * 【鼓舌】：出牌阶段限一次，选择1~3名有手牌的其他角色，用自己的一张手牌
 *          依次与他们拼点（同一张牌，不重新出牌）。没赢的一方各自结算：
 *          王朗没赢则获得1枚"饶舌"（满7点死亡）；目标没赢则选择弃置1张牌
 *          或令王朗摸1张牌。
 * 【激词】：王朗当前拼点牌有效点数≤饶舌数量X时，可以发动，令这次拼点
 *          effective number+X，并令本回合【鼓舌】视为未发动（可再发动）。
 */

const GUSHE = 'gushe'
const JICI = 'jici'
const GUSHE_PILE = 'gushe'
const PINDIAN_TAG = 'wanglang-gushe-pindian'

interface GusheData {
  [key: string]: unknown
  queue: PlayerId[]
  index: number
  gusheCardId: CardId
  jiciUsed: boolean
}

function playerOf(state: SanguoshaState, playerId: PlayerId) {
  return state.players.find((candidate) => candidate.id === playerId)
}

function raosheOf(state: SanguoshaState, ownerId: PlayerId): number {
  return playerOf(state, ownerId)?.marks[GUSHE + '-raoshe'] ?? 0
}

registerSkillRuntime({
  id: GUSHE,
  activeActions(state, ownerId) {
    if (state.phase !== 'play' || state.currentPlayerId !== ownerId) return []
    const owner = playerOf(state, ownerId)
    if (!owner?.alive || owner.zones.hand.length === 0 || owner.turnUsedSkills.includes(GUSHE)) return []
    if (!state.players.some((candidate) => candidate.alive && candidate.id !== ownerId && candidate.zones.hand.length > 0)) return []
    return [{ id: GUSHE, label: '鼓舌：用一张手牌与1~3名角色依次拼点' }]
  },
  invokeActive(host, ownerId, actionId) {
    if (actionId !== GUSHE) return
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive || owner.zones.hand.length === 0 || owner.turnUsedSkills.includes(GUSHE)) return
    const candidateIds = host.state.players.filter((candidate) => candidate.alive && candidate.id !== ownerId && candidate.zones.hand.length > 0).map((candidate) => candidate.id)
    if (candidateIds.length === 0) return
    owner.turnUsedSkills.push(GUSHE)
    host.askSkill({
      skillId: GUSHE, ownerId, step: 'pick-targets', data: {},
      build: (requestId): ChooseTargetsRequest => ({
        id: requestId, kind: 'choose-targets', playerId: ownerId,
        prompt: '【鼓舌】：选择1~3名有手牌的角色', timeoutMs: 20_000, optional: false,
        candidateIds, min: 1, max: Math.min(3, candidateIds.length),
      }),
    })
  },
  resume(host, ownerId, resolution, response) {
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return

    if (resolution.step === 'pick-targets') {
      const targetIds = ((response.payload as { targetIds?: PlayerId[] }).targetIds ?? []).filter((id) => playerOf(host.state, id)?.alive && (playerOf(host.state, id)?.zones.hand.length ?? 0) > 0)
      if (targetIds.length === 0 || owner.zones.hand.length === 0) return
      host.askSkill({
        skillId: GUSHE, ownerId, step: 'pick-card', data: { queue: targetIds },
        build: (requestId): ChooseCardsRequest => ({
          id: requestId, kind: 'choose-cards', playerId: ownerId,
          prompt: '【鼓舌】：选择一张手牌用于拼点', timeoutMs: 20_000, optional: false,
          purpose: 'skill', cardIds: [...owner.zones.hand], hiddenCardSlots: [], min: 1, max: 1,
        }),
      })
      return
    }

    if (resolution.step === 'pick-card') {
      const { queue } = resolution.data as { queue: PlayerId[] }
      const [cardId] = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
      if (!cardId || !owner.zones.hand.includes(cardId)) return
      moveCard(host.state, cardId, { kind: 'hand', playerId: ownerId }, { kind: 'characterPile', playerId: ownerId, pile: GUSHE_PILE })
      host.dispatch('SkillActivated', { skillId: GUSHE, skillName: '鼓舌', playerId: ownerId, logText: `${owner.nickname}发动【鼓舌】` }, { sourceId: ownerId, cardIds: [cardId] })
      advanceGushe(host, ownerId, { queue, index: 0, gusheCardId: cardId, jiciUsed: false })
      return
    }

    if (resolution.step === 'jici-ask') {
      const data = resolution.data as GusheData
      const optionId = (response.payload as { optionId?: string }).optionId
      if (optionId === 'yes') {
        const rank = host.state.cards[data.gusheCardId]?.rank ?? 0
        const x = raosheOf(host.state, ownerId)
        host.state.wanglangJici ??= {}
        host.state.wanglangJici[ownerId] = { overrideRank: rank + x }
        data.jiciUsed = true
        host.dispatch('SkillActivated', { skillId: JICI, skillName: '激词', playerId: ownerId, logText: `${owner.nickname}发动【激词】，拼点牌视为${rank + x}点` }, { sourceId: ownerId })
      }
      startGusheRound(host, ownerId, data)
      return
    }

    if (resolution.step === 'target-choice') {
      const data = resolution.data as GusheData
      const optionId = (response.payload as { optionId?: string }).optionId
      const targetId = response.playerId
      if (optionId === 'draw') {
        drawCards(host.state, host.rng, ownerId, 1, (name, payload) => { host.dispatch(name, payload) })
        host.dispatch('SkillActivated', { skillId: GUSHE, skillName: '鼓舌', playerId: ownerId, logText: `${owner.nickname}摸1张牌` }, { sourceId: ownerId })
        data.index += 1
        advanceGushe(host, ownerId, data)
        return
      }
      const target = playerOf(host.state, targetId)
      if (optionId === 'discard' && target?.alive && target.zones.hand.length > 0) {
        host.askSkill({
          skillId: GUSHE, ownerId, step: 'target-discard', data,
          build: (requestId): ChooseCardsRequest => ({
            id: requestId, kind: 'choose-cards', playerId: targetId,
            prompt: '【鼓舌】：弃置1张手牌', timeoutMs: 20_000, optional: false,
            purpose: 'skill', cardIds: [...target.zones.hand], hiddenCardSlots: [], min: 1, max: 1,
          }),
        })
        return
      }
      data.index += 1
      advanceGushe(host, ownerId, data)
      return
    }

    if (resolution.step === 'target-discard') {
      const data = resolution.data as GusheData
      const targetId = response.playerId
      const target = playerOf(host.state, targetId)
      const [cardId] = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
      if (target?.alive && cardId && target.zones.hand.includes(cardId)) {
        moveCard(host.state, cardId, { kind: 'hand', playerId: targetId }, { kind: 'discardPile' })
        host.dispatch('LoseCard', { playerId: targetId, cardIds: [cardId], reason: GUSHE }, { sourceId: targetId, cardIds: [cardId] })
      }
      data.index += 1
      advanceGushe(host, ownerId, data)
    }
  },
})

function advanceGushe(host: SkillHost, ownerId: PlayerId, data: GusheData): void {
  const owner = playerOf(host.state, ownerId)
  if (!owner?.alive) return
  if (data.index >= data.queue.length) {
    const pileHasCard = owner.characterPiles[GUSHE_PILE]?.includes(data.gusheCardId)
    if (pileHasCard) moveCard(host.state, data.gusheCardId, { kind: 'characterPile', playerId: ownerId, pile: GUSHE_PILE }, { kind: 'discardPile' })
    if (data.jiciUsed) owner.turnUsedSkills = owner.turnUsedSkills.filter((id) => id !== GUSHE)
    return
  }
  const targetId = data.queue[data.index]
  const target = playerOf(host.state, targetId)
  if (!target?.alive || target.zones.hand.length === 0) {
    data.index += 1
    advanceGushe(host, ownerId, data)
    return
  }
  const rank = host.state.cards[data.gusheCardId]?.rank ?? 0
  const x = raosheOf(host.state, ownerId)
  if (rank <= x) {
    host.askSkill({
      skillId: GUSHE, ownerId, step: 'jici-ask', data,
      build: (requestId): ChooseOptionRequest => ({
        id: requestId, kind: 'choose-option', playerId: ownerId,
        prompt: `【激词】：拼点牌${rank}点≤饶舌${x}，是否发动？`, timeoutMs: 20_000, optional: true,
        options: [{ id: 'yes', label: '发动' }, { id: 'no', label: '不发动' }],
      }),
    })
    return
  }
  startGusheRound(host, ownerId, data)
}

function startGusheRound(host: SkillHost, ownerId: PlayerId, data: GusheData): void {
  const targetId = data.queue[data.index]
  startPindian(host as never, {
    id: `gushe-${host.state.seq}`, initiatorId: ownerId, opponentId: targetId,
    reason: GUSHE, continuationTag: PINDIAN_TAG, timeoutMs: 20_000,
    initiatorForcedCardId: data.gusheCardId, data: data as unknown as Record<string, unknown>,
  })
}

registerPindianContinuation(PINDIAN_TAG, (host, result) => {
  const skillHost = host as unknown as SkillHost
  const ownerId = result.initiatorId
  const data = result.data as unknown as GusheData
  delete host.state.wanglangJici?.[ownerId]
  const owner = playerOf(host.state, ownerId)
  if (!owner?.alive) return
  // 保留王朗自己那张拼点牌供下一轮复用：先移出处理区，再让公共结算只清对方那张
  moveCard(host.state, result.initiatorCardId, { kind: 'processingArea' }, { kind: 'characterPile', playerId: ownerId, pile: GUSHE_PILE })
  finishPindianSettlement(host)

  const ownerWon = result.outcome === 'initiator-win'
  const targetWon = result.outcome === 'opponent-win'
  if (!ownerWon) {
    owner.marks[GUSHE + '-raoshe'] = (owner.marks[GUSHE + '-raoshe'] ?? 0) + 1
    host.dispatch('SkillActivated', { skillId: GUSHE, skillName: '鼓舌', playerId: ownerId, logText: `${owner.nickname}获得1枚"饶舌"（${owner.marks[GUSHE + '-raoshe']}）` }, { sourceId: ownerId })
    if (owner.marks[GUSHE + '-raoshe'] >= 7) {
      killPlayer(skillHost as never, ownerId, ownerId, GUSHE)
      return
    }
  }

  if (!targetWon) {
    const targetId = result.opponentId
    skillHost.askSkill({
      skillId: GUSHE, ownerId, step: 'target-choice', data,
      build: (requestId): ChooseOptionRequest => ({
        id: requestId, kind: 'choose-option', playerId: targetId,
        prompt: '【鼓舌】：弃置1张牌，或令王朗摸1张牌', timeoutMs: 20_000, optional: false,
        options: [{ id: 'discard', label: '弃置1张牌' }, { id: 'draw', label: '令王朗摸1张牌' }],
      }),
    })
    return
  }
  data.index += 1
  advanceGushe(skillHost, ownerId, data)
})

registerSkillRuntime({
  id: JICI,
  pindianRankOverride(state, ownerId) {
    const armed = state.wanglangJici?.[ownerId]
    return armed ? armed.overrideRank : null
  },
})

export const WANGLANG: CharacterDefinition = {
  id: 'wanglang',
  name: '王朗',
  kingdom: 'wei',
  gender: 'male',
  maxHp: 3,
  pack: 'sp',
  skills: [
    { id: GUSHE, name: '鼓舌', description: '出牌阶段限一次，选择1~3名有手牌的其他角色，用一张手牌依次与其拼点：没赢的一方，你获得1枚"饶舌"（满7点死亡）；对方没赢则弃置1张牌或令你摸1张牌。' },
    { id: JICI, name: '激词', description: '你的拼点牌有效点数≤饶舌数量X时，可以发动，令这次拼点点数+X，并令本回合【鼓舌】视为未发动。' },
  ],
}
