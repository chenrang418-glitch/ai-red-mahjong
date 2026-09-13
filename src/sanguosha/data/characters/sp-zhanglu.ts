import { moveCard } from '../../engine/zones'
import { drawCards } from '../../engine/draw'
import { recover } from '../../engine/recover'
import { registerSkillRuntime } from '../../engine/skills/runtime'
import type { SkillHost } from '../../engine/skills/runtime'
import type { ChooseCardsRequest, ChooseOptionRequest } from '../../engine/requests'
import type { CardId, PlayerId, SanguoshaState } from '../../engine/types'
import type { CharacterDefinition } from './types'

/**
 * 张鲁（三国杀 OL 经典身份 SP）。
 *
 * 【义舍】：结束阶段，若张鲁没有【米】，可以摸2张牌，然后选2张牌置于
 *          专属牌堆（`characterPiles`）成为米。米清空时（不论一次清走
 *          几张都只算一次）回复1点体力。
 * 【布施】：张鲁受到伤害后，或张鲁对其他角色造成伤害后，按伤害点数各给
 *          1次机会获得1张米——简化为一次性选择获得数量（0~min(伤害点数,
 *          米数量)），不逐点单独发问。
 * 【米道】：一张判定牌即将生效前，张鲁可以用1张米替换（复用既有判定
 *          改判 `retrial` 核心）。
 */

const YISHE = 'yishe'
const BUSHI = 'bushi'
const MIDAO = 'midao'
const MI_PILE = 'mi'

function playerOf(state: SanguoshaState, playerId: PlayerId) {
  return state.players.find((candidate) => candidate.id === playerId)
}

function riceOf(state: SanguoshaState, ownerId: PlayerId): CardId[] {
  return playerOf(state, ownerId)?.characterPiles[MI_PILE] ?? []
}

function checkRiceEmptied(host: SkillHost, ownerId: PlayerId, wasNonEmpty: boolean): void {
  if (!wasNonEmpty || riceOf(host.state, ownerId).length > 0) return
  const owner = playerOf(host.state, ownerId)
  if (!owner?.alive) return
  recover(host as never, ownerId, 1, ownerId)
}

registerSkillRuntime({
  id: YISHE,
  triggers: [{
    event: 'PhaseStart',
    handle(host, ownerId, context) {
      const payload = context.event.payload as { playerId?: PlayerId; phase?: string }
      if (payload.phase !== 'end' || payload.playerId !== ownerId) return
      const owner = playerOf(host.state, ownerId)
      if (!owner?.alive || riceOf(host.state, ownerId).length > 0) return
      host.queueSkill({ skillId: YISHE, ownerId, step: 'ask', data: {} })
    },
  }],

  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'ask') return
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    host.askSkill({
      skillId: YISHE, ownerId, step: 'ask',
      build: (requestId): ChooseOptionRequest => ({
        id: requestId, kind: 'choose-option', playerId: ownerId,
        prompt: '【义舍】：是否发动？（摸2张后置2张为米）', timeoutMs: 20_000, optional: true,
        options: [{ id: 'yes', label: '发动' }, { id: 'no', label: '不发动' }],
      }),
    })
  },

  resume(host, ownerId, resolution, response) {
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    if (resolution.step === 'ask') {
      if ((response.payload as { optionId?: string }).optionId !== 'yes') return
      host.dispatch('SkillActivated', { skillId: YISHE, skillName: '义舍', playerId: ownerId, logText: `${owner.nickname}发动【义舍】` }, { sourceId: ownerId })
      drawCards(host.state, host.rng, ownerId, 2, (name, payload) => { host.dispatch(name, payload) })
      const current = playerOf(host.state, ownerId)
      if (!current?.alive || current.zones.hand.length === 0) return
      host.askSkill({
        skillId: YISHE, ownerId, step: 'place',
        build: (requestId): ChooseCardsRequest => ({
          id: requestId, kind: 'choose-cards', playerId: ownerId,
          prompt: '【义舍】：选择2张牌置为米', timeoutMs: 20_000, optional: false,
          purpose: 'skill', cardIds: [...current.zones.hand], hiddenCardSlots: [], min: Math.min(2, current.zones.hand.length), max: Math.min(2, current.zones.hand.length),
        }),
      })
      return
    }
    if (resolution.step === 'place') {
      const cardIds = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
      const valid = cardIds.filter((id) => owner.zones.hand.includes(id))
      if (valid.length === 0) return
      for (const cardId of valid) moveCard(host.state, cardId, { kind: 'hand', playerId: ownerId }, { kind: 'characterPile', playerId: ownerId, pile: MI_PILE })
      host.dispatch('LoseCard', { playerId: ownerId, cardIds: valid, reason: YISHE }, { sourceId: ownerId, cardIds: valid })
    }
  },
})

