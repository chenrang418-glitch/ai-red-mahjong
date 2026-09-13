import { moveCard } from '../../engine/zones'
import { flipCharacter } from '../../engine/character-state'
import { registerSkillRuntime } from '../../engine/skills/runtime'
import type { ChooseOptionRequest, ChooseTargetsRequest } from '../../engine/requests'
import type { PlayerId, SanguoshaState } from '../../engine/types'
import type { CharacterDefinition } from './types'

/**
 * 梁兴（三国杀 OL 经典身份 SP）。
 *
 * 【掳掠】：出牌阶段开始时，选择一名手牌数少于梁兴的、有手牌的其他角色A，
 *          A选择：1.将所有手牌交给梁兴，然后梁兴翻面；2.翻面，然后视为对
 *          梁兴使用一张【杀】。
 * 【追袭】：锁定技，梁兴造成或受到的伤害，若双方翻面状态不同，伤害+1。
 */

const LULUE = 'lulue'
const ZHUIXI = 'zhuixi'

function playerOf(state: SanguoshaState, playerId: PlayerId) {
  return state.players.find((candidate) => candidate.id === playerId)
}

registerSkillRuntime({
  id: LULUE,
  triggers: [{
    event: 'PlayPhase',
    handle(host, ownerId, context) {
      if (context.event.sourceId !== ownerId) return
      const owner = playerOf(host.state, ownerId)
      if (!owner?.alive) return
      const candidateIds = host.state.players.filter((candidate) => candidate.alive && candidate.id !== ownerId && candidate.zones.hand.length > 0 && candidate.zones.hand.length < owner.zones.hand.length).map((candidate) => candidate.id)
      if (candidateIds.length === 0) return
      host.queueSkill({ skillId: LULUE, ownerId, step: 'pick-target', data: { candidateIds } })
    },
  }],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'pick-target') return
    const { candidateIds } = prompt.data as { candidateIds: PlayerId[] }
    host.askSkill({
      skillId: LULUE, ownerId, step: 'pick-target', data: {},
      build: (requestId): ChooseTargetsRequest => ({
        id: requestId, kind: 'choose-targets', playerId: ownerId,
        prompt: '【掳掠】：选择一名手牌数少于你的角色', timeoutMs: 20_000, optional: true,
        candidateIds, min: 0, max: 1,
      }),
    })
  },
  resume(host, ownerId, resolution, response) {
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    if (resolution.step === 'pick-target') {
      const [targetId] = (response.payload as { targetIds?: PlayerId[] }).targetIds ?? []
      const target = targetId ? playerOf(host.state, targetId) : undefined
      if (!target?.alive || target.zones.hand.length === 0) return
      host.askSkill({
        skillId: LULUE, ownerId, step: 'choice', data: { targetId },
        build: (requestId): ChooseOptionRequest => ({
          id: requestId, kind: 'choose-option', playerId: targetId,
          prompt: '【掳掠】：交出所有手牌并令梁兴翻面，或翻面并视为对梁兴使用一张杀', timeoutMs: 20_000, optional: false,
          options: [{ id: 'give', label: '交出所有手牌' }, { id: 'slash', label: '翻面并视为使用一张杀' }],
        }),
      })
      return
    }
    if (resolution.step === 'choice') {
      const { targetId } = resolution.data as { targetId: PlayerId }
      const target = playerOf(host.state, targetId)
      const optionId = (response.payload as { optionId?: string }).optionId
      if (!target?.alive) return
      host.dispatch('SkillActivated', { skillId: LULUE, skillName: '掳掠', playerId: ownerId, logText: `${owner.nickname}发动【掳掠】` }, { sourceId: ownerId, targetId })
      if (optionId === 'give' && target.zones.hand.length > 0) {
        const cardIds = [...target.zones.hand]
        for (const cardId of cardIds) moveCard(host.state, cardId, { kind: 'hand', playerId: targetId }, { kind: 'hand', playerId: ownerId })
        host.dispatch('GainCard', { playerId: ownerId, cardIds, reason: LULUE }, { sourceId: targetId, targetId: ownerId, cardIds })
        flipCharacter(host, ownerId, LULUE)
        return
      }
      flipCharacter(host, targetId, LULUE)
      host.beginVirtualSlash({ sourceId: targetId, targetId: ownerId, sourceSkillId: LULUE })
    }
  },
})

registerSkillRuntime({
  id: ZHUIXI,
  triggers: [{
    event: 'BeforeDamage',
    handle(host, ownerId, context) {
      const sourceId = context.event.sourceId
      const targetId = context.event.targetId
      if (!targetId) return
      const owner = playerOf(host.state, ownerId)
      if (!owner?.alive) return
      let otherId: PlayerId | null = null
      if (sourceId === ownerId && targetId !== ownerId) otherId = targetId
      else if (targetId === ownerId && sourceId && sourceId !== ownerId) otherId = sourceId
      if (!otherId) return
      const other = playerOf(host.state, otherId)
      if (!other?.alive || other.faceDown === owner.faceDown) return
      const payload = context.event.payload as { amount?: number }
      payload.amount = (typeof payload.amount === 'number' ? payload.amount : 0) + 1
      host.dispatch('SkillActivated', { skillId: ZHUIXI, skillName: '追袭', playerId: ownerId, logText: `${owner.nickname}发动【追袭】，伤害+1` }, { sourceId: ownerId })
    },
  }],
})

export const LIANGXING: CharacterDefinition = {
  id: 'liangxing',
  name: '梁兴',
  kingdom: 'qun',
  gender: 'male',
  maxHp: 4,
  pack: 'sp',
  skills: [
    { id: LULUE, name: '掳掠', description: '出牌阶段开始时，选择一名手牌数少于你的、有手牌的其他角色，其选择：交出所有手牌并令你翻面；或翻面并视为对你使用一张【杀】。' },
    { id: ZHUIXI, name: '追袭', description: '锁定技，你造成或受到的伤害，若双方翻面状态不同，此伤害+1。' },
  ],
}
