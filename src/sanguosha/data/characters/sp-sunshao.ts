import { drawCards } from '../../engine/draw'
import { moveCard } from '../../engine/zones'
import { DELAYED_TRICKS } from '../../engine/cards/tricks'
import { registerSkillRuntime, type SkillHost } from '../../engine/skills/runtime'
import type { ChooseCardsRequest, ChooseOptionRequest, ChooseTargetsRequest } from '../../engine/requests'
import type { CardId, PlayerId, SanguoshaState } from '../../engine/types'
import type { CharacterDefinition } from './types'

/**
 * 孙邵（三国杀 OL 经典身份 SP）。
 *
 * 【弼政】：摸牌阶段结束时，可以选择一名其他角色A，A摸2张牌，然后孙邵与
 *          A 分别检查：手牌数>体力上限的角色各弃置2张。
 * 【佚典】：孙邵使用基本牌或普通/非延时锦囊指定目标时，若弃牌堆中不存在
 *          同名牌，可以额外指定1名目标（无距离限制，其余合法性仍需满足，
 *          借刀杀人不享受）。
 */

const BIZHENG = 'bizheng'
const YIDIAN = 'yidian'

function playerOf(state: SanguoshaState, playerId: PlayerId) {
  return state.players.find((candidate) => candidate.id === playerId)
}

function askBizhengDiscard(host: SkillHost, ownerId: PlayerId, queue: PlayerId[]): void {
  let remainingQueue = queue
  while (remainingQueue.length > 0) {
    const [next, ...rest] = remainingQueue
    const target = playerOf(host.state, next)
    if (target?.alive && target.zones.hand.length > target.maxHp) {
      const excess = target.zones.hand.length - target.maxHp
      host.askSkill({
        skillId: BIZHENG, ownerId, step: 'discard', data: { queue: rest },
        build: (requestId: string): ChooseCardsRequest => ({
          id: requestId, kind: 'choose-cards', playerId: next,
          prompt: `【弼政】：弃置${excess}张手牌`, timeoutMs: 20_000, optional: false,
          purpose: 'skill', cardIds: [...target.zones.hand], hiddenCardSlots: [], min: excess, max: excess,
        }),
      })
      return
    }
    remainingQueue = rest
  }
}

registerSkillRuntime({
  id: BIZHENG,
  triggers: [{
    event: 'PhaseEnd',
    handle(host, ownerId, context) {
      const payload = context.event.payload as { playerId?: PlayerId; phase?: string }
      if (payload.playerId !== ownerId || payload.phase !== 'draw') return
      const owner = playerOf(host.state, ownerId)
      if (!owner?.alive) return
      host.queueSkill({ skillId: BIZHENG, ownerId, step: 'ask', data: {} })
    },
  }],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'ask') return
    const candidateIds = host.state.players.filter((candidate) => candidate.alive && candidate.id !== ownerId).map((candidate) => candidate.id)
    if (candidateIds.length === 0) return
    host.askSkill({
      skillId: BIZHENG, ownerId, step: 'pick', data: {},
      build: (requestId): ChooseTargetsRequest => ({
        id: requestId, kind: 'choose-targets', playerId: ownerId,
        prompt: '【弼政】：选择一名其他角色', timeoutMs: 20_000, optional: true,
        candidateIds, min: 0, max: 1,
      }),
    })
  },
  resume(host, ownerId, resolution, response) {
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return

    if (resolution.step === 'pick') {
      const [targetId] = (response.payload as { targetIds?: PlayerId[] }).targetIds ?? []
      const target = targetId ? playerOf(host.state, targetId) : undefined
      if (!target?.alive) return
      host.dispatch('SkillActivated', { skillId: BIZHENG, skillName: '弼政', playerId: ownerId, targetId, logText: `${owner.nickname}发动【弼政】` }, { sourceId: ownerId, targetId })
      drawCards(host.state, host.rng, targetId, 2, (name, payload) => { host.dispatch(name, payload) })
      askBizhengDiscard(host, ownerId, [ownerId, targetId])
      return
    }

    if (resolution.step === 'discard') {
      const { queue } = resolution.data as { queue: PlayerId[] }
      const cardIds = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
      const responder = playerOf(host.state, response.playerId)
      const valid = cardIds.filter((id) => responder?.zones.hand.includes(id))
      for (const id of valid) moveCard(host.state, id, { kind: 'hand', playerId: response.playerId }, { kind: 'discardPile' })
      if (valid.length > 0) host.dispatch('LoseCard', { playerId: response.playerId, cardIds: valid, reason: BIZHENG }, { sourceId: response.playerId, cardIds: valid })
      askBizhengDiscard(host, ownerId, queue)
    }
  },
})

