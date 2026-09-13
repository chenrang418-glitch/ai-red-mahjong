import { swapHands } from '../../engine/hand-transfer'
import { drawCards } from '../../engine/draw'
import { registerSkillRuntime } from '../../engine/skills/runtime'
import type { ChooseOptionRequest, ChooseTargetsRequest } from '../../engine/requests'
import type { PlayerId, SanguoshaState } from '../../engine/types'
import type { CharacterDefinition } from './types'

/**
 * 鲁芝（三国杀 OL 经典身份 SP，建议 ID `luzhi_sp` 以避免与卢植 `luzhi` 冲突）。
 *
 * 【清忠】：出牌阶段开始时，可以摸2张牌；出牌阶段结束时，与当前手牌数
 *          最少的其他角色交换全部手牌（她自己若并列最少则忽略她）。
 * 【卫境】：每轮限一次，可以视为使用一张杀，或在需要打出闪时视为打出
 *          一张闪。
 */

const QINGZHONG = 'qingzhong'
const WEIJING = 'weijing'

function playerOf(state: SanguoshaState, playerId: PlayerId) {
  return state.players.find((candidate) => candidate.id === playerId)
}

function weijingAvailable(state: SanguoshaState, ownerId: PlayerId): boolean {
  const owner = playerOf(state, ownerId)
  return Boolean(owner?.alive) && owner!.marks['weijing-round'] !== state.roundNumber
}

registerSkillRuntime({
  id: QINGZHONG,
  triggers: [
    {
      event: 'PhaseStart',
      handle(host, ownerId, context) {
        const payload = context.event.payload as { phase?: string; playerId?: PlayerId }
        if (payload.phase !== 'play' || payload.playerId !== ownerId) return
        host.queueSkill({ skillId: QINGZHONG, ownerId, step: 'ask-draw', data: {} })
      },
    },
    {
      event: 'PhaseEnd',
      handle(host, ownerId, context) {
        const payload = context.event.payload as { phase?: string; playerId?: PlayerId }
        if (payload.phase !== 'play' || payload.playerId !== ownerId) return
        const owner = playerOf(host.state, ownerId)
        if (!owner?.alive) return
        const alive = host.state.players.filter((candidate) => candidate.alive)
        const minCount = Math.min(...alive.map((candidate) => candidate.zones.hand.length))
        const candidateIds = alive.filter((candidate) => candidate.id !== ownerId && candidate.zones.hand.length === minCount).map((candidate) => candidate.id)
        if (candidateIds.length === 0) return
        host.queueSkill({ skillId: QINGZHONG, ownerId, step: 'pick-swap', data: { candidateIds } })
      },
    },
  ],
  startQueued(host, ownerId, prompt) {
    if (prompt.step === 'ask-draw') {
      const owner = playerOf(host.state, ownerId)
      if (!owner?.alive) return
      host.askSkill({
        skillId: QINGZHONG, ownerId, step: 'ask-draw', data: {},
        build: (requestId): ChooseOptionRequest => ({
          id: requestId, kind: 'choose-option', playerId: ownerId,
          prompt: '【清忠】：是否摸2张牌？', timeoutMs: 20_000, optional: true,
          options: [{ id: 'yes', label: '摸2张牌' }, { id: 'no', label: '不发动' }],
        }),
      })
      return
    }
    if (prompt.step === 'pick-swap') {
      const { candidateIds } = prompt.data as { candidateIds: PlayerId[] }
      host.askSkill({
        skillId: QINGZHONG, ownerId, step: 'pick-swap', data: {},
        build: (requestId): ChooseTargetsRequest => ({
          id: requestId, kind: 'choose-targets', playerId: ownerId,
          prompt: '【清忠】：选择手牌数最少的一名角色，交换全部手牌', timeoutMs: 20_000, optional: false,
          candidateIds, min: 1, max: 1,
        }),
      })
    }
  },
  resume(host, ownerId, resolution, response) {
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    if (resolution.step === 'ask-draw') {
      if ((response.payload as { optionId?: string }).optionId !== 'yes') return
      host.dispatch('SkillActivated', { skillId: QINGZHONG, skillName: '清忠', playerId: ownerId, logText: `${owner.nickname}发动【清忠】，摸2张牌` }, { sourceId: ownerId })
      drawCards(host.state, host.rng, ownerId, 2, (name, payload) => { host.dispatch(name, payload) })
      return
    }
    if (resolution.step === 'pick-swap') {
      const [targetId] = (response.payload as { targetIds?: PlayerId[] }).targetIds ?? []
      const target = targetId ? playerOf(host.state, targetId) : undefined
      if (!target?.alive) return
      host.dispatch('SkillActivated', { skillId: QINGZHONG, skillName: '清忠', playerId: ownerId, targetId, logText: `${owner.nickname}发动【清忠】，与${target.nickname}交换全部手牌` }, { sourceId: ownerId, targetId })
      swapHands(host as never, ownerId, targetId, QINGZHONG)
    }
  },
})

