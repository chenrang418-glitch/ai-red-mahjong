import { moveCard } from '../../engine/zones'
import { loseHp } from '../../engine/hp'
import { reshuffleDrawPile } from '../../engine/deck'
import { registerSkillRuntime } from '../../engine/skills/runtime'
import type { ChooseOptionRequest, ChooseTargetsRequest } from '../../engine/requests'
import type { PlayerId, SanguoshaState } from '../../engine/types'
import type { CharacterDefinition } from './types'

/**
 * 吴苋（三国杀 OL 经典身份 SP）。
 *
 * 【福绵】：准备阶段，选择一项：本回合摸牌阶段额外摸1张；或本回合限一次，
 *          使用红色基本牌/红色普通锦囊可以额外指定1个无距离限制的目标
 *          （只对红色杀生效）。若与上一次选择的选项不同，本次数值+1。
 * 【怠宴】：结束阶段，可以选择一名其他角色，令其获得牌堆中1张红桃基本牌；
 *          若上一次（你自己的回合）怠宴也对其发动过，其失去1点体力。
 */

const FUMIAN = 'fumian'
const DAIYAN = 'daiyan'

function playerOf(state: SanguoshaState, playerId: PlayerId) {
  return state.players.find((candidate) => candidate.id === playerId)
}

registerSkillRuntime({
  id: FUMIAN,
  triggers: [
    {
      event: 'PhaseStart',
      handle(host, ownerId, context) {
        const payload = context.event.payload as { phase?: string; playerId?: PlayerId }
        if (payload.phase !== 'prepare' || payload.playerId !== ownerId) return
        host.queueSkill({ skillId: FUMIAN, ownerId, step: 'ask', data: {} })
      },
    },
    {
      event: 'DrawPhase',
      handle(host, ownerId, context) {
        const payload = context.event.payload as { playerId?: PlayerId; count?: number }
        if (payload.playerId !== ownerId) return
        const owner = playerOf(host.state, ownerId)
        if (owner?.marks['fumian-draw-turn'] !== host.state.turnNumber) return
        payload.count = (typeof payload.count === 'number' ? payload.count : 2) + (owner.marks['fumian-draw-bonus'] ?? 1)
      },
    },
  ],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'ask') return
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    host.askSkill({
      skillId: FUMIAN, ownerId, step: 'ask', data: {},
      build: (requestId): ChooseOptionRequest => ({
        id: requestId, kind: 'choose-option', playerId: ownerId,
        prompt: '【福绵】：选择一项', timeoutMs: 20_000, optional: false,
        options: [
          { id: 'draw', label: '本回合摸牌阶段额外摸1张' },
          { id: 'target', label: '本回合限一次，使用红色杀可以额外指定1个无距离限制的目标' },
        ],
      }),
    })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'ask') return
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    const choice = (response.payload as { optionId?: string }).optionId === 'target' ? 'target' : 'draw'
    const last = host.state.wuxianLastChoice
    const boost = last && last !== choice ? 1 : 0
    host.state.wuxianLastChoice = choice
    host.dispatch('SkillActivated', { skillId: FUMIAN, skillName: '福绵', playerId: ownerId, logText: `${owner.nickname}发动【福绵】` }, { sourceId: ownerId })
    if (choice === 'draw') {
      owner.marks['fumian-draw-turn'] = host.state.turnNumber
      owner.marks['fumian-draw-bonus'] = 1 + boost
    } else {
      owner.marks['fumian-target-turn'] = host.state.turnNumber
      owner.marks['fumian-target-bonus'] = 1 + boost
    }
  },
  extraSlashTargets(state, ownerId, nature) {
    const owner = playerOf(state, ownerId)
    if (!owner || owner.marks['fumian-target-turn'] !== state.turnNumber) return 0
    if (nature !== 'normal') return 0
    return owner.marks['fumian-target-bonus'] ?? 0
  },
  ignoresDistanceTo(state, sourceId, targetId, cardId) {
    void targetId
    const owner = playerOf(state, sourceId)
    if (!owner || owner.marks['fumian-target-turn'] !== state.turnNumber) return false
    if (!cardId) return false
    return state.cards[cardId]?.name === '杀' && state.cards[cardId]?.color === 'red'
  },
})