registerSkillRuntime({
  id: YIDIAN,
  interceptSourceTarget(host, ownerId, context) {
    if (context.cardName === '借刀杀人') return false
    if (context.category === 'trick' && DELAYED_TRICKS.has(context.cardName)) return false
    if (context.category !== 'basic' && context.category !== 'trick') return false
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return false
    if (host.state.zones.discardPile.some((id) => host.state.cards[id]?.name === context.cardName)) return false
    const resolution = host.state.cardResolution
    if (!resolution) return false
    const currentTargets = resolution.kind === 'trick' ? resolution.targetIds
      : resolution.kind === 'slash' ? [resolution.targetId, ...resolution.remainingTargetIds] : []
    const candidateIds = host.state.players.filter((candidate) => candidate.alive && !currentTargets.includes(candidate.id)).map((candidate) => candidate.id)
    if (candidateIds.length === 0) return false
    host.askSkill({
      skillId: YIDIAN, ownerId, step: 'ask', data: { candidateIds },
      build: (requestId): ChooseOptionRequest => ({
        id: requestId, kind: 'choose-option', playerId: ownerId,
        prompt: '【佚典】：是否额外指定1个目标？', timeoutMs: 20_000, optional: true,
        options: [{ id: 'yes', label: '额外指定目标' }, { id: 'no', label: '不发动' }],
      }),
    })
    return true
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'ask') {
      const { candidateIds } = resolution.data as { candidateIds: PlayerId[] }
      if ((response.payload as { optionId?: string }).optionId !== 'yes') { host.resumeCardTarget(); return }
      host.askSkill({
        skillId: YIDIAN, ownerId, step: 'pick', data: {},
        build: (requestId): ChooseTargetsRequest => ({
          id: requestId, kind: 'choose-targets', playerId: ownerId,
          prompt: '【佚典】：选择额外目标', timeoutMs: 20_000, optional: false,
          candidateIds, min: 1, max: 1,
        }),
      })
      return
    }
    if (resolution.step === 'pick') {
      const [targetId] = (response.payload as { targetIds?: PlayerId[] }).targetIds ?? []
      const current = host.state.cardResolution
      if (targetId && current) {
        if (current.kind === 'trick') current.targetIds.push(targetId)
        else if (current.kind === 'slash') current.remainingTargetIds.push(targetId)
      }
      host.resumeCardTarget()
    }
  },
})

export const SUNSHAO: CharacterDefinition = {
  id: 'sunshao',
  name: '孙邵',
  kingdom: 'wu',
  gender: 'male',
  maxHp: 3,
  pack: 'sp',
  skills: [
    { id: BIZHENG, name: '弼政', description: '摸牌阶段结束时，可以选择一名其他角色，令其摸2张牌，然后你与其分别检查：手牌数大于体力上限的角色各弃置2张。' },
    { id: YIDIAN, name: '佚典', description: '你使用基本牌或普通/非延时锦囊指定目标时，若弃牌堆中不存在同名牌，可以额外指定1名目标（借刀杀人除外）。' },
  ],
}
