import { movePickedCard, pickableCardsOf, resolvePickedCard } from '../../engine/card-pick'
import { drawCards } from '../../engine/draw'
import { markUsedThisTurn, usedThisTurn } from '../../engine/turn-usage'
import { registerSkillRuntime } from '../../engine/skills/runtime'
import type { ChooseOptionRequest, ChooseTargetsRequest } from '../../engine/requests'
import type { PlayerId, SanguoshaState } from '../../engine/types'
import type { CharacterDefinition } from './types'

/**
 * 全琮（一将成名 2015）。
 *
 * 【邀名】：每回合限一次，当你造成或受到伤害后，你可以选择一项：
 *          1. 弃置手牌数大于你的一名角色的一张手牌；
 *          2. 令手牌数小于你的一名角色摸一张牌。
 *
 * 最容易做错的：**触发条件是「造成」或「受到」伤害，两个方向都算**，不能只
 * 挂在 `AfterDamage` 的伤害来源一侧；弃置分支的目标手牌是暗的，走占位槽
 * 盲选，不能让全琮先看牌再挑。
 */

const YAOMING = 'yaoming'

function playerOf(state: SanguoshaState, playerId: PlayerId) {
  return state.players.find((candidate) => candidate.id === playerId)
}

function biggerHandTargets(state: SanguoshaState, ownerId: PlayerId): PlayerId[] {
  const ownerHand = playerOf(state, ownerId)?.zones.hand.length ?? 0
  return state.players
    .filter((candidate) => candidate.alive && candidate.id !== ownerId && candidate.zones.hand.length > ownerHand)
    .map((candidate) => candidate.id)
}

function smallerHandTargets(state: SanguoshaState, ownerId: PlayerId): PlayerId[] {
  const ownerHand = playerOf(state, ownerId)?.zones.hand.length ?? 0
  return state.players
    .filter((candidate) => candidate.alive && candidate.id !== ownerId && candidate.zones.hand.length < ownerHand)
    .map((candidate) => candidate.id)
}

registerSkillRuntime({
  id: YAOMING,
  triggers: [{
    event: 'AfterDamage',
    handle(host, ownerId, context) {
      // sourceId/targetId 是事件的元数据字段，不在 payload 里
      if (context.event.sourceId !== ownerId && context.event.targetId !== ownerId) return
      const owner = playerOf(host.state, ownerId)
      if (!owner?.alive || usedThisTurn(host.state, ownerId, YAOMING)) return
      const bigger = biggerHandTargets(host.state, ownerId)
      const smaller = smallerHandTargets(host.state, ownerId)
      if (bigger.length === 0 && smaller.length === 0) return
      host.queueSkill({ skillId: YAOMING, ownerId, step: 'choice', data: { bigger, smaller } })
    },
  }],

  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'choice') return
    const { bigger, smaller } = prompt.data as { bigger: PlayerId[]; smaller: PlayerId[] }
    host.askSkill({
      skillId: YAOMING, ownerId, step: 'choice', data: { bigger, smaller },
      build: (requestId): ChooseOptionRequest => ({
        id: requestId, kind: 'choose-option', playerId: ownerId,
        prompt: '【邀名】：选择一项',
        timeoutMs: 20_000, optional: true,
        options: [
          ...(bigger.length > 0 ? [{ id: 'discard', label: '弃置手牌数大于你的一名角色的一张手牌' }] : []),
          ...(smaller.length > 0 ? [{ id: 'draw', label: '令手牌数小于你的一名角色摸一张牌' }] : []),
        ],
      }),
    })
  },

  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'choice') {
      const { bigger, smaller } = resolution.data as { bigger: PlayerId[]; smaller: PlayerId[] }
      const optionId = (response.payload as { optionId?: string }).optionId
      if (optionId !== 'discard' && optionId !== 'draw') return
      const candidateIds = optionId === 'discard' ? bigger : smaller
      if (candidateIds.length === 0) return
      markUsedThisTurn(host.state, ownerId, YAOMING)
      host.askSkill({
        skillId: YAOMING, ownerId, step: 'target', data: { branch: optionId },
        build: (requestId): ChooseTargetsRequest => ({
          id: requestId, kind: 'choose-targets', playerId: ownerId,
          prompt: optionId === 'discard' ? '【邀名】：选择一名手牌数大于你的角色' : '【邀名】：选择一名手牌数小于你的角色',
          timeoutMs: 20_000, optional: false,
          candidateIds, min: 1, max: 1,
        }),
      })
      return
    }

    if (resolution.step === 'target') {
      const branch = resolution.data.branch as 'discard' | 'draw'
      const [targetId] = (response.payload as { targetIds?: PlayerId[] }).targetIds ?? []
      const owner = playerOf(host.state, ownerId)
      const target = targetId ? playerOf(host.state, targetId) : undefined
      if (!owner?.alive || !target?.alive) return

      if (branch === 'draw') {
        host.dispatch('SkillActivated', {
          skillId: YAOMING, skillName: '邀名', playerId: ownerId, targetId,
          logText: `${owner.nickname}发动【邀名】，${target.nickname}摸一张牌`,
        }, { sourceId: ownerId, targetId })
        drawCards(host.state, host.rng, targetId!, 1, (name, payload) => { host.dispatch(name, payload) })
        return
      }

      // 【邀名】只弃「一张手牌」，不能碰装备区——只看 hiddenCardSlots，忽略 pickableCardsOf 的公开装备牌
      const hiddenCardSlots = pickableCardsOf(host.state, targetId!).hiddenCardSlots
      if (hiddenCardSlots.length === 0) return
      host.dispatch('SkillActivated', {
        skillId: YAOMING, skillName: '邀名', playerId: ownerId, targetId,
        logText: `${owner.nickname}发动【邀名】，弃置${target.nickname}一张手牌`,
      }, { sourceId: ownerId, targetId })
      const slot = hiddenCardSlots[host.rng.nextInt(hiddenCardSlots.length)]
      const cardId = resolvePickedCard(host.state, targetId!, slot)
      if (cardId) movePickedCard(host as never, targetId!, cardId, { kind: 'discardPile' })
    }
  },
})

export const QUANZONG: CharacterDefinition = {
  id: 'quanzong',
  name: '全琮',
  kingdom: 'wu',
  gender: 'male',
  maxHp: 4,
  pack: 'yjcm2015',
  skills: [
    {
      id: YAOMING,
      name: '邀名',
      description: '每回合限一次，当你造成或受到伤害后，你可以选择一项：1. 弃置手牌数大于你的一名角色的一张手牌；2. 令手牌数小于你的一名角色摸一张牌。',
    },
  ],
}
