import { flipCharacter } from '../../engine/character-state'
import { recover } from '../../engine/recover'
import { drawCards } from '../../engine/draw'
import { markUsedThisPhase, usedThisPhase } from '../../engine/phase-usage'
import { registerSkillRuntime } from '../../engine/skills/runtime'
import { moveCard } from '../../engine/zones'
import type { ChooseCardsRequest, ChooseOptionRequest, ChooseTargetsRequest } from '../../engine/requests'
import type { CardCategory, CardId, PlayerId, SanguoshaState } from '../../engine/types'
import type { CharacterDefinition } from './types'

/**
 * 满宠（一将成名 2013）。
 *
 * 【峻刑】：出牌阶段限一次，你可以弃置至少一张手牌，然后选择一名其他角色，
 *          其选择：弃置一张与你此次弃置的所有牌类别均不同的手牌；
 *          或者翻面，然后摸 X 张牌（X 为你此次弃置的牌数）。
 * 【御策】：你受到一次伤害后，你可以展示一张手牌，然后伤害来源选择是否
 *          弃置一张与你展示的牌类别不同的手牌，若其不弃置或无法弃置，你回复 1 点体力。
 *
 * 三处最容易做错的：
 *
 * 1. **峻刑的「类别不同」看的是满宠此次弃置的全部类别的集合**：一次弃了
 *    基本 + 锦囊，目标就只能弃装备；三种类别都弃了，目标必然无路可走，
 *    只能选翻面摸牌。
 * 2. **X 等于满宠这次峻刑弃置的牌数**，不是固定值。
 * 3. **御策按「一次伤害」触发，不按每点伤害**；来源为空或已死时，
 *    直接按「无法弃置」处理，满宠回复 1 点体力。
 */

const JUNXING = 'junxing'
const YUCE = 'yuce'
const JUNXING_ACTION = 'junxing-invoke'

function playerOf(state: SanguoshaState, playerId: PlayerId) {
  return state.players.find((candidate) => candidate.id === playerId)
}

function categoryOf(state: SanguoshaState, cardId: CardId): CardCategory | null {
  return state.cards[cardId]?.category ?? null
}

/** 目标手牌里，类别不在 `excluded` 集合内的那些。 */
function eligibleForA(state: SanguoshaState, targetId: PlayerId, excluded: Set<CardCategory>): CardId[] {
  const target = playerOf(state, targetId)
  if (!target?.alive) return []
  return target.zones.hand.filter((cardId) => {
    const category = categoryOf(state, cardId)
    return category != null && !excluded.has(category)
  })
}