registerSkillRuntime({
  id: DAIYAN,
  triggers: [{
    event: 'PhaseStart',
    handle(host, ownerId, context) {
      const payload = context.event.payload as { phase?: string; playerId?: PlayerId }
      if (payload.phase !== 'finish' || payload.playerId !== ownerId) return
      const owner = playerOf(host.state, ownerId)
      if (!owner?.alive) return
      const candidateIds = host.state.players.filter((candidate) => candidate.alive && candidate.id !== ownerId).map((candidate) => candidate.id)
      if (candidateIds.length === 0) return
      host.queueSkill({ skillId: DAIYAN, ownerId, step: 'pick-target', data: { candidateIds } })
    },
  }],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'pick-target') return
    const { candidateIds } = prompt.data as { candidateIds: PlayerId[] }
    host.askSkill({
      skillId: DAIYAN, ownerId, step: 'pick-target', data: {},
      build: (requestId): ChooseTargetsRequest => ({
        id: requestId, kind: 'choose-targets', playerId: ownerId,
        prompt: '【怠宴】：选择一名其他角色', timeoutMs: 20_000, optional: true,
        candidateIds, min: 0, max: 1,
      }),
    })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'pick-target') return
    const [targetId] = (response.payload as { targetIds?: PlayerId[] }).targetIds ?? []
    const owner = playerOf(host.state, ownerId)
    const target = targetId ? playerOf(host.state, targetId) : undefined
    if (!owner?.alive || !target?.alive) return
    if (host.state.zones.drawPile.length === 0) reshuffleDrawPile(host.state, host.rng, (name, payload) => { host.dispatch(name, payload) })
    let cardId = host.state.zones.drawPile.find((id) => host.state.cards[id]?.category === 'basic' && host.state.cards[id]?.suit === 'heart')
    if (!cardId) {
      reshuffleDrawPile(host.state, host.rng, (name, payload) => { host.dispatch(name, payload) })
      cardId = host.state.zones.drawPile.find((id) => host.state.cards[id]?.category === 'basic' && host.state.cards[id]?.suit === 'heart')
    }
    if (!cardId) return
    host.dispatch('SkillActivated', { skillId: DAIYAN, skillName: '怠宴', playerId: ownerId, targetId, logText: `${owner.nickname}发动【怠宴】` }, { sourceId: ownerId, targetId })
    moveCard(host.state, cardId, { kind: 'drawPile' }, { kind: 'hand', playerId: targetId })
    host.dispatch('GainCard', { playerId: targetId, cardIds: [cardId], reason: DAIYAN }, { targetId, cardIds: [cardId] })
    const last = host.state.wuxianDaiyanLastTarget
    host.state.wuxianDaiyanLastTarget = targetId
    if (last === targetId) loseHp(host as never, targetId, 1, DAIYAN)
  },
})

export const WUXIAN: CharacterDefinition = {
  id: 'wuxian',
  name: '吴苋',
  kingdom: 'wu',
  gender: 'female',
  maxHp: 3,
  pack: 'sp',
  skills: [
    { id: FUMIAN, name: '福绵', description: '准备阶段，选择一项：本回合摸牌阶段额外摸1张；或本回合限一次，使用红色杀可以额外指定1个无距离限制的目标。若与上一次选择的选项不同，本次数值+1。' },
    { id: DAIYAN, name: '怠宴', description: '结束阶段，可以选择一名其他角色，令其获得牌堆中1张红桃基本牌；若上一次你自己的回合怠宴也对其发动过，其失去1点体力。' },
  ],
}
