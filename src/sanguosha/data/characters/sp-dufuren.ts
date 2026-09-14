import { moveCard } from '../../engine/zones'
import { recover } from '../../engine/recover'
import { gainEntryOf } from '../../engine/card-gain-provenance'
import { registerSkillRuntime } from '../../engine/skills/runtime'
import type { ChooseTargetsRequest } from '../../engine/requests'
import type { CardId, PlayerId, SanguoshaState } from '../../engine/types'
import type { CharacterDefinition } from './types'

/**
 * 杜夫人（三国杀 OL 经典身份 SP）。
 *
 * 【异色】：其他角色获得你的牌后，若其中至少1张红色，你可以令其回复1点
 *          体力；若其中至少1张黑色，其获得"下一次受到杀造成的伤害+1"
 *          （可叠加）的状态。
 * 【顺世】：准备阶段，或你在自己回合外受到伤害后，可以交给一名其他角色
 *          （若由伤害触发，不能是伤害来源）1张牌；然后你获得"下一个
 *          摸牌阶段额外摸1/下一个出牌阶段杀次数+1/下一个弃牌阶段手牌
 *          上限+1"三项可叠加的记账。
 */

const YISE = 'yise'
const SHUNSHI = 'shunshi'

function playerOf(state: SanguoshaState, playerId: PlayerId) {
  return state.players.find((candidate) => candidate.id === playerId)
}

registerSkillRuntime({
  id: YISE,
  triggers: [{
    event: 'GainCard',
    handle(host, ownerId, context) {
      const payload = context.event.payload as { playerId?: PlayerId; cardIds?: CardId[] }
      const targetId = payload.playerId
      if (!targetId || targetId === ownerId) return
      const target = playerOf(host.state, targetId)
      if (!target?.alive) return
      const mine = (payload.cardIds ?? []).filter((cardId) => gainEntryOf(host.state, cardId)?.fromId === ownerId)
      if (mine.length === 0) return
      const hasRed = mine.some((cardId) => host.state.cards[cardId]?.color === 'red')
      const hasBlack = mine.some((cardId) => host.state.cards[cardId]?.color === 'black')
      const owner = playerOf(host.state, ownerId)
      if (!owner?.alive) return
      if (hasBlack) {
        target.marks['yise-slash-bonus'] = (target.marks['yise-slash-bonus'] ?? 0) + 1
        host.dispatch('SkillActivated', { skillId: YISE, skillName: '异色', playerId: ownerId, targetId, logText: `${target.nickname}获得黑色异色标记` }, { sourceId: ownerId, targetId })
      }
      if (hasRed) host.queueSkill({ skillId: YISE, ownerId, step: 'ask-recover', data: { targetId } })
    },
  }, {
    event: 'BeforeDamage',
    handle(host, ownerId, context) {
      const targetId = context.event.targetId
      if (!targetId) return
      const target = playerOf(host.state, targetId)
      const bonus = target?.marks['yise-slash-bonus'] ?? 0
      if (bonus <= 0) return
      const payload = context.event.payload as { amount?: number; cardName?: string }
      if (payload.cardName !== '杀') return
      target!.marks['yise-slash-bonus'] = 0
      payload.amount = (typeof payload.amount === 'number' ? payload.amount : 0) + bonus
      void ownerId
    },
  }],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'ask-recover') return
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    host.askSkill({
      skillId: YISE, ownerId, step: 'ask-recover', data: prompt.data,
      build: (requestId) => ({
        id: requestId, kind: 'choose-option' as const, playerId: ownerId,
        prompt: '【异色】：是否令其回复1点体力？', timeoutMs: 20_000, optional: true,
        options: [{ id: 'yes', label: '发动' }, { id: 'no', label: '不发动' }],
      }),
    })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'ask-recover') return
    const { targetId } = resolution.data as { targetId: PlayerId }
    const owner = playerOf(host.state, ownerId)
    const target = playerOf(host.state, targetId)
    if (!owner?.alive || !target?.alive || (response.payload as { optionId?: string }).optionId !== 'yes') return
    if (target.hp < target.maxHp) {
      recover(host as never, targetId, 1, ownerId)
      host.dispatch('SkillActivated', { skillId: YISE, skillName: '异色', playerId: ownerId, targetId, logText: `${owner.nickname}发动【异色】` }, { sourceId: ownerId, targetId })
    }
  },
})

