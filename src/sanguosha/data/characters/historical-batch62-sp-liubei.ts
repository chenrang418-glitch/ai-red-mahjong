import type { CardId, PlayerId, SanguoshaState } from '../../engine/types'
import type { ChooseCardsRequest, ChooseOptionRequest, ChooseTargetsRequest } from '../../engine/requests'
import { beginVirtualBasic, wineUseAllowed } from '../../engine/cards/basic'
import { discardCardsByIds } from '../../engine/discard-all'
import { drawCards } from '../../engine/draw'
import { resolveDamage } from '../../engine/damage'
import { finishMultiCardViewAs } from '../../engine/multi-card-viewas'
import { moveCard } from '../../engine/zones'
import { isCardUseLocked } from '../../engine/card-play-lock'
import { isCardProtectedFromDiscard } from '../../engine/skills/runtime'
import {
  characterSkillIdsOf, effectiveCardSuit, grantSkill, isCardUseProhibited,
  registerSkillRuntime, skillsOf, type SkillHost,
} from '../../engine/skills/runtime'
import type { CharacterDefinition } from './types'

const XUDAI = 'xudai-sp-liubei-b62'
const ZHUJIU = 'zhujiu-sp-liubei-b62'
const JINGLEI = 'jinglei-sp-liubei-b62'
const TURN_DISABLED = 'b62-sp-liubei-zhujiu-disabled-turn'

type LiubeiState = SanguoshaState & {
  b62LiubeiPendingJinglei?: Record<PlayerId, PlayerId>
}

function player(state: SanguoshaState, id: PlayerId) {
  return state.players.find((candidate) => candidate.id === id)
}

function hasZhujiu(state: SanguoshaState, id: PlayerId): boolean {
  return skillsOf(state, id, characterSkillIdsOf).some((runtime) => runtime.id === ZHUJIU)
}

function askOption(host: SkillHost, ownerId: PlayerId, skillId: string, step: string, prompt: string, options: Array<{ id: string; label: string }>, data: Record<string, unknown> = {}): void {
  host.askSkill({ skillId, ownerId, step, data, build: (id): ChooseOptionRequest => ({
    id, kind: 'choose-option', playerId: ownerId, prompt, timeoutMs: 25_000, optional: false, options,
  }) })
}

function askTargets(host: SkillHost, ownerId: PlayerId, skillId: string, step: string, prompt: string, candidateIds: PlayerId[], data: Record<string, unknown> = {}): void {
  host.askSkill({ skillId, ownerId, step, data, build: (id): ChooseTargetsRequest => ({
    id, kind: 'choose-targets', playerId: ownerId, prompt, timeoutMs: 25_000,
    optional: false, candidateIds, min: 1, max: 1,
  }) })
}

function zhujiuCards(state: SanguoshaState, ownerId: PlayerId): CardId[] {
  const owner = player(state, ownerId)
  if (!owner) return []
  return [...owner.zones.hand, ...Object.values(owner.zones.equipment).filter((id): id is CardId => Boolean(id))]
}

function zhujiuMin(state: SanguoshaState): number {
  return Math.max(1, state.turnUsage.wineUses + 1)
}

function zhujiuDisabled(state: SanguoshaState, ownerId: PlayerId): boolean {
  return player(state, ownerId)?.marks[TURN_DISABLED] === state.turnNumber
}

function markZhujiuDisabled(state: SanguoshaState, ownerId: PlayerId, cards: readonly CardId[]): void {
  if (cards.some((cardId) => effectiveCardSuit(state, ownerId, cardId) !== 'club')) {
    const owner = player(state, ownerId)
    if (owner) owner.marks[TURN_DISABLED] = state.turnNumber
  }
}

function askZhujiuCards(host: SkillHost, ownerId: PlayerId, source: 'play' | 'multi-viewas', requiredCount: number, maxCount: number): void {
  const cardIds = zhujiuCards(host.state, ownerId)
  host.askSkill({ skillId: ZHUJIU, ownerId, step: source === 'play' ? 'play-cards' : 'response-cards', data: { source }, build: (id): ChooseCardsRequest => ({
    id, kind: 'choose-cards', playerId: ownerId,
    prompt: `【煮酒】：选择至少${requiredCount}张牌当【酒】使用（本次最多${maxCount}张）`,
    timeoutMs: 30_000, optional: false, purpose: 'skill', cardIds, hiddenCardSlots: [],
    min: requiredCount, max: maxCount,
  }) })
}

