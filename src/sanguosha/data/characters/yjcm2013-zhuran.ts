import { movePickedCard, pickableCardsOf, resolvePickedCard } from '../../engine/card-pick'
import { resolveDamage } from '../../engine/damage'
import { getAttackRange, canTarget } from '../../engine/distance'
import { drawCards } from '../../engine/draw'
import { markUsedThisPhase, usedThisPhase } from '../../engine/phase-usage'
import { registerSkillRuntime } from '../../engine/skills/runtime'
import { moveCard } from '../../engine/zones'
import type { ChooseCardsRequest, ChooseTargetsRequest } from '../../engine/requests'
import type { CardId, PlayerId, SanguoshaState } from '../../engine/types'
import type { CharacterDefinition } from './types'

/**
 * 朱然（一将成名 2013，采用 2014 调整后的成熟版）。
 *
 * 【胆守】：出牌阶段，你可以反复发动：弃置 X 张牌，选择攻击范围内一名角色，
 *          X 为本出牌阶段内你已经发动过胆守的次数 + 1（第一次 X=1，第二次
 *          X=2，第三次 X=3，第四次及以后 X≥4）：
 *          X=1，该角色弃置一张牌；X=2，该角色将一张手牌交给你；
 *          X=3，你对该角色造成 1 点伤害；X≥4，你和该角色各摸两张牌。
 *
 * 三处最容易做错的：
 *
 * 1. **发动次数按本出牌阶段实例算，不是按整个回合**——复用
 *    `phase-usage.ts` 的「阶段限一次」账本，用 `danshou-N` 逐级探测出
 *    「已经发动过几次」，天然随每个新出牌阶段（含额外阶段）重新计数。
 * 2. **X=1/X=2 都是从目标身上拿牌，不能让朱然看见目标完整手牌**——
 *    走 `card-pick.ts` 的暗手牌占位槽。
 * 3. **X=2 是「交给」（Give），不是朱然自己选牌抢**；服务端只是代为
 *    选择哪一张（占位槽避免泄漏），去向是朱然的手牌，仍然算「交给」而不是夺取。
 */

const DANSHOU = 'danshou'
const DANSHOU_ACTION = 'danshou-invoke'

function playerOf(state: SanguoshaState, playerId: PlayerId) {
  return state.players.find((candidate) => candidate.id === playerId)
}

function danshouCountThisPhase(state: SanguoshaState, ownerId: PlayerId): number {
  let count = 0
  while (usedThisPhase(state, ownerId, `${DANSHOU}-${count + 1}`)) count += 1
  return count
}

function danshouTargets(state: SanguoshaState, ownerId: PlayerId): PlayerId[] {
  const range = getAttackRange(state, ownerId)
  return state.players.filter((candidate) => candidate.alive && canTarget(state, ownerId, candidate.id, range)).map((candidate) => candidate.id)
}

