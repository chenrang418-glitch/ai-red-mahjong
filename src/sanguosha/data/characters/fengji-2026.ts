import type { CardCategory, CardId, PlayerId, SanguoshaState } from '../../engine/types'
import type { CharacterDefinition } from './types'
import type { ChooseCardsRequest, ChooseTargetsRequest } from '../../engine/requests'
import { registerSkillRuntime, isCardProtectedFromDiscard, type SkillHost } from '../../engine/skills/runtime'
import { canPindian, continuePindianReveal, registerPindianContinuation, startPindian, swapPindianCards } from '../../engine/pindian'
import { lockCardCategory } from '../../engine/card-play-lock'
import { movePickedCard } from '../../engine/card-pick'
import { moveCard } from '../../engine/zones'
import { drawCards } from '../../engine/draw'

export const FENGJI_2026_PIGUO = 'fengji-2026-piguo'
export const FENGJI_2026_DOUYU = 'fengji-2026-douyu'

const PIGUO_PINDIAN = 'fengji-2026-piguo-pindian'
export const FENGJI_2026_PINDIAN_TAG = 'fengji-2026-piguo-target'
const CATEGORIES: readonly CardCategory[] = ['basic', 'trick', 'equipment']

function playerOf(state: SanguoshaState, playerId: PlayerId) {
  return state.players.find((player) => player.id === playerId)
}

function discardableCards(state: SanguoshaState, playerId: PlayerId): CardId[] {
  const player = playerOf(state, playerId)
  if (!player) return []
  return [...player.zones.hand, ...Object.values(player.zones.equipment).filter((id): id is CardId => Boolean(id))]
    .filter((cardId) => !isCardProtectedFromDiscard(state, playerId, cardId))
}

function gainOneOfEachCategory(host: SkillHost, ownerId: PlayerId): void {
  const found = new Set<CardCategory>()
  const gained: CardId[] = []
  for (const cardId of [...host.state.zones.drawPile]) {
    const category = host.state.cards[cardId]?.category
    if (!category || !CATEGORIES.includes(category) || found.has(category)) continue
    found.add(category)
    gained.push(cardId)
    moveCard(host.state, cardId, { kind: 'drawPile' }, { kind: 'hand', playerId: ownerId })
    if (found.size === CATEGORIES.length) break
  }
  if (!gained.length) return
  host.dispatch('CardMove', { playerId: ownerId, cardIds: gained, reason: FENGJI_2026_PIGUO, revealed: true },
    { sourceId: ownerId, targetId: ownerId, cardIds: gained, sourceSkillId: FENGJI_2026_PIGUO })
  host.dispatch('GainCard', { playerId: ownerId, cardIds: gained, reason: FENGJI_2026_PIGUO },
    { sourceId: ownerId, targetId: ownerId, cardIds: gained, sourceSkillId: FENGJI_2026_PIGUO })
}

registerPindianContinuation(FENGJI_2026_PINDIAN_TAG, () => undefined)