function scheduleXudai(host: SkillHost, ownerId: PlayerId, timing: string): void {
  const owner = player(host.state, ownerId)
  if (!owner?.alive || owner.usedLimitedSkills.includes(XUDAI)) return
  host.queueSkill({ skillId: XUDAI, ownerId, step: 'offer', data: { timing } })
}

function startJingleiHandAdjustment(host: SkillHost, ownerId: PlayerId, targetId: PlayerId): void {
  const owner = player(host.state, ownerId)
  const target = player(host.state, targetId)
  if (!owner?.alive || !target?.alive || !hasZhujiu(host.state, targetId)) return
  const difference = target.zones.hand.length - target.maxHp
  if (difference < 0) {
    drawCards(host.state, host.rng, targetId, Math.min(-difference, 5), host.dispatch.bind(host))
    return
  }
  if (difference === 0) return
  const discardable = target.zones.hand.filter((cardId) => !isCardProtectedFromDiscard(host.state, targetId, cardId, ownerId))
  if (!discardable.length) return
  const max = Math.min(difference, discardable.length)
  host.askSkill({ skillId: JINGLEI, ownerId, step: 'discard', data: { targetId }, build: (id): ChooseCardsRequest => ({
    id, kind: 'choose-cards', playerId: targetId,
    prompt: `【惊雷】：选择${max}张手牌弃置（将手牌数调整至体力上限${target.maxHp}）`,
    timeoutMs: 25_000, optional: false, purpose: 'skill', cardIds: discardable, hiddenCardSlots: [], min: max, max,
  }) })
}

function resolveJingleiAfterDamage(host: SkillHost, ownerId: PlayerId): void {
  const state = host.state as LiubeiState
  const targetId = state.b62LiubeiPendingJinglei?.[ownerId]
  if (!targetId) return
  delete state.b62LiubeiPendingJinglei![ownerId]
  if (player(host.state, ownerId)?.alive) startJingleiHandAdjustment(host, ownerId, targetId)
}

function giveDiscardedCards(host: SkillHost, fromId: PlayerId, toId: PlayerId, cardIds: readonly CardId[]): void {
  const given = [...new Set(cardIds)].filter((cardId) => host.state.zones.discardPile.includes(cardId))
  for (const cardId of given) moveCard(host.state, cardId, { kind: 'discardPile' }, { kind: 'hand', playerId: toId })
  if (!given.length) return
  host.dispatch('GainCard', { playerId: toId, cardIds: given, reason: JINGLEI }, { targetId: toId, cardIds: given })
  host.dispatch('CardGiven', { fromId, toId, cardIds: given, reason: JINGLEI }, { sourceId: fromId, targetId: toId, cardIds: given })
}

registerSkillRuntime({
  id: XUDAI,
  limited: true,
  triggers: [
    { event: 'CardResponded', handle(host, ownerId, context) {
      if (context.event.sourceId === ownerId) scheduleXudai(host, ownerId, 'respond')
    } },
    { event: 'AfterDamage', handle(host, ownerId, context) {
      if (context.event.targetId === ownerId) scheduleXudai(host, ownerId, 'damage')
    } },
  ],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'offer' || player(host.state, ownerId)?.usedLimitedSkills.includes(XUDAI)) return
    askOption(host, ownerId, XUDAI, 'invoke', '【虚待】：是否令一名其他角色获得【煮酒】？', [
      { id: 'yes', label: '发动【虚待】' }, { id: 'no', label: '不发动' },
    ], prompt.data)
  },
  resume(host, ownerId, resolution, response) {
    const owner = player(host.state, ownerId)
    if (!owner?.alive) return
    if (resolution.step === 'invoke') {
      if ((response.payload as { optionId: string }).optionId !== 'yes' || owner.usedLimitedSkills.includes(XUDAI)) return
      const candidates = host.state.players.filter((candidate) => candidate.alive && candidate.id !== ownerId)
      if (!candidates.length) return
      askTargets(host, ownerId, XUDAI, 'target', '【虚待】：选择一名其他角色获得【煮酒】', candidates.map(({ id }) => id), resolution.data)
      return
    }
    if (resolution.step !== 'target') return
    const targetId = (response.payload as { targetIds: PlayerId[] }).targetIds[0]
    const target = targetId ? player(host.state, targetId) : undefined
    if (!target?.alive || target.id === ownerId || owner.usedLimitedSkills.includes(XUDAI)) return
    owner.usedLimitedSkills.push(XUDAI)
    grantSkill(host.state, targetId, ZHUJIU)
    host.dispatch('SkillActivated', { skillId: XUDAI, skillName: '虚待', grantedSkillId: ZHUJIU }, { sourceId: ownerId, targetId })
  },
})

