import { moveCard } from '../../engine/zones'
import { drawCards } from '../../engine/draw'
import { getAttackRange } from '../../engine/distance'
import { effectiveCardSuit } from '../../engine/skills/runtime'
import { skillIdsOf } from '../../data/characters/standard'
import { registerSkillRuntime } from '../../engine/skills/runtime'
import type { ChooseCardsRequest } from '../../engine/requests'
import type { CardId, PlayerId, SanguoshaState } from '../../engine/types'
import type { CharacterDefinition } from './types'

/**
 * 潘濬（三国杀 OL 经典身份 SP）。
 *
 * 【观微】：每个回合限一次，一名角色出牌阶段结束时，若其本阶段至今使用
 *          过至少2张花色全部相同的牌，潘濬可以弃置1张牌，令其摸2张牌并
 *          获得一个额外的出牌阶段——直接复用既有的额外阶段机制
 *          （`extra-phase.ts`），只是在阶段结束而非回合开始时插入，
 *          借同一套 `state.extraPhase` 字段实现。
 * 【公清】：锁定技，潘濬受到伤害时，检查伤害来源当前攻击范围：<3 时这次
 *          伤害改为1点，>3 时+1点，==3 不修改，无来源不处理。
 */

const GUANWEI = 'guanwei'
const GONGQING = 'gongqing'

function playerOf(state: SanguoshaState, playerId: PlayerId) {
  return state.players.find((candidate) => candidate.id === playerId)
}

registerSkillRuntime({
  id: GUANWEI,
  triggers: [
    {
      event: 'PhaseStart',
      handle(host, _ownerId, context) {
        const payload = context.event.payload as { playerId?: PlayerId; phase?: string }
        if (payload.phase !== 'play' || !payload.playerId) return
        host.state.panjunSuitLog ??= {}
        host.state.panjunSuitLog[payload.playerId] = { turnNumber: host.state.turnNumber, suits: [] }
      },
    },
    {
      event: 'CardUsed',
      handle(host, _ownerId, context) {
        const sourceId = context.event.sourceId
        if (!sourceId) return
        const log = host.state.panjunSuitLog?.[sourceId]
        if (!log || log.turnNumber !== host.state.turnNumber) return
        const payload = context.event.payload as { cardId?: CardId }
        const suit = payload.cardId ? effectiveCardSuit(host.state, sourceId, payload.cardId, skillIdsOf) : null
        log.suits.push(suit ?? null)
      },
    },
    {
      event: 'PhaseEnd',
      handle(host, ownerId, context) {
        const payload = context.event.payload as { playerId?: PlayerId; phase?: string }
        const actorId = payload.playerId
        if (payload.phase !== 'play' || !actorId) return
        const owner = playerOf(host.state, ownerId)
        if (!owner?.alive || owner.zones.hand.length === 0 || owner.turnUsedSkills.includes(GUANWEI)) return
        const log = host.state.panjunSuitLog?.[actorId]
        if (!log || log.turnNumber !== host.state.turnNumber || log.suits.length < 2) return
        if (!log.suits.every((suit) => suit !== null && suit === log.suits[0])) return
        host.queueSkill({ skillId: GUANWEI, ownerId, step: 'ask', data: { actorId } })
      },
    },
  ],

  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'ask') return
    const owner = playerOf(host.state, ownerId)
    const { actorId } = prompt.data as { actorId: PlayerId }
    if (!owner?.alive || owner.zones.hand.length === 0 || owner.turnUsedSkills.includes(GUANWEI) || !playerOf(host.state, actorId)?.alive) return
    host.askSkill({
      skillId: GUANWEI, ownerId, step: 'discard', data: { actorId },
      build: (requestId): ChooseCardsRequest => ({
        id: requestId, kind: 'choose-cards', playerId: ownerId,
        prompt: '【观微】：可以弃置一张牌，令其摸2张牌并获得额外出牌阶段', timeoutMs: 20_000, optional: true,
        purpose: 'skill', cardIds: [...owner.zones.hand], hiddenCardSlots: [], min: 0, max: 1,
      }),
    })
  },

  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'discard') return
    const { actorId } = resolution.data as { actorId: PlayerId }
    const owner = playerOf(host.state, ownerId)
    const actor = playerOf(host.state, actorId)
    const [cardId] = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
    if (!owner?.alive || owner.turnUsedSkills.includes(GUANWEI) || !cardId || !owner.zones.hand.includes(cardId) || !actor?.alive) return
    owner.turnUsedSkills.push(GUANWEI)
    moveCard(host.state, cardId, { kind: 'hand', playerId: ownerId }, { kind: 'discardPile' })
    host.dispatch('LoseCard', { playerId: ownerId, cardIds: [cardId], reason: GUANWEI }, { sourceId: ownerId, cardIds: [cardId] })
    drawCards(host.state, host.rng, actorId, 2, (name, payload) => { host.dispatch(name, payload) })
    host.dispatch('SkillActivated', { skillId: GUANWEI, skillName: '观微', playerId: ownerId, targetId: actorId, logText: `${owner.nickname}发动【观微】，${actor.nickname}获得额外出牌阶段` }, { sourceId: ownerId, targetId: actorId })
    // 复用既有额外阶段字段：不是回合开始时插入，而是这一次阶段推进时被 advancePhase 读到
    host.state.extraPhase = {
      phase: 'play', resumeSlot: 'discard', playerId: actorId,
      skillId: GUANWEI, instanceId: host.state.seq, preSkipped: host.state.skippedPhases.includes('play'),
    }
  },
})

registerSkillRuntime({
  id: GONGQING,
  incomingDamage(state, _ownerId, context) {
    if (!context.sourceId) return null
    const range = getAttackRange(state, context.sourceId)
    if (range < 3) return { amount: 1 }
    if (range > 3) return { amount: context.amount + 1 }
    return null
  },
})

export const PANJUN: CharacterDefinition = {
  id: 'panjun',
  name: '潘濬',
  kingdom: 'wu',
  gender: 'male',
  maxHp: 3,
  pack: 'sp',
  skills: [
    { id: GUANWEI, name: '观微', description: '每回合限一次，一名角色出牌阶段结束时，若其本阶段使用过至少2张花色全部相同的牌，可以弃置1张牌，令其摸2张牌并获得一个额外的出牌阶段。' },
    { id: GONGQING, name: '公清', description: '锁定技，潘濬受到伤害时，检查来源当前攻击范围：小于3改为1点，大于3则+1点，等于3不变。' },
  ],
}