registerSkillRuntime({
  id: SHUNSHI,
  triggers: [
    {
      event: 'PhaseStart',
      handle(host, ownerId, context) {
        const payload = context.event.payload as { phase?: string; playerId?: PlayerId }
        if (payload.phase !== 'prepare' || payload.playerId !== ownerId) return
        const owner = playerOf(host.state, ownerId)
        if (!owner?.alive || owner.zones.hand.length === 0) return
        const candidateIds = host.state.players.filter((candidate) => candidate.alive && candidate.id !== ownerId).map((candidate) => candidate.id)
        if (candidateIds.length === 0) return
        host.queueSkill({ skillId: SHUNSHI, ownerId, step: 'ask-give', data: { candidateIds } })
      },
    },
    {
      event: 'Damaged',
      handle(host, ownerId, context) {
        if (context.event.targetId !== ownerId || host.state.currentPlayerId === ownerId) return
        const owner = playerOf(host.state, ownerId)
        if (!owner?.alive || owner.zones.hand.length === 0) return
        const excludeId = context.event.sourceId
        const candidateIds = host.state.players.filter((candidate) => candidate.alive && candidate.id !== ownerId && candidate.id !== excludeId).map((candidate) => candidate.id)
        if (candidateIds.length === 0) return
        host.queueSkill({ skillId: SHUNSHI, ownerId, step: 'ask-give', data: { candidateIds } })
      },
    },
    {
      event: 'DrawPhase',
      handle(host, ownerId, context) {
        const payload = context.event.payload as { playerId?: PlayerId; count?: number }
        if (payload.playerId !== ownerId) return
        const owner = playerOf(host.state, ownerId)
        const bonus = owner?.marks['shunshi-draw'] ?? 0
        if (bonus <= 0) return
        owner!.marks['shunshi-draw'] = 0
        payload.count = (typeof payload.count === 'number' ? payload.count : 2) + bonus
      },
    },
    {
      event: 'PhaseStart',
      handle(host, ownerId, context) {
        const payload = context.event.payload as { phase?: string; playerId?: PlayerId }
        if (payload.phase !== 'play' || payload.playerId !== ownerId) return
        const owner = playerOf(host.state, ownerId)
        if (!owner || (owner.marks['shunshi-slash'] ?? 0) <= 0) return
        owner.marks['shunshi-slash-active-turn'] = host.state.turnNumber
        owner.marks['shunshi-slash-active'] = owner.marks['shunshi-slash']
        owner.marks['shunshi-slash'] = 0
      },
    },
    {
      event: 'PhaseStart',
      handle(host, ownerId, context) {
        const payload = context.event.payload as { phase?: string; playerId?: PlayerId }
        if (payload.phase !== 'discard' || payload.playerId !== ownerId) return
        const owner = playerOf(host.state, ownerId)
        if (!owner || (owner.marks['shunshi-maxcards'] ?? 0) <= 0) return
        owner.marks['shunshi-maxcards-active-turn'] = host.state.turnNumber
        owner.marks['shunshi-maxcards-active'] = owner.marks['shunshi-maxcards']
        owner.marks['shunshi-maxcards'] = 0
      },
    },
  ],
  globalSlashUses(state, ownerId, targetId) {
    if (targetId !== ownerId) return 0
    const owner = playerOf(state, ownerId)
    return owner?.marks['shunshi-slash-active-turn'] === state.turnNumber ? (owner.marks['shunshi-slash-active'] ?? 0) : 0
  },
  maxCardsBonus(state, ownerId) {
    const owner = playerOf(state, ownerId)
    return owner?.marks['shunshi-maxcards-active-turn'] === state.turnNumber ? (owner.marks['shunshi-maxcards-active'] ?? 0) : 0
  },
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'ask-give') return
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive || owner.zones.hand.length === 0) return
    const { candidateIds } = prompt.data as { candidateIds: PlayerId[] }
    host.askSkill({
      skillId: SHUNSHI, ownerId, step: 'ask-give', data: {},
      build: (requestId): ChooseTargetsRequest => ({
        id: requestId, kind: 'choose-targets', playerId: ownerId,
        prompt: '【顺世】：可以交给一名其他角色1张牌', timeoutMs: 20_000, optional: true,
        candidateIds, min: 0, max: 1,
      }),
    })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'ask-give') return
    const [targetId] = (response.payload as { targetIds?: PlayerId[] }).targetIds ?? []
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive || !targetId || !playerOf(host.state, targetId)?.alive || owner.zones.hand.length === 0) return
    const cardId = owner.zones.hand[0]
    moveCard(host.state, cardId, { kind: 'hand', playerId: ownerId }, { kind: 'hand', playerId: targetId })
    host.dispatch('LoseCard', { playerId: ownerId, cardIds: [cardId], reason: SHUNSHI }, { sourceId: ownerId, cardIds: [cardId] })
    host.dispatch('GainCard', { playerId: targetId, cardIds: [cardId], reason: SHUNSHI }, { sourceId: ownerId, targetId, cardIds: [cardId] })
    owner.marks['shunshi-draw'] = (owner.marks['shunshi-draw'] ?? 0) + 1
    owner.marks['shunshi-slash'] = (owner.marks['shunshi-slash'] ?? 0) + 1
    owner.marks['shunshi-maxcards'] = (owner.marks['shunshi-maxcards'] ?? 0) + 1
    host.dispatch('SkillActivated', { skillId: SHUNSHI, skillName: '顺世', playerId: ownerId, targetId, logText: `${owner.nickname}发动【顺世】` }, { sourceId: ownerId, targetId })
  },
})

export const DUFUREN: CharacterDefinition = {
  id: 'dufuren',
  name: '杜夫人',
  kingdom: 'shu',
  gender: 'female',
  maxHp: 3,
  pack: 'sp',
  skills: [
    { id: YISE, name: '异色', description: '其他角色获得你的牌后，若其中至少1张红色，你可以令其回复1点体力；若其中至少1张黑色，其获得"下一次受到杀造成的伤害+1"（可叠加）的状态。' },
    { id: SHUNSHI, name: '顺世', description: '准备阶段，或你在自己回合外受到伤害后，可以交给一名其他角色（若由伤害触发，不能是伤害来源）1张牌；然后你获得下一个摸牌阶段额外摸1/下一个出牌阶段杀次数+1/下一个弃牌阶段手牌上限+1，均可叠加。' },
  ],
}
