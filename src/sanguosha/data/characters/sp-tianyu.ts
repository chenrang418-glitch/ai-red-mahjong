import { isSoleTargetOf } from '../../engine/card-use-targets'
import { registerSkillRuntime } from '../../engine/skills/runtime'
import type { ChooseOptionRequest, ChooseTargetsRequest } from '../../engine/requests'
import type { PlayerId, SanguoshaState } from '../../engine/types'
import type { CharacterDefinition } from './types'

/**
 * 田豫（三国杀 OL 经典身份 SP）。
 *
 * 【扫狄】：田豫使用【杀】且只指定一名其他角色为目标时，可以令田豫与该目标
 *          在座次之间的角色全部成为这张【杀】的额外目标。
 * 【追讨】：准备阶段，田豫可以选择一名此前未被追讨减少距离的其他角色，
 *          田豫计算与其的距离 -1（可跨回合持续）；田豫对其造成伤害后，
 *          移除这一份 -1，该角色重新变为可以被追讨选择。
 *
 * 两处最容易做错的：
 *
 * 1. **扫狄只覆盖【杀】**：普通/非延时锦囊的对应「使用者侧同步插入点」
 *    引擎目前没有（只有【杀】的 `askSlashInterceptors` 支持
 *    `interceptSourceTarget`），本轮不新增，记在案。
 * 2. **追讨是 source-target 持久状态，不是永久黑名单**：走新增的
 *    `directedDistanceTo` 钩子 + `state.zhuitaoDistance`，田豫可以同时
 *    对多个目标各自独立生效；造成伤害后移除对应那一条即可，不清空全部。
 */

const SAODI = 'saodi'
const ZHUITAO = 'zhuitao'

function playerOf(state: SanguoshaState, playerId: PlayerId) {
  return state.players.find((candidate) => candidate.id === playerId)
}

/** 存活角色按座次排列后，田豫与目标之间（较短一段弧）的其他角色。 */
function betweenBySeat(state: SanguoshaState, sourceId: PlayerId, targetId: PlayerId): PlayerId[] {
  const alive = state.players.filter((candidate) => candidate.alive).sort((a, b) => a.seat - b.seat)
  const sourceIndex = alive.findIndex((candidate) => candidate.id === sourceId)
  const targetIndex = alive.findIndex((candidate) => candidate.id === targetId)
  if (sourceIndex < 0 || targetIndex < 0) return []
  const n = alive.length
  const clockwise: PlayerId[] = []
  for (let i = (sourceIndex + 1) % n; i !== targetIndex; i = (i + 1) % n) clockwise.push(alive[i].id)
  const counter: PlayerId[] = []
  for (let i = (sourceIndex - 1 + n) % n; i !== targetIndex; i = (i - 1 + n) % n) counter.push(alive[i].id)
  return clockwise.length <= counter.length ? clockwise : counter
}

registerSkillRuntime({
  id: SAODI,
  interceptSourceTarget(host, ownerId, context) {
    if (context.cardName !== '杀') return false
    const resolution = host.state.cardResolution
    if (resolution?.kind !== 'slash' || !isSoleTargetOf(host.state, context.cardId, context.targetId)) return false
    const between = betweenBySeat(host.state, ownerId, context.targetId)
    if (between.length === 0) return false
    host.askSkill({
      skillId: SAODI, ownerId, step: 'ask', data: { between },
      build: (requestId): ChooseOptionRequest => ({
        id: requestId, kind: 'choose-option', playerId: ownerId,
        prompt: '【扫狄】：令田豫与目标座次之间的角色全部成为额外目标？',
        timeoutMs: 20_000, optional: true,
        options: [{ id: 'yes', label: '发动【扫狄】' }, { id: 'no', label: '不发动' }],
      }),
    })
    return true
  },

  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'ask') return
    if ((response.payload as { optionId?: string }).optionId === 'yes') {
      const { between } = resolution.data as { between: PlayerId[] }
      const current = host.state.cardResolution
      if (current?.kind === 'slash') {
        current.remainingTargetIds.push(...between)
        host.dispatch('SkillActivated', {
          skillId: SAODI, skillName: '扫狄', playerId: ownerId,
          logText: `${playerOf(host.state, ownerId)?.nickname ?? ''}发动【扫狄】，新增 ${between.length} 名额外目标`,
        }, { sourceId: ownerId })
      }
    }
    host.resumeCardTarget()
  },
})

