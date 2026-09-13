import { registerSkillRuntime } from '../../engine/skills/runtime'
import type { ChooseOptionsRequest, ChooseTargetsRequest } from '../../engine/requests'
import type { PlayerId, SanguoshaState } from '../../engine/types'
import type { CharacterDefinition } from './types'

/**
 * 陈登（三国杀 OL 经典身份 SP）。
 *
 * 【丰积】：每轮开始时，陈登可以在"自己本轮摸牌数-1"和"自己本轮出杀
 *          次数-1"中选择至多2项，每选一项需再选一名其他角色，令其获得
 *          对应+2；没有选择的项目自己+1。所有 modifier 持续当前 Round
 *          （监听 `DrawPhase` 事件改写摸牌数，出杀次数复用既有
 *          `globalSlashUses` 聚合）。
 * 【旋回】：陈登准备阶段，可以与本轮仍拥有丰积 modifier 的另一名角色
 *          交换双方由丰积产生的 modifier；发动后失效，直到任意角色死亡
 *          才恢复可用。
 */

const FENGJI = 'fengji'
const XUANHUI = 'xuanhui'

function playerOf(state: SanguoshaState, playerId: PlayerId) {
  return state.players.find((candidate) => candidate.id === playerId)
}

function entryOf(state: SanguoshaState, playerId: PlayerId) {
  const entry = state.chendengModifiers?.[playerId]
  return entry?.roundNumber === state.roundNumber ? entry : null
}

function setDelta(state: SanguoshaState, playerId: PlayerId, drawDelta: number, slashDelta: number): void {
  state.chendengModifiers ??= {}
  const current = entryOf(state, playerId)
  state.chendengModifiers[playerId] = {
    roundNumber: state.roundNumber,
    drawDelta: (current?.drawDelta ?? 0) + drawDelta,
    slashDelta: (current?.slashDelta ?? 0) + slashDelta,
  }
}

registerSkillRuntime({
  id: FENGJI,
  triggers: [
    {
      event: 'RoundStart',
      handle(host, ownerId) {
        const owner = playerOf(host.state, ownerId)
        if (!owner?.alive) return
        if (!host.state.players.some((candidate) => candidate.alive && candidate.id !== ownerId)) return
        host.queueSkill({ skillId: FENGJI, ownerId, step: 'choose', data: {} })
      },
    },
    {
      event: 'DrawPhase',
      handle(host, _ownerId, context) {
        const payload = context.event.payload as { playerId?: PlayerId; count?: number }
        if (!payload.playerId) return
        const entry = entryOf(host.state, payload.playerId)
        if (!entry || entry.drawDelta === 0) return
        context.event.payload = { ...payload, count: Math.max(0, (payload.count ?? 2) + entry.drawDelta) }
      },
    },
  ],

  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'choose') return
    if (!playerOf(host.state, ownerId)?.alive) return
    host.askSkill({
      skillId: FENGJI, ownerId, step: 'choose',
      build: (requestId): ChooseOptionsRequest => ({
        id: requestId, kind: 'choose-options', playerId: ownerId,
        prompt: '【丰积】：选择至多2项', timeoutMs: 20_000, optional: true, min: 0, max: 2,
        options: [{ id: 'draw', label: '本轮摸牌数-1' }, { id: 'slash', label: '本轮出杀次数-1' }],
      }),
    })
  },

  resume(host, ownerId, resolution, response) {
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return

    if (resolution.step === 'choose') {
      const chosen = (response.payload as { optionIds?: string[] }).optionIds ?? []
      if (chosen.includes('draw')) setDelta(host.state, ownerId, -1, 0)
      if (chosen.includes('slash')) setDelta(host.state, ownerId, 0, -1)
      if (!chosen.includes('draw') && !chosen.includes('slash')) {
        setDelta(host.state, ownerId, 1, 1)
        return
      }
      host.dispatch('SkillActivated', { skillId: FENGJI, skillName: '丰积', playerId: ownerId, logText: `${owner.nickname}发动【丰积】` }, { sourceId: ownerId })
      host.queueSkill({ skillId: FENGJI, ownerId, step: 'target', data: { remaining: chosen } })
      return
    }

    if (resolution.step === 'target') {
      const { remaining } = resolution.data as { remaining: string[] }
      const [kind, ...rest] = remaining
      const [targetId] = (response.payload as { targetIds?: PlayerId[] }).targetIds ?? []
      const target = targetId ? playerOf(host.state, targetId) : undefined
      if (target?.alive) setDelta(host.state, targetId, kind === 'draw' ? 2 : 0, kind === 'slash' ? 2 : 0)
      if (rest.length === 0) return
      const others = host.state.players.filter((candidate) => candidate.alive && candidate.id !== ownerId).map((candidate) => candidate.id)
      host.askSkill({
        skillId: FENGJI, ownerId, step: 'target', data: { remaining: rest },
        build: (requestId): ChooseTargetsRequest => ({
          id: requestId, kind: 'choose-targets', playerId: ownerId,
          prompt: `【丰积】：选择一名其他角色获得${rest[0] === 'draw' ? '摸牌+2' : '出杀次数+2'}`, timeoutMs: 20_000, optional: false, candidateIds: others, min: 1, max: 1,
        }),
      })
    }
  },

  globalSlashUses(state, _ownerId, targetId) {
    return entryOf(state, targetId)?.slashDelta ?? 0
  },
})

