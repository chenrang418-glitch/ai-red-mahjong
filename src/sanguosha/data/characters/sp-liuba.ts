import { moveCard } from '../../engine/zones'
import { drawCards } from '../../engine/draw'
import { registerSkillRuntime } from '../../engine/skills/runtime'
import type { ChooseCardsRequest, ChooseTargetsRequest } from '../../engine/requests'
import type { CardId, PlayerId, SanguoshaState } from '../../engine/types'
import type { CharacterDefinition } from './types'

/**
 * 刘巴（三国杀 OL 经典身份 SP）。
 *
 * 【统度】：准备阶段，选择一名角色，令其交给你1张手牌；你的出牌阶段结束时，
 *          若这张具体的牌仍在你处，将其置于牌堆顶。
 * 【铸币】：出牌阶段限X次（X=你的体力上限），选择一名角色重铸1张牌，因此
 *          摸到的具体牌标记为"币"；持有至少1张"币"的角色结束阶段可以看牌堆
 *          底5张，并将手中任意数量的"币"与等量的牌堆底牌交换。
 */

const TONGDU = 'tongdu'
const ZHUBI = 'zhubi'

function playerOf(state: SanguoshaState, playerId: PlayerId) {
  return state.players.find((candidate) => candidate.id === playerId)
}

registerSkillRuntime({
  id: TONGDU,
  triggers: [
    {
      event: 'PhaseStart',
      handle(host, ownerId, context) {
        const payload = context.event.payload as { phase?: string; playerId?: PlayerId }
        if (payload.phase !== 'prepare' || payload.playerId !== ownerId) return
        const owner = playerOf(host.state, ownerId)
        if (!owner?.alive) return
        const candidateIds = host.state.players.filter((candidate) => candidate.alive && candidate.id !== ownerId && candidate.zones.hand.length > 0).map((candidate) => candidate.id)
        if (candidateIds.length === 0) return
        host.queueSkill({ skillId: TONGDU, ownerId, step: 'pick-target', data: {} })
      },
    },
    {
      event: 'PhaseEnd',
      handle(host, ownerId, context) {
        const payload = context.event.payload as { phase?: string; playerId?: PlayerId }
        if (payload.phase !== 'play' || payload.playerId !== ownerId) return
        const cardId = host.state.liubaTongduCardId
        host.state.liubaTongduCardId = undefined
        if (!cardId) return
        const owner = playerOf(host.state, ownerId)
        if (!owner?.alive || !owner.zones.hand.includes(cardId)) return
        moveCard(host.state, cardId, { kind: 'hand', playerId: ownerId }, { kind: 'drawPile' }, { toTop: true })
        host.dispatch('LoseCard', { playerId: ownerId, cardIds: [cardId], reason: TONGDU }, { sourceId: ownerId, cardIds: [cardId] })
        host.dispatch('SkillActivated', { skillId: TONGDU, skillName: '统度', playerId: ownerId, logText: `${owner.nickname}发动【统度】，将一张牌置于牌堆顶` }, { sourceId: ownerId })
      },
    },
  ],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'pick-target') return
    const candidateIds = host.state.players.filter((candidate) => candidate.alive && candidate.id !== ownerId && candidate.zones.hand.length > 0).map((candidate) => candidate.id)
    if (candidateIds.length === 0) return
    host.askSkill({
      skillId: TONGDU, ownerId, step: 'pick-target', data: {},
      build: (requestId): ChooseTargetsRequest => ({
        id: requestId, kind: 'choose-targets', playerId: ownerId,
        prompt: '【统度】：选择一名角色，令其交给你1张手牌', timeoutMs: 20_000, optional: true,
        candidateIds, min: 0, max: 1,
      }),
    })
  },
  resume(host, ownerId, resolution, response) {
    const owner = playerOf(host.state, ownerId)
    if (resolution.step === 'pick-target') {
      const [targetId] = (response.payload as { targetIds?: PlayerId[] }).targetIds ?? []
      const target = targetId ? playerOf(host.state, targetId) : undefined
      if (!owner?.alive || !target?.alive || target.zones.hand.length === 0) return
      host.dispatch('SkillActivated', { skillId: TONGDU, skillName: '统度', playerId: ownerId, targetId, logText: `${owner.nickname}发动【统度】` }, { sourceId: ownerId, targetId })
      host.askSkill({
        skillId: TONGDU, ownerId, step: 'target-give', data: { targetId },
        build: (requestId): ChooseCardsRequest => ({
          id: requestId, kind: 'choose-cards', playerId: targetId,
          prompt: '【统度】：交给刘巴1张手牌', timeoutMs: 20_000, optional: false,
          purpose: 'skill', cardIds: [...target.zones.hand], hiddenCardSlots: [], min: 1, max: 1,
        }),
      })
      return
    }
    if (resolution.step === 'target-give') {
      const { targetId } = resolution.data as { targetId: PlayerId }
      const target = playerOf(host.state, targetId)
      const [cardId] = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
      if (!owner?.alive || !target?.alive || !cardId || !target.zones.hand.includes(cardId)) return
      moveCard(host.state, cardId, { kind: 'hand', playerId: targetId }, { kind: 'hand', playerId: ownerId })
      host.dispatch('GainCard', { playerId: ownerId, cardIds: [cardId], reason: TONGDU }, { sourceId: targetId, targetId: ownerId, cardIds: [cardId] })
      host.state.liubaTongduCardId = cardId
    }
  },
})