registerSkillRuntime({
  id: JUNXING,
  announcesSelf: true,

  activeActions(state, ownerId) {
    if (state.phase !== 'play' || state.currentPlayerId !== ownerId) return []
    if (usedThisPhase(state, ownerId, JUNXING)) return []
    const owner = playerOf(state, ownerId)
    if (!owner?.alive || owner.zones.hand.length === 0) return []
    if (state.players.filter((candidate) => candidate.alive && candidate.id !== ownerId).length === 0) return []
    return [{ id: JUNXING_ACTION, label: '峻刑：弃置至少一张手牌，令一名其他角色选择弃牌或翻面摸牌' }]
  },

  invokeActive(host, ownerId, actionId) {
    if (actionId !== JUNXING_ACTION) return
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive || owner.zones.hand.length === 0) return
    host.askSkill({
      skillId: JUNXING, ownerId, step: 'cost',
      build: (requestId): ChooseCardsRequest => ({
        id: requestId, kind: 'choose-cards', playerId: ownerId,
        prompt: '【峻刑】：弃置至少一张手牌',
        timeoutMs: 25_000, optional: true, purpose: 'skill',
        cardIds: [...owner.zones.hand], hiddenCardSlots: [],
        min: 0, max: owner.zones.hand.length,
      }),
    })
  },

  resume(host, ownerId, resolution, response) {
    const owner = playerOf(host.state, ownerId)

    if (resolution.step === 'cost') {
      const cardIds = [...new Set((response.payload as { cardIds?: CardId[] }).cardIds ?? [])]
        .filter((cardId) => owner?.zones.hand.includes(cardId))
      if (cardIds.length === 0 || !owner?.alive) return
      const candidateIds = host.state.players.filter((candidate) => candidate.alive && candidate.id !== ownerId).map((candidate) => candidate.id)
      if (candidateIds.length === 0) return
      markUsedThisPhase(host.state, ownerId, JUNXING)
      for (const cardId of cardIds) moveCard(host.state, cardId, { kind: 'hand', playerId: ownerId }, { kind: 'discardPile' })
      host.dispatch('LoseCard', { playerId: ownerId, cardIds, reason: JUNXING }, { targetId: ownerId, cardIds })
      const excluded = new Set(cardIds.map((cardId) => categoryOf(host.state, cardId)).filter((category): category is CardCategory => category != null))
      host.askSkill({
        skillId: JUNXING, ownerId, step: 'target', data: { excluded: [...excluded], count: cardIds.length },
        build: (requestId): ChooseTargetsRequest => ({
          id: requestId, kind: 'choose-targets', playerId: ownerId,
          prompt: '【峻刑】：选择一名其他角色',
          timeoutMs: 20_000, optional: false,
          candidateIds, min: 1, max: 1,
        }),
      })
      return
    }

    if (resolution.step === 'target') {
      const [targetId] = (response.payload as { targetIds?: PlayerId[] }).targetIds ?? []
      const target = targetId ? playerOf(host.state, targetId) : undefined
      if (!owner?.alive || !target?.alive) return
      const excluded = new Set(resolution.data.excluded as CardCategory[])
      const count = resolution.data.count as number
      const optionA = eligibleForA(host.state, targetId!, excluded)
      host.askSkill({
        skillId: JUNXING, ownerId, step: 'choice', data: { targetId, excluded: [...excluded], count },
        build: (requestId): ChooseOptionRequest => ({
          id: requestId, kind: 'choose-option', playerId: targetId!,
          prompt: `${owner.nickname}发动【峻刑】：选择一项`,
          timeoutMs: 25_000, optional: false,
          options: [
            ...(optionA.length > 0 ? [{ id: 'discard', label: '弃置一张类别不同的手牌' }] : []),
            { id: 'flip', label: `翻面，然后摸 ${count} 张牌` },
          ],
        }),
      })
      return
    }

    if (resolution.step === 'choice') {
      const targetId = resolution.data.targetId as PlayerId
      const count = resolution.data.count as number
      const target = playerOf(host.state, targetId)
      if (!target?.alive) return
      const optionId = (response.payload as { optionId?: string }).optionId
      const excluded = new Set(resolution.data.excluded as CardCategory[])
      if (optionId === 'discard' && eligibleForA(host.state, targetId, excluded).length > 0) {
        host.askSkill({
          skillId: JUNXING, ownerId, step: 'discard-pick', data: { targetId, excluded: [...excluded] },
          build: (requestId): ChooseCardsRequest => ({
            id: requestId, kind: 'choose-cards', playerId: targetId,
            prompt: '【峻刑】：弃置一张类别不同的手牌',
            timeoutMs: 20_000, optional: false, purpose: 'skill',
            cardIds: eligibleForA(host.state, targetId, excluded), hiddenCardSlots: [],
            min: 1, max: 1,
          }),
        })
        return
      }
      // 翻面然后摸 X 张
      flipCharacter(host as never, targetId, JUNXING)
      drawCards(host.state, host.rng, targetId, count, (name, payload) => { host.dispatch(name, payload) })
      return
    }

    if (resolution.step === 'discard-pick') {
      const targetId = resolution.data.targetId as PlayerId
      const target = playerOf(host.state, targetId)
      const excluded = new Set(resolution.data.excluded as CardCategory[])
      const [cardId] = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
      if (!target?.alive || !cardId || !eligibleForA(host.state, targetId, excluded).includes(cardId)) return
      moveCard(host.state, cardId, { kind: 'hand', playerId: targetId }, { kind: 'discardPile' })
      host.dispatch('LoseCard', { playerId: targetId, cardIds: [cardId], reason: JUNXING }, { targetId, cardIds: [cardId] })
    }
  },
})

// ─────────────────────────────── 御策 ───────────────────────────────