registerSkillRuntime({
  id: XUANHUI,
  triggers: [{
    event: 'Death',
    handle(host, ownerId) {
      if (host.state.chendengXuanhuiDisabled?.[ownerId]) delete host.state.chendengXuanhuiDisabled[ownerId]
    },
  }],

  activeActions(state, ownerId) {
    if (state.phase !== 'prepare' || state.currentPlayerId !== ownerId) return []
    if (state.chendengXuanhuiDisabled?.[ownerId]) return []
    const owner = playerOf(state, ownerId)
    if (!owner?.alive) return []
    const eligible = state.players.some((candidate) => candidate.alive && candidate.id !== ownerId && entryOf(state, candidate.id))
    return eligible ? [{ id: XUANHUI, label: '旋回：与本轮仍有丰积效果的角色交换 modifier' }] : []
  },

  invokeActive(host, ownerId, actionId) {
    if (actionId !== XUANHUI || host.state.chendengXuanhuiDisabled?.[ownerId]) return
    const candidateIds = host.state.players.filter((candidate) => candidate.alive && candidate.id !== ownerId && entryOf(host.state, candidate.id)).map((candidate) => candidate.id)
    if (candidateIds.length === 0) return
    host.askSkill({
      skillId: XUANHUI, ownerId, step: 'pick',
      build: (requestId): ChooseTargetsRequest => ({
        id: requestId, kind: 'choose-targets', playerId: ownerId,
        prompt: '【旋回】：选择一名角色交换丰积效果', timeoutMs: 20_000, optional: false, candidateIds, min: 1, max: 1,
      }),
    })
  },

  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'pick') return
    const [targetId] = (response.payload as { targetIds?: PlayerId[] }).targetIds ?? []
    const owner = playerOf(host.state, ownerId)
    const target = targetId ? playerOf(host.state, targetId) : undefined
    if (!owner?.alive || !target?.alive) return
    const mine = entryOf(host.state, ownerId)
    const theirs = entryOf(host.state, targetId)
    host.state.chendengModifiers ??= {}
    if (theirs) host.state.chendengModifiers[ownerId] = theirs
    else delete host.state.chendengModifiers[ownerId]
    if (mine) host.state.chendengModifiers[targetId] = mine
    else delete host.state.chendengModifiers[targetId]
    host.state.chendengXuanhuiDisabled ??= {}
    host.state.chendengXuanhuiDisabled[ownerId] = true
    host.dispatch('SkillActivated', { skillId: XUANHUI, skillName: '旋回', playerId: ownerId, targetId, logText: `${owner.nickname}发动【旋回】` }, { sourceId: ownerId, targetId })
  },
})

export const CHENDENG: CharacterDefinition = {
  id: 'chendeng',
  name: '陈登',
  kingdom: 'qun',
  gender: 'male',
  maxHp: 4,
  pack: 'sp',
  skills: [
    { id: FENGJI, name: '丰积', description: '每轮开始时，可以选择至多2项（本轮摸牌数-1/本轮出杀次数-1），每选一项需选一名其他角色令其对应+2；没有选择的项目自己+1，持续本轮。' },
    { id: XUANHUI, name: '旋回', description: '准备阶段，可以与本轮仍有丰积效果的另一名角色交换其 modifier；发动后失效，直到任意角色死亡才恢复。' },
  ],
}
