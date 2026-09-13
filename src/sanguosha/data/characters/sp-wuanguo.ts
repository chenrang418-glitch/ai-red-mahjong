import { moveCard } from '../../engine/zones'
import { createVirtualTrick } from '../../engine/virtual-trick'
import { executeUseCardAction } from '../../engine/cards/basic'
import { conversionStateOf, toggleConversionState } from '../../engine/conversion'
import { registerSkillRuntime } from '../../engine/skills/runtime'
import type { ChooseCardsRequest, ChooseOptionRequest, ChooseTargetsRequest } from '../../engine/requests'
import type { CardId, PlayerId, SanguoshaState, Suit } from '../../engine/types'
import type { CharacterDefinition } from './types'

/**
 * 武安国（三国杀 OL 经典身份 SP）。
 *
 * 【历勇】：转换技。阳：出牌阶段，可以将1张本回合尚未使用过花色的牌当
 *          【决斗】使用；阴：出牌阶段，可以从牌堆中获得1张本回合已经
 *          使用过花色的牌，然后选择一名角色，令其视为对你使用一张
 *          【决斗】。每次成功发动后阴阳切换。
 */

const LIYONG = 'liyong'
const SUIT_LABELS: Record<Suit, string> = { spade: '黑桃', heart: '红桃', club: '梅花', diamond: '方块' }

function playerOf(state: SanguoshaState, playerId: PlayerId) {
  return state.players.find((candidate) => candidate.id === playerId)
}

function usedSuitsThisTurn(state: SanguoshaState, ownerId: PlayerId): Suit[] {
  const entry = state.wuanguoUsedSuitsTurn?.[ownerId]
  return entry?.turnNumber === state.turnNumber ? entry.suits : []
}

