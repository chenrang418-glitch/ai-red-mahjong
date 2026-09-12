import { moveCard } from '../../engine/zones'
import { executeUseCardAction } from '../../engine/cards/basic'
import { getDistance, ignoresDistanceTo as canBypassDistance } from '../../engine/distance'
import { registerSkillRuntime } from '../../engine/skills/runtime'
import type { ChooseCardsRequest, ChooseOptionRequest, ChooseTargetsRequest } from '../../engine/requests'
import type { CardId, PlayerId, SanguoshaState } from '../../engine/types'
import type { CharacterDefinition } from './types'

/**
 * 郭汜（三国杀 OL 经典身份 SP）。
 *
 * 【贪狈】：出牌阶段限一次，郭汜选择一名其他角色 A，由 A 选择一项：
 *          郭汜随机获得 A 区域内一张牌，然后直到本回合结束不能对 A 使用
 *          牌；或直到本回合结束，郭汜对 A 使用牌没有距离和次数限制。
 * 【伺盗】：出牌阶段限一次，当郭汜连续对同一名其他角色使用两张牌后，
 *          可以将一张手牌当【顺手牵羊】对其使用。
 *
 * 「次数限制」只覆盖【杀】的次数（`ignoresSlashUsesTo`）——常规锦囊在
 * 身份场本来就没有回合次数限制，这条覆盖已经是规则里真正存在次数限制
 * 的那一种牌，不需要为“所有牌的次数”发明一个新概念。
 */

const TANBEI = 'tanbei'
const SIDAO = 'sidao'

function playerOf(state: SanguoshaState, playerId: PlayerId) {
  return state.players.find((candidate) => candidate.id === playerId)
}

function turnBound(state: SanguoshaState, entry: { targetId: PlayerId; turnNumber: number } | undefined, targetId: PlayerId): boolean {
  return !!entry && entry.turnNumber === state.turnNumber && entry.targetId === targetId
}

registerSkillRuntime({
  id: TANBEI,
  announcesSelf: true,

  activeActions(state, ownerId) {
    if (state.phase !== 'play' || state.currentPlayerId !== ownerId) return []
    const owner = playerOf(state, ownerId)
    if (!owner?.alive || owner.turnUsedSkills.includes(TANBEI)) return []
    if (!state.players.some((candidate) => candidate.alive && candidate.id !== ownerId)) return []
    return [{ id: TANBEI, label: '贪狈：选择一名其他角色' }]
  },

  invokeActive(host, ownerId, actionId) {
    if (actionId !== TANBEI) return
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive || owner.turnUsedSkills.includes(TANBEI)) return
    const candidateIds = host.state.players.filter((candidate) => candidate.alive && candidate.id !== ownerId).map((candidate) => candidate.id)
    if (candidateIds.length === 0) return
    host.askSkill({
      skillId: TANBEI, ownerId, step: 'target',
      build: (requestId): ChooseTargetsRequest => ({
        id: requestId, kind: 'choose-targets', playerId: ownerId,
        prompt: '【贪狈】：选择一名其他角色', timeoutMs: 20_000, optional: false, candidateIds, min: 1, max: 1,
      }),
    })
  },

  prohibitsSourceTarget(state, ownerId, targetId) {
    return turnBound(state, state.guosiTanbeiLock?.[ownerId], targetId)
  },

  ignoresDistanceTo(state, ownerId, targetId) {
    return turnBound(state, state.guosiTanbeiUnlimited?.[ownerId], targetId)
  },

  ignoresSlashUsesTo(state, ownerId, targetId) {
    return turnBound(state, state.guosiTanbeiUnlimited?.[ownerId], targetId)
  },

  resume(host, ownerId, resolution, response) {
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return

    if (resolution.step === 'target') {
      const [targetId] = (response.payload as { targetIds?: PlayerId[] }).targetIds ?? []
      const target = targetId ? playerOf(host.state, targetId) : undefined
      if (!target?.alive) return
      if (!owner.turnUsedSkills.includes(TANBEI)) owner.turnUsedSkills.push(TANBEI)
      host.askSkill({
        skillId: TANBEI, ownerId, step: 'choice', data: { targetId },
        build: (requestId): ChooseOptionRequest => ({
          id: requestId, kind: 'choose-option', playerId: targetId,
          prompt: `${owner.nickname}对你发动了【贪狈】，选择一项`, timeoutMs: 20_000, optional: false,
          options: [
            { id: 'give', label: '令对方随机获得你区域内一张牌，本回合其不能对你使用牌' },
            { id: 'unlimited', label: '本回合对方对你使用牌没有距离和次数限制' },
          ],
        }),
      })
      return
    }

    if (resolution.step === 'choice') {
      const { targetId } = resolution.data as { targetId: PlayerId }
      const target = playerOf(host.state, targetId)
      const optionId = (response.payload as { optionId?: string }).optionId
      if (!target?.alive) return
      host.dispatch('SkillActivated', { skillId: TANBEI, skillName: '贪狈', playerId: ownerId, targetId, logText: `${owner.nickname}发动【贪狈】` }, { sourceId: ownerId, targetId })

      if (optionId === 'unlimited') {
        host.state.guosiTanbeiUnlimited ??= {}
        host.state.guosiTanbeiUnlimited[ownerId] = { targetId, turnNumber: host.state.turnNumber }
        return
      }

      const pool: Array<{ cardId: CardId; from: { kind: 'hand'; playerId: PlayerId } | { kind: 'equipment'; playerId: PlayerId; slot: keyof typeof target.zones.equipment } | { kind: 'judgingArea'; playerId: PlayerId } }> = [
        ...target.zones.hand.map((cardId) => ({ cardId, from: { kind: 'hand' as const, playerId: targetId } })),
        ...target.zones.judgingArea.map((cardId) => ({ cardId, from: { kind: 'judgingArea' as const, playerId: targetId } })),
        ...(Object.keys(target.zones.equipment) as Array<keyof typeof target.zones.equipment>)
          .filter((slot) => target.zones.equipment[slot])
          .map((slot) => ({ cardId: target.zones.equipment[slot] as CardId, from: { kind: 'equipment' as const, playerId: targetId, slot } })),
      ]
      host.state.guosiTanbeiLock ??= {}
      host.state.guosiTanbeiLock[ownerId] = { targetId, turnNumber: host.state.turnNumber }
      if (pool.length === 0) return
      const picked = host.rng.pick(pool)
      moveCard(host.state, picked.cardId, picked.from, { kind: 'hand', playerId: ownerId })
      host.dispatch('GainCard', { playerId: ownerId, cardIds: [picked.cardId], reason: TANBEI }, { targetId: ownerId, cardIds: [picked.cardId] })
    }
  },
})

