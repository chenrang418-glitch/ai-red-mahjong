import { drawCards } from '../../engine/draw'
import { loseHp } from '../../engine/hp'
import { skillIdsOf } from '../../data/characters/standard'
import { registerSkillRuntime } from '../../engine/skills/runtime'
import type { ChooseTargetsRequest } from '../../engine/requests'
import type { PlayerId, SanguoshaState } from '../../engine/types'
import type { CharacterDefinition } from './types'

/**
 * 朱灵（三国杀 OL 经典身份 SP）。
 *
 * 【急陷】：摸牌阶段结束时，选择一名其他角色A，A满足以下条件的数量为
 *          X（1~3）：装备区有防具；武将技能数多于朱灵；当前未受伤。视为
 *          对A使用一张【杀】，然后摸X张牌；若这张杀结算后未造成伤害，
 *          朱灵失去1点体力。
 */

const JIXIAN = 'jixian'

function playerOf(state: SanguoshaState, playerId: PlayerId) {
  return state.players.find((candidate) => candidate.id === playerId)
}

function conditionCount(state: SanguoshaState, ownerId: PlayerId, targetId: PlayerId): number {
  const owner = playerOf(state, ownerId)
  const target = playerOf(state, targetId)
  if (!owner || !target) return 0
  let count = 0
  if (target.zones.equipment.armor) count += 1
  if (skillIdsOf(target.characterId ?? '').length > skillIdsOf(owner.characterId ?? '').length) count += 1
  if (target.hp >= target.maxHp) count += 1
  return count
}

registerSkillRuntime({
  id: JIXIAN,
  triggers: [{
    event: 'PhaseEnd',
    handle(host, ownerId, context) {
      const payload = context.event.payload as { phase?: string; playerId?: PlayerId }
      if (payload.phase !== 'draw' || payload.playerId !== ownerId) return
      const owner = playerOf(host.state, ownerId)
      if (!owner?.alive) return
      const candidateIds = host.state.players.filter((candidate) => candidate.alive && candidate.id !== ownerId && conditionCount(host.state, ownerId, candidate.id) >= 1).map((candidate) => candidate.id)
      if (candidateIds.length === 0) return
      host.queueSkill({ skillId: JIXIAN, ownerId, step: 'pick-target', data: { candidateIds } })
    },
  }, {
    event: 'Damaged',
    handle(host, ownerId, context) {
      const pending = host.state.zhulingPending
      if (!pending || pending.turnNumber !== host.state.turnNumber || context.event.sourceId !== ownerId || context.event.targetId !== pending.targetId) return
      pending.dealt = true
    },
  }, {
    event: 'CardResolved',
    handle(host, ownerId, context) {
      const pending = host.state.zhulingPending
      if (!pending || pending.turnNumber !== host.state.turnNumber || context.event.sourceId !== ownerId) return
      host.state.zhulingPending = undefined
      if (pending.dealt) return
      const owner = playerOf(host.state, ownerId)
      if (!owner?.alive) return
      loseHp(host as never, ownerId, 1, JIXIAN)
    },
  }],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'pick-target') return
    const { candidateIds } = prompt.data as { candidateIds: PlayerId[] }
    host.askSkill({
      skillId: JIXIAN, ownerId, step: 'pick-target', data: {},
      build: (requestId): ChooseTargetsRequest => ({
        id: requestId, kind: 'choose-targets', playerId: ownerId,
        prompt: '【急陷】：选择一名符合条件的角色', timeoutMs: 20_000, optional: true,
        candidateIds, min: 0, max: 1,
      }),
    })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'pick-target') return
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    const [targetId] = (response.payload as { targetIds?: PlayerId[] }).targetIds ?? []
    const target = targetId ? playerOf(host.state, targetId) : undefined
    if (!target?.alive) return
    const x = conditionCount(host.state, ownerId, targetId)
    if (x === 0) return
    host.dispatch('SkillActivated', { skillId: JIXIAN, skillName: '急陷', playerId: ownerId, logText: `${owner.nickname}发动【急陷】，对${target.nickname}视为使用一张杀` }, { sourceId: ownerId, targetId })
    host.state.zhulingPending = { turnNumber: host.state.turnNumber, targetId, dealt: false }
    host.beginVirtualSlash({ sourceId: ownerId, targetId, sourceSkillId: JIXIAN })
    drawCards(host.state, host.rng, ownerId, x, (name, payload) => { host.dispatch(name, payload) })
  },
})

export const ZHULING: CharacterDefinition = {
  id: 'zhuling',
  name: '朱灵',
  kingdom: 'wei',
  gender: 'male',
  maxHp: 4,
  pack: 'sp',
  skills: [
    { id: JIXIAN, name: '急陷', description: '摸牌阶段结束时，选择一名其他角色A，X=A满足"有防具/技能数多于你/未受伤"的条件数（1~3），视为对A使用一张【杀】，然后摸X张牌；若未造成伤害，你失去1点体力。' },
  ],
}
