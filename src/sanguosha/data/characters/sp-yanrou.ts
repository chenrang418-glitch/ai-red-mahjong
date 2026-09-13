import { moveCard } from '../../engine/zones'
import { drawCards } from '../../engine/draw'
import { recover } from '../../engine/recover'
import { registerSkillRuntime, type SkillHost } from '../../engine/skills/runtime'
import type { ChooseCardsRequest, ChooseOptionRequest, ChooseTargetsRequest } from '../../engine/requests'
import type { CardId, PlayerId, SanguoshaState } from '../../engine/types'
import type { CharacterDefinition } from './types'

/**
 * 阎柔（三国杀 OL 经典身份 SP）。
 *
 * 【仇讨】：阎柔使用【杀】指定目标后，或阎柔成为其他角色使用【杀】的目标
 *          后，可以弃置使用者1张牌（阎柔自己是使用者时弃自己的牌，是别人
 *          的牌则随机弃1张对方手牌），然后这张【杀】不能被抵消；阎柔自己
 *          是使用者时这张杀不计入使用次数。
 * 【襄戍】：限定技，结束阶段，若本回合造成过伤害，X=min(本回合造成伤害
 *          点数总和,5)，选择一名已受伤角色，其回复X点体力，然后摸X张牌。
 */

const QIUTAO = 'qiutao'
const XIANGSHU = 'xiangshu'

function playerOf(state: SanguoshaState, playerId: PlayerId) {
  return state.players.find((candidate) => candidate.id === playerId)
}

function bypassUsage(host: SkillHost): void {
  const usesBefore = host.state.turnUsage.slashUses
  const turnUsesBefore = host.state.turnUsage.slashUsesThisTurn ?? 0
  host.state.turnUsage.slashUses = Math.max(0, usesBefore - 1)
  host.state.turnUsage.slashUsesThisTurn = Math.max(0, turnUsesBefore - 1)
}

registerSkillRuntime({
  id: QIUTAO,
  interceptSourceTarget(host, ownerId, context) {
    if (context.cardName !== '杀' || context.sourceId !== ownerId) return false
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive || owner.zones.hand.length === 0) return false
    host.askSkill({
      skillId: QIUTAO, ownerId, step: 'self-discard', data: {},
      build: (requestId): ChooseCardsRequest => ({
        id: requestId, kind: 'choose-cards', playerId: ownerId,
        prompt: '【仇讨】：是否弃置自己1张牌，令这张杀不能被抵消且不计入次数？', timeoutMs: 20_000, optional: true,
        purpose: 'skill', cardIds: [...owner.zones.hand], hiddenCardSlots: [], min: 0, max: 1,
      }),
    })
    return true
  },
  interceptTarget(host, ownerId, context) {
    if (context.cardName !== '杀' || context.sourceId === ownerId) return false
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return false
    host.askSkill({
      skillId: QIUTAO, ownerId, step: 'other-ask', data: { sourceId: context.sourceId },
      build: (requestId): ChooseOptionRequest => ({
        id: requestId, kind: 'choose-option', playerId: ownerId,
        prompt: '【仇讨】：是否随机弃置使用者1张牌，令这张杀不能被抵消？', timeoutMs: 20_000, optional: true,
        options: [{ id: 'yes', label: '发动' }, { id: 'no', label: '不发动' }],
      }),
    })
    return true
  },
  resume(host, ownerId, resolution, response) {
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) { host.resumeCardTarget(); return }

    if (resolution.step === 'self-discard') {
      const [cardId] = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
      if (cardId && owner.zones.hand.includes(cardId)) {
        moveCard(host.state, cardId, { kind: 'hand', playerId: ownerId }, { kind: 'discardPile' })
        host.dispatch('LoseCard', { playerId: ownerId, cardIds: [cardId], reason: QIUTAO }, { sourceId: ownerId, cardIds: [cardId] })
        const current = host.state.cardResolution
        if (current?.kind === 'slash') current.noDodge = true
        bypassUsage(host)
        host.dispatch('SkillActivated', { skillId: QIUTAO, skillName: '仇讨', playerId: ownerId, logText: `${owner.nickname}发动【仇讨】` }, { sourceId: ownerId })
      }
      host.resumeCardTarget()
      return
    }

    if (resolution.step === 'other-ask') {
      const { sourceId } = resolution.data as { sourceId: PlayerId }
      const optionId = (response.payload as { optionId?: string }).optionId
      if (optionId === 'yes') {
        const source = playerOf(host.state, sourceId)
        if (source?.alive && source.zones.hand.length > 0) {
          const cardId = source.zones.hand[host.rng.nextInt(source.zones.hand.length)]
          moveCard(host.state, cardId, { kind: 'hand', playerId: sourceId }, { kind: 'discardPile' })
          host.dispatch('LoseCard', { playerId: sourceId, cardIds: [cardId], reason: QIUTAO }, { sourceId, cardIds: [cardId] })
        }
        const current = host.state.cardResolution
        if (current?.kind === 'slash') current.noDodge = true
        host.dispatch('SkillActivated', { skillId: QIUTAO, skillName: '仇讨', playerId: ownerId, logText: `${owner.nickname}发动【仇讨】` }, { sourceId: ownerId })
      }
      host.resumeCardTarget()
    }
  },
})