function zhuitaoTargets(state: SanguoshaState, ownerId: PlayerId): PlayerId[] {
  const active = new Set((state.zhuitaoDistance ?? []).filter((entry) => entry.ownerId === ownerId).map((entry) => entry.targetId))
  return state.players.filter((candidate) => candidate.alive && candidate.id !== ownerId && !active.has(candidate.id)).map((candidate) => candidate.id)
}

registerSkillRuntime({
  id: ZHUITAO,
  directedDistanceTo(state, ownerId, targetId) {
    const has = (state.zhuitaoDistance ?? []).some((entry) => entry.ownerId === ownerId && entry.targetId === targetId)
    return has ? -1 : 0
  },

  triggers: [
    {
      event: 'PhaseStart',
      handle(host, ownerId, context) {
        const payload = context.event.payload as { playerId?: PlayerId; phase?: string }
        if (payload.phase !== 'prepare' || payload.playerId !== ownerId) return
        const owner = playerOf(host.state, ownerId)
        if (!owner?.alive) return
        const candidateIds = zhuitaoTargets(host.state, ownerId)
        if (candidateIds.length === 0) return
        host.queueSkill({ skillId: ZHUITAO, ownerId, step: 'ask', data: { candidateIds } })
      },
    },
    {
      event: 'AfterDamage',
      handle(host, ownerId, context) {
        if (context.event.sourceId !== ownerId) return
        const targetId = context.event.targetId
        if (!targetId || !host.state.zhuitaoDistance) return
        const before = host.state.zhuitaoDistance.length
        host.state.zhuitaoDistance = host.state.zhuitaoDistance.filter((entry) => !(entry.ownerId === ownerId && entry.targetId === targetId))
        if (host.state.zhuitaoDistance.length !== before) {
          host.dispatch('SkillActivated', {
            skillId: ZHUITAO, skillName: '追讨', playerId: ownerId, targetId,
            logText: `${playerOf(host.state, ownerId)?.nickname ?? ''}对其造成伤害，移除【追讨】的距离修正`,
          }, { sourceId: ownerId, targetId })
        }
      },
    },
  ],

  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'ask') return
    const { candidateIds } = prompt.data as { candidateIds: PlayerId[] }
    if (!playerOf(host.state, ownerId)?.alive) return
    host.askSkill({
      skillId: ZHUITAO, ownerId, step: 'target', data: {},
      build: (requestId): ChooseTargetsRequest => ({
        id: requestId, kind: 'choose-targets', playerId: ownerId,
        prompt: '【追讨】：选择一名此前未被减少距离的其他角色', timeoutMs: 20_000, optional: true, candidateIds, min: 0, max: 1,
      }),
    })
  },

  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'target') return
    const [targetId] = (response.payload as { targetIds?: PlayerId[] }).targetIds ?? []
    const owner = playerOf(host.state, ownerId)
    const target = targetId ? playerOf(host.state, targetId) : undefined
    if (!owner?.alive || !target?.alive) return
    host.state.zhuitaoDistance ??= []
    host.state.zhuitaoDistance.push({ ownerId, targetId: targetId! })
    host.dispatch('SkillActivated', {
      skillId: ZHUITAO, skillName: '追讨', playerId: ownerId, targetId,
      logText: `${owner.nickname}发动【追讨】，与${target.nickname}距离 -1`,
    }, { sourceId: ownerId, targetId })
  },
})

export const TIANYU: CharacterDefinition = {
  id: 'tianyu',
  name: '田豫',
  kingdom: 'wei',
  gender: 'male',
  maxHp: 4,
  pack: 'sp',
  skills: [
    {
      id: SAODI,
      name: '扫狄',
      description: '田豫使用【杀】且只指定一名其他角色为目标时，可以令田豫与该目标在座次之间的角色全部成为这张【杀】的额外目标。',
    },
    {
      id: ZHUITAO,
      name: '追讨',
      description: '准备阶段，田豫可以选择一名此前未被追讨减少距离的其他角色，田豫计算与其的距离 -1（可跨回合持续）；田豫对其造成伤害后，移除这一份 -1，该角色重新变为可以被追讨选择。',
    },
  ],
}
