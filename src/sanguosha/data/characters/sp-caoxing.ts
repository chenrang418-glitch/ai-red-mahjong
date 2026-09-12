import { moveCard } from '../../engine/zones'
import { drawCards } from '../../engine/draw'
import { registerSkillRuntime } from '../../engine/skills/runtime'
import type { ChooseCardsRequest, ChooseTargetsRequest } from '../../engine/requests'
import type { CardId, PlayerId, SanguoshaState } from '../../engine/types'
import type { CharacterDefinition } from './types'

/**
 * 曹性（三国杀 OL 经典身份 SP）。
 *
 * 【流矢】：出牌阶段，曹性可以将一张红桃手牌置于牌堆顶，然后视为对一名
 *          角色使用一张【杀】（无距离限制、不计入次数）。若造成了伤害，
 *          目标获得【流矢】标记：手牌上限-1，直到被【斩腕】移除。
 * 【斩腕】：锁定技，带有【流矢】标记的角色在弃牌阶段实际弃置牌后，曹性
 *          摸等量的牌，然后移除该标记。
 */

const LIUSHI = 'liushi'
const ZHANWAN = 'zhanwan'
const LIUSHI_MARK = 'liushi-mark'

function playerOf(state: SanguoshaState, playerId: PlayerId) {
  return state.players.find((candidate) => candidate.id === playerId)
}

registerSkillRuntime({
  id: LIUSHI,
  activeActions(state, ownerId) {
    if (state.phase !== 'play' || state.currentPlayerId !== ownerId) return []
    const owner = playerOf(state, ownerId)
    if (!owner?.alive || !owner.zones.hand.some((cardId) => state.cards[cardId]?.suit === 'heart')) return []
    return [{ id: LIUSHI, label: '流矢：置一张红桃于牌堆顶，视为使用一张无限制的杀' }]
  },

  invokeActive(host, ownerId, actionId) {
    if (actionId !== LIUSHI) return
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    const hearts = owner.zones.hand.filter((cardId) => host.state.cards[cardId]?.suit === 'heart')
    if (hearts.length === 0) return
    host.askSkill({
      skillId: LIUSHI, ownerId, step: 'pick',
      build: (requestId): ChooseCardsRequest => ({
        id: requestId, kind: 'choose-cards', playerId: ownerId,
        prompt: '【流矢】：选择一张红桃置于牌堆顶', timeoutMs: 20_000, optional: false,
        purpose: 'skill', cardIds: hearts, hiddenCardSlots: [], min: 1, max: 1,
      }),
    })
  },

  resume(host, ownerId, resolution, response) {
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return

    if (resolution.step === 'pick') {
      const [cardId] = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
      if (!cardId || !owner.zones.hand.includes(cardId)) return
      moveCard(host.state, cardId, { kind: 'hand', playerId: ownerId }, { kind: 'drawPile' }, { toTop: true })
      host.dispatch('LoseCard', { playerId: ownerId, cardIds: [cardId], reason: LIUSHI }, { sourceId: ownerId, cardIds: [cardId] })
      const candidateIds = host.state.players.filter((candidate) => candidate.alive).map((candidate) => candidate.id)
      host.askSkill({
        skillId: LIUSHI, ownerId, step: 'target',
        build: (requestId): ChooseTargetsRequest => ({
          id: requestId, kind: 'choose-targets', playerId: ownerId,
          prompt: '【流矢】：视为使用一张杀', timeoutMs: 20_000, optional: false, candidateIds, min: 1, max: 1,
        }),
      })
      return
    }

    if (resolution.step === 'target') {
      const [targetId] = (response.payload as { targetIds?: PlayerId[] }).targetIds ?? []
      const target = targetId ? playerOf(host.state, targetId) : undefined
      if (!target?.alive) return
      host.dispatch('SkillActivated', { skillId: LIUSHI, skillName: '流矢', playerId: ownerId, targetId, logText: `${owner.nickname}发动【流矢】` }, { sourceId: ownerId, targetId })
      host.state.caoxingLiushiPending = { ownerId, targetId }
      host.beginVirtualSlash({ sourceId: ownerId, targetId, sourceSkillId: LIUSHI, countUsage: false })
      host.state.caoxingLiushiPending = undefined
    }
  },

  triggers: [{
    event: 'Damaged',
    handle(host, ownerId, context) {
      const pending = host.state.caoxingLiushiPending
      if (!pending || pending.ownerId !== ownerId) return
      if (context.event.sourceId !== ownerId || context.event.targetId !== pending.targetId) return
      const target = playerOf(host.state, pending.targetId)
      if (!target?.alive) return
      target.marks[LIUSHI_MARK] = 1
      host.state.caoxingLiushiPending = undefined
    },
  }],

  maxCardsBonus(state, ownerId) {
    return (playerOf(state, ownerId)?.marks[LIUSHI_MARK] ?? 0) > 0 ? -1 : 0
  },
})

registerSkillRuntime({
  id: ZHANWAN,
  triggers: [{
    event: 'LoseCard',
    handle(host, ownerId, context) {
      const payload = context.event.payload as { playerId?: PlayerId; cardIds?: CardId[]; reason?: string }
      if (payload.reason !== 'discard-phase' || !payload.playerId || payload.playerId === ownerId) return
      const target = playerOf(host.state, payload.playerId)
      if (!target || (target.marks[LIUSHI_MARK] ?? 0) <= 0) return
      const owner = playerOf(host.state, ownerId)
      if (!owner?.alive) return
      const count = payload.cardIds?.length ?? 0
      if (count > 0) drawCards(host.state, host.rng, ownerId, count, (name, drawPayload) => { host.dispatch(name, drawPayload) })
      target.marks[LIUSHI_MARK] = 0
      host.dispatch('SkillActivated', { skillId: ZHANWAN, skillName: '斩腕', playerId: ownerId, targetId: target.id, logText: `${owner.nickname}发动【斩腕】，摸${count}张牌` }, { sourceId: ownerId, targetId: target.id })
    },
  }],
})

export const CAOXING: CharacterDefinition = {
  id: 'caoxing',
  name: '曹性',
  kingdom: 'qun',
  gender: 'male',
  maxHp: 4,
  pack: 'sp',
  skills: [
    { id: LIUSHI, name: '流矢', description: '出牌阶段，曹性可以将一张红桃手牌置于牌堆顶，然后视为对一名角色使用一张无距离和次数限制的【杀】。若造成伤害，目标手牌上限-1，直到被【斩腕】移除。' },
    { id: ZHANWAN, name: '斩腕', description: '锁定技，带有流矢效果的角色在弃牌阶段实际弃置牌后，曹性摸等量的牌，然后移除流矢效果。' },
  ],
}