registerSkillRuntime({
  id: SIDAO,
  triggers: [{
    event: 'CardUsed',
    handle(host, ownerId, context) {
      if (context.event.sourceId !== ownerId || host.state.currentPlayerId !== ownerId) return
      const payload = context.event.payload as { targetIds?: PlayerId[] }
      const targets = payload.targetIds ?? []
      const key = `${host.state.turnNumber}:${host.state.phase}`
      const prev = host.state.guosiConsecutiveUse?.[ownerId]
      if (targets.length === 0) { delete host.state.guosiConsecutiveUse?.[ownerId]; return }
      let nextTargetId: PlayerId
      let nextCount: number
      if (prev && prev.phaseKey === key && targets.includes(prev.targetId)) {
        nextTargetId = prev.targetId
        nextCount = prev.count + 1
      } else {
        nextTargetId = targets[0]
        nextCount = 1
      }
      host.state.guosiConsecutiveUse ??= {}
      host.state.guosiConsecutiveUse[ownerId] = { targetId: nextTargetId, count: nextCount, phaseKey: key }
      const owner = playerOf(host.state, ownerId)
      if (nextCount < 2 || !owner?.alive || owner.turnUsedSkills.includes(SIDAO)) return
      const target = playerOf(host.state, nextTargetId)
      if (!target?.alive) return
      const canReach = canBypassDistance(host.state, ownerId, nextTargetId) || getDistance(host.state, ownerId, nextTargetId) <= 1
      const hasSteal = target.zones.hand.length + target.zones.judgingArea.length + Object.values(target.zones.equipment).filter(Boolean).length > 0
      if (!canReach || !hasSteal || owner.zones.hand.length === 0) return
      host.queueSkill({ skillId: SIDAO, ownerId, step: 'ask', data: { targetId: nextTargetId } })
    },
  }],

  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'ask') return
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive || owner.turnUsedSkills.includes(SIDAO) || owner.zones.hand.length === 0) return
    const { targetId } = prompt.data as { targetId: PlayerId }
    host.askSkill({
      skillId: SIDAO, ownerId, step: 'ask', data: { targetId },
      build: (requestId): ChooseCardsRequest => ({
        id: requestId, kind: 'choose-cards', playerId: ownerId,
        prompt: '【伺盗】：可以将一张手牌当【顺手牵羊】使用', timeoutMs: 20_000, optional: true,
        purpose: 'skill', cardIds: [...owner.zones.hand], hiddenCardSlots: [], min: 0, max: 1,
      }),
    })
  },

  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'ask') return
    const { targetId } = resolution.data as { targetId: PlayerId }
    const owner = playerOf(host.state, ownerId)
    const target = playerOf(host.state, targetId)
    const [cardId] = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
    if (!owner?.alive || !target?.alive || !cardId || !owner.zones.hand.includes(cardId) || owner.turnUsedSkills.includes(SIDAO)) return
    owner.turnUsedSkills.push(SIDAO)
    host.dispatch('SkillActivated', { skillId: SIDAO, skillName: '伺盗', playerId: ownerId, targetId, logText: `${owner.nickname}发动【伺盗】` }, { sourceId: ownerId, targetId })
    executeUseCardAction(host as never, ownerId, {
      kind: 'use-card', id: `sidao:${cardId}`, playerId: ownerId,
      cardIds: [cardId], targetIds: [targetId], targetMin: 1, targetMax: 1,
      asCardName: '顺手牵羊', label: '视为使用【顺手牵羊】',
    })
  },
})

export const GUOSI: CharacterDefinition = {
  id: 'guosi',
  name: '郭汜',
  kingdom: 'qun',
  gender: 'male',
  maxHp: 4,
  pack: 'sp',
  skills: [
    { id: TANBEI, name: '贪狈', description: '出牌阶段限一次，选择一名其他角色A，由A选择一项：郭汜随机获得A区域内一张牌，然后本回合不能对A使用牌；或本回合对A使用牌没有距离和次数限制。' },
    { id: SIDAO, name: '伺盗', description: '出牌阶段限一次，当郭汜连续对同一名其他角色使用两张牌后，可以将一张手牌当【顺手牵羊】对其使用。' },
  ],
}