registerSkillRuntime({
  id: ZHUJIU,
  multiCardViewAs(state, ownerId) {
    const cards = zhujiuCards(state, ownerId)
    const requiredCount = zhujiuMin(state)
    if (!player(state, ownerId)?.alive || zhujiuDisabled(state, ownerId) || cards.length < requiredCount) return null
    return {
      skillId: ZHUJIU, skillName: '煮酒', requiredCount, maxCount: cards.length,
      sameSuit: false, anySuitCardNames: ['酒'], suitToCardName: {},
      onConvert(currentState, id, _carrierId, selected) { markZhujiuDisabled(currentState, id, selected) },
    }
  },
  activeActions(state, ownerId) {
    const owner = player(state, ownerId)
    const cards = zhujiuCards(state, ownerId)
    return owner?.alive && state.currentPlayerId === ownerId && state.phase === 'play'
      && !zhujiuDisabled(state, ownerId) && cards.length >= zhujiuMin(state)
      && wineUseAllowed(state, ownerId)
      ? [{ id: ZHUJIU, label: `煮酒：将至少${zhujiuMin(state)}张牌当【酒】使用` }] : []
  },
  invokeActive(host, ownerId, actionId) {
    if (actionId !== ZHUJIU || host.state.phase !== 'play' || host.state.currentPlayerId !== ownerId
      || zhujiuDisabled(host.state, ownerId) || !wineUseAllowed(host.state, ownerId)
      || isCardUseProhibited(host.state, ownerId, '酒', { dyingPlayerId: null })) return
    const cards = zhujiuCards(host.state, ownerId)
    const min = zhujiuMin(host.state)
    if (cards.length < min) return
    askZhujiuCards(host, ownerId, 'play', min, cards.length)
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'multi-viewas') {
      finishMultiCardViewAs(host, (response.payload as { cardIds?: CardId[] }).cardIds ?? [])
      return
    }
    if (resolution.step !== 'play-cards') return
    const owner = player(host.state, ownerId)
    const selected = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
    const current = zhujiuCards(host.state, ownerId)
    const unique = [...new Set(selected)]
    const min = zhujiuMin(host.state)
    if (!owner?.alive || host.state.currentPlayerId !== ownerId || host.state.phase !== 'play'
      || zhujiuDisabled(host.state, ownerId) || !wineUseAllowed(host.state, ownerId)
      || isCardUseProhibited(host.state, ownerId, '酒', { dyingPlayerId: null, cardIds: unique })
      || unique.length < min || unique.length > current.length || unique.some((id) => !current.includes(id) || isCardUseLocked(host.state, ownerId, id))) return
    const nonClub = unique.some((id) => effectiveCardSuit(host.state, ownerId, id) !== 'club')
    if (nonClub) owner.marks[TURN_DISABLED] = host.state.turnNumber
    const actuallyDiscarded = discardCardsByIds(host as never, ownerId, unique, ZHUJIU)
    if (actuallyDiscarded.length !== unique.length) {
      if (nonClub) delete owner.marks[TURN_DISABLED]
      return
    }
    const used = beginVirtualBasic(host, { sourceId: ownerId, targetIds: [ownerId], cardName: '酒', sourceSkillId: ZHUJIU })
    if (!used && nonClub) delete owner.marks[TURN_DISABLED]
  },
})