registerSkillRuntime({
  id: YUCE,
  triggers: [{
    event: 'AfterDamage',
    handle(host, ownerId, context) {
      if (context.event.targetId !== ownerId) return
      const owner = playerOf(host.state, ownerId)
      if (!owner?.alive) return
      host.queueSkill({ skillId: YUCE, ownerId, step: 'show', data: { sourceId: context.event.sourceId ?? null } })
    },
  }],

  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'show') return
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive || owner.zones.hand.length === 0) return
    host.askSkill({
      skillId: YUCE, ownerId, step: 'show', data: prompt.data,
      build: (requestId): ChooseCardsRequest => ({
        id: requestId, kind: 'choose-cards', playerId: ownerId,
        prompt: '【御策】：展示一张手牌？',
        timeoutMs: 20_000, optional: true, purpose: 'skill',
        cardIds: [...owner.zones.hand], hiddenCardSlots: [],
        min: 0, max: 1,
      }),
    })
  },

  resume(host, ownerId, resolution, response) {
    const owner = playerOf(host.state, ownerId)

    if (resolution.step === 'show') {
      const [cardId] = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
      const sourceId = resolution.data.sourceId as PlayerId | null
      if (!cardId || !owner?.alive || !owner.zones.hand.includes(cardId)) return
      const category = categoryOf(host.state, cardId)
      host.dispatch('SkillActivated', {
        skillId: YUCE, skillName: '御策', playerId: ownerId, cardIds: [cardId],
        logText: `${owner.nickname}发动【御策】，展示一张手牌`,
      }, { sourceId: ownerId, cardIds: [cardId] })
      const source = sourceId ? playerOf(host.state, sourceId) : undefined
      if (!source?.alive) {
        recover(host as never, ownerId, 1, YUCE)
        return
      }
      const eligible = source.zones.hand.filter((candidateId) => {
        const candidateCategory = categoryOf(host.state, candidateId)
        return candidateCategory != null && candidateCategory !== category
      })
      if (eligible.length === 0) {
        recover(host as never, ownerId, 1, YUCE)
        return
      }
      host.askSkill({
        skillId: YUCE, ownerId, step: 'source-discard', data: { sourceId, category },
        build: (requestId): ChooseCardsRequest => ({
          id: requestId, kind: 'choose-cards', playerId: sourceId!,
          prompt: `${owner.nickname}发动【御策】：弃置一张与展示牌类别不同的手牌？否则${owner.nickname}回复 1 点体力`,
          timeoutMs: 20_000, optional: true, purpose: 'skill',
          cardIds: eligible, hiddenCardSlots: [],
          min: 0, max: 1,
        }),
      })
      return
    }

    if (resolution.step === 'source-discard') {
      const sourceId = resolution.data.sourceId as PlayerId
      const category = resolution.data.category as CardCategory | null
      const source = playerOf(host.state, sourceId)
      const [cardId] = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
      const valid = cardId && source?.alive && source.zones.hand.includes(cardId) && categoryOf(host.state, cardId) !== category
      if (!valid) {
        if (owner?.alive) recover(host as never, ownerId, 1, YUCE)
        return
      }
      moveCard(host.state, cardId!, { kind: 'hand', playerId: sourceId }, { kind: 'discardPile' })
      host.dispatch('LoseCard', { playerId: sourceId, cardIds: [cardId!], reason: YUCE }, { targetId: sourceId, cardIds: [cardId!] })
    }
  },
})

export const MANCHONG: CharacterDefinition = {
  id: 'manchong',
  name: '满宠',
  kingdom: 'wei',
  gender: 'male',
  maxHp: 3,
  pack: 'yjcm2013',
  skills: [
    {
      id: JUNXING,
      name: '峻刑',
      description: '出牌阶段限一次，你可以弃置至少一张手牌，然后选择一名其他角色，其选择：弃置一张与你此次弃置的所有牌类别均不同的手牌；或者翻面，然后摸 X 张牌（X 为你此次弃置的牌数）。',
    },
    {
      id: YUCE,
      name: '御策',
      description: '你受到一次伤害后，你可以展示一张手牌，然后伤害来源选择是否弃置一张与你展示的牌类别不同的手牌，若其不弃置或无法弃置，你回复 1 点体力。',
    },
  ],
}
