import { drawCards } from '../../engine/draw'
import { effectiveGenderOf } from '../../engine/huashen'
import { registerSkillRuntime } from '../../engine/skills/runtime'
import { moveCard } from '../../engine/zones'
import type { ChooseCardsRequest, ChooseTargetsRequest } from '../../engine/requests'
import type { CardId, PlayerId, SanguoshaState } from '../../engine/types'
import type { CharacterDefinition } from './types'

/**
 * 夏侯氏（一将成名 2015）。
 *
 * 【樵拾】：其他角色的结束阶段开始时，若夏侯氏的手牌数与该角色相同，夏侯氏
 *          可以发动：夏侯氏和该角色各摸一张牌。
 * 【燕语】：自己的出牌阶段，夏侯氏可以重铸一张实体【杀】（可反复发动）；此
 *          出牌阶段结束时，若她本阶段因燕语重铸过至少 2 张【杀】，可以令
 *          一名男性角色摸两张牌。
 *
 * 两处最容易做错的：
 *
 * 1. **燕语的重铸走「弃置原因=recast」的专用去向**，不是普通弃置——不能
 *    触发落英这类只认 `discard` 原因的技能。
 * 2. **燕语的重铸次数按当前出牌阶段计**，走 `phase-usage.ts` 的阶段账本。
 */

const QIAOSHI = 'qiaoshi'
const YANYU = 'yanyu'
const YANYU_ACTION = 'yanyu-recast'
const RECAST_TURN_MARK = 'yanyu-recast-turn'
const RECAST_COUNT_MARK = 'yanyu-recast-count'

function recastCountThisTurn(state: SanguoshaState, ownerId: PlayerId): number {
  const owner = playerOf(state, ownerId)
  if (!owner || owner.marks[RECAST_TURN_MARK] !== state.turnNumber) return 0
  return owner.marks[RECAST_COUNT_MARK] ?? 0
}

function playerOf(state: SanguoshaState, playerId: PlayerId) {
  return state.players.find((candidate) => candidate.id === playerId)
}

registerSkillRuntime({
  id: QIAOSHI,
  triggers: [{
    event: 'PhaseStart',
    handle(host, ownerId, context) {
      const payload = context.event.payload as { playerId?: PlayerId; phase?: string }
      if (payload.phase !== 'finish' || !payload.playerId || payload.playerId === ownerId) return
      const targetId = payload.playerId
      const owner = playerOf(host.state, ownerId)
      const target = playerOf(host.state, targetId)
      if (!owner?.alive || !target?.alive || owner.zones.hand.length !== target.zones.hand.length) return
      host.queueSkill({ skillId: QIAOSHI, ownerId, step: 'ask', data: { targetId } })
    },
  }],

  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'ask') return
    const targetId = prompt.data.targetId as PlayerId
    const owner = playerOf(host.state, ownerId)
    const target = playerOf(host.state, targetId)
    if (!owner?.alive || !target?.alive || owner.zones.hand.length !== target.zones.hand.length) return
    host.askSkill({
      skillId: QIAOSHI, ownerId, step: 'ask', data: { targetId },
      build: (requestId) => ({
        id: requestId, kind: 'choose-option' as const, playerId: ownerId,
        prompt: `【樵拾】：与${target.nickname}各摸一张牌？`,
        timeoutMs: 20_000, optional: true,
        options: [{ id: 'yes', label: '发动【樵拾】' }, { id: 'no', label: '不发动' }],
      }),
    })
  },

  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'ask') return
    if ((response.payload as { optionId?: string }).optionId !== 'yes') return
    const targetId = resolution.data.targetId as PlayerId
    const owner = playerOf(host.state, ownerId)
    const target = playerOf(host.state, targetId)
    if (!owner?.alive || !target?.alive) return
    host.dispatch('SkillActivated', {
      skillId: QIAOSHI, skillName: '樵拾', playerId: ownerId, targetId,
      logText: `${owner.nickname}发动【樵拾】`,
    }, { sourceId: ownerId, targetId })
    drawCards(host.state, host.rng, ownerId, 1, (name, payload) => { host.dispatch(name, payload) })
    drawCards(host.state, host.rng, targetId, 1, (name, payload) => { host.dispatch(name, payload) })
  },
})

