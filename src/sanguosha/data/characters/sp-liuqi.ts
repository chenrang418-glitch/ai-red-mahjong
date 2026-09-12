import { drawCards } from '../../engine/draw'
import { livingKingdomCount } from '../../engine/living-kingdoms'
import { registerSkillRuntime } from '../../engine/skills/runtime'
import { moveCard } from '../../engine/zones'
import type { ChooseCardsRequest, ChooseOptionRequest, ChooseTargetsRequest } from '../../engine/requests'
import type { CardId, PlayerId, SanguoshaState } from '../../engine/types'
import type { CharacterDefinition } from './types'

/**
 * 刘琦（三国杀 OL 经典身份 SP）。
 *
 * 【问计】：出牌阶段开始时，刘琦可以选择一名其他角色A，令A交给自己1张牌
 *          （由A决定给哪张）；本回合内，刘琦使用与这张牌同名的牌不能被
 *          响应。响应封锁通过既有的 `slashUndodgeable`（杀不可闪）和
 *          `trickUnresponsive`（锦囊目标不可响应）实现，覆盖目标方响应；
 *          引擎没有面向旁观者无懈可击的通用封锁钩子，这部分不在范围内。
 * 【屯江】：结束阶段，若刘琦本回合没有跳过出牌阶段、且出牌阶段内没有使用
 *          牌指定过其他角色为目标，可以摸牌，数量为当前存活势力数。
 */

const WENJI = 'wenji'
const TUNJIANG = 'tunjiang'

function playerOf(state: SanguoshaState, playerId: PlayerId) {
  return state.players.find((candidate) => candidate.id === playerId)
}

registerSkillRuntime({
  id: WENJI,
  triggers: [{
    event: 'PhaseStart',
    handle(host, ownerId, context) {
      const payload = context.event.payload as { playerId?: PlayerId; phase?: string }
      if (payload.phase !== 'play' || payload.playerId !== ownerId) return
      const owner = playerOf(host.state, ownerId)
      if (!owner?.alive) return
      const candidateIds = host.state.players.filter((candidate) => candidate.alive && candidate.id !== ownerId).map((candidate) => candidate.id)
      if (candidateIds.length === 0) return
      host.queueSkill({ skillId: WENJI, ownerId, step: 'target', data: { candidateIds } })
    },
  }],

  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'target') return
    if (!playerOf(host.state, ownerId)?.alive) return
    const { candidateIds } = prompt.data as { candidateIds: PlayerId[] }
    host.askSkill({
      skillId: WENJI, ownerId, step: 'target',
      build: (requestId): ChooseTargetsRequest => ({
        id: requestId, kind: 'choose-targets', playerId: ownerId,
        prompt: '【问计】：选择一名其他角色', timeoutMs: 20_000, optional: true, candidateIds, min: 0, max: 1,
      }),
    })
  },

  resume(host, ownerId, resolution, response) {
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return

    if (resolution.step === 'target') {
      const [targetId] = (response.payload as { targetIds?: PlayerId[] }).targetIds ?? []
      const target = targetId ? playerOf(host.state, targetId) : undefined
      if (!target?.alive || target.zones.hand.length === 0) return
      host.askSkill({
        skillId: WENJI, ownerId, step: 'give', data: { targetId },
        build: (requestId): ChooseCardsRequest => ({
          id: requestId, kind: 'choose-cards', playerId: targetId,
          prompt: `【问计】：交给${owner.nickname}1张牌`, timeoutMs: 20_000, optional: false,
          purpose: 'skill', cardIds: [...target.zones.hand], hiddenCardSlots: [], min: 1, max: 1,
        }),
      })
      return
    }

    if (resolution.step === 'give') {
      const { targetId } = resolution.data as { targetId: PlayerId }
      const target = playerOf(host.state, targetId)
      const [cardId] = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
      if (!target?.alive || !cardId || !target.zones.hand.includes(cardId)) return
      const cardName = host.state.cards[cardId]?.name
      moveCard(host.state, cardId, { kind: 'hand', playerId: targetId }, { kind: 'hand', playerId: ownerId })
      host.dispatch('LoseCard', { playerId: targetId, cardIds: [cardId], reason: WENJI }, { sourceId: targetId, cardIds: [cardId] })
      host.dispatch('GainCard', { playerId: ownerId, cardIds: [cardId], reason: WENJI }, { targetId: ownerId, cardIds: [cardId] })
      host.dispatch('SkillActivated', { skillId: WENJI, skillName: '问计', playerId: ownerId, targetId, logText: `${owner.nickname}发动【问计】` }, { sourceId: ownerId, targetId })
      if (cardName) {
        host.state.liuqiWenjiLock ??= {}
        host.state.liuqiWenjiLock[ownerId] = { cardName, turnNumber: host.state.turnNumber }
      }
    }
  },

  slashUndodgeable(state, ownerId, _targetId) {
    return isLockedSlash(state, ownerId)
  },
  trickUnresponsive(state, ownerId, _targetId, cardName) {
    const lock = state.liuqiWenjiLock?.[ownerId]
    return !!lock && lock.turnNumber === state.turnNumber && lock.cardName === cardName
  },
})