registerSkillRuntime({
  id: JINGLEI,
  triggers: [
    { event: 'AfterCardUse', handle(host, ownerId, context) {
      const payload = context.event.payload as { cardName?: string }
      if (payload.cardName === '酒' && !host.state.dying) scheduleJinglei(host, ownerId, 'use')
    } },
    { event: 'CardResponded', handle(host, ownerId, context) {
      const payload = context.event.payload as { cardName?: string }
      if (payload.cardName === '酒') scheduleJinglei(host, ownerId, 'response')
    } },
    { event: 'QuitDying', handle(host, ownerId, context) {
      if (context.event.targetId === ownerId && (host.state as LiubeiState).b62LiubeiPendingJinglei?.[ownerId]) {
        host.queueSkill({ skillId: JINGLEI, ownerId, step: 'adjust-after-dying', data: {} })
      }
    } },
    { event: 'DamageSettled', handle(host, ownerId, context) {
      const payload = context.event.payload as { reason?: string; finalAmount?: number }
      if (payload.reason !== JINGLEI || context.event.targetId !== ownerId) return
      if ((payload.finalAmount ?? 0) <= 0) {
        delete (host.state as LiubeiState).b62LiubeiPendingJinglei?.[ownerId]
        return
      }
      if (!host.state.dying) resolveJingleiAfterDamage(host, ownerId)
    } },
    { event: 'Death', handle(host, ownerId, context) {
      if (context.event.targetId === ownerId) delete (host.state as LiubeiState).b62LiubeiPendingJinglei?.[ownerId]
    } },
  ],
  startQueued(host, ownerId, prompt) {
    const owner = player(host.state, ownerId)
    if (prompt.step === 'adjust-after-dying') {
      if (!host.state.dying) resolveJingleiAfterDamage(host, ownerId)
      return
    }
    if (prompt.step !== 'offer' || !owner?.alive || host.state.dying || owner.turnUsedSkills.includes(JINGLEI)) return
    const candidates = host.state.players.filter((candidate) => candidate.alive && hasZhujiu(host.state, candidate.id))
    if (!candidates.length) return
    askOption(host, ownerId, JINGLEI, 'invoke', '【惊雷】：是否受到1点无来源雷电伤害，令一名拥有【煮酒】的角色调整手牌？', [
      { id: 'yes', label: '受到伤害并调整手牌' }, { id: 'no', label: '不发动' },
    ], { candidateIds: candidates.map(({ id }) => id) })
  },
  resume(host, ownerId, resolution, response) {
    const owner = player(host.state, ownerId)
    if (!owner?.alive) return
    if (resolution.step === 'invoke') {
      if ((response.payload as { optionId: string }).optionId !== 'yes' || owner.turnUsedSkills.includes(JINGLEI) || host.state.dying) return
      const candidates = (resolution.data.candidateIds as PlayerId[]).filter((id) => player(host.state, id)?.alive && hasZhujiu(host.state, id))
      if (!candidates.length) return
      owner.turnUsedSkills.push(JINGLEI)
      askTargets(host, ownerId, JINGLEI, 'target', '【惊雷】：选择一名拥有【煮酒】的角色调整手牌', candidates)
      return
    }
    if (resolution.step === 'target') {
      const targetId = (response.payload as { targetIds: PlayerId[] }).targetIds[0]
      if (!targetId || !hasZhujiu(host.state, targetId) || !player(host.state, targetId)?.alive || host.state.dying) return
      const state = host.state as LiubeiState
      state.b62LiubeiPendingJinglei ??= {}
      state.b62LiubeiPendingJinglei[ownerId] = targetId
      resolveDamage(host as never, { sourceId: null, targetId: ownerId, amount: 1, nature: 'thunder', reason: JINGLEI })
      return
    }
    if (resolution.step === 'discard') {
      const targetId = (resolution.data as { targetId: PlayerId }).targetId
      const target = player(host.state, targetId)
      if (!owner.alive || !target?.alive || !hasZhujiu(host.state, targetId)) return
      const required = Math.max(0, target.zones.hand.length - target.maxHp)
      const selected = [...new Set((response.payload as { cardIds?: CardId[] }).cardIds ?? [])]
      const valid = selected.length === required && selected.every((id) => target.zones.hand.includes(id)
        && !isCardProtectedFromDiscard(host.state, targetId, id, ownerId))
      if (!valid) return
      const discarded = discardCardsByIds(host as never, targetId, selected, JINGLEI)
      if (targetId !== ownerId && discarded.length) giveDiscardedCards(host, targetId, ownerId, discarded)
    }
  },
})

function scheduleJinglei(host: SkillHost, ownerId: PlayerId, timing: string): void {
  const owner = player(host.state, ownerId)
  if (!owner?.alive || owner.turnUsedSkills.includes(JINGLEI)) return
  host.queueSkill({ skillId: JINGLEI, ownerId, step: 'offer', data: { timing } })
}

export const SP_LIU_BEI_B62: CharacterDefinition = {
  id: 'sp-liu-bei-b62', name: 'SP·刘备', kingdom: 'qun', gender: 'male', maxHp: 4, pack: 'sp',
  skills: [
    { id: XUDAI, name: '虚待', description: '限定技，当你响应牌后或受到伤害后，你可以令一名其他角色获得“煮酒”。' },
    { id: ZHUJIU, name: '煮酒', description: '你可以将至少X+1张牌当【酒】使用（X为你本回合已使用过【酒】的次数），然后若这些牌不为梅花，此技能本回合失效。' },
    { id: JINGLEI, name: '惊雷', description: '每回合限一次，一名角色使用【酒】结算结束后，若没有处于濒死的角色，你可以受到1点无来源的雷电伤害，令一名拥有“煮酒”角色将手牌调整至体力上限（至多摸至5），然后若该角色不为你，其须将以此法弃置的牌交给你。' },
  ],
}
