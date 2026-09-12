import { gainMaxHp } from '../../engine/hp'
import { recover } from '../../engine/recover'
import { drawCards } from '../../engine/draw'
import { canTarget } from '../../engine/distance'
import { grantSkill, registerSkillRuntime } from '../../engine/skills/runtime'
import type { SkillHost } from '../../engine/skills/runtime'
import type { ChooseTargetsRequest, ChooseOptionRequest } from '../../engine/requests'
import type { PlayerId, SanguoshaState } from '../../engine/types'
import type { CharacterDefinition } from './types'

/**
 * 卑弥呼（三国杀经典身份 SP）。
 *
 * 【纵傀】：每个回合开始前，可以选择一名没有【傀】的其他角色令其获得傀；
 *          每轮开始时，当前体力最少且没有傀的其他角色之一自动获得傀
 *          （多人并列由卑弥呼选择）。
 * 【骨疽】：锁定技，带有傀的角色受到一次伤害后，卑弥呼摸1张牌（按次计，
 *          一次伤害无论数值多少只摸1张），并累计骨疽摸牌次数。
 * 【拜假】：觉醒技，骨疽累计摸牌数达到7且未觉醒时，准备阶段强制觉醒：
 *          体力上限+1，回复1点，所有没有傀的其他角色获得傀，永久失去
 *          【骨疽】，获得【蚕食】。
 * 【蚕食】：有傀的角色使用只以卑弥呼为唯一目标的基本牌或普通锦囊牌时，
 *          卑弥呼可以取消对自己的效果并移除其傀（觉醒后获得）；卑弥呼
 *          使用只指定1名角色的基本牌或普通锦囊牌时，可以额外指定任意
 *          数量带傀的其他合法角色为目标（无距离限制），这些角色各自
 *          移除傀。
 */

const ZONGKUI = 'zongkui'
const GUJU = 'guju'
const BAIJIA = 'baijia'
const CANSHI = 'canshi'
const KUI_MARK = 'kui'
const GUJU_COUNT_MARK = 'guju-count'

function playerOf(state: SanguoshaState, playerId: PlayerId) {
  return state.players.find((candidate) => candidate.id === playerId)
}

function hasKui(state: SanguoshaState, playerId: PlayerId): boolean {
  return (playerOf(state, playerId)?.marks[KUI_MARK] ?? 0) > 0
}

registerSkillRuntime({
  id: ZONGKUI,
  triggers: [
    {
      event: 'TurnStart',
      handle(host, ownerId, context) {
        if (context.event.targetId !== ownerId && context.event.sourceId !== ownerId) return
        // 每个角色的回合开始前都问一次：谁的回合都可以发动
        const owner = playerOf(host.state, ownerId)
        if (!owner?.alive) return
        const candidateIds = host.state.players.filter((candidate) => candidate.alive && candidate.id !== ownerId && !hasKui(host.state, candidate.id)).map((candidate) => candidate.id)
        if (candidateIds.length === 0) return
        host.queueSkill({ skillId: ZONGKUI, ownerId, step: 'a', data: { candidateIds } })
      },
    },
    {
      event: 'RoundStart',
      handle(host, ownerId) {
        const owner = playerOf(host.state, ownerId)
        if (!owner?.alive) return
        const others = host.state.players.filter((candidate) => candidate.alive && candidate.id !== ownerId && !hasKui(host.state, candidate.id))
        if (others.length === 0) return
        const minHp = Math.min(...others.map((candidate) => candidate.hp))
        const candidateIds = others.filter((candidate) => candidate.hp === minHp).map((candidate) => candidate.id)
        if (candidateIds.length === 1) {
          giveKui(host, ownerId, candidateIds[0])
          return
        }
        host.queueSkill({ skillId: ZONGKUI, ownerId, step: 'b', data: { candidateIds } })
      },
    },
  ],

  startQueued(host, ownerId, prompt) {
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    if (prompt.step === 'a') {
      const { candidateIds } = prompt.data as { candidateIds: PlayerId[] }
      host.askSkill({
        skillId: ZONGKUI, ownerId, step: 'a',
        build: (requestId): ChooseTargetsRequest => ({
          id: requestId, kind: 'choose-targets', playerId: ownerId,
          prompt: '【纵傀】：选择一名没有傀的其他角色', timeoutMs: 20_000, optional: true, candidateIds, min: 0, max: 1,
        }),
      })
      return
    }
    if (prompt.step === 'b') {
      const { candidateIds } = prompt.data as { candidateIds: PlayerId[] }
      host.askSkill({
        skillId: ZONGKUI, ownerId, step: 'b',
        build: (requestId): ChooseTargetsRequest => ({
          id: requestId, kind: 'choose-targets', playerId: ownerId,
          prompt: '【纵傀】：体力最少的角色中选择一名获得傀', timeoutMs: 20_000, optional: false, candidateIds, min: 1, max: 1,
        }),
      })
    }
  },

  resume(host, ownerId, _resolution, response) {
    const [targetId] = (response.payload as { targetIds?: PlayerId[] }).targetIds ?? []
    if (!targetId) return
    giveKui(host, ownerId, targetId)
  },
})