function isLockedSlash(state: SanguoshaState, ownerId: PlayerId): boolean {
  const lock = state.liuqiWenjiLock?.[ownerId]
  return !!lock && lock.turnNumber === state.turnNumber && lock.cardName === '杀'
}

registerSkillRuntime({
  id: TUNJIANG,
  triggers: [
    {
      event: 'PhaseStart',
      handle(host, ownerId, context) {
        const payload = context.event.payload as { playerId?: PlayerId; phase?: string }
        if (payload.phase === 'play' && payload.playerId === ownerId) {
          host.state.liuqiPlayPhaseTurn = host.state.turnNumber
          host.state.liuqiTargetedOthers = host.state.liuqiTargetedOthers ?? {}
          delete host.state.liuqiTargetedOthers[ownerId]
        }
        if (payload.phase !== 'end' || payload.playerId !== ownerId) return
        const owner = playerOf(host.state, ownerId)
        if (!owner?.alive) return
        if (host.state.liuqiPlayPhaseTurn !== host.state.turnNumber) return
        if (host.state.liuqiTargetedOthers?.[ownerId]) return
        host.queueSkill({ skillId: TUNJIANG, ownerId, step: 'ask', data: {} })
      },
    },
    {
      event: 'TargetConfirmed',
      handle(host, ownerId, context) {
        if (context.event.sourceId !== ownerId || !context.event.targetId || context.event.targetId === ownerId) return
        if (host.state.phase !== 'play' || host.state.currentPlayerId !== ownerId) return
        host.state.liuqiTargetedOthers ??= {}
        host.state.liuqiTargetedOthers[ownerId] = true
      },
    },
  ],

  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'ask') return
    if (!playerOf(host.state, ownerId)?.alive) return
    host.askSkill({
      skillId: TUNJIANG, ownerId, step: 'ask',
      build: (requestId): ChooseOptionRequest => ({
        id: requestId, kind: 'choose-option', playerId: ownerId,
        prompt: '【屯江】：是否摸牌？', timeoutMs: 20_000, optional: true,
        options: [{ id: 'yes', label: '发动' }, { id: 'no', label: '不发动' }],
      }),
    })
  },

  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'ask') return
    if ((response.payload as { optionId?: string }).optionId !== 'yes') return
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    const count = livingKingdomCount(host.state)
    host.dispatch('SkillActivated', { skillId: TUNJIANG, skillName: '屯江', playerId: ownerId, logText: `${owner.nickname}发动【屯江】，摸${count}张牌` }, { sourceId: ownerId })
    drawCards(host.state, host.rng, ownerId, count, (name, payload) => { host.dispatch(name, payload) })
  },
})

export const LIUQI: CharacterDefinition = {
  id: 'liuqi',
  name: '刘琦',
  kingdom: 'qun',
  gender: 'male',
  maxHp: 3,
  pack: 'sp',
  skills: [
    { id: WENJI, name: '问计', description: '出牌阶段开始时，刘琦可以选择一名其他角色，令其交给自己1张牌；本回合内，刘琦使用与这张牌同名的牌不能被响应。' },
    { id: TUNJIANG, name: '屯江', description: '结束阶段，若刘琦本回合没有跳过出牌阶段、且出牌阶段内没有使用牌指定过其他角色为目标，可以摸牌，数量为当前存活势力数。' },
  ],
}