registerSkillRuntime({
  id: YANYU,
  activeActionUsesCard: true,

  activeActions(state, ownerId) {
    if (state.phase !== 'play' || state.currentPlayerId !== ownerId) return []
    const owner = playerOf(state, ownerId)
    if (!owner?.alive || !owner.zones.hand.some((cardId) => state.cards[cardId]?.name === '杀')) return []
    return [{ id: YANYU_ACTION, label: '燕语：重铸一张【杀】' }]
  },

  invokeActive(host, ownerId, actionId) {
    if (actionId !== YANYU_ACTION) return
    const owner = playerOf(host.state, ownerId)
    const slashes = owner?.zones.hand.filter((cardId) => host.state.cards[cardId]?.name === '杀') ?? []
    if (!owner?.alive || slashes.length === 0) return
    host.askSkill({
      skillId: YANYU, ownerId, step: 'pick',
      build: (requestId): ChooseCardsRequest => ({
        id: requestId, kind: 'choose-cards', playerId: ownerId,
        prompt: '【燕语】：选择一张【杀】重铸',
        timeoutMs: 20_000, optional: false, purpose: 'skill',
        cardIds: slashes, hiddenCardSlots: [], min: 1, max: 1,
      }),
    })
  },

  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'pick') return
    const owner = playerOf(host.state, ownerId)
    const [cardId] = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
    if (!owner?.alive || !cardId || !owner.zones.hand.includes(cardId) || host.state.cards[cardId]?.name !== '杀') return
    moveCard(host.state, cardId, { kind: 'hand', playerId: ownerId }, { kind: 'discardPile' }, { discardReason: 'other' })
    host.dispatch('LoseCard', { playerId: ownerId, cardIds: [cardId], reason: 'recast' }, { sourceId: ownerId, cardIds: [cardId] })
    host.dispatch('SkillActivated', {
      skillId: YANYU, skillName: '燕语', playerId: ownerId,
      logText: `${owner.nickname}发动【燕语】，重铸一张【杀】`,
    }, { sourceId: ownerId })
    drawCards(host.state, host.rng, ownerId, 1, (name, payload) => { host.dispatch(name, payload) })
    if (owner.marks[RECAST_TURN_MARK] !== host.state.turnNumber) {
      owner.marks[RECAST_TURN_MARK] = host.state.turnNumber
      owner.marks[RECAST_COUNT_MARK] = 0
    }
    owner.marks[RECAST_COUNT_MARK] = (owner.marks[RECAST_COUNT_MARK] ?? 0) + 1
  },
})

registerSkillRuntime({
  id: `${YANYU}-finish`,
  triggers: [{
    event: 'PhaseEnd',
    handle(host, ownerId, context) {
      const payload = context.event.payload as { playerId?: PlayerId; phase?: string }
      if (payload.phase !== 'play' || payload.playerId !== ownerId) return
      const owner = playerOf(host.state, ownerId)
      if (!owner?.alive || recastCountThisTurn(host.state, ownerId) < 2) return
      const candidateIds = host.state.players
        .filter((candidate) => candidate.alive && effectiveGenderOf(host.state, candidate.id) === 'male')
        .map((candidate) => candidate.id)
      if (candidateIds.length === 0) return
      host.queueSkill({ skillId: `${YANYU}-finish`, ownerId, step: 'target', data: { candidateIds } })
    },
  }],

  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'target') return
    const candidateIds = prompt.data.candidateIds as PlayerId[]
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    host.askSkill({
      skillId: `${YANYU}-finish`, ownerId, step: 'target', data: {},
      build: (requestId): ChooseTargetsRequest => ({
        id: requestId, kind: 'choose-targets', playerId: ownerId,
        prompt: '【燕语】：选择一名男性角色，摸两张牌',
        timeoutMs: 20_000, optional: true,
        candidateIds, min: 1, max: 1,
      }),
    })
  },

  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'target') return
    const [targetId] = (response.payload as { targetIds?: PlayerId[] }).targetIds ?? []
    if (!targetId || !playerOf(host.state, targetId)?.alive) return
    host.dispatch('SkillActivated', {
      skillId: YANYU, skillName: '燕语', playerId: ownerId, targetId,
      logText: `${playerOf(host.state, ownerId)?.nickname ?? ''}发动【燕语】，${playerOf(host.state, targetId)?.nickname ?? ''}摸两张牌`,
    }, { sourceId: ownerId, targetId })
    drawCards(host.state, host.rng, targetId, 2, (name, payload) => { host.dispatch(name, payload) })
  },
})

export const XIAHOUSHI: CharacterDefinition = {
  id: 'xiahoushi',
  name: '夏侯氏',
  kingdom: 'shu',
  gender: 'female',
  maxHp: 3,
  pack: 'yjcm2015',
  skills: [
    {
      id: QIAOSHI,
      name: '樵拾',
      description: '其他角色的结束阶段开始时，若夏侯氏的手牌数与该角色相同，夏侯氏可以发动：夏侯氏和该角色各摸一张牌。',
    },
    {
      id: YANYU,
      name: '燕语',
      description: '自己的出牌阶段，夏侯氏可以重铸一张实体【杀】（可反复发动）；此出牌阶段结束时，若她本阶段因燕语重铸过至少 2 张【杀】，可以令一名男性角色摸两张牌。',
    },
  ],
}
