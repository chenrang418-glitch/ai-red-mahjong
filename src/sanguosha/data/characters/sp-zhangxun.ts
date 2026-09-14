import { registerSkillRuntime } from '../../engine/skills/runtime'
import type { ChooseOptionRequest, ChooseTargetsRequest } from '../../engine/requests'
import type { PlayerId, SanguoshaState } from '../../engine/types'
import type { CharacterDefinition } from './types'

/**
 * 张勋（三国杀 OL 经典身份 SP）。
 *
 * 【随征】：结束阶段，你可以选择一名角色A；A的下一个出牌阶段内，其使用
 *          【杀】无距离限制且次数+1；该出牌阶段结束时，若A本回合对其他
 *          角色造成过伤害，你可以选择其中一名B（A本人除外），视为对B
 *          使用一张杀。
 */

const SUIZHENG = 'suizheng'

function playerOf(state: SanguoshaState, playerId: PlayerId) {
  return state.players.find((candidate) => candidate.id === playerId)
}

function boundOwnerFor(state: SanguoshaState, targetId: PlayerId): PlayerId | undefined {
  return state.suizhengBound?.[targetId]
}

registerSkillRuntime({
  id: SUIZHENG,
  ignoresDistanceTo(state, sourceId, _targetId, cardId) {
    if (!cardId || state.cards[cardId]?.name !== '杀') return false
    return boundOwnerFor(state, sourceId) !== undefined
  },
  globalSlashUses(state, ownerId, targetId) {
    return boundOwnerFor(state, targetId) === ownerId ? 1 : 0
  },
  triggers: [
    {
      event: 'PhaseStart',
      handle(host, ownerId, context) {
        const payload = context.event.payload as { phase?: string; playerId?: PlayerId }
        if (payload.phase !== 'finish' || payload.playerId !== ownerId) return
        const owner = playerOf(host.state, ownerId)
        if (!owner?.alive) return
        const candidateIds = host.state.players.filter((candidate) => candidate.alive).map((candidate) => candidate.id)
        if (candidateIds.length === 0) return
        host.queueSkill({ skillId: SUIZHENG, ownerId, step: 'pick-bind', data: {} })
      },
    },
    {
      event: 'PhaseStart',
      handle(host, _ownerId, context) {
        const payload = context.event.payload as { phase?: string; playerId?: PlayerId }
        if (payload.phase !== 'play' || !payload.playerId) return
        if (boundOwnerFor(host.state, payload.playerId) === undefined) return
        host.state.suizhengDamaged = { ...(host.state.suizhengDamaged ?? {}), [payload.playerId]: [] }
      },
    },
    {
      event: 'Damaged',
      handle(host, _ownerId, context) {
        const sourceId = context.event.sourceId
        const targetId = context.event.targetId
        if (!sourceId || !targetId || sourceId === targetId) return
        if (!(sourceId in (host.state.suizhengDamaged ?? {}))) return
        const list = host.state.suizhengDamaged![sourceId] ?? []
        if (!list.includes(targetId)) list.push(targetId)
        host.state.suizhengDamaged![sourceId] = list
      },
    },
    {
      event: 'PhaseEnd',
      handle(host, ownerId, context) {
        const payload = context.event.payload as { phase?: string; playerId?: PlayerId }
        if (payload.phase !== 'play' || !payload.playerId) return
        const actorId = payload.playerId
        const boundOwnerId = boundOwnerFor(host.state, actorId)
        if (boundOwnerId !== ownerId) return
        if (host.state.suizhengBound) delete host.state.suizhengBound[actorId]
        // B 不能是张勋（技能拥有者）自己——即使他就是被 A 伤害过的对象之一
        const damaged = (host.state.suizhengDamaged?.[actorId] ?? []).filter((id) => id !== ownerId && playerOf(host.state, id)?.alive)
        if (host.state.suizhengDamaged) delete host.state.suizhengDamaged[actorId]
        const owner = playerOf(host.state, ownerId)
        if (!owner?.alive || damaged.length === 0) return
        host.queueSkill({ skillId: SUIZHENG, ownerId, step: 'ask-slash', data: { candidateIds: damaged } })
      },
    },
  ],
  startQueued(host, ownerId, prompt) {
    if (prompt.step === 'pick-bind') {
      const owner = playerOf(host.state, ownerId)
      if (!owner?.alive) return
      const candidateIds = host.state.players.filter((candidate) => candidate.alive).map((candidate) => candidate.id)
      if (candidateIds.length === 0) return
      host.askSkill({
        skillId: SUIZHENG, ownerId, step: 'pick-bind', data: {},
        build: (requestId): ChooseTargetsRequest => ({
          id: requestId, kind: 'choose-targets', playerId: ownerId,
          prompt: '【随征】：选择一名角色', timeoutMs: 20_000, optional: true,
          candidateIds, min: 0, max: 1,
        }),
      })
      return
    }
    if (prompt.step === 'ask-slash') {
      const owner = playerOf(host.state, ownerId)
      if (!owner?.alive) return
      host.askSkill({
        skillId: SUIZHENG, ownerId, step: 'ask-slash', data: prompt.data,
        build: (requestId): ChooseOptionRequest => ({
          id: requestId, kind: 'choose-option', playerId: ownerId,
          prompt: '【随征】：是否视为对一名角色使用一张杀？', timeoutMs: 20_000, optional: true,
          options: [{ id: 'yes', label: '发动' }, { id: 'no', label: '不发动' }],
        }),
      })
    }
  },
  resume(host, ownerId, resolution, response) {
    const owner = playerOf(host.state, ownerId)
    if (resolution.step === 'pick-bind') {
      const [targetId] = (response.payload as { targetIds?: PlayerId[] }).targetIds ?? []
      if (!owner?.alive || !targetId || !playerOf(host.state, targetId)?.alive) return
      host.state.suizhengBound = { ...(host.state.suizhengBound ?? {}), [targetId]: ownerId }
      host.dispatch('SkillActivated', { skillId: SUIZHENG, skillName: '随征', playerId: ownerId, targetId, logText: `${owner.nickname}发动【随征】` }, { sourceId: ownerId, targetId })
      return
    }
    if (resolution.step === 'ask-slash') {
      const { candidateIds } = resolution.data as { candidateIds: PlayerId[] }
      if (!owner?.alive || (response.payload as { optionId?: string }).optionId !== 'yes') return
      const valid = candidateIds.filter((id) => playerOf(host.state, id)?.alive)
      if (valid.length === 0) return
      host.askSkill({
        skillId: SUIZHENG, ownerId, step: 'pick-victim', data: {},
        build: (requestId): ChooseTargetsRequest => ({
          id: requestId, kind: 'choose-targets', playerId: ownerId,
          prompt: '【随征】：选择一名角色，视为对其使用一张杀', timeoutMs: 20_000, optional: false,
          candidateIds: valid, min: 1, max: 1,
        }),
      })
      return
    }
    if (resolution.step === 'pick-victim') {
      const [victimId] = (response.payload as { targetIds?: PlayerId[] }).targetIds ?? []
      if (!owner?.alive || !victimId || !playerOf(host.state, victimId)?.alive) return
      host.dispatch('SkillActivated', { skillId: SUIZHENG, skillName: '随征', playerId: ownerId, targetId: victimId, logText: `${owner.nickname}发动【随征】，视为使用一张杀` }, { sourceId: ownerId, targetId: victimId })
      host.beginVirtualSlash({ sourceId: ownerId, targetId: victimId, sourceSkillId: SUIZHENG, countUsage: false })
    }
  },
})

export const ZHANGXUN: CharacterDefinition = {
  id: 'zhangxun',
  name: '张勋',
  kingdom: 'qun',
  gender: 'male',
  maxHp: 4,
  pack: 'sp',
  skills: [
    { id: SUIZHENG, name: '随征', description: '结束阶段，你可以选择一名角色；其下一个出牌阶段内，使用杀无距离限制且次数+1；该出牌阶段结束时，若其对其他角色造成过伤害，你可以选择其中一名，视为对其使用一张杀。' },
  ],
}