registerSkillRuntime({
  id: XIANGSHU,
  triggers: [{
    event: 'Damaged',
    handle(host, ownerId, context) {
      if (context.event.sourceId !== ownerId) return
      const payload = context.event.payload as { amount?: number }
      const entry = host.state.yanrouTurnDamage?.[ownerId]
      const total = (entry && entry.turnNumber === host.state.turnNumber ? entry.total : 0) + Math.max(0, Math.trunc(payload.amount ?? 0))
      host.state.yanrouTurnDamage ??= {}
      host.state.yanrouTurnDamage[ownerId] = { turnNumber: host.state.turnNumber, total }
    },
  }, {
    event: 'PhaseEnd',
    handle(host, ownerId, context) {
      const payload = context.event.payload as { phase?: string; playerId?: PlayerId }
      if (payload.phase !== 'end' || payload.playerId !== ownerId) return
      const owner = playerOf(host.state, ownerId)
      if (!owner?.alive || owner.usedLimitedSkills.includes(XIANGSHU)) return
      const entry = host.state.yanrouTurnDamage?.[ownerId]
      const total = entry && entry.turnNumber === host.state.turnNumber ? entry.total : 0
      if (total <= 0) return
      const candidateIds = host.state.players.filter((candidate) => candidate.alive && candidate.hp < candidate.maxHp).map((candidate) => candidate.id)
      if (candidateIds.length === 0) return
      host.queueSkill({ skillId: XIANGSHU, ownerId, step: 'pick-target', data: { x: Math.min(total, 5), candidateIds } })
    },
  }],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'pick-target') return
    const { candidateIds } = prompt.data as { x: number; candidateIds: PlayerId[] }
    host.askSkill({
      skillId: XIANGSHU, ownerId, step: 'pick-target', data: prompt.data,
      build: (requestId): ChooseTargetsRequest => ({
        id: requestId, kind: 'choose-targets', playerId: ownerId,
        prompt: '【襄戍】：选择一名已受伤角色', timeoutMs: 20_000, optional: false,
        candidateIds, min: 1, max: 1,
      }),
    })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'pick-target') return
    const { x } = resolution.data as { x: number }
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive || owner.usedLimitedSkills.includes(XIANGSHU)) return
    const [targetId] = (response.payload as { targetIds?: PlayerId[] }).targetIds ?? []
    const target = targetId ? playerOf(host.state, targetId) : undefined
    if (!target?.alive) return
    owner.usedLimitedSkills.push(XIANGSHU)
    host.dispatch('SkillActivated', { skillId: XIANGSHU, skillName: '襄戍', playerId: ownerId, logText: `${owner.nickname}发动限定技【襄戍】` }, { sourceId: ownerId, targetId })
    recover(host as never, targetId, x, ownerId)
    drawCards(host.state, host.rng, targetId, x, (name, payload) => { host.dispatch(name, payload) })
  },
})

export const YANROU: CharacterDefinition = {
  id: 'yanrou',
  name: '阎柔',
  kingdom: 'wei',
  gender: 'male',
  maxHp: 4,
  pack: 'sp',
  skills: [
    { id: QIUTAO, name: '仇讨', description: '你使用【杀】指定目标后，或成为其他角色使用【杀】的目标后，可以弃置使用者1张牌，然后这张杀不能被抵消；你自己是使用者时不计入使用次数。' },
    { id: XIANGSHU, name: '襄戍', description: '限定技，结束阶段，若本回合你造成过伤害，X=min(本回合伤害点数总和,5)，选择一名已受伤角色回复X点体力，然后摸X张牌。' },
  ],
}