registerSkillRuntime({
  id: FENGJI_2026_PIGUO,
  triggers: [
    {
      event: 'PhaseEnd',
      handle(host, ownerId, context) {
        const phase = context.event.payload as { phase?: string; playerId?: PlayerId }
        if (phase.phase !== 'draw' || phase.playerId !== ownerId || !playerOf(host.state, ownerId)?.alive
          || !discardableCards(host.state, ownerId).length) return
        host.queueSkill({ skillId: FENGJI_2026_PIGUO, ownerId, step: 'discard-for-types', data: {} })
      },
    },
    {
      event: 'TargetConfirmed',
      handle(host, ownerId, context) {
        const targetId = (context.event.payload as { targetId?: PlayerId }).targetId ?? context.event.targetId
        if (targetId !== ownerId || host.state.currentPlayerId !== ownerId || !playerOf(host.state, ownerId)?.alive) return
        const candidateIds = host.state.players.filter((player) => player.alive && player.id !== ownerId && canPindian(host.state, player.id))
          .map(({ id }) => id)
        if (!candidateIds.length || !canPindian(host.state, ownerId)) return
        host.queueSkill({ skillId: FENGJI_2026_PIGUO, ownerId, step: 'choose-pindian-target', data: { candidateIds } })
      },
    },
    {
      event: 'PindianEnd',
      handle(host, ownerId, context) {
        const result = context.event.payload as {
          initiatorId?: PlayerId; opponentId?: PlayerId; initiatorCardId?: CardId; opponentCardId?: CardId
          outcome?: 'initiator-win' | 'opponent-win' | 'tie'
        }
        if (!result.initiatorId || !result.opponentId || !result.initiatorCardId || !result.opponentCardId) return
        if (ownerId !== result.initiatorId && ownerId !== result.opponentId) return
        const lost: PlayerId[] = result.outcome === 'tie' ? [result.initiatorId, result.opponentId]
          : result.outcome === 'initiator-win' ? [result.opponentId] : [result.initiatorId]
        const categories = [...new Set([result.initiatorCardId, result.opponentCardId]
          .map((cardId) => host.state.cards[cardId]?.category)
          .filter((category): category is CardCategory => !!category && CATEGORIES.includes(category)))]
        for (const playerId of lost) {
          for (const category of categories) {
            lockCardCategory(host.state, {
              targetId: playerId, category, sourceId: ownerId,
              skillId: `${FENGJI_2026_PIGUO}:${category}`,
            })
          }
        }
        const ownerWon = result.outcome === 'initiator-win' ? result.initiatorId === ownerId
          : result.outcome === 'opponent-win' && result.opponentId === ownerId
        if (ownerWon && playerOf(host.state, ownerId)?.alive) {
          drawCards(host.state, host.rng, ownerId, 2, (name, payload) => host.dispatch(name, payload))
        }
      },
    },
  ],
  startQueued(host, ownerId, queued) {
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    if (queued.step === 'discard-for-types') {
      const cardIds = discardableCards(host.state, ownerId)
      if (!cardIds.length) return
      host.askSkill({
        skillId: FENGJI_2026_PIGUO, ownerId, step: 'discard-for-types', data: {},
        build: (id): ChooseCardsRequest => ({
          id, kind: 'choose-cards', playerId: ownerId,
          prompt: '【愎果】：弃置一张牌，从牌堆中展示并获得基本牌、锦囊牌、装备牌各一张',
          timeoutMs: 20_000, optional: true, purpose: 'skill', cardIds, hiddenCardSlots: [], min: 0, max: 1,
        }),
      })
      return
    }
    if (queued.step === 'choose-pindian-target') {
      const candidateIds = (queued.data.candidateIds as PlayerId[]).filter((id) => canPindian(host.state, id))
      if (!canPindian(host.state, ownerId) || !candidateIds.length) return
      host.askSkill({
        skillId: FENGJI_2026_PIGUO, ownerId, step: 'choose-pindian-target', data: {},
        build: (id): ChooseTargetsRequest => ({
          id, kind: 'choose-targets', playerId: ownerId,
          prompt: '【愎果】：选择一名有手牌的其他角色拼点', timeoutMs: 20_000,
          optional: true, candidateIds, min: 0, max: 1,
        }),
      })
    }
  },
  resume(host, ownerId, resolution, response) {
    const owner = playerOf(host.state, ownerId)
    if (resolution.step === 'discard-for-types') {
      if (!owner?.alive) return
      const cardId = (response.payload as { cardIds?: CardId[] }).cardIds?.[0]
      if (!cardId || !discardableCards(host.state, ownerId).includes(cardId)) return
      if (movePickedCard(host, ownerId, cardId, { kind: 'discardPile' })) {
        host.dispatch('LoseCard', { playerId: ownerId, cardIds: [cardId], reason: FENGJI_2026_PIGUO },
          { sourceId: ownerId, cardIds: [cardId], sourceSkillId: FENGJI_2026_PIGUO })
        gainOneOfEachCategory(host, ownerId)
      }
      return
    }
    if (resolution.step === 'choose-pindian-target') {
      const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
      if (!owner?.alive || !targetId || targetId === ownerId || !canPindian(host.state, ownerId)
        || !canPindian(host.state, targetId)) return
      startPindian(host as never, {
        id: `${PIGUO_PINDIAN}:${host.state.seq}`, initiatorId: ownerId, opponentId: targetId,
        reason: FENGJI_2026_PIGUO, continuationTag: FENGJI_2026_PINDIAN_TAG,
      })
    }
  },
})

registerSkillRuntime({
  id: FENGJI_2026_DOUYU,
  offersPindianPreRevealAsk(host, ownerId, pindianId) {
    const pindian = host.state.pindian
    if (!playerOf(host.state, ownerId)?.alive || pindian?.id !== pindianId
      || ![pindian.initiatorId, pindian.opponentId].includes(ownerId)
      || !pindian.initiatorCardId || !pindian.opponentCardId) return false
    host.askSkill({
      skillId: FENGJI_2026_DOUYU, ownerId, step: 'exchange-before-reveal', data: { pindianId },
      build: (id) => ({
        id, kind: 'choose-option', playerId: ownerId,
        prompt: '【斗誉】：是否与对方交换双方的拼点牌？', timeoutMs: 20_000, optional: true,
        options: [{ id: 'exchange', label: '交换拼点牌' }, { id: 'keep', label: '不交换' }],
      }),
    })
    return true
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'exchange-before-reveal') return
    const pindianId = resolution.data.pindianId as string
    const pindian = host.state.pindian
    if (pindian?.id === pindianId && (response.payload as { optionId?: string }).optionId === 'exchange')
      swapPindianCards(host as never, pindianId, ownerId)
    continuePindianReveal(host as never, ownerId)
  },
})

export const FENGJI_2026: CharacterDefinition = {
  id: 'fengji-2026', name: '逢纪', kingdom: 'qun', gender: 'male', maxHp: 3, pack: 'sp',
  skills: [
    { id: FENGJI_2026_PIGUO, name: '愎果', description: '摸牌阶段结束时，你可弃置一张牌，从牌堆中展示并获得每个类型的牌各一张。然后你本回合成为牌的目标后，你可以拼点，没赢的角色本回合不能使用或打出与双方拼点牌类型相同的牌。' },
    { id: FENGJI_2026_DOUYU, name: '斗誉', description: '你的拼点牌亮出前，你可以与对方交换拼点牌，若你赢，你摸两张牌。' },
  ],
}
