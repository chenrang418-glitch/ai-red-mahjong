import { drawCards } from '../../engine/draw'
import { loseHp } from '../../engine/hp'
import { moveCard } from '../../engine/zones'
import { registerSkillRuntime, type SkillHost } from '../../engine/skills/runtime'
import type { ChooseCardsRequest, ChooseOptionRequest, ChooseTargetsRequest } from '../../engine/requests'
import type { CardCategory, CardId, PlayerId, SanguoshaState } from '../../engine/types'
import type { CharacterDefinition } from './types'

/**
 * 陈琳（三国杀 OL 经典身份 SP）。
 *
 * 【笔伐】：结束阶段，陈琳可以将一张手牌暗置于一名其他角色的武将牌上（笔伐
 *          牌）。该角色下一次回合开始时看这张牌，然后选择：交给陈琳一张
 *          同类别的手牌并获得笔伐牌；或移去笔伐牌并失去 1 点体力。
 * 【颂词】：出牌阶段，陈琳可以选择一名角色（每名角色整局限一次）：若其
 *          手牌数 < 体力值，可令其摸 2 张；若手牌数 > 体力值，可令其弃置
 *          2 张；相等则不能发动。
 *
 * 两处最容易做错的：
 *
 * 1. **笔伐牌是真实 CardId 暗置进目标的专属牌堆**（`characterPiles.bifa` +
 *    `hiddenCharacterPiles`），不是复制一份牌面；待结算信息（谁放的、
 *    类别）存进 `state.pendingBifa`，可序列化、重连接得上。
 * 2. **颂词的「每名角色限一次」是跨回合的持久记录**（`owner.marks` 按
 *    `songci-used:<targetId>` 记），不是按回合/按阶段清空的临时标记。
 */

const BIFA = 'bifa'
const SONGCI = 'songci'

function playerOf(state: SanguoshaState, playerId: PlayerId) {
  return state.players.find((candidate) => candidate.id === playerId)
}

function categoryLabel(category: CardCategory): string {
  return category === 'basic' ? '基本牌' : category === 'trick' ? '锦囊牌' : '装备牌'
}