registerSkillRuntime({
  id: BUSHI,
  triggers: [{
    event: 'Damaged',
    handle(host, ownerId, context) {
      const targetId = context.event.targetId
      const sourceId = context.event.sourceId
      if (!targetId) return
      let recipientId: PlayerId | null = null
      if (targetId === ownerId) recipientId = ownerId
      else if (sourceId === ownerId && targetId !== ownerId) recipientId = targetId
      if (!recipientId) return
      const recipient = playerOf(host.state, recipientId)
      const rice = riceOf(host.state, ownerId)
      if (!recipient?.alive || rice.length === 0) return
      const payload = context.event.payload as { amount?: number }
      const amount = payload.amount ?? 1
      const max = Math.min(amount, rice.length)
      if (max <= 0) return
      host.queueSkill({ skillId: BUSHI, ownerId, step: 'ask', data: { recipientId, max } })
    },
  }],

  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'ask') return
    const { recipientId, max } = prompt.data as { recipientId: PlayerId; max: number }
    const recipient = playerOf(host.state, recipientId)
    if (!recipient?.alive) return
    const actualMax = Math.min(max, riceOf(host.state, ownerId).length)
    if (actualMax <= 0) return
    host.askSkill({
      skillId: BUSHI, ownerId, step: 'count', data: { recipientId },
      build: (requestId): ChooseOptionRequest => ({
        id: requestId, kind: 'choose-option', playerId: recipientId,
        prompt: '【布施】：获得几张米？', timeoutMs: 20_000, optional: true,
        options: [{ id: '0', label: '不获得' }, ...Array.from({ length: actualMax }, (_, index) => ({ id: String(index + 1), label: `获得${index + 1}张` }))],
      }),
    })
  },

  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'count') return
    const { recipientId } = resolution.data as { recipientId: PlayerId }
    const recipient = playerOf(host.state, recipientId)
    const owner = playerOf(host.state, ownerId)
    if (!recipient?.alive || !owner?.alive) return
    const count = Number((response.payload as { optionId?: string }).optionId ?? '0')
    if (count <= 0) return
    const rice = riceOf(host.state, ownerId)
    const wasNonEmpty = rice.length > 0
    const taken = rice.slice(0, Math.min(count, rice.length))
    for (const cardId of taken) moveCard(host.state, cardId, { kind: 'characterPile', playerId: ownerId, pile: MI_PILE }, { kind: 'hand', playerId: recipientId })
    if (taken.length > 0) {
      host.dispatch('SkillActivated', { skillId: BUSHI, skillName: '布施', playerId: ownerId, targetId: recipientId, logText: `${owner.nickname}发动【布施】` }, { sourceId: ownerId, targetId: recipientId })
      host.dispatch('GainCard', { playerId: recipientId, cardIds: taken, reason: BUSHI }, { targetId: recipientId, cardIds: taken })
      checkRiceEmptied(host, ownerId, wasNonEmpty)
    }
  },
})

registerSkillRuntime({
  id: MIDAO,
  retrial(state, ownerId) {
    return [...riceOf(state, ownerId)]
  },
  triggers: [{
    event: 'CardResponded',
    handle(host, ownerId, context) {
      const payload = context.event.payload as { reason?: string; cardId?: CardId }
      if (payload.reason !== '改判' || context.event.sourceId !== ownerId) return
      checkRiceEmptied(host, ownerId, true)
    },
  }],
})

export const ZHANGLU: CharacterDefinition = {
  id: 'zhanglu',
  name: '张鲁',
  kingdom: 'qun',
  gender: 'male',
  maxHp: 4,
  pack: 'sp',
  skills: [
    { id: YISHE, name: '义舍', description: '结束阶段，若张鲁没有米，可以摸2张牌，然后选2张牌置于武将牌上成为米；米清空时回复1点体力。' },
    { id: BUSHI, name: '布施', description: '张鲁受到伤害后，或对其他角色造成伤害后，受伤/造成伤害的一方可以获得最多等同伤害点数的米（不超过当前米的数量）。' },
    { id: MIDAO, name: '米道', description: '一张判定牌即将生效前，张鲁可以用1张米替换。' },
  ],
}