function giveKui(host: SkillHost, ownerId: PlayerId, targetId: PlayerId): void {
  const owner = playerOf(host.state, ownerId)
  const target = playerOf(host.state, targetId)
  if (!owner?.alive || !target?.alive || hasKui(host.state, targetId)) return
  target.marks[KUI_MARK] = 1
  host.dispatch('SkillActivated', { skillId: ZONGKUI, skillName: '纵傀', playerId: ownerId, targetId, logText: `${owner.nickname}发动【纵傀】` }, { sourceId: ownerId, targetId })
}

registerSkillRuntime({
  id: GUJU,
  triggers: [{
    event: 'Damaged',
    handle(host, ownerId, context) {
      const targetId = context.event.targetId
      if (!targetId || !hasKui(host.state, targetId)) return
      const owner = playerOf(host.state, ownerId)
      if (!owner?.alive) return
      drawCards(host.state, host.rng, ownerId, 1, (name, payload) => { host.dispatch(name, payload) })
      owner.marks[GUJU_COUNT_MARK] = (owner.marks[GUJU_COUNT_MARK] ?? 0) + 1
    },
  }],
})

registerSkillRuntime({
  id: BAIJIA,
  awakening: {
    phase: 'prepare',
    ready(state, ownerId) {
      return (playerOf(state, ownerId)?.marks[GUJU_COUNT_MARK] ?? 0) >= 7
    },
    invoke(host, ownerId) {
      const owner = playerOf(host.state, ownerId)
      if (!owner?.alive) return
      gainMaxHp(host as never, ownerId, 1, BAIJIA)
      recover(host as never, ownerId, 1, ownerId)
      for (const candidate of host.state.players) {
        if (candidate.alive && candidate.id !== ownerId && !hasKui(host.state, candidate.id)) candidate.marks[KUI_MARK] = 1
      }
      grantSkill(host.state, ownerId, CANSHI)
      host.dispatch('SkillActivated', { skillId: BAIJIA, skillName: '拜假', playerId: ownerId, logText: `${owner.nickname}发动【拜假】，觉醒` }, { sourceId: ownerId })
    },
  },
})