registerSkillRuntime({
  id: BIFA,
  triggers: [{
    event: 'PhaseStart',
    handle(host, ownerId, context) {
      const payload = context.event.payload as { playerId?: PlayerId; phase?: string }
      if (payload.phase !== 'finish' || payload.playerId !== ownerId) return
      const owner = playerOf(host.state, ownerId)
      if (!owner?.alive || owner.zones.hand.length === 0) return
      const candidateIds = host.state.players.filter((candidate) => candidate.alive && candidate.id !== ownerId).map((candidate) => candidate.id)
      if (candidateIds.length === 0) return
      host.queueSkill({ skillId: BIFA, ownerId, step: 'ask', data: { candidateIds } })
    },
  }],

  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'ask') return
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive || owner.zones.hand.length === 0) return
    host.askSkill({
      skillId: BIFA, ownerId, step: 'ask',
      build: (requestId): ChooseOptionRequest => ({
        id: requestId, kind: 'choose-option', playerId: ownerId,
        prompt: '【笔伐】：将一张手牌暗置于一名其他角色的武将牌上？',
        timeoutMs: 20_000, optional: true,
        options: [{ id: 'yes', label: '发动【笔伐】' }, { id: 'no', label: '不发动' }],
      }),
    })
  },

  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'ask') {
      if ((response.payload as { optionId?: string }).optionId !== 'yes') return
      const owner = playerOf(host.state, ownerId)
      if (!owner?.alive || owner.zones.hand.length === 0) return
      host.askSkill({
        skillId: BIFA, ownerId, step: 'pick-card',
        build: (requestId): ChooseCardsRequest => ({
          id: requestId, kind: 'choose-cards', playerId: ownerId,
          prompt: '【笔伐】：选择一张手牌暗置',
          timeoutMs: 20_000, optional: false, purpose: 'skill',
          cardIds: [...owner.zones.hand], hiddenCardSlots: [], min: 1, max: 1,
        }),
      })
      return
    }

    if (resolution.step === 'pick-card') {
      const owner = playerOf(host.state, ownerId)
      const [cardId] = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
      if (!owner?.alive || !cardId || !owner.zones.hand.includes(cardId)) return
      const candidateIds = host.state.players.filter((candidate) => candidate.alive && candidate.id !== ownerId).map((candidate) => candidate.id)
      if (candidateIds.length === 0) return
      host.askSkill({
        skillId: BIFA, ownerId, step: 'pick-target', data: { cardId },
        build: (requestId): ChooseTargetsRequest => ({
          id: requestId, kind: 'choose-targets', playerId: ownerId,
          prompt: '【笔伐】：选择一名其他角色',
          timeoutMs: 20_000, optional: false, candidateIds, min: 1, max: 1,
        }),
      })
      return
    }

    if (resolution.step === 'pick-target') {
      const cardId = resolution.data.cardId as CardId
      const owner = playerOf(host.state, ownerId)
      const [targetId] = (response.payload as { targetIds?: PlayerId[] }).targetIds ?? []
      const target = targetId ? playerOf(host.state, targetId) : undefined
      if (!owner?.alive || !target?.alive || !owner.zones.hand.includes(cardId)) return
      const category = host.state.cards[cardId]?.category ?? 'basic'
      moveCard(host.state, cardId, { kind: 'hand', playerId: ownerId }, { kind: 'characterPile', playerId: targetId, pile: BIFA })
      target.hiddenCharacterPiles ??= []
      if (!target.hiddenCharacterPiles.includes(BIFA)) target.hiddenCharacterPiles.push(BIFA)
      host.state.pendingBifa ??= {}
      host.state.pendingBifa[targetId] = { cardId, ownerId, category }
      host.dispatch('SkillActivated', {
        skillId: BIFA, skillName: '笔伐', playerId: ownerId, targetId,
        logText: `${owner.nickname}发动【笔伐】，将一张手牌暗置于${target.nickname}的武将牌上`,
      }, { sourceId: ownerId, targetId })
    }
  },
})

registerSkillRuntime({
  id: `${BIFA}-resolve`,
  triggers: [{
    event: 'TurnStart',
    handle(host, ownerId, context) {
      const payload = context.event.payload as { playerId?: PlayerId }
      if (payload.playerId !== ownerId) return
      const pending = host.state.pendingBifa?.[ownerId]
      if (!pending) return
      host.queueSkill({ skillId: `${BIFA}-resolve`, ownerId, step: 'choice', data: {} })
    },
  }],

  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'choice') return
    const pending = host.state.pendingBifa?.[ownerId]
    const owner = playerOf(host.state, ownerId)
    if (!pending || !owner?.alive) return
    const hasSameCategory = owner.zones.hand.some((cardId) => host.state.cards[cardId]?.category === pending.category)
    host.askSkill({
      skillId: `${BIFA}-resolve`, ownerId, step: 'choice',
      build: (requestId): ChooseOptionRequest => ({
        id: requestId, kind: 'choose-option', playerId: ownerId,
        prompt: `你看到了一张【笔伐】牌（${categoryLabel(pending.category)}类）：选择一项`,
        timeoutMs: 20_000, optional: false,
        options: [
          ...(hasSameCategory ? [{ id: 'give', label: `交给对方一张${categoryLabel(pending.category)}，获得这张笔伐牌` }] : []),
          { id: 'remove', label: '移去笔伐牌，失去 1 点体力' },
        ],
      }),
    })
  },

  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'choice') return
    const pending = host.state.pendingBifa?.[ownerId]
    const owner = playerOf(host.state, ownerId)
    if (!pending || !owner?.alive) return
    const optionId = (response.payload as { optionId?: string }).optionId
    if (optionId === 'give') {
      const sameCategoryCards = owner.zones.hand.filter((cardId) => host.state.cards[cardId]?.category === pending.category)
      if (sameCategoryCards.length === 0) { resolveBifaRemove(host, ownerId, pending); return }
      host.askSkill({
        skillId: `${BIFA}-give`, ownerId, step: 'give-pick',
        build: (requestId): ChooseCardsRequest => ({
          id: requestId, kind: 'choose-cards', playerId: ownerId,
          prompt: `交给${playerOf(host.state, pending.ownerId)?.nickname ?? ''}一张${categoryLabel(pending.category)}`,
          timeoutMs: 20_000, optional: false, purpose: 'skill',
          cardIds: sameCategoryCards, hiddenCardSlots: [], min: 1, max: 1,
        }),
      })
      return
    }
    resolveBifaRemove(host, ownerId, pending)
  },
})

