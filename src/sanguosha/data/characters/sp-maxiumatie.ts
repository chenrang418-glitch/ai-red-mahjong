import { drawCards } from '../../engine/draw'
import { canTarget } from '../../engine/distance'
import { hasUnlimitedSlash } from '../../engine/equipment'
import { canUseSlash, hasSlashUsesBypass } from '../../engine/slash-rules'
import { cardDamageDealt } from '../../engine/card-damage-ledger'
import { executeUseCardAction } from '../../engine/cards/basic'
import { registerSkillRuntime } from '../../engine/skills/runtime'
import type { ChooseCardsRequest, ChooseTargetsRequest } from '../../engine/requests'
import type { CardId, PlayerId, SanguoshaState } from '../../engine/types'
import type { CharacterDefinition } from './types'

/**
 * 马休马铁（三国杀 OL 经典身份 SP）。
 *
 * 【马术】：锁定技，直接复用已注册的 `mashu`（马超/庞德同款）。
 * 【垦伤】：可以选择至少2张牌当【杀】使用，视为对等量（≤合法目标数）名
 *          角色使用；结算后若这些牌的数量N大于这张杀实际造成的伤害总
 *          点数，摸1张牌。
 */

const KENSHANG = 'kenshang'

function playerOf(state: SanguoshaState, playerId: PlayerId) {
  return state.players.find((candidate) => candidate.id === playerId)
}

registerSkillRuntime({
  id: KENSHANG,
  activeActions(state, ownerId) {
    if (state.phase !== 'play' || state.currentPlayerId !== ownerId) return []
    const owner = playerOf(state, ownerId)
    if (!owner?.alive || owner.zones.hand.length < 2) return []
    if (!canUseSlash(state, ownerId, hasUnlimitedSlash(state, ownerId)) && !hasSlashUsesBypass(state, ownerId)) return []
    return [{ id: 'kenshang-invoke', label: '垦伤：选择至少2张牌当【杀】使用' }]
  },
  invokeActive(host, ownerId, actionId) {
    if (actionId !== 'kenshang-invoke') return
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive || owner.zones.hand.length < 2) return
    host.askSkill({
      skillId: KENSHANG, ownerId, step: 'pick-cards', data: {},
      build: (requestId): ChooseCardsRequest => ({
        id: requestId, kind: 'choose-cards', playerId: ownerId,
        prompt: '【垦伤】：选择至少2张牌当【杀】使用', timeoutMs: 20_000, optional: false,
        purpose: 'skill', cardIds: [...owner.zones.hand], hiddenCardSlots: [], min: 2, max: owner.zones.hand.length,
      }),
    })
  },
  resume(host, ownerId, resolution, response) {
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return

    if (resolution.step === 'pick-cards') {
      const cardIds = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
      const valid = [...new Set(cardIds.filter((id) => owner.zones.hand.includes(id)))]
      if (valid.length < 2) return
      const n = valid.length
      const candidateIds = host.state.players.filter((candidate) => candidate.alive && candidate.id !== ownerId && canTarget(host.state, ownerId, candidate.id)).map((candidate) => candidate.id)
      const max = Math.min(n, candidateIds.length)
      if (max === 0) return
      host.askSkill({
        skillId: KENSHANG, ownerId, step: 'pick-targets', data: { cardIds: valid, n },
        build: (requestId): ChooseTargetsRequest => ({
          id: requestId, kind: 'choose-targets', playerId: ownerId,
          prompt: `【垦伤】：选择${max}名角色`, timeoutMs: 20_000, optional: false,
          candidateIds, min: max, max,
        }),
      })
      return
    }

    if (resolution.step === 'pick-targets') {
      const { cardIds, n } = resolution.data as { cardIds: CardId[]; n: number }
      const targetIds = (response.payload as { targetIds?: PlayerId[] }).targetIds ?? []
      const validCardIds = cardIds.filter((id) => owner.zones.hand.includes(id))
      if (targetIds.length === 0 || validCardIds.length < 2) return
      host.dispatch('SkillActivated', { skillId: KENSHANG, skillName: '垦伤', playerId: ownerId, logText: `${owner.nickname}发动【垦伤】，对${targetIds.length}名角色使用【杀】` }, { sourceId: ownerId })
      host.state.maxiuKenshangPending = { turnNumber: host.state.turnNumber, n, cardId: validCardIds[0] }
      executeUseCardAction(host as never, ownerId, {
        kind: 'use-card', id: `kenshang:${validCardIds[0]}`, playerId: ownerId,
        cardIds: validCardIds, targetIds, targetMin: targetIds.length, targetMax: targetIds.length,
        asCardName: '杀', label: '垦伤：视为使用【杀】',
      })
    }
  },
  triggers: [{
    event: 'AfterCardUse',
    handle(host, ownerId, context) {
      const pending = host.state.maxiuKenshangPending
      const payload = context.event.payload as { cardId?: CardId; cancelled?: boolean }
      if (!pending || pending.cardId !== payload.cardId || context.event.sourceId !== ownerId) return
      host.state.maxiuKenshangPending = undefined
      if (payload.cancelled || !payload.cardId) return
      const total = cardDamageDealt(host.state, payload.cardId)
      if (pending.n <= total) return
      const owner = playerOf(host.state, ownerId)
      if (!owner?.alive) return
      drawCards(host.state, host.rng, ownerId, 1, (name, drawPayload) => { host.dispatch(name, drawPayload) })
      host.dispatch('SkillActivated', { skillId: KENSHANG, skillName: '垦伤', playerId: ownerId, logText: `${owner.nickname}发动【垦伤】，摸1张牌` }, { sourceId: ownerId })
    },
  }],
})

export const MAXIU_MATIE: CharacterDefinition = {
  id: 'maxiumatie',
  name: '马休马铁',
  kingdom: 'qun',
  gender: 'male',
  maxHp: 4,
  pack: 'sp',
  skills: [
    { id: 'mashu', name: '马术', description: '锁定技，你计算与其他角色的距离-1。' },
    { id: KENSHANG, name: '垦伤', description: '可以选择至少2张牌当【杀】使用，视为对等量（不超过合法目标数）名角色使用；结算后若这些牌的数量大于这张杀实际造成的伤害总点数，摸1张牌。' },
  ],
}
