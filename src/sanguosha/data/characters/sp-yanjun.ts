import { moveCard } from '../../engine/zones'
import { drawCards } from '../../engine/draw'
import { registerSkillRuntime, type SkillHost } from '../../engine/skills/runtime'
import type { ChooseOptionRequest, ChooseTargetsRequest } from '../../engine/requests'
import type { CardId, PlayerId, SanguoshaState } from '../../engine/types'
import type { CharacterDefinition } from './types'

/**
 * 严畯（三国杀 OL 经典身份 SP）。
 *
 * 【观潮】：严畯出牌阶段开始时，选择“严格递增”或“严格递减”，持续本阶段
 *          实例；此后每使用一张牌，若至今使用的牌点数仍保持严格趋势，
 *          摸1张牌；一旦被打破，本阶段不再恢复。
 * 【逊贤】：每个回合限一次，严畯于自己回合外使用/打出一张牌，这张实体牌
 *          进入弃牌堆后，若仍在弃牌堆，可以将其交给一名手牌数比严畯多
 *          的角色。
 */

const GUANCHAO = 'guanchao'
const XUNXIAN = 'xunxian'

function playerOf(state: SanguoshaState, playerId: PlayerId) {
  return state.players.find((candidate) => candidate.id === playerId)
}

registerSkillRuntime({
  id: GUANCHAO,
  triggers: [
    {
      event: 'PhaseStart',
      handle(host, ownerId, context) {
        const payload = context.event.payload as { playerId?: PlayerId; phase?: string }
        if (payload.phase !== 'play' || payload.playerId !== ownerId) return
        const owner = playerOf(host.state, ownerId)
        if (!owner?.alive) return
        host.queueSkill({ skillId: GUANCHAO, ownerId, step: 'ask', data: {} })
      },
    },
    {
      event: 'CardUsed',
      handle(host, ownerId, context) {
        if (context.event.sourceId !== ownerId || host.state.phase !== 'play' || host.state.currentPlayerId !== ownerId) return
        const trend = host.state.yanjunTrend?.[ownerId]
        if (!trend || trend.broken) return
        const payload = context.event.payload as { cardId?: CardId }
        const rank = payload.cardId ? host.state.cards[payload.cardId]?.rank ?? null : null
        if (rank === null) return
        const owner = playerOf(host.state, ownerId)
        if (!owner?.alive) return
        if (trend.lastRank !== null) {
          const ok = trend.direction === 'asc' ? rank > trend.lastRank : rank < trend.lastRank
          if (!ok) { trend.broken = true; return }
        }
        trend.lastRank = rank
        drawCards(host.state, host.rng, ownerId, 1, (name, drawPayload) => { host.dispatch(name, drawPayload) })
        host.dispatch('SkillActivated', { skillId: GUANCHAO, skillName: '观潮', playerId: ownerId, logText: `${owner.nickname}发动【观潮】，摸牌` }, { sourceId: ownerId })
      },
    },
  ],

  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'ask') return
    if (!playerOf(host.state, ownerId)?.alive) return
    host.askSkill({
      skillId: GUANCHAO, ownerId, step: 'ask', data: {},
      build: (requestId): ChooseOptionRequest => ({
        id: requestId, kind: 'choose-option', playerId: ownerId,
        prompt: '【观潮】：选择本阶段牌点走势', timeoutMs: 20_000, optional: true,
        options: [{ id: 'asc', label: '严格递增' }, { id: 'desc', label: '严格递减' }, { id: 'none', label: '不发动' }],
      }),
    })
  },

  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'ask') return
    const optionId = (response.payload as { optionId?: string }).optionId
    if (optionId !== 'asc' && optionId !== 'desc') return
    host.state.yanjunTrend ??= {}
    host.state.yanjunTrend[ownerId] = { direction: optionId, lastRank: null, broken: false }
  },
})

