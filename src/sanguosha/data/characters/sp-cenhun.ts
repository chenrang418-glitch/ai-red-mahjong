import { drawCards } from '../../engine/draw'
import { setChained } from '../../engine/character-state'
import { maxCardsOf } from '../../engine/phase'
import { registerSkillRuntime } from '../../engine/skills/runtime'
import type { ChooseTargetsRequest } from '../../engine/requests'
import type { PlayerId, SanguoshaState } from '../../engine/types'
import type { CharacterDefinition } from './types'

/**
 * 岑昏（三国杀 OL 经典身份 SP）。
 *
 * 【极奢】：出牌阶段，若你当前手牌上限大于0，可以摸1张牌，然后本回合手牌
 *          上限-1（可反复发动直到手牌上限为0）；结束阶段，若你当前手牌数
 *          为0，可以令至多X名未处于连环状态的角色进入连环状态（X为你的
 *          体力值）。
 * 【链祸】：锁定技，你处于连环状态时受到的火焰伤害，若这是本次属性伤害
 *          传导的起点，则伤害+1。
 */

const JISHE = 'jishe'
const LIANHUO = 'lianhuo'

function playerOf(state: SanguoshaState, playerId: PlayerId) {
  return state.players.find((candidate) => candidate.id === playerId)
}

function jisheDelta(state: SanguoshaState, ownerId: PlayerId): number {
  const owner = playerOf(state, ownerId)
  return owner?.marks['jishe-turn'] === state.turnNumber ? (owner.marks['jishe-delta'] ?? 0) : 0
}

registerSkillRuntime({
  id: JISHE,
  maxCardsBonus(state, ownerId) { return jisheDelta(state, ownerId) },
  activeActions(state, ownerId) {
    if (state.phase !== 'play' || state.currentPlayerId !== ownerId) return []
    const owner = playerOf(state, ownerId)
    if (!owner?.alive || maxCardsOf(state, ownerId) <= 0) return []
    return [{ id: JISHE, label: '极奢：摸1张牌，本回合手牌上限-1' }]
  },
  invokeActive(host, ownerId, actionId) {
    if (actionId !== JISHE) return
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive || maxCardsOf(host.state, ownerId) <= 0) return
    if (owner.marks['jishe-turn'] !== host.state.turnNumber) { owner.marks['jishe-turn'] = host.state.turnNumber; owner.marks['jishe-delta'] = 0 }
    owner.marks['jishe-delta'] = (owner.marks['jishe-delta'] ?? 0) - 1
    host.dispatch('SkillActivated', { skillId: JISHE, skillName: '极奢', playerId: ownerId, logText: `${owner.nickname}发动【极奢】，摸1张牌，手牌上限-1` }, { sourceId: ownerId })
    drawCards(host.state, host.rng, ownerId, 1, (name, payload) => { host.dispatch(name, payload) })
  },
  triggers: [{
    event: 'PhaseStart',
    handle(host, ownerId, context) {
      const payload = context.event.payload as { phase?: string; playerId?: PlayerId }
      if (payload.phase !== 'finish' || payload.playerId !== ownerId) return
      const owner = playerOf(host.state, ownerId)
      if (!owner?.alive || owner.zones.hand.length > 0 || owner.hp <= 0) return
      const candidateIds = host.state.players.filter((candidate) => candidate.alive && !candidate.chained).map((candidate) => candidate.id)
      if (candidateIds.length === 0) return
      host.queueSkill({ skillId: JISHE, ownerId, step: 'pick-chain', data: { candidateIds } })
    },
  }],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'pick-chain') return
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    const { candidateIds } = prompt.data as { candidateIds: PlayerId[] }
    const max = Math.min(owner.hp, candidateIds.length)
    if (max <= 0) return
    host.askSkill({
      skillId: JISHE, ownerId, step: 'pick-chain', data: {},
      build: (requestId): ChooseTargetsRequest => ({
        id: requestId, kind: 'choose-targets', playerId: ownerId,
        prompt: `【极奢】：选择至多${max}名未连环的角色`, timeoutMs: 20_000, optional: true,
        candidateIds, min: 0, max,
      }),
    })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'pick-chain') return
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    const ids = (response.payload as { targetIds?: PlayerId[] }).targetIds ?? []
    if (ids.length === 0) return
    host.dispatch('SkillActivated', { skillId: JISHE, skillName: '极奢', playerId: ownerId, logText: `${owner.nickname}发动【极奢】，令${ids.length}名角色进入连环状态` }, { sourceId: ownerId })
    for (const id of ids) setChained(host as never, id, JISHE, true)
  },
})

registerSkillRuntime({
  id: LIANHUO,
  triggers: [{
    event: 'BeforeDamage',
    handle(host, ownerId, context) {
      if (context.event.targetId !== ownerId) return
      const owner = playerOf(host.state, ownerId)
      if (!owner?.alive || !owner.chained) return
      if ((context.event.damageNature ?? 'normal') !== 'fire') return
      const payload = context.event.payload as { amount?: number; chainTransfer?: boolean }
      if (payload.chainTransfer) return
      payload.amount = (typeof payload.amount === 'number' ? payload.amount : 0) + 1
      host.dispatch('SkillActivated', { skillId: LIANHUO, skillName: '链祸', playerId: ownerId, logText: `${owner.nickname}发动【链祸】，伤害+1` }, { sourceId: ownerId })
    },
  }],
})

export const CENHUN: CharacterDefinition = {
  id: 'cenhun',
  name: '岑昏',
  kingdom: 'wu',
  gender: 'male',
  maxHp: 3,
  pack: 'sp',
  skills: [
    { id: JISHE, name: '极奢', description: '出牌阶段，若你当前手牌上限大于0，可以摸1张牌，然后本回合手牌上限-1（可反复发动）；结束阶段，若你当前手牌数为0，可以令至多X名未处于连环状态的角色进入连环状态（X为你的体力值）。' },
    { id: LIANHUO, name: '链祸', description: '锁定技，你处于连环状态时受到的火焰伤害，若这是本次属性伤害传导的起点，则伤害+1。' },
  ],
}
