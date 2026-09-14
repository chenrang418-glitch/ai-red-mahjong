import { moveCard } from '../../engine/zones'
import { drawCards } from '../../engine/draw'
import { executeUseCardAction } from '../../engine/cards/basic'
import { registerSkillRuntime, type SkillHost } from '../../engine/skills/runtime'
import type { ChooseCardsRequest, ChooseTargetsRequest } from '../../engine/requests'
import type { CardId, PlayerId, SanguoshaState } from '../../engine/types'
import type { CharacterDefinition } from './types'

/**
 * 傅肜（三国杀 OL 经典身份 SP）。
 *
 * 【效死】：出牌阶段限一次，选择一名有手牌的其他角色A，你弃置1张基本牌，
 *          A弃置1张基本牌（若A无基本牌可弃，你摸1张牌）；然后你可以使用
 *          其中任意张牌（无距离和次数限制）。
 */

const XIAOSI = 'xiaosi'
const PILE = 'xiaosi'

function playerOf(state: SanguoshaState, playerId: PlayerId) {
  return state.players.find((candidate) => candidate.id === playerId)
}

function basicsOf(state: SanguoshaState, playerId: PlayerId): CardId[] {
  return playerOf(state, playerId)?.zones.hand.filter((id) => state.cards[id]?.category === 'basic' && state.cards[id]?.name !== '闪') ?? []
}

