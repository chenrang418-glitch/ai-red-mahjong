import { pickableCardsOf, resolvePickedCard } from '../../engine/card-pick'
import { drawCards } from '../../engine/draw'
import { killedInTurn } from '../../engine/turn-kills'
import { loseHp } from '../../engine/hp'
import { markUsedThisPhase, usedThisPhase } from '../../engine/phase-usage'
import { registerSkillRuntime } from '../../engine/skills/runtime'
import { moveCard } from '../../engine/zones'
import type { CardCategory, CardId, PlayerId, SanguoshaState } from '../../engine/types'
import type { ChooseCardsRequest, ChooseTargetsRequest } from '../../engine/requests'
import type { CharacterDefinition } from './types'

/**
 * 张松（一将成名 2014）。
 *
 * 【强识】：出牌阶段开始时，张松可以展示一名其他角色的一张手牌（暗置盲选，
 *          不看到对方完整手牌），本出牌阶段内每当他使用与这张牌类别相同的
 *          牌时，可以摸一张牌。
 * 【献图】：其他角色的出牌阶段开始时，张松可以摸两张牌，然后交给该角色两张
 *          牌；若完成，此出牌阶段结束时，若该角色本阶段没有杀死过任何角色，
 *          张松失去 1 点体力。
 *
 * 三处最容易做错的：
 *
 * 1. **强识按当前出牌阶段实例记类别**，走 `phase-usage.ts` 的账本，
 *    额外出牌阶段各自重新选、重新计。
 * 2. **强识按「使用」触发，不按「打出/响应」**；转化牌按有效类别判断。
 * 3. **献图统计的是「本阶段真的杀死过人」**，不是造成过伤害；张松已死亡时
 *    不再执行失去体力。
 */

const QIANGSHI = 'qiangshi'
const XIANTU = 'xiantu'
const CATEGORY_MARKS: Record<CardCategory, string> = {
  basic: 'qiangshi-cat-basic',
  trick: 'qiangshi-cat-trick',
  equipment: 'qiangshi-cat-equipment',
}

function playerOf(state: SanguoshaState, playerId: PlayerId) {
  return state.players.find((candidate) => candidate.id === playerId)
}

registerSkillRuntime({
  id: QIANGSHI,
  announcesSelf: true,

  triggers: [
    {
      event: 'PhaseStart',
      handle(host, ownerId, context) {
        const payload = context.event.payload as { playerId?: PlayerId; phase?: string }
        if (payload.phase !== 'play' || payload.playerId !== ownerId) return
        // 排队而不是当场问：同一次阶段开始可能有好几名角色的技能都想发问，
        // 当场 askSkill 会撞上别人已经挂起的那一个。
        host.queueSkill({ skillId: QIANGSHI, ownerId, step: 'target', data: {} })
      },
    },
    {
      event: 'AfterCardUse',
      handle(host, ownerId, context) {
        if (context.event.sourceId !== ownerId) return
        const payload = context.event.payload as { cardId?: CardId }
        const category = payload.cardId ? host.state.cards[payload.cardId]?.category : undefined
        if (!category || !usedThisPhase(host.state, ownerId, CATEGORY_MARKS[category])) return
        const owner = playerOf(host.state, ownerId)
        if (!owner?.alive) return
        drawCards(host.state, host.rng, ownerId, 1, (name, drawPayload) => { host.dispatch(name, drawPayload) })
      },
    },
  ],

  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'target') return
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    const candidateIds = host.state.players
      .filter((candidate) => candidate.alive && candidate.id !== ownerId && candidate.zones.hand.length > 0)
      .map((candidate) => candidate.id)
    if (candidateIds.length === 0) return
    host.askSkill({
      skillId: QIANGSHI, ownerId, step: 'target',
      build: (requestId): ChooseTargetsRequest => ({
        id: requestId, kind: 'choose-targets', playerId: ownerId,
        prompt: '【强识】：展示一名其他角色的一张手牌',
        timeoutMs: 20_000, optional: true,
        candidateIds, min: 1, max: 1,
      }),
    })
  },

  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'target') {
      const [targetId] = (response.payload as { targetIds?: PlayerId[] }).targetIds ?? []
      const target = targetId ? playerOf(host.state, targetId) : undefined
      if (!target?.alive || target.zones.hand.length === 0) return
      const pickable = pickableCardsOf(host.state, targetId!)
      host.askSkill({
        skillId: QIANGSHI, ownerId, step: 'pick', data: { targetId },
        build: (requestId): ChooseCardsRequest => ({
          id: requestId, kind: 'choose-cards', playerId: ownerId,
          prompt: '【强识】：盲选一张对方手牌展示',
          timeoutMs: 20_000, optional: false, purpose: 'skill',
          cardIds: [], hiddenCardSlots: pickable.hiddenCardSlots, min: 1, max: 1,
        }),
      })
      return
    }

    if (resolution.step === 'pick') {
      const targetId = resolution.data.targetId as PlayerId
      const target = playerOf(host.state, targetId)
      const owner = playerOf(host.state, ownerId)
      const [picked] = (response.payload as { cardIds?: string[] }).cardIds ?? []
      const cardId = picked ? resolvePickedCard(host.state, targetId, picked) : null
      if (!cardId || !target?.alive || !owner?.alive) return
      const category = host.state.cards[cardId]?.category
      if (!category) return
      markUsedThisPhase(host.state, ownerId, CATEGORY_MARKS[category])
      host.dispatch('SkillActivated', {
        skillId: QIANGSHI, skillName: '强识', playerId: ownerId, targetId, cardIds: [cardId],
        logText: `${owner.nickname}发动【强识】，展示了${target.nickname}的一张手牌`,
      }, { sourceId: ownerId, targetId, cardIds: [cardId] })
    }
  },
})