registerSkillRuntime({
  id: CANSHI,

  interceptTarget(host, ownerId, context) {
    if (context.category !== 'basic' && context.category !== 'trick') return false
    if (!hasKui(host.state, context.sourceId)) return false
    const resolution = host.state.cardResolution
    const isSoleTarget = resolution?.kind === 'slash'
      ? resolution.remainingTargetIds.length === 0
      : resolution?.kind === 'trick' && resolution.targetIds.length === 1
    if (!isSoleTarget) return false
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return false
    host.askSkill({
      skillId: CANSHI, ownerId, step: 'defend', data: { sourceId: context.sourceId },
      build: (requestId): ChooseOptionRequest => ({
        id: requestId, kind: 'choose-option', playerId: ownerId,
        prompt: '【蚕食】：取消这张牌对你的效果，并移除使用者的傀？', timeoutMs: 20_000, optional: true,
        options: [{ id: 'yes', label: '发动' }, { id: 'no', label: '不发动' }],
      }),
    })
    return true
  },

  interceptSourceTarget(host, ownerId, context) {
    if (context.category !== 'basic' && context.category !== 'trick') return false
    const resolution = host.state.cardResolution
    const isSingleTargeted = resolution?.kind === 'slash'
      ? resolution.remainingTargetIds.length === 0
      : resolution?.kind === 'trick' && resolution.targetIds.length === 1
    if (!isSingleTargeted) return false
    const extra = host.state.players.filter((candidate) => candidate.alive && candidate.id !== ownerId && candidate.id !== context.targetId && hasKui(host.state, candidate.id) && canTarget(host.state, ownerId, candidate.id)).map((candidate) => candidate.id)
    if (extra.length === 0) return false
    host.askSkill({
      skillId: CANSHI, ownerId, step: 'attack',
      build: (requestId): ChooseTargetsRequest => ({
        id: requestId, kind: 'choose-targets', playerId: ownerId,
        prompt: '【蚕食】：额外指定任意数量带傀的角色为目标', timeoutMs: 20_000, optional: true, candidateIds: extra, min: 0, max: extra.length,
      }),
    })
    return true
  },

  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'defend') {
      if ((response.payload as { optionId?: string }).optionId !== 'yes') { host.resumeCardTarget(); return }
      const { sourceId } = resolution.data as { sourceId: PlayerId }
      const owner = playerOf(host.state, ownerId)
      const source = playerOf(host.state, sourceId)
      const current = host.state.cardResolution
      if (!owner?.alive || (current?.kind !== 'slash' && current?.kind !== 'trick')) { host.resumeCardTarget(); return }
      if (current.kind === 'slash') current.targetCancelled = true
      else if (!current.cancelledTargetIds.includes(ownerId)) current.cancelledTargetIds.push(ownerId)
      if (source) source.marks[KUI_MARK] = 0
      host.dispatch('SkillActivated', { skillId: CANSHI, skillName: '蚕食', playerId: ownerId, logText: `${owner.nickname}发动【蚕食】，效果无效` }, { sourceId: ownerId })
      host.resumeCardTarget()
      return
    }
    if (resolution.step === 'attack') {
      const targetIds = (response.payload as { targetIds?: PlayerId[] }).targetIds ?? []
      const current = host.state.cardResolution
      for (const targetId of targetIds) {
        const target = playerOf(host.state, targetId)
        if (!target?.alive) continue
        if (current?.kind === 'slash' && !current.remainingTargetIds.includes(targetId)) current.remainingTargetIds.push(targetId)
        else if (current?.kind === 'trick' && !current.targetIds.includes(targetId)) current.targetIds.push(targetId)
        target.marks[KUI_MARK] = 0
      }
      if (targetIds.length > 0) {
        host.dispatch('SkillActivated', { skillId: CANSHI, skillName: '蚕食', playerId: ownerId, logText: `${playerOf(host.state, ownerId)?.nickname}发动【蚕食】，额外指定目标` }, { sourceId: ownerId })
      }
      host.resumeCardTarget()
    }
  },
})

export const BEIMIHU: CharacterDefinition = {
  id: 'beimihu',
  name: '卑弥呼',
  kingdom: 'qun',
  gender: 'female',
  maxHp: 3,
  pack: 'sp',
  skills: [
    { id: ZONGKUI, name: '纵傀', description: '每个回合开始前，可以选择一名没有傀的其他角色令其获得傀；每轮开始时，当前体力最少且没有傀的其他角色之一自动获得傀（多人并列由卑弥呼选择）。' },
    { id: GUJU, name: '骨疽', description: '锁定技，带有傀的角色受到一次伤害后，卑弥呼摸1张牌。' },
    { id: BAIJIA, name: '拜假', description: '觉醒技，骨疽累计摸牌数达到7且未觉醒时，准备阶段强制觉醒：体力上限+1，回复1点，所有没有傀的其他角色获得傀，永久失去【骨疽】，获得【蚕食】。' },
    { id: CANSHI, name: '蚕食', description: '有傀的角色使用只以卑弥呼为唯一目标的基本牌或普通锦囊牌时，卑弥呼可以取消对自己的效果并移除其傀；卑弥呼使用只指定1名角色的基本牌或普通锦囊牌时，可以额外指定任意数量带傀的其他角色为目标（无距离限制），这些角色各自移除傀（觉醒后获得）。', granted: true },
  ],
}