function zhubiUsesThisPhase(state: SanguoshaState, ownerId: PlayerId): number {
  const owner = playerOf(state, ownerId)
  if (!owner) return 0
  return owner.marks['zhubi-turn'] === state.turnNumber ? (owner.marks['zhubi-count'] ?? 0) : 0
}

registerSkillRuntime({
  id: ZHUBI,
  triggers: [{
    // 铸币的"币"是持有者结束阶段触发看底牌，持有者未必是刘巴自己，
    // 但触发派发只认技能拥有者——所以这里固定用刘巴当 ownerId，
    // 通过 payload.playerId 找真正的持有者，请求的 playerId 才路由给他。
    event: 'PhaseStart',
    handle(host, ownerId, context) {
      const payload = context.event.payload as { phase?: string; playerId?: PlayerId }
      if (payload.phase !== 'finish' || !payload.playerId) return
      const holderId = payload.playerId
      const holder = playerOf(host.state, holderId)
      if (!holder?.alive) return
      const coins = coinCardsHeldBy(host.state, holderId)
      if (coins.length === 0) return
      const bottom = host.state.zones.drawPile.slice(-5)
      if (bottom.length === 0) return
      host.dispatch('CardMove', { cardIds: bottom, reason: 'zhubi-bottom', revealed: true }, { sourceId: holderId })
      host.queueSkill({ skillId: ZHUBI, ownerId, step: 'ask-swap', data: { holderId, coins, bottom } })
    },
  }],
  activeActions(state, ownerId) {
    if (state.phase !== 'play' || state.currentPlayerId !== ownerId) return []
    const owner = playerOf(state, ownerId)
    if (!owner?.alive || zhubiUsesThisPhase(state, ownerId) >= owner.maxHp) return []
    const candidateIds = state.players.filter((candidate) => candidate.alive && candidate.zones.hand.length > 0).map((candidate) => candidate.id)
    if (candidateIds.length === 0) return []
    return [{ id: ZHUBI, label: '铸币：选择一名角色重铸1张牌' }]
  },
  invokeActive(host, ownerId, actionId) {
    if (actionId !== ZHUBI) return
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive || zhubiUsesThisPhase(host.state, ownerId) >= owner.maxHp) return
    const candidateIds = host.state.players.filter((candidate) => candidate.alive && candidate.zones.hand.length > 0).map((candidate) => candidate.id)
    if (candidateIds.length === 0) return
    host.askSkill({
      skillId: ZHUBI, ownerId, step: 'pick-target', data: {},
      build: (requestId): ChooseTargetsRequest => ({
        id: requestId, kind: 'choose-targets', playerId: ownerId,
        prompt: '【铸币】：选择一名角色重铸1张牌', timeoutMs: 20_000, optional: false,
        candidateIds, min: 1, max: 1,
      }),
    })
  },
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'ask-swap') return
    const { holderId, coins, bottom } = prompt.data as { holderId: PlayerId; coins: CardId[]; bottom: CardId[] }
    const max = Math.min(coins.length, bottom.length)
    host.askSkill({
      skillId: ZHUBI, ownerId, step: 'ask-swap', data: { holderId, bottom },
      build: (requestId): ChooseCardsRequest => ({
        id: requestId, kind: 'choose-cards', playerId: holderId,
        prompt: `【铸币】：选择任意数量"币"与牌堆底等量的牌交换（至多${max}张）`, timeoutMs: 20_000, optional: true,
        purpose: 'skill', cardIds: coins, hiddenCardSlots: [], min: 0, max,
      }),
    })
  },
  resume(host, ownerId, resolution, response) {
    const owner = playerOf(host.state, ownerId)
    if (resolution.step === 'ask-swap') {
      const { holderId, bottom } = resolution.data as { holderId: PlayerId; bottom: CardId[] }
      const holder = playerOf(host.state, holderId)
      if (!holder?.alive) return
      const coins = new Set(host.state.liubaCoinIds ?? [])
      const picked = ((response.payload as { cardIds?: CardId[] }).cardIds ?? []).filter((cardId) => holder.zones.hand.includes(cardId) && coins.has(cardId))
      const remainingBottom = bottom.filter((cardId) => host.state.zones.drawPile.includes(cardId))
      const n = Math.min(picked.length, remainingBottom.length)
      if (n === 0) return
      const swapCoins = picked.slice(0, n)
      const swapBottom = remainingBottom.slice(0, n)
      for (const cardId of swapCoins) moveCard(host.state, cardId, { kind: 'hand', playerId: holderId }, { kind: 'drawPile' })
      host.dispatch('LoseCard', { playerId: holderId, cardIds: swapCoins, reason: 'zhubi-bottom' }, { sourceId: holderId, cardIds: swapCoins })
      for (const cardId of swapBottom) moveCard(host.state, cardId, { kind: 'drawPile' }, { kind: 'hand', playerId: holderId })
      host.dispatch('GainCard', { playerId: holderId, cardIds: swapBottom, reason: 'zhubi-bottom' }, { targetId: holderId, cardIds: swapBottom })
      host.state.liubaCoinIds = (host.state.liubaCoinIds ?? []).filter((cardId) => !swapCoins.includes(cardId))
      host.dispatch('SkillActivated', { skillId: ZHUBI, skillName: '铸币', playerId: holderId, logText: `${holder.nickname}用${n}张"币"交换了牌堆底牌` }, { sourceId: holderId })
      return
    }
    if (resolution.step === 'pick-target') {
      const [targetId] = (response.payload as { targetIds?: PlayerId[] }).targetIds ?? []
      const target = targetId ? playerOf(host.state, targetId) : undefined
      if (!owner?.alive || !target?.alive || target.zones.hand.length === 0) return
      host.askSkill({
        skillId: ZHUBI, ownerId, step: 'target-recast', data: { targetId },
        build: (requestId): ChooseCardsRequest => ({
          id: requestId, kind: 'choose-cards', playerId: targetId,
          prompt: '【铸币】：重铸1张牌', timeoutMs: 20_000, optional: false,
          purpose: 'skill', cardIds: [...target.zones.hand], hiddenCardSlots: [], min: 1, max: 1,
        }),
      })
      return
    }
    if (resolution.step === 'target-recast') {
      const { targetId } = resolution.data as { targetId: PlayerId }
      const target = playerOf(host.state, targetId)
      const [cardId] = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
      if (!owner?.alive || !target?.alive || !cardId || !target.zones.hand.includes(cardId)) return
      if (owner.marks['zhubi-turn'] !== host.state.turnNumber) { owner.marks['zhubi-turn'] = host.state.turnNumber; owner.marks['zhubi-count'] = 0 }
      owner.marks['zhubi-count'] = (owner.marks['zhubi-count'] ?? 0) + 1
      host.dispatch('SkillActivated', { skillId: ZHUBI, skillName: '铸币', playerId: ownerId, targetId, logText: `${owner.nickname}发动【铸币】` }, { sourceId: ownerId, targetId })
      moveCard(host.state, cardId, { kind: 'hand', playerId: targetId }, { kind: 'discardPile' })
      host.dispatch('LoseCard', { playerId: targetId, cardIds: [cardId], reason: 'recast' }, { sourceId: targetId, cardIds: [cardId] })
      const [drawnId] = drawCards(host.state, host.rng, targetId, 1, (name, payload) => { host.dispatch(name, payload) })
      if (drawnId) {
        host.state.liubaCoinIds = [...(host.state.liubaCoinIds ?? []), drawnId]
      }
    }
  },
})

function coinCardsHeldBy(state: SanguoshaState, playerId: PlayerId): CardId[] {
  const player = playerOf(state, playerId)
  if (!player) return []
  const coins = new Set(state.liubaCoinIds ?? [])
  return player.zones.hand.filter((cardId) => coins.has(cardId))
}

export const LIUBA: CharacterDefinition = {
  id: 'liuba',
  name: '刘巴',
  kingdom: 'shu',
  gender: 'male',
  maxHp: 3,
  pack: 'sp',
  skills: [
    { id: TONGDU, name: '统度', description: '准备阶段，选择一名角色，令其交给你1张手牌；你的出牌阶段结束时，若这张具体的牌仍在你处，将其置于牌堆顶。' },
    { id: ZHUBI, name: '铸币', description: '出牌阶段限X次（X为你的体力上限），选择一名角色重铸1张牌，因此摸到的具体牌标记为"币"；持有至少1张"币"的角色结束阶段可以看牌堆底5张，并将手中任意数量的"币"与等量的牌堆底牌交换。' },
  ],
}