registerSkillRuntime({
  id: XIANTU,
  triggers: [
    {
      event: 'PhaseStart',
      handle(host, ownerId, context) {
        const payload = context.event.payload as { playerId?: PlayerId; phase?: string }
        if (payload.phase !== 'play' || !payload.playerId || payload.playerId === ownerId) return
        host.queueSkill({ skillId: XIANTU, ownerId, step: 'ask', data: { targetId: payload.playerId } })
      },
    },
    {
      event: 'PhaseEnd',
      handle(host, ownerId, context) {
        const payload = context.event.payload as { playerId?: PlayerId; phase?: string }
        if (payload.phase !== 'play' || !payload.playerId) return
        const targetId = payload.playerId
        if (!usedThisPhase(host.state, targetId, `xiantu-active:${ownerId}`)) return
        const owner = playerOf(host.state, ownerId)
        if (!owner?.alive) return
        if (killedInTurn(host.state, targetId, host.state.turnNumber)) return
        loseHp(host as never, ownerId, 1, XIANTU)
      },
    },
  ],

  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'ask') return
    const targetId = prompt.data.targetId as PlayerId
    const owner = playerOf(host.state, ownerId)
    const target = playerOf(host.state, targetId)
    if (!owner?.alive || !target?.alive) return
    host.askSkill({
      skillId: XIANTU, ownerId, step: 'ask', data: { targetId },
      build: (requestId) => ({
        id: requestId, kind: 'choose-option' as const, playerId: ownerId,
        prompt: `【献图】：摸两张牌，然后交给${target.nickname}两张牌？`,
        timeoutMs: 20_000, optional: true,
        options: [{ id: 'yes', label: '发动【献图】' }, { id: 'no', label: '不发动' }],
      }),
    })
  },

  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'ask') {
      if ((response.payload as { optionId?: string }).optionId !== 'yes') return
      const targetId = resolution.data.targetId as PlayerId
      const owner = playerOf(host.state, ownerId)
      if (!owner?.alive || !playerOf(host.state, targetId)?.alive) return
      host.dispatch('SkillActivated', {
        skillId: XIANTU, skillName: '献图', playerId: ownerId, targetId,
        logText: `${owner.nickname}发动【献图】，摸两张牌`,
      }, { sourceId: ownerId, targetId })
      drawCards(host.state, host.rng, ownerId, 2, (name, payload) => { host.dispatch(name, payload) })
      const current = playerOf(host.state, ownerId)
      if (!current?.alive || current.zones.hand.length < 2) return
      host.askSkill({
        skillId: XIANTU, ownerId, step: 'give', data: { targetId },
        build: (requestId): ChooseCardsRequest => ({
          id: requestId, kind: 'choose-cards', playerId: ownerId,
          prompt: '【献图】：交给对方两张牌',
          timeoutMs: 20_000, optional: false, purpose: 'skill',
          cardIds: [...current.zones.hand], hiddenCardSlots: [], min: 2, max: 2,
        }),
      })
      return
    }

    if (resolution.step === 'give') {
      const targetId = resolution.data.targetId as PlayerId
      const owner = playerOf(host.state, ownerId)
      const target = playerOf(host.state, targetId)
      const cardIds = [...new Set((response.payload as { cardIds?: CardId[] }).cardIds ?? [])]
        .filter((cardId) => owner?.zones.hand.includes(cardId))
      if (!owner?.alive || !target?.alive || cardIds.length !== 2) return
      for (const cardId of cardIds) moveCard(host.state, cardId, { kind: 'hand', playerId: ownerId }, { kind: 'hand', playerId: targetId })
      host.dispatch('GainCard', { playerId: targetId, cardIds, reason: XIANTU }, { sourceId: ownerId, targetId, cardIds })
      // 记「张松对这名角色的这个出牌阶段发动过献图」，阶段结束时据此判定要不要失血
      markUsedThisPhase(host.state, targetId, `xiantu-active:${ownerId}`)
    }
  },
})

export const ZHANGSONG: CharacterDefinition = {
  id: 'zhangsong',
  name: '张松',
  kingdom: 'shu',
  gender: 'male',
  maxHp: 3,
  pack: 'yjcm2014',
  skills: [
    {
      id: QIANGSHI,
      name: '强识',
      description: '出牌阶段开始时，张松可以展示一名其他角色的一张手牌，本出牌阶段内每当他使用与这张牌类别相同的牌时，可以摸一张牌。',
    },
    {
      id: XIANTU,
      name: '献图',
      description: '其他角色的出牌阶段开始时，张松可以摸两张牌，然后交给该角色两张牌；若完成，此出牌阶段结束时，若该角色本阶段没有杀死过任何角色，张松失去 1 点体力。',
    },
  ],
}