function resolveBifaRemove(
  host: SkillHost,
  ownerId: PlayerId,
  pending: { cardId: CardId; ownerId: PlayerId; category: CardCategory },
): void {
  const target = playerOf(host.state, ownerId)
  if (!target?.alive) return
  if (host.state.cards[pending.cardId] && target.characterPiles[BIFA]?.includes(pending.cardId)) {
    moveCard(host.state, pending.cardId, { kind: 'characterPile', playerId: ownerId, pile: BIFA }, { kind: 'discardPile' })
  }
  delete host.state.pendingBifa?.[ownerId]
  host.dispatch('SkillActivated', {
    skillId: BIFA, skillName: '笔伐', playerId: ownerId,
    logText: `${target.nickname}移去笔伐牌，失去 1 点体力`,
  }, { targetId: ownerId })
  loseHp(host as never, ownerId, 1, BIFA)
}

registerSkillRuntime({
  id: `${BIFA}-give`,
  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'give-pick') return
    const pending = host.state.pendingBifa?.[ownerId]
    const target = playerOf(host.state, ownerId)
    const [cardId] = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
    if (!pending || !target?.alive || !cardId || !target.zones.hand.includes(cardId)) return
    const bifaOwner = playerOf(host.state, pending.ownerId)
    if (!bifaOwner?.alive) { resolveBifaRemove(host, ownerId, pending); return }
    moveCard(host.state, cardId, { kind: 'hand', playerId: ownerId }, { kind: 'hand', playerId: pending.ownerId })
    host.dispatch('GainCard', { playerId: pending.ownerId, cardIds: [cardId], reason: BIFA }, { sourceId: ownerId, targetId: pending.ownerId, cardIds: [cardId] })
    if (host.state.cards[pending.cardId] && target.characterPiles[BIFA]?.includes(pending.cardId)) {
      moveCard(host.state, pending.cardId, { kind: 'characterPile', playerId: ownerId, pile: BIFA }, { kind: 'hand', playerId: ownerId })
      host.dispatch('GainCard', { playerId: ownerId, cardIds: [pending.cardId], reason: BIFA }, { sourceId: pending.ownerId, targetId: ownerId, cardIds: [pending.cardId] })
    }
    delete host.state.pendingBifa?.[ownerId]
    host.dispatch('SkillActivated', {
      skillId: BIFA, skillName: '笔伐', playerId: ownerId,
      logText: `${target.nickname}交给${bifaOwner.nickname}一张牌，获得笔伐牌`,
    }, { targetId: ownerId })
  },
})

function songciUsedKey(targetId: PlayerId): string {
  return `songci-used:${targetId}`
}

function songciTargets(state: SanguoshaState, ownerId: PlayerId): PlayerId[] {
  const owner = playerOf(state, ownerId)
  if (!owner?.alive) return []
  return state.players
    .filter((candidate) => candidate.alive && candidate.id !== ownerId)
    .filter((candidate) => !owner.marks[songciUsedKey(candidate.id)])
    .filter((candidate) => candidate.zones.hand.length !== candidate.hp)
    .map((candidate) => candidate.id)
}