function tryXunxian(host: SkillHost, ownerId: PlayerId, cardId: CardId): void {
  const owner = playerOf(host.state, ownerId)
  if (!owner?.alive || owner.turnUsedSkills.includes(XUNXIAN)) return
  if (host.state.currentPlayerId === ownerId) return
  if (!host.state.zones.discardPile.includes(cardId)) return
  const candidateIds = host.state.players.filter((candidate) => candidate.alive && candidate.id !== ownerId && candidate.zones.hand.length > owner.zones.hand.length).map((candidate) => candidate.id)
  if (candidateIds.length === 0) return
  host.queueSkill({ skillId: XUNXIAN, ownerId, step: 'ask', data: { cardId, candidateIds } })
}

registerSkillRuntime({
  id: XUNXIAN,
  triggers: [
    {
      event: 'AfterCardUse',
      handle(host, ownerId, context) {
        const payload = context.event.payload as { cardId?: CardId; cancelled?: boolean }
        if (context.event.sourceId !== ownerId || payload.cancelled || !payload.cardId) return
        tryXunxian(host, ownerId, payload.cardId)
      },
    },
    {
      event: 'CardResponded',
      handle(host, ownerId, context) {
        const payload = context.event.payload as { playerId?: PlayerId; cardId?: CardId }
        if (payload.playerId !== ownerId || !payload.cardId) return
        tryXunxian(host, ownerId, payload.cardId)
      },
    },
  ],

  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'ask') return
    const owner = playerOf(host.state, ownerId)
    const { cardId, candidateIds } = prompt.data as { cardId: CardId; candidateIds: PlayerId[] }
    if (!owner?.alive || owner.turnUsedSkills.includes(XUNXIAN) || !host.state.zones.discardPile.includes(cardId)) return
    host.askSkill({
      skillId: XUNXIAN, ownerId, step: 'target', data: { cardId },
      build: (requestId): ChooseTargetsRequest => ({
        id: requestId, kind: 'choose-targets', playerId: ownerId,
        prompt: '【逊贤】：可以将这张牌交给一名手牌数比自己多的角色', timeoutMs: 20_000, optional: true, candidateIds, min: 0, max: 1,
      }),
    })
  },

  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'target') return
    const { cardId } = resolution.data as { cardId: CardId }
    const [targetId] = (response.payload as { targetIds?: PlayerId[] }).targetIds ?? []
    const owner = playerOf(host.state, ownerId)
    const target = targetId ? playerOf(host.state, targetId) : undefined
    if (!owner?.alive || owner.turnUsedSkills.includes(XUNXIAN) || !target?.alive || !host.state.zones.discardPile.includes(cardId)) return
    owner.turnUsedSkills.push(XUNXIAN)
    moveCard(host.state, cardId, { kind: 'discardPile' }, { kind: 'hand', playerId: targetId! })
    host.dispatch('GainCard', { playerId: targetId, cardIds: [cardId], reason: XUNXIAN }, { targetId, cardIds: [cardId] })
    host.dispatch('SkillActivated', { skillId: XUNXIAN, skillName: '逊贤', playerId: ownerId, targetId, logText: `${owner.nickname}发动【逊贤】` }, { sourceId: ownerId, targetId })
  },
})

export const YANJUN: CharacterDefinition = {
  id: 'yanjun',
  name: '严畯',
  kingdom: 'wu',
  gender: 'male',
  maxHp: 3,
  pack: 'sp',
  skills: [
    { id: GUANCHAO, name: '观潮', description: '出牌阶段开始时，选择“严格递增”或“严格递减”，此后每使用一张牌，若至今使用的牌点数仍保持严格趋势，摸1张牌，一旦被打破本阶段不再恢复。' },
    { id: XUNXIAN, name: '逊贤', description: '每个回合限一次，严畯于自己回合外使用/打出一张牌，这张实体牌进入弃牌堆后，若仍在弃牌堆，可以将其交给一名手牌数比自己多的角色。' },
  ],
}