registerSkillRuntime({
  id: DANSHOU,
  announcesSelf: true,

  activeActions(state, ownerId) {
    if (state.phase !== 'play' || state.currentPlayerId !== ownerId) return []
    const owner = playerOf(state, ownerId)
    if (!owner?.alive) return []
    const x = danshouCountThisPhase(state, ownerId) + 1
    if (owner.zones.hand.length < x) return []
    if (danshouTargets(state, ownerId).length === 0) return []
    return [{ id: DANSHOU_ACTION, label: `胆守：弃置 ${x} 张牌，对攻击范围内一名角色发动` }]
  },

  invokeActive(host, ownerId, actionId) {
    if (actionId !== DANSHOU_ACTION) return
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    const x = danshouCountThisPhase(host.state, ownerId) + 1
    if (owner.zones.hand.length < x || danshouTargets(host.state, ownerId).length === 0) return
    host.askSkill({
      skillId: DANSHOU, ownerId, step: 'cost', data: { x },
      build: (requestId): ChooseCardsRequest => ({
        id: requestId, kind: 'choose-cards', playerId: ownerId,
        prompt: `【胆守】：弃置 ${x} 张牌`,
        timeoutMs: 20_000, optional: true, purpose: 'skill',
        cardIds: [...owner.zones.hand], hiddenCardSlots: [],
        min: x, max: x,
      }),
    })
  },

  resume(host, ownerId, resolution, response) {
    const owner = playerOf(host.state, ownerId)

    if (resolution.step === 'cost') {
      const x = resolution.data.x as number
      const cardIds = [...new Set((response.payload as { cardIds?: CardId[] }).cardIds ?? [])]
        .filter((cardId) => owner?.zones.hand.includes(cardId))
      if (cardIds.length !== x || !owner?.alive) return
      const candidateIds = danshouTargets(host.state, ownerId)
      if (candidateIds.length === 0) return
      for (const cardId of cardIds) {
        host.dispatch('LoseCard', { playerId: ownerId, cardIds: [cardId], reason: DANSHOU }, { targetId: ownerId, cardIds: [cardId] })
      }
      for (const cardId of cardIds) moveCard(host.state, cardId, { kind: 'hand', playerId: ownerId }, { kind: 'discardPile' })
      markUsedThisPhase(host.state, ownerId, `${DANSHOU}-${x}`)
      host.askSkill({
        skillId: DANSHOU, ownerId, step: 'target', data: { x },
        build: (requestId): ChooseTargetsRequest => ({
          id: requestId, kind: 'choose-targets', playerId: ownerId,
          prompt: '【胆守】：选择攻击范围内一名角色',
          timeoutMs: 20_000, optional: false,
          candidateIds, min: 1, max: 1,
        }),
      })
      return
    }

    if (resolution.step === 'target') {
      const x = resolution.data.x as number
      const [targetId] = (response.payload as { targetIds?: PlayerId[] }).targetIds ?? []
      const target = targetId ? playerOf(host.state, targetId) : undefined
      if (!owner?.alive || !target?.alive) return
      host.dispatch('SkillActivated', {
        skillId: DANSHOU, skillName: '胆守', playerId: ownerId, targetId,
        logText: `${owner.nickname}发动【胆守】（第 ${x} 次）`,
      }, { sourceId: ownerId, targetId })

      if (x === 1) {
        const pickable = pickableCardsOf(host.state, targetId!)
        if (pickable.cardIds.length + pickable.hiddenCardSlots.length === 0) return
        host.askSkill({
          skillId: DANSHOU, ownerId, step: 'discard-pick', data: { targetId },
          build: (requestId): ChooseCardsRequest => ({
            id: requestId, kind: 'choose-cards', playerId: ownerId,
            prompt: `【胆守】：${target.nickname}弃置一张牌`,
            timeoutMs: 20_000, optional: false, purpose: 'skill',
            cardIds: pickable.cardIds, hiddenCardSlots: pickable.hiddenCardSlots,
            min: 1, max: 1,
          }),
        })
        return
      }
      if (x === 2) {
        const pickable = pickableCardsOf(host.state, targetId!)
        if (pickable.cardIds.length + pickable.hiddenCardSlots.length === 0) return
        host.askSkill({
          skillId: DANSHOU, ownerId, step: 'give-pick', data: { targetId },
          build: (requestId): ChooseCardsRequest => ({
            id: requestId, kind: 'choose-cards', playerId: ownerId,
            prompt: `【胆守】：${target.nickname}将一张手牌交给你`,
            timeoutMs: 20_000, optional: false, purpose: 'skill',
            cardIds: pickable.cardIds, hiddenCardSlots: pickable.hiddenCardSlots,
            min: 1, max: 1,
          }),
        })
        return
      }
      if (x === 3) {
        resolveDamage(host as never, { sourceId: ownerId, targetId: targetId!, amount: 1, nature: 'normal', cardName: null })
        return
      }
      // X >= 4：双方各摸两张
      drawCards(host.state, host.rng, ownerId, 2, (name, payload) => { host.dispatch(name, payload) })
      drawCards(host.state, host.rng, targetId!, 2, (name, payload) => { host.dispatch(name, payload) })
      return
    }

    if (resolution.step === 'discard-pick') {
      const targetId = resolution.data.targetId as PlayerId
      const target = playerOf(host.state, targetId)
      const picked = (response.payload as { cardIds?: string[] }).cardIds?.[0]
      if (!target?.alive || !picked) return
      const cardId = resolvePickedCard(host.state, targetId, picked)
      if (cardId) movePickedCard(host as never, targetId, cardId, { kind: 'discardPile' })
      return
    }

    if (resolution.step === 'give-pick') {
      const targetId = resolution.data.targetId as PlayerId
      const target = playerOf(host.state, targetId)
      const picked = (response.payload as { cardIds?: string[] }).cardIds?.[0]
      if (!owner?.alive || !target?.alive || !picked) return
      const cardId = resolvePickedCard(host.state, targetId, picked)
      if (cardId && movePickedCard(host as never, targetId, cardId, { kind: 'hand', playerId: ownerId })) {
        host.dispatch('GainCard', { playerId: ownerId, cardIds: [cardId], reason: DANSHOU }, { targetId: ownerId, cardIds: [cardId] })
      }
    }
  },
})

export const ZHURAN: CharacterDefinition = {
  id: 'zhuran',
  name: '朱然',
  kingdom: 'wu',
  gender: 'male',
  maxHp: 4,
  pack: 'yjcm2013',
  skills: [
    {
      id: DANSHOU,
      name: '胆守',
      description: '出牌阶段，你可以反复发动：弃置 X 张牌（X 为本出牌阶段内你已经发动过胆守的次数 + 1），选择攻击范围内一名角色：X=1，其弃置一张牌；X=2，其将一张手牌交给你；X=3，你对其造成 1 点伤害；X≥4，你和其各摸两张牌。',
    },
  ],
}