registerSkillRuntime({
  id: SONGCI,
  announcesSelf: true,

  activeActions(state, ownerId) {
    if (state.phase !== 'play' || state.currentPlayerId !== ownerId) return []
    if (songciTargets(state, ownerId).length === 0) return []
    return [{ id: SONGCI, label: '颂词：选择一名角色（每名角色整局限一次）' }]
  },

  invokeActive(host, ownerId, actionId) {
    if (actionId !== SONGCI) return
    const candidateIds = songciTargets(host.state, ownerId)
    if (candidateIds.length === 0) return
    host.askSkill({
      skillId: SONGCI, ownerId, step: 'target',
      build: (requestId): ChooseTargetsRequest => ({
        id: requestId, kind: 'choose-targets', playerId: ownerId,
        prompt: '【颂词】：选择一名角色', timeoutMs: 20_000, optional: false,
        candidateIds, min: 1, max: 1,
      }),
    })
  },

  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'target') return
    const [targetId] = (response.payload as { targetIds?: PlayerId[] }).targetIds ?? []
    const owner = playerOf(host.state, ownerId)
    const target = targetId ? playerOf(host.state, targetId) : undefined
    if (!owner?.alive || !target?.alive) return
    owner.marks[songciUsedKey(targetId!)] = 1
    if (target.zones.hand.length === target.hp) return
    const draw = target.zones.hand.length < target.hp
    host.dispatch('SkillActivated', {
      skillId: SONGCI, skillName: '颂词', playerId: ownerId, targetId,
      logText: draw ? `${owner.nickname}发动【颂词】，${target.nickname}摸 2 张牌` : `${owner.nickname}发动【颂词】，${target.nickname}弃置 2 张牌`,
    }, { sourceId: ownerId, targetId })
    if (draw) {
      drawCards(host.state, host.rng, targetId!, 2, (name, payload) => { host.dispatch(name, payload) })
      return
    }
    host.askSkill({
      skillId: SONGCI, ownerId, step: 'discard', data: { targetId },
      build: (requestId): ChooseCardsRequest => ({
        id: requestId, kind: 'choose-cards', playerId: targetId!,
        prompt: '【颂词】：弃置 2 张手牌', timeoutMs: 20_000, optional: false, purpose: 'skill',
        cardIds: [...target.zones.hand], hiddenCardSlots: [],
        min: Math.min(2, target.zones.hand.length), max: Math.min(2, target.zones.hand.length),
      }),
    })
  },
})

registerSkillRuntime({
  id: `${SONGCI}-discard`,
  resume(host, _ownerId, resolution, response) {
    if (resolution.step !== 'discard') return
    const targetId = resolution.data.targetId as PlayerId
    const target = playerOf(host.state, targetId)
    const cardIds = [...new Set((response.payload as { cardIds?: CardId[] }).cardIds ?? [])]
      .filter((cardId) => target?.zones.hand.includes(cardId))
    if (!target?.alive || cardIds.length === 0) return
    for (const cardId of cardIds) moveCard(host.state, cardId, { kind: 'hand', playerId: targetId }, { kind: 'discardPile' })
    host.dispatch('LoseCard', { playerId: targetId, cardIds, reason: SONGCI }, { targetId, cardIds })
  },
})

export const CHENLIN: CharacterDefinition = {
  id: 'chenlin',
  name: '陈琳',
  kingdom: 'qun',
  gender: 'male',
  maxHp: 3,
  pack: 'sp',
  skills: [
    {
      id: BIFA,
      name: '笔伐',
      description: '结束阶段，陈琳可以将一张手牌暗置于一名其他角色的武将牌上。该角色下一次回合开始时看这张牌，然后选择：交给陈琳一张同类别的手牌并获得这张牌；或移去这张牌并失去 1 点体力。',
    },
    {
      id: SONGCI,
      name: '颂词',
      description: '出牌阶段，陈琳可以选择一名角色（每名角色整局限一次）：若其手牌数小于体力值，可令其摸 2 张牌；若手牌数大于体力值，可令其弃置 2 张牌。',
    },
  ],
}
