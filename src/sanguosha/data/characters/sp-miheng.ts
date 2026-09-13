import { moveCard } from '../../engine/zones'
import { drawCards } from '../../engine/draw'
import { resolveDamage } from '../../engine/damage'
import { registerSkillRuntime } from '../../engine/skills/runtime'
import type { ChooseCardsRequest, ChooseOptionRequest } from '../../engine/requests'
import type { CardId, PlayerId, SanguoshaState } from '../../engine/types'
import type { CharacterDefinition } from './types'

/**
 * 祢衡（三国杀 OL 经典身份 SP）。
 *
 * 【狂才】：锁定技，祢衡自己回合内使用牌无距离限制、不计入使用次数限制；
 *          弃牌阶段开始时，若本回合没有使用过牌，手牌上限+1；使用过牌但
 *          没有造成过伤害，手牌上限-1；结束阶段，若本回合造成过伤害，
 *          摸X张牌，X为本回合造成的伤害点数总和（最多5）。
 * 【舌剑】：每个 TurnInstance 最多发动2次，祢衡成为其他角色使用牌的唯一
 *          目标后，可以弃置至少2张手牌（N=实际弃置数），然后选择：令
 *          使用者弃置N张牌，或对使用者造成1点伤害。
 */

const KUANGCAI = 'kuangcai'
const SHEJIAN = 'shejian'

function playerOf(state: SanguoshaState, playerId: PlayerId) {
  return state.players.find((candidate) => candidate.id === playerId)
}

/** 舌剑"每个 TurnInstance 最多2次"必须按回合归零，不能用永久 marks 记账。 */
function shejianUsed(state: SanguoshaState, ownerId: PlayerId): number {
  const entry = state.mihengShejianUsed?.[ownerId]
  return entry?.turnNumber === state.turnNumber ? entry.count : 0
}

registerSkillRuntime({
  id: KUANGCAI,
  unlimitedSlash: true,
  ignoresDistanceTo(state, ownerId) {
    return state.currentPlayerId === ownerId
  },
  triggers: [
    {
      event: 'CardUsed',
      handle(host, ownerId, context) {
        if (context.event.sourceId !== ownerId || host.state.currentPlayerId !== ownerId) return
        host.state.mihengUsedCardTurn = host.state.turnNumber
      },
    },
    {
      event: 'Damaged',
      handle(host, ownerId, context) {
        if (context.event.sourceId !== ownerId) return
        const payload = context.event.payload as { amount?: number }
        const amount = payload.amount ?? 0
        host.state.mihengDamageTurn ??= {}
        const entry = host.state.mihengDamageTurn[ownerId]
        const total = entry?.turnNumber === host.state.turnNumber ? entry.total + amount : amount
        host.state.mihengDamageTurn[ownerId] = { turnNumber: host.state.turnNumber, total }
      },
    },
    {
      event: 'PhaseStart',
      handle(host, ownerId, context) {
        const payload = context.event.payload as { playerId?: PlayerId; phase?: string }
        if (payload.playerId !== ownerId) return
        const owner = playerOf(host.state, ownerId)
        if (!owner?.alive) return
        if (payload.phase === 'discard') {
          const usedCard = host.state.mihengUsedCardTurn === host.state.turnNumber
          const damage = host.state.mihengDamageTurn?.[ownerId]
          const dealtDamage = damage?.turnNumber === host.state.turnNumber && damage.total > 0
          if (!usedCard) host.state.mihengMaxCardsDelta = { turnNumber: host.state.turnNumber, delta: 1 }
          else if (!dealtDamage) host.state.mihengMaxCardsDelta = { turnNumber: host.state.turnNumber, delta: -1 }
          else host.state.mihengMaxCardsDelta = undefined
        }
        if (payload.phase === 'end') {
          const damage = host.state.mihengDamageTurn?.[ownerId]
          if (damage?.turnNumber !== host.state.turnNumber || damage.total <= 0) return
          const drawCount = Math.min(5, damage.total)
          host.dispatch('SkillActivated', { skillId: KUANGCAI, skillName: '狂才', playerId: ownerId, logText: `${owner.nickname}发动【狂才】，摸${drawCount}张牌` }, { sourceId: ownerId })
          drawCards(host.state, host.rng, ownerId, drawCount, (name, drawPayload) => { host.dispatch(name, drawPayload) })
        }
      },
    },
  ],
  maxCardsBonus(state, _ownerId) {
    const entry = state.mihengMaxCardsDelta
    return entry?.turnNumber === state.turnNumber ? entry.delta : 0
  },
})