registerSkillRuntime({
  id: WEIJING,
  activeActions(state, ownerId) {
    if (state.phase !== 'play' || state.currentPlayerId !== ownerId) return []
    if (!weijingAvailable(state, ownerId)) return []
    const candidateIds = state.players.filter((candidate) => candidate.alive && candidate.id !== ownerId).map((candidate) => candidate.id)
    if (candidateIds.length === 0) return []
    return [{ id: WEIJING, label: '卫境：视为使用一张杀' }]
  },
  invokeActive(host, ownerId, actionId) {
    if (actionId !== WEIJING || !weijingAvailable(host.state, ownerId)) return
    const candidateIds = host.state.players.filter((candidate) => candidate.alive && candidate.id !== ownerId).map((candidate) => candidate.id)
    if (candidateIds.length === 0) return
    host.askSkill({
      skillId: WEIJING, ownerId, step: 'pick-target', data: {},
      build: (requestId): ChooseTargetsRequest => ({
        id: requestId, kind: 'choose-targets', playerId: ownerId,
        prompt: '【卫境】：选择杀的目标', timeoutMs: 20_000, optional: false,
        candidateIds, min: 1, max: 1,
      }),
    })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'pick-target') return
    const owner = playerOf(host.state, ownerId)
    const [targetId] = (response.payload as { targetIds?: PlayerId[] }).targetIds ?? []
    if (!owner?.alive || !targetId || !playerOf(host.state, targetId)?.alive || !weijingAvailable(host.state, ownerId)) return
    owner.marks['weijing-round'] = host.state.roundNumber
    host.dispatch('SkillActivated', { skillId: WEIJING, skillName: '卫境', playerId: ownerId, targetId, logText: `${owner.nickname}发动【卫境】，视为使用一张杀` }, { sourceId: ownerId, targetId })
    host.beginVirtualSlash({ sourceId: ownerId, targetId, sourceSkillId: WEIJING, countUsage: false })
  },
  virtualDodge(state, ownerId, sourceId) {
    void sourceId
    return weijingAvailable(state, ownerId)
  },
  consumeVirtualDodge(host, ownerId) {
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    owner.marks['weijing-round'] = host.state.roundNumber
    host.dispatch('SkillActivated', { skillId: WEIJING, skillName: '卫境', playerId: ownerId, logText: `${owner.nickname}发动【卫境】，视为打出一张闪` }, { sourceId: ownerId })
  },
})

export const LUZHI_SP: CharacterDefinition = {
  id: 'luzhi_sp',
  name: '鲁芝',
  kingdom: 'wei',
  gender: 'male',
  maxHp: 3,
  pack: 'sp',
  skills: [
    { id: QINGZHONG, name: '清忠', description: '出牌阶段开始时，可以摸2张牌；出牌阶段结束时，与当前手牌数最少的其他角色交换全部手牌。' },
    { id: WEIJING, name: '卫境', description: '每轮限一次，可以视为使用一张杀，或在需要打出闪时视为打出一张闪。' },
  ],
}