registerSkillRuntime({
  id: LIYONG,
  triggers: [{
    event: 'CardUsed',
    handle(host, ownerId, context) {
      if (context.event.sourceId !== ownerId) return
      const payload = context.event.payload as { cardId?: CardId }
      const suit = payload.cardId ? host.state.cards[payload.cardId]?.suit : undefined
      if (!suit) return
      const suits = new Set(usedSuitsThisTurn(host.state, ownerId))
      suits.add(suit)
      host.state.wuanguoUsedSuitsTurn ??= {}
      host.state.wuanguoUsedSuitsTurn[ownerId] = { turnNumber: host.state.turnNumber, suits: [...suits] }
    },
  }],
  activeActions(state, ownerId) {
    if (state.phase !== 'play' || state.currentPlayerId !== ownerId) return []
    const owner = playerOf(state, ownerId)
    if (!owner?.alive) return []
    const mode = conversionStateOf(state, ownerId, LIYONG)
    const used = usedSuitsThisTurn(state, ownerId)
    if (mode === 'yang') {
      if (!owner.zones.hand.some((id) => { const suit = state.cards[id]?.suit; return suit && !used.includes(suit) })) return []
      return [{ id: 'liyong-yang', label: '历勇：将1张本回合未用过花色的牌当【决斗】使用' }]
    }
    if (used.length === 0) return []
    return [{ id: 'liyong-yin', label: '历勇：从牌堆获得1张已用过花色的牌' }]
  },
  invokeActive(host, ownerId, actionId) {
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    const mode = conversionStateOf(host.state, ownerId, LIYONG)
    if (actionId === 'liyong-yang' && mode === 'yang') {
      const used = usedSuitsThisTurn(host.state, ownerId)
      const candidates = owner.zones.hand.filter((id) => { const suit = host.state.cards[id]?.suit; return suit && !used.includes(suit) })
      if (candidates.length === 0) return
      host.askSkill({
        skillId: LIYONG, ownerId, step: 'pick-card', data: {},
        build: (requestId): ChooseCardsRequest => ({
          id: requestId, kind: 'choose-cards', playerId: ownerId,
          prompt: '【历勇】：选择1张本回合未用过花色的牌当【决斗】使用', timeoutMs: 20_000, optional: false,
          purpose: 'skill', cardIds: candidates, hiddenCardSlots: [], min: 1, max: 1,
        }),
      })
      return
    }
    if (actionId === 'liyong-yin' && mode === 'yin') {
      const used = usedSuitsThisTurn(host.state, ownerId)
      host.askSkill({
        skillId: LIYONG, ownerId, step: 'pick-suit', data: {},
        build: (requestId): ChooseOptionRequest => ({
          id: requestId, kind: 'choose-option', playerId: ownerId,
          prompt: '【历勇】：选择一个已使用过的花色', timeoutMs: 20_000, optional: false,
          options: used.map((suit) => ({ id: suit, label: SUIT_LABELS[suit] })),
        }),
      })
    }
  },
  resume(host, ownerId, resolution, response) {
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return

    if (resolution.step === 'pick-card') {
      const [cardId] = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
      if (!cardId || !owner.zones.hand.includes(cardId)) return
      const candidateIds = host.state.players.filter((candidate) => candidate.alive && candidate.id !== ownerId).map((candidate) => candidate.id)
      if (candidateIds.length === 0) return
      host.askSkill({
        skillId: LIYONG, ownerId, step: 'yang-target', data: { cardId },
        build: (requestId): ChooseTargetsRequest => ({
          id: requestId, kind: 'choose-targets', playerId: ownerId,
          prompt: '【历勇】：选择决斗目标', timeoutMs: 20_000, optional: false,
          candidateIds, min: 1, max: 1,
        }),
      })
      return
    }

    if (resolution.step === 'yang-target') {
      const { cardId } = resolution.data as { cardId: CardId }
      const [targetId] = (response.payload as { targetIds?: PlayerId[] }).targetIds ?? []
      if (!targetId || !owner.zones.hand.includes(cardId)) return
      host.dispatch('SkillActivated', { skillId: LIYONG, skillName: '历勇', playerId: ownerId, targetId, logText: `${owner.nickname}发动【历勇】（阳）` }, { sourceId: ownerId, targetId })
      executeUseCardAction(host as never, ownerId, {
        kind: 'use-card', id: `liyong:${cardId}`, playerId: ownerId,
        cardIds: [cardId], targetIds: [targetId], targetMin: 1, targetMax: 1,
        asCardName: '决斗', label: '历勇：视为使用【决斗】',
      })
      toggleConversionState(host.state, ownerId, LIYONG)
      return
    }

    if (resolution.step === 'pick-suit') {
      const suit = (response.payload as { optionId?: string }).optionId as Suit
      const candidates = host.state.zones.drawPile.filter((id) => host.state.cards[id]?.suit === suit)
      if (candidates.length === 0) return
      const cardId = candidates[host.rng.nextInt(candidates.length)]
      moveCard(host.state, cardId, { kind: 'drawPile' }, { kind: 'hand', playerId: ownerId })
      host.dispatch('GainCard', { playerId: ownerId, cardIds: [cardId], reason: LIYONG }, { targetId: ownerId, cardIds: [cardId] })
      const candidateIds = host.state.players.filter((candidate) => candidate.alive && candidate.id !== ownerId).map((candidate) => candidate.id)
      if (candidateIds.length === 0) { toggleConversionState(host.state, ownerId, LIYONG); return }
      host.askSkill({
        skillId: LIYONG, ownerId, step: 'yin-target', data: {},
        build: (requestId): ChooseTargetsRequest => ({
          id: requestId, kind: 'choose-targets', playerId: ownerId,
          prompt: '【历勇】：选择一名角色，令其对你使用【决斗】', timeoutMs: 20_000, optional: false,
          candidateIds, min: 1, max: 1,
        }),
      })
      return
    }

    if (resolution.step === 'yin-target') {
      const [targetId] = (response.payload as { targetIds?: PlayerId[] }).targetIds ?? []
      if (!targetId) return
      host.dispatch('SkillActivated', { skillId: LIYONG, skillName: '历勇', playerId: ownerId, targetId, logText: `${owner.nickname}发动【历勇】（阴）` }, { sourceId: ownerId, targetId })
      const virtualId = createVirtualTrick(host.state, targetId, '决斗', LIYONG)
      executeUseCardAction(host as never, targetId, {
        kind: 'use-card', id: `liyong-duel:${virtualId}`, playerId: targetId,
        cardIds: [virtualId], targetIds: [ownerId], targetMin: 1, targetMax: 1,
        asCardName: '决斗', label: '历勇：视为使用【决斗】',
      })
      toggleConversionState(host.state, ownerId, LIYONG)
    }
  },
})

export const WUANGUO: CharacterDefinition = {
  id: 'wuanguo',
  name: '武安国',
  kingdom: 'qun',
  gender: 'male',
  maxHp: 4,
  pack: 'sp',
  skills: [
    { id: LIYONG, name: '历勇', description: '转换技。阳：出牌阶段，可以将1张本回合尚未使用过花色的牌当【决斗】使用；阴：出牌阶段，可以从牌堆中获得1张本回合已经使用过花色的牌，然后选择一名角色，令其视为对你使用一张【决斗】。每次成功发动后阴阳切换。' },
  ],
}