registerSkillRuntime({
  id: XIAOSI,
  activeActions(state, ownerId) {
    if (state.phase !== 'play' || state.currentPlayerId !== ownerId) return []
    const owner = playerOf(state, ownerId)
    if (!owner?.alive || owner.turnUsedSkills.includes(XIAOSI) || basicsOf(state, ownerId).length === 0) return []
    if (!state.players.some((candidate) => candidate.alive && candidate.id !== ownerId && candidate.zones.hand.length > 0)) return []
    return [{ id: XIAOSI, label: '效死：选择一名有手牌的其他角色' }]
  },
  invokeActive(host, ownerId, actionId) {
    if (actionId !== XIAOSI) return
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive || owner.turnUsedSkills.includes(XIAOSI) || basicsOf(host.state, ownerId).length === 0) return
    const candidateIds = host.state.players.filter((candidate) => candidate.alive && candidate.id !== ownerId && candidate.zones.hand.length > 0).map((candidate) => candidate.id)
    if (candidateIds.length === 0) return
    owner.turnUsedSkills.push(XIAOSI)
    host.askSkill({
      skillId: XIAOSI, ownerId, step: 'pick-target', data: {},
      build: (requestId): ChooseTargetsRequest => ({
        id: requestId, kind: 'choose-targets', playerId: ownerId,
        prompt: '【效死】：选择一名有手牌的其他角色', timeoutMs: 20_000, optional: false,
        candidateIds, min: 1, max: 1,
      }),
    })
  },
  resume(host, ownerId, resolution, response) {
    const owner = playerOf(host.state, ownerId)
    if (resolution.step === 'pick-target') {
      const [targetId] = (response.payload as { targetIds?: PlayerId[] }).targetIds ?? []
      const target = targetId ? playerOf(host.state, targetId) : undefined
      const basics = basicsOf(host.state, ownerId)
      if (!owner?.alive || !target?.alive || basics.length === 0) return
      host.dispatch('SkillActivated', { skillId: XIAOSI, skillName: '效死', playerId: ownerId, targetId, logText: `${owner.nickname}发动【效死】` }, { sourceId: ownerId, targetId })
      host.askSkill({
        skillId: XIAOSI, ownerId, step: 'self-discard', data: { targetId },
        build: (requestId): ChooseCardsRequest => ({
          id: requestId, kind: 'choose-cards', playerId: ownerId,
          prompt: '【效死】：弃置1张基本牌', timeoutMs: 20_000, optional: false,
          purpose: 'skill', cardIds: basics, hiddenCardSlots: [], min: 1, max: 1,
        }),
      })
      return
    }
    if (resolution.step === 'self-discard') {
      const { targetId } = resolution.data as { targetId: PlayerId }
      const [cardId] = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
      if (!owner?.alive || !cardId || !owner.zones.hand.includes(cardId) || host.state.cards[cardId]?.category !== 'basic') return
      moveCard(host.state, cardId, { kind: 'hand', playerId: ownerId }, { kind: 'discardPile' })
      host.dispatch('LoseCard', { playerId: ownerId, cardIds: [cardId], reason: XIAOSI }, { sourceId: ownerId, cardIds: [cardId] })
      const collected: CardId[] = [cardId]
      const target = playerOf(host.state, targetId)
      const targetBasics = target?.alive ? basicsOf(host.state, targetId) : []
      if (targetBasics.length === 0) {
        drawCards(host.state, host.rng, ownerId, 1, (name, payload) => { host.dispatch(name, payload) })
        startUsePick(host, ownerId, collected)
        return
      }
      host.askSkill({
        skillId: XIAOSI, ownerId, step: 'target-discard', data: { targetId, collected },
        build: (requestId): ChooseCardsRequest => ({
          id: requestId, kind: 'choose-cards', playerId: targetId,
          prompt: '【效死】：弃置1张基本牌', timeoutMs: 20_000, optional: false,
          purpose: 'skill', cardIds: targetBasics, hiddenCardSlots: [], min: 1, max: 1,
        }),
      })
      return
    }
    if (resolution.step === 'target-discard') {
      const { targetId, collected } = resolution.data as { targetId: PlayerId; collected: CardId[] }
      const target = playerOf(host.state, targetId)
      const [cardId] = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
      if (target?.alive && cardId && target.zones.hand.includes(cardId) && host.state.cards[cardId]?.category === 'basic') {
        moveCard(host.state, cardId, { kind: 'hand', playerId: targetId }, { kind: 'discardPile' })
        host.dispatch('LoseCard', { playerId: targetId, cardIds: [cardId], reason: XIAOSI }, { sourceId: ownerId, targetId, cardIds: [cardId] })
        collected.push(cardId)
      }
      startUsePick(host, ownerId, collected)
      return
    }
    if (resolution.step === 'ask-use') {
      const { remaining } = resolution.data as { remaining: CardId[] }
      const [cardId] = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
      // 不选牌 = 主动放弃剩余的使用机会，不能拿同一份 remaining 再问一遍
      if (!cardId) return
      const next = remaining.filter((id) => id !== cardId)
      if (!owner?.alive || !host.state.zones.discardPile.includes(cardId)) return
      const card = host.state.cards[cardId]
      moveCard(host.state, cardId, { kind: 'discardPile' }, { kind: 'characterPile', playerId: ownerId, pile: PILE })
      if (card?.name === '杀') {
        const candidateIds = host.state.players.filter((candidate) => candidate.alive && candidate.id !== ownerId).map((candidate) => candidate.id)
        if (candidateIds.length === 0) { moveCard(host.state, cardId, { kind: 'characterPile', playerId: ownerId, pile: PILE }, { kind: 'discardPile' }); startUsePick(host, ownerId, next); return }
        host.askSkill({
          skillId: XIAOSI, ownerId, step: 'pick-slash-target', data: { cardId, remaining: next },
          build: (requestId): ChooseTargetsRequest => ({
            id: requestId, kind: 'choose-targets', playerId: ownerId,
            prompt: '【效死】：使用【杀】，选择目标', timeoutMs: 20_000, optional: false,
            candidateIds, min: 1, max: 1,
          }),
        })
        return
      }
      executeUseCardAction(host as never, ownerId, {
        kind: 'use-card', id: `xiaosi-use:${cardId}`, playerId: ownerId, label: '',
        cardIds: [cardId], targetIds: [ownerId], targetMin: 1, targetMax: 1, asCardName: card?.name ?? '',
      })
      startUsePick(host, ownerId, next)
      return
    }
    if (resolution.step === 'pick-slash-target') {
      const { cardId, remaining } = resolution.data as { cardId: CardId; remaining: CardId[] }
      const [victimId] = (response.payload as { targetIds?: PlayerId[] }).targetIds ?? []
      if (!owner?.alive || !victimId) { startUsePick(host, ownerId, remaining); return }
      // 出杀本身会挂起求闪，不能在同一步里紧接着再问"是否使用下一张"，
      // 推迟到 AfterCardUse（这张杀完全结算完毕）之后再继续。
      host.state.xiaosiPendingNext = { ownerId, remaining }
      executeUseCardAction(host as never, ownerId, {
        kind: 'use-card', id: `xiaosi-slash:${cardId}`, playerId: ownerId, label: '',
        cardIds: [cardId], targetIds: [victimId], targetMin: 1, targetMax: 1, asCardName: '杀',
      })
    }
  },
  triggers: [{
    event: 'AfterCardUse',
    handle(host, ownerId, context) {
      const pending = host.state.xiaosiPendingNext
      if (!pending || pending.ownerId !== ownerId || context.event.sourceId !== ownerId) return
      host.state.xiaosiPendingNext = undefined
      host.queueSkill({ skillId: XIAOSI, ownerId, step: 'continue', data: { remaining: pending.remaining } })
    },
  }],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'continue') return
    startUsePick(host, ownerId, (prompt.data as { remaining: CardId[] }).remaining)
  },
})

function startUsePick(host: SkillHost, ownerId: PlayerId, remaining: CardId[]): void {
  const owner = playerOf(host.state, ownerId)
  const available = remaining.filter((id) => host.state.zones.discardPile.includes(id))
  if (!owner?.alive || available.length === 0) return
  host.askSkill({
    skillId: XIAOSI, ownerId, step: 'ask-use', data: { remaining: available },
    build: (requestId): ChooseCardsRequest => ({
      id: requestId, kind: 'choose-cards', playerId: ownerId,
      prompt: '【效死】：可以使用其中一张牌（无距离和次数限制）', timeoutMs: 20_000, optional: true,
      purpose: 'skill', cardIds: available, hiddenCardSlots: [], min: 0, max: 1,
    }),
  })
}

export const FURONG: CharacterDefinition = {
  id: 'furong',
  name: '傅肜',
  kingdom: 'shu',
  gender: 'male',
  maxHp: 4,
  pack: 'sp',
  skills: [
    { id: XIAOSI, name: '效死', description: '出牌阶段限一次，选择一名有手牌的其他角色，你弃置1张基本牌，其弃置1张基本牌（若其无基本牌可弃，你摸1张牌）；然后你可以使用其中任意张牌，无距离和次数限制。' },
  ],
}
