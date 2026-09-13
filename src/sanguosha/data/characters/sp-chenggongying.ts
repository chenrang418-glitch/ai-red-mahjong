import { moveCard } from '../../engine/zones'
import { drawCards } from '../../engine/draw'
import { registerSkillRuntime } from '../../engine/skills/runtime'
import type { ChooseCardsRequest, ChooseTargetsRequest } from '../../engine/requests'
import type { CardId, PlayerId, SanguoshaState } from '../../engine/types'
import type { CharacterDefinition } from './types'

/**
 * 成公英（三国杀 OL 经典身份 SP）。
 *
 * 【匡襄】：准备阶段，成公英选择一名角色A，令其手牌调整为4张（不足则
 *          摸牌补齐，超过则弃至4张）。因此实际摸到的黑色牌：本回合内若
 *          被A使用并造成伤害，这次伤害+1（绑定具体 Card ID，新增
 *          `globalOutgoingDamage` 钩子承接"拥有者是成公英、来源是A"这种
 *          第三方伤害加成）。因此摸到的每张红色牌：A的下一个 Draw Phase
 *          摸牌数-1（监听 `DrawPhase` 事件改写其 `count`，可叠加）。
 */

const KUANGXIANG = 'kuangxiang'

function playerOf(state: SanguoshaState, playerId: PlayerId) {
  return state.players.find((candidate) => candidate.id === playerId)
}

registerSkillRuntime({
  id: KUANGXIANG,
  triggers: [
    {
      event: 'PhaseStart',
      handle(host, ownerId, context) {
        const payload = context.event.payload as { playerId?: PlayerId; phase?: string }
        if (payload.phase !== 'prepare' || payload.playerId !== ownerId) return
        const owner = playerOf(host.state, ownerId)
        if (!owner?.alive) return
        const candidateIds = host.state.players.filter((candidate) => candidate.alive).map((candidate) => candidate.id)
        host.queueSkill({ skillId: KUANGXIANG, ownerId, step: 'pick-target', data: { candidateIds } })
      },
    },
    {
      event: 'DrawPhase',
      handle(host, _ownerId, context) {
        const payload = context.event.payload as { playerId?: PlayerId; count?: number }
        if (!payload.playerId) return
        const penalty = host.state.chenggongyingDrawPenalty?.[payload.playerId]
        if (!penalty || penalty <= 0) return
        const nextCount = Math.max(0, (payload.count ?? 2) - penalty)
        context.event.payload = { ...payload, count: nextCount }
        delete host.state.chenggongyingDrawPenalty![payload.playerId]
      },
    },
  ],

  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'pick-target') return
    if (!playerOf(host.state, ownerId)?.alive) return
    const { candidateIds } = prompt.data as { candidateIds: PlayerId[] }
    host.askSkill({
      skillId: KUANGXIANG, ownerId, step: 'pick-target',
      build: (requestId): ChooseTargetsRequest => ({
        id: requestId, kind: 'choose-targets', playerId: ownerId,
        prompt: '【匡襄】：选择一名角色，将其手牌调整为4张', timeoutMs: 20_000, optional: true, candidateIds, min: 0, max: 1,
      }),
    })
  },

  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'discard') {
      const { targetId } = resolution.data as { targetId: PlayerId }
      const target = playerOf(host.state, targetId)
      const cardIds = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
      const valid = cardIds.filter((id) => target?.zones.hand.includes(id))
      if (!target?.alive || valid.length === 0) return
      for (const cardId of valid) moveCard(host.state, cardId, { kind: 'hand', playerId: targetId }, { kind: 'discardPile' })
      host.dispatch('LoseCard', { playerId: targetId, cardIds: valid, reason: KUANGXIANG }, { sourceId: targetId, cardIds: valid })
      return
    }
    if (resolution.step !== 'pick-target') return
    const owner = playerOf(host.state, ownerId)
    const [targetId] = (response.payload as { targetIds?: PlayerId[] }).targetIds ?? []
    const target = targetId ? playerOf(host.state, targetId) : undefined
    if (!owner?.alive || !target?.alive) return
    host.dispatch('SkillActivated', { skillId: KUANGXIANG, skillName: '匡襄', playerId: ownerId, targetId, logText: `${owner.nickname}发动【匡襄】` }, { sourceId: ownerId, targetId })

    if (target.zones.hand.length < 4) {
      const need = 4 - target.zones.hand.length
      const drawn = drawCards(host.state, host.rng, target.id, need, (name, payload) => { host.dispatch(name, payload) })
      for (const cardId of drawn) {
        const color = host.state.cards[cardId]?.color
        if (color === 'black') {
          host.state.chenggongyingBlackCards ??= {}
          host.state.chenggongyingBlackCards[cardId] = { ownerId, sourceId: target.id, turnNumber: host.state.turnNumber }
        } else if (color === 'red') {
          host.state.chenggongyingDrawPenalty ??= {}
          host.state.chenggongyingDrawPenalty[target.id] = (host.state.chenggongyingDrawPenalty[target.id] ?? 0) + 1
        }
      }
      return
    }
    if (target.zones.hand.length > 4) {
      host.askSkill({
        skillId: KUANGXIANG, ownerId, step: 'discard', data: { targetId },
        build: (requestId): ChooseCardsRequest => ({
          id: requestId, kind: 'choose-cards', playerId: target.id,
          prompt: '【匡襄】：弃置手牌至4张', timeoutMs: 20_000, optional: false,
          purpose: 'skill', cardIds: [...target.zones.hand], hiddenCardSlots: [], min: target.zones.hand.length - 4, max: target.zones.hand.length - 4,
        }),
      })
    }
  },

  globalOutgoingDamage(state, ownerId, sourceId, context) {
    const entry = state.chenggongyingBlackCards?.[context.cardId ?? '']
    if (!entry || entry.ownerId !== ownerId || entry.sourceId !== sourceId || entry.turnNumber !== state.turnNumber) return null
    return { amount: context.amount + 1 }
  },
})

export const CHENGGONGYING: CharacterDefinition = {
  id: 'chenggongying',
  name: '成公英',
  kingdom: 'qun',
  gender: 'male',
  maxHp: 4,
  pack: 'sp',
  skills: [
    { id: KUANGXIANG, name: '匡襄', description: '准备阶段，成公英选择一名角色，令其手牌调整为4张（不足摸牌补齐，超过弃至4张）；因此摸到的黑色牌本回合内若被其使用并造成伤害，这次伤害+1；因此摸到的每张红色牌，其下一个摸牌阶段摸牌数-1。' },
  ],
}