registerSkillRuntime({
  id: SHEJIAN,
  triggers: [{
    event: 'AfterCardUse',
    handle(host, ownerId, context) {
      const payload = context.event.payload as { targetIds?: PlayerId[]; cancelled?: boolean }
      const sourceId = context.event.sourceId
      if (!sourceId || sourceId === ownerId || payload.cancelled) return
      const targetIds = payload.targetIds ?? []
      if (targetIds.length !== 1 || targetIds[0] !== ownerId) return
      const owner = playerOf(host.state, ownerId)
      if (!owner?.alive || owner.zones.hand.length < 2) return
      const used = shejianUsed(host.state, ownerId)
      if (used >= 2) return
      host.queueSkill({ skillId: SHEJIAN, ownerId, step: 'ask', data: { sourceId } })
    },
  }],

  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'ask') return
    const owner = playerOf(host.state, ownerId)
    const { sourceId } = prompt.data as { sourceId: PlayerId }
    if (!owner?.alive || owner.zones.hand.length < 2 || shejianUsed(host.state, ownerId) >= 2) return
    host.askSkill({
      skillId: SHEJIAN, ownerId, step: 'discard', data: { sourceId },
      build: (requestId): ChooseCardsRequest => ({
        id: requestId, kind: 'choose-cards', playerId: ownerId,
        prompt: '【舌剑】：弃置至少2张手牌', timeoutMs: 20_000, optional: true,
        purpose: 'skill', cardIds: [...owner.zones.hand], hiddenCardSlots: [], min: 0, max: owner.zones.hand.length,
      }),
    })
  },

  resume(host, ownerId, resolution, response) {
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return

    if (resolution.step === 'discard') {
      const { sourceId } = resolution.data as { sourceId: PlayerId }
      const cardIds = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
      const valid = cardIds.filter((id) => owner.zones.hand.includes(id))
      if (valid.length < 2) return
      host.state.mihengShejianUsed = { ...host.state.mihengShejianUsed, [ownerId]: { turnNumber: host.state.turnNumber, count: shejianUsed(host.state, ownerId) + 1 } }
      for (const cardId of valid) moveCard(host.state, cardId, { kind: 'hand', playerId: ownerId }, { kind: 'discardPile' })
      host.dispatch('LoseCard', { playerId: ownerId, cardIds: valid, reason: SHEJIAN }, { sourceId: ownerId, cardIds: valid })
      host.dispatch('SkillActivated', { skillId: SHEJIAN, skillName: '舌剑', playerId: ownerId, targetId: sourceId, logText: `${owner.nickname}发动【舌剑】` }, { sourceId: ownerId, targetId: sourceId })
      const source = playerOf(host.state, sourceId)
      if (!source?.alive) return
      host.askSkill({
        skillId: SHEJIAN, ownerId, step: 'choose', data: { sourceId, n: valid.length },
        build: (requestId): ChooseOptionRequest => ({
          id: requestId, kind: 'choose-option', playerId: ownerId,
          prompt: '【舌剑】：请选择', timeoutMs: 20_000, optional: false,
          options: [{ id: 'discard', label: `令${source.nickname}弃置${valid.length}张牌` }, { id: 'damage', label: `对${source.nickname}造成1点伤害` }],
        }),
      })
      return
    }

    if (resolution.step === 'choose') {
      const { sourceId, n } = resolution.data as { sourceId: PlayerId; n: number }
      const source = playerOf(host.state, sourceId)
      if (!source?.alive) return
      const optionId = (response.payload as { optionId?: string }).optionId
      if (optionId === 'damage') {
        resolveDamage(host as never, { sourceId: ownerId, targetId: sourceId, amount: 1, nature: 'normal', cardName: null })
        return
      }
      const discardCount = Math.min(n, source.zones.hand.length)
      if (discardCount <= 0) return
      host.askSkill({
        skillId: SHEJIAN, ownerId, step: 'target-discard', data: {},
        build: (requestId): ChooseCardsRequest => ({
          id: requestId, kind: 'choose-cards', playerId: sourceId,
          prompt: `【舌剑】：弃置${discardCount}张牌`, timeoutMs: 20_000, optional: false,
          purpose: 'skill', cardIds: [...source.zones.hand], hiddenCardSlots: [], min: discardCount, max: discardCount,
        }),
      })
      return
    }

    if (resolution.step === 'target-discard') {
      const cardIds = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
      const responderId = response.playerId
      const responder = playerOf(host.state, responderId)
      const valid = cardIds.filter((id) => responder?.zones.hand.includes(id))
      if (!responder?.alive || valid.length === 0) return
      for (const cardId of valid) moveCard(host.state, cardId, { kind: 'hand', playerId: responderId }, { kind: 'discardPile' })
      host.dispatch('LoseCard', { playerId: responderId, cardIds: valid, reason: SHEJIAN }, { sourceId: responderId, cardIds: valid })
    }
  },
})

export const MIHENG: CharacterDefinition = {
  id: 'miheng',
  name: '祢衡',
  kingdom: 'qun',
  gender: 'male',
  maxHp: 3,
  pack: 'sp',
  skills: [
    { id: KUANGCAI, name: '狂才', description: '锁定技，祢衡自己回合内使用牌无距离限制、不计入次数限制；弃牌阶段开始时，若本回合没用过牌，手牌上限+1，用过牌但没造成过伤害则-1；结束阶段，若本回合造成过伤害，摸牌数等于本回合伤害点数总和（最多5）。' },
    { id: SHEJIAN, name: '舌剑', description: '每个 TurnInstance 最多2次，祢衡成为其他角色使用牌的唯一目标后，可以弃置至少2张手牌，然后令使用者弃置等量的牌，或对使用者造成1点伤害。' },
  ],
}
